// Roblox Open Cloud client. The API key is sent only in the x-api-key header
// and every error text passes through the redactor before leaving this file.
//   Assets:  https://create.roblox.com/docs/cloud/reference/features/assets.md
//   Places:  https://create.roblox.com/docs/cloud/reference/features/places.md

import type { Creator, Redactor } from "./config.js";

const API = "https://apis.roblox.com";

export type ErrorKind = "quota" | "rate_limit" | "auth" | "invalid" | "server" | "network";
/** What the caller was doing, which decides the limits quoted in the message. */
export type CloudContext = "audio" | "image" | "place" | "poll";

export class CloudError extends Error {
  constructor(message: string, readonly kind: ErrorKind, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

export interface Operation {
  path?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: { assetId?: string | number; revisionId?: string; moderationResult?: ModerationResult };
}

export interface ModerationResult {
  moderationState?: string;
  [extra: string]: unknown;
}

const QUOTA_WORDS = /quota|monthly|upload limit|limit (?:was |has been )?(?:reached|exceeded)|exceeded .*limit|resource.?exhausted/i;
const MANUAL = "If it keeps failing you may need to upload it yourself in Creator Hub or the Studio Asset Manager.";

function quotaLimit(ctx: CloudContext): string {
  if (ctx === "audio") return "Limit: audio uploads are capped at 100 per month for ID-verified accounts and 10 per month otherwise; the period does not always reset on the 1st.";
  return "Limit: Roblox does not publish a fixed count for this asset type.";
}

function rateLimit(ctx: CloudContext): string {
  if (ctx === "place") return "Limit: 30 requests per minute per API key owner for place uploads.";
  if (ctx === "poll") return "Limit: 300 operation checks and 100 version checks per minute per API key owner.";
  return "Limit: 120 Create Asset requests per minute per API key owner.";
}

function explain(ctx: CloudContext, status: number, message: string, retryAfter?: number): CloudError {
  const detail = message ? ` Roblox said: "${message}".` : "";
  const retry = retryAfter ? ` Retry after ${retryAfter} s.` : "";
  if (QUOTA_WORDS.test(message)) {
    return new CloudError(`Upload refused: your Roblox upload quota is used up.${detail} ${quotaLimit(ctx)}${retry} ${MANUAL}`, "quota", retryAfter);
  }
  if (status === 429) {
    return new CloudError(`Upload refused: Open Cloud rate limit hit.${detail} ${rateLimit(ctx)}${retry} ${MANUAL}`, "rate_limit", retryAfter);
  }
  if (ctx === "place") {
    if (status === 401 || status === 403) return new CloudError(`Place upload refused (HTTP ${status}).${detail} The key needs the universe-places:write permission for this experience.`, "auth");
    if (status === 404) return new CloudError(`Place or universe does not exist (HTTP 404).${detail}`, "invalid");
    if (status === 409) return new CloudError(`This place is not part of that universe (HTTP 409).${detail}`, "invalid");
  } else if (status === 401 || status === 403) {
    return new CloudError(`Open Cloud refused the key (HTTP ${status}).${detail} The key needs the asset:read and asset:write permissions and must belong to the configured creator.`, "auth");
  }
  if (status >= 500) return new CloudError(`Open Cloud server error (HTTP ${status}).${detail}`, "server");
  return new CloudError(`Open Cloud refused the request (HTTP ${status}).${detail}`, "invalid");
}

export class OpenCloud {
  constructor(private apiKey: string, public fetchImpl: typeof fetch, private redactor: Redactor) {}

  private async request(ctx: CloudContext, url: string, init: RequestInit, timeoutMs: number): Promise<any> {
    let r: Response;
    try {
      r = await this.fetchImpl(url, { ...init, headers: { ...init.headers, "x-api-key": this.apiKey }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) {
      throw new CloudError(this.redactor.text(`Network error talking to Open Cloud: ${e?.message ?? e}`), "network");
    }
    const body: any = await r.json().catch(() => ({}));
    if (r.ok) return body;
    const retryAfter = Number(r.headers.get("retry-after")) || undefined;
    const err = explain(ctx, r.status, String(body?.message ?? body?.error?.message ?? ""), retryAfter);
    throw new CloudError(this.redactor.text(err.message), err.kind, err.retryAfterSeconds);
  }

  async createAsset(ctx: "audio" | "image", req: { assetType: string; displayName: string; description: string; creator: Creator; data: Buffer; contentType: string; fileName: string }): Promise<Operation> {
    const form = new FormData();
    form.append("request", JSON.stringify({ assetType: req.assetType, displayName: req.displayName, description: req.description, creationContext: { creator: req.creator } }));
    form.append("fileContent", new Blob([new Uint8Array(req.data)], { type: req.contentType }), req.fileName);
    return this.request(ctx, `${API}/assets/v1/assets`, { method: "POST", body: form }, 300_000);
  }

  getOperation(path: string): Promise<Operation> {
    if (!/^operations\/[\w-]+$/.test(path)) throw new CloudError(`Unexpected operation path: ${path}`, "invalid");
    return this.request("poll", `${API}/assets/v1/${path}`, {}, 30_000);
  }

  /** Get Asset Version: the documented way to read moderationResult after the upload. */
  async getModeration(assetId: string, version: string): Promise<ModerationResult | undefined> {
    const body = await this.request("poll", `${API}/assets/v1/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(version)}`, {}, 30_000);
    return body.moderationResult;
  }

  /** Returns the new version number. Reference: POST /universes/v1/{u}/places/{p}/versions. */
  async uploadPlace(universeId: number, placeId: number, versionType: "Saved" | "Published", data: Buffer, contentType: string): Promise<number | undefined> {
    const body = await this.request(
      "place",
      `${API}/universes/v1/${universeId}/places/${placeId}/versions?versionType=${versionType}`,
      { method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(data) },
      600_000,
    );
    return body.versionNumber;
  }
}

/** An operation that finished with an error, in the same words as an HTTP failure. */
export function explainOperationError(ctx: CloudContext, err: { code?: number; message?: string }, redactor: Redactor): string {
  return redactor.text(explain(ctx, Number(err.code) || 0, err.message ?? "").message);
}

export type ModerationState = "approved" | "rejected" | "reviewing";

/** Docs list Reviewing/Rejected/Approved; the guide's sample uses MODERATION_STATE_*. */
export function parseModeration(m: ModerationResult | undefined): ModerationState | undefined {
  const raw = m?.moderationState;
  if (typeof raw !== "string") return undefined;
  const s = raw.toUpperCase().replace(/^MODERATION_STATE_/, "");
  if (s === "APPROVED") return "approved";
  if (s === "REJECTED") return "rejected";
  if (s === "REVIEWING") return "reviewing";
  return undefined;
}

/** The docs define no reason field, so anything else Roblox attaches is passed on. */
export function moderationReason(m: ModerationResult | undefined): string {
  for (const key of ["moderationNote", "reason", "message", "details"]) {
    const v = m?.[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "Roblox did not give a reason through the API; check the asset on the Creator Dashboard.";
}
