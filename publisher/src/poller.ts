// Moves queue entries forward: operation -> moderation -> real id in Studio.
// Everything it needs is in the state file, so a restart picks up where it left off.

import type { Log, Redactor } from "./config.js";
import { CloudError, explainOperationError, moderationReason, parseModeration, type ModerationResult, type OpenCloud, type Operation } from "./opencloud.js";
import { StudioOffline, type RoLinkClient } from "./rolink.js";
import type { QueueEntry, StateStore } from "./store.js";

export const PENDING_ATTRIBUTE = "RoLinkPendingAsset";
const UPLOAD_GRACE_MS = 10 * 60_000;
const RETRY_DEFAULT_MS = 60_000;
const WAITING_FOR_STUDIO = "Waiting for Roblox Studio to connect through RoLink.";

export interface PollerDeps {
  store: StateStore;
  cloud?: OpenCloud;
  rolink: RoLinkClient;
  redactor: Redactor;
  log: Log;
  intervalMs?: number;
}

function needsGrant(e: QueueEntry) {
  if (!e.universeId || !e.assetId || e.status === "rejected" || e.status === "failed") return false;
  return !e.grant || e.grant.status === "pending";
}

function isActive(e: QueueEntry) {
  if (e.status === "uploading" || e.status === "processing" || e.status === "reviewing") return true;
  if (needsGrant(e)) return true;
  return e.status === "approved" && !!e.target;
}

function splitPath(instancePath: string) {
  const at = instancePath.lastIndexOf("/");
  return { parent: instancePath.slice(0, at), name: instancePath.slice(at + 1) };
}

export class Poller {
  private timer?: NodeJS.Timeout;
  private running = false;
  private cloudPausedUntil = 0;

  constructor(private deps: PollerDeps) {}

  start() {
    this.timer ??= setInterval(() => void this.tick(), this.deps.intervalMs ?? 15_000);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const e of this.deps.store.read().queue.filter(isActive)) await this.processEntry(e.prepareId);
    } catch (e: any) {
      this.deps.log("poll failed", e);
    } finally {
      this.running = false;
    }
  }

  private entry(prepareId: string) {
    return this.deps.store.read().queue.find((q) => q.prepareId === prepareId);
  }

  private text(e: any) {
    return this.deps.redactor.text(String(e?.message ?? e));
  }

  private noteCloudError(e: any, prepareId: string) {
    if (e instanceof CloudError && (e.kind === "rate_limit" || e.kind === "quota")) {
      this.cloudPausedUntil = Date.now() + (e.retryAfterSeconds ? e.retryAfterSeconds * 1000 : RETRY_DEFAULT_MS);
    }
    this.deps.log("status check failed", prepareId, e);
    return this.deps.store.update(prepareId, { lastError: this.text(e) });
  }

  /** Advances one entry as far as it can go right now. Never throws for remote failures. */
  async processEntry(prepareId: string, known?: Operation) {
    let e = this.entry(prepareId);
    if (!e) return;
    if (e.status === "uploading") {
      if (Date.now() - e.createdAt > UPLOAD_GRACE_MS) {
        await this.deps.store.update(prepareId, {
          status: "failed",
          reason: "The upload was interrupted before Roblox confirmed it. Check the Creator Dashboard before uploading again.",
        });
      }
      return;
    }

    if (e.target && !e.placeholder?.created && (e.status === "processing" || e.status === "reviewing")) {
      await this.ensurePlaceholder(e);
    }

    const cloudReady = this.deps.cloud && Date.now() >= this.cloudPausedUntil;
    if (cloudReady || known) {
      try {
        if (e.status === "processing") await this.checkOperation(e, known);
        else if (e.status === "reviewing") await this.checkModeration(e);
      } catch (err) {
        await this.noteCloudError(err, prepareId);
      }
    }

    e = this.entry(prepareId);
    if (e && needsGrant(e) && this.deps.cloud && Date.now() >= this.cloudPausedUntil) await this.grantUse(e);

    e = this.entry(prepareId);
    if (e?.status === "approved" && e.target) await this.applyApproved(e);
  }

  /** The upload stands whatever happens here, so a failure is only recorded. */
  private async grantUse(e: QueueEntry) {
    try {
      await this.deps.cloud!.grantUse(e.universeId!, e.assetId!);
      this.deps.log("granted use", e.prepareId, e.universeId);
      await this.deps.store.update(e.prepareId, { grant: { status: "granted" } });
    } catch (err) {
      const retry = err instanceof CloudError && (err.kind === "rate_limit" || err.kind === "network" || err.kind === "server");
      if (retry) await this.noteCloudError(err, e.prepareId);
      else this.deps.log("grant failed", e.prepareId, err);
      await this.deps.store.update(e.prepareId, { grant: { status: retry ? "pending" : "failed", error: this.text(err) } });
    }
  }

  private async checkOperation(e: QueueEntry, known?: Operation) {
    const op = known?.done ? known : await this.deps.cloud!.getOperation(e.operationPath!);
    if (!op.done) return;
    if (op.error) {
      const reason = explainOperationError(e.kind, op.error, this.deps.redactor);
      this.deps.log("upload failed", e.prepareId, reason);
      await this.deps.store.update(e.prepareId, { status: "failed", reason });
      return;
    }
    const r = op.response;
    if (r?.assetId === undefined) {
      await this.deps.store.update(e.prepareId, { status: "failed", reason: "Open Cloud finished the operation without an asset id." });
      return;
    }
    const base = { assetId: String(r.assetId), revisionId: r.revisionId ?? "1", lastError: undefined };
    await this.recordModeration(e, r.moderationResult, base);
  }

  private async checkModeration(e: QueueEntry) {
    const m = await this.deps.cloud!.getModeration(e.assetId!, e.revisionId ?? "1");
    await this.recordModeration(e, m, { lastError: undefined });
  }

  private async recordModeration(e: QueueEntry, m: ModerationResult | undefined, base: Partial<QueueEntry>) {
    // an unknown or absent state must never count as approved
    const state = parseModeration(m) ?? "reviewing";
    if (state === "rejected") {
      const reason = this.deps.redactor.text(moderationReason(m));
      this.deps.log("rejected by moderation", e.prepareId);
      await this.deps.store.update(e.prepareId, { ...base, status: "rejected", reason });
    } else {
      if (state === "approved") this.deps.log("approved by moderation", e.prepareId);
      await this.deps.store.update(e.prepareId, { ...base, status: state });
    }
  }

  /** The Studio this entry is tied to, if it is connected right now. */
  private async boundPlace(e: QueueEntry): Promise<string | undefined> {
    if (e.place) return (await this.deps.rolink.isConnected(e.place)) ? e.place : undefined;
    const place = await this.deps.rolink.currentPlace(e.target!.place);
    if (place) await this.deps.store.update(e.prepareId, { place });
    return place;
  }

  private setPlaceholder(e: QueueEntry, placeholder: NonNullable<QueueEntry["placeholder"]>) {
    return this.deps.store.update(e.prepareId, { placeholder: { ...placeholder, ...(placeholder.error ? { error: this.deps.redactor.text(placeholder.error) } : {}) } });
  }

  private studioFailure(e: QueueEntry, err: any) {
    if (err instanceof StudioOffline || /not connected|session|did not answer/i.test(String(err?.message))) {
      return this.setPlaceholder(e, { created: !!e.placeholder?.created, note: WAITING_FOR_STUDIO });
    }
    this.deps.log("studio update failed", e.prepareId, err);
    return this.setPlaceholder(e, { created: !!e.placeholder?.created, error: this.text(err) });
  }

  private wrongClass(e: QueueEntry, found: string) {
    return `${e.target!.path} already exists as ${found}, expected ${e.target!.class}. Rename it or choose another target.`;
  }

  private async ensurePlaceholder(e: QueueEntry) {
    const t = e.target!;
    try {
      const place = await this.boundPlace(e);
      if (!place) return this.setPlaceholder(e, { created: false, note: WAITING_FOR_STUDIO });
      const found = await this.deps.rolink.getInstance(t.path, t.property, place);
      if (!found) {
        const { parent, name } = splitPath(t.path);
        await this.deps.rolink.call("build", { parent, items: [{ class: t.class, name, attrs: { [PENDING_ATTRIBUTE]: e.prepareId } }], select: false, place });
      } else if (found.class !== t.class) {
        return this.setPlaceholder(e, { created: false, error: this.wrongClass(e, found.class) });
      } else {
        // an existing instance keeps its current id until the new one is approved
        await this.deps.rolink.call("set", { edits: [{ path: t.path, attrs: { [PENDING_ATTRIBUTE]: e.prepareId } }], place });
      }
      await this.setPlaceholder(e, { created: true });
    } catch (err) {
      await this.studioFailure(e, err);
    }
  }

  private async applyApproved(e: QueueEntry) {
    const t = e.target!;
    const contentId = `rbxassetid://${e.assetId}`;
    try {
      const place = await this.boundPlace(e);
      if (!place) return this.setPlaceholder(e, { created: !!e.placeholder?.created, note: WAITING_FOR_STUDIO });
      const found = await this.deps.rolink.getInstance(t.path, t.property, place);
      if (!found) {
        // e.g. the place was closed without saving the placeholder
        const { parent, name } = splitPath(t.path);
        await this.deps.rolink.call("build", { parent, items: [{ class: t.class, name, [t.property]: contentId }], select: false, place });
      } else if (found.class !== t.class) {
        return this.setPlaceholder(e, { created: false, error: this.wrongClass(e, found.class) });
      } else {
        const owner = found.attrs?.[PENDING_ATTRIBUTE];
        if (owner !== undefined && owner !== e.prepareId) {
          return this.setPlaceholder(e, { created: false, error: `${t.path} is now waiting for another upload (${String(owner)}); left unchanged.` });
        }
        const r = await this.deps.rolink.call("set", {
          edits: [{ path: t.path, props: { [t.property]: contentId }, attrs: { [PENDING_ATTRIBUTE]: false }, removeFalseAttrs: true }],
          place,
        });
        if (r?.warnings?.length) return this.setPlaceholder(e, { created: true, error: r.warnings.join("; ") });
      }
      this.deps.log("applied", e.prepareId, contentId);
      await this.deps.store.update(e.prepareId, { status: "applied", placeholder: { created: true } });
    } catch (err) {
      await this.studioFailure(e, err);
    }
  }
}
