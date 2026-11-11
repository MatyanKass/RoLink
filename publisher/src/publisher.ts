// The tool behaviour: prepare -> user types the phrase -> publish -> queue.

import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Creator, Log, PublishConfig, Redactor } from "./config.js";
import { runCopyrightCheck, type CopyrightProvider, type CopyrightResult } from "./copyright.js";
import { inspectMedia, sha256, type AssetKind } from "./media.js";
import { DIALOG_TIMEOUT_MS, cleanLine, requireNativeYes, type NativeConfirm } from "./nativeconfirm.js";
import type { OpenCloud } from "./opencloud.js";
import type { Poller } from "./poller.js";
import type { RoLinkClient } from "./rolink.js";
import type { Prepared, QueueEntry, StateStore, Target } from "./store.js";

export const RESPONSIBILITY_NOTICE =
  "You are responsible for holding the rights to everything published through this tool, including anything an agent picked for you. Roblox can remove assets and penalise the account.";

const NAME_MAX = 50;
const DESCRIPTION_MAX = 1000;

export const PLACE_API_NOTE =
  "Roblox's place publishing guide says this API does not update EditableImage, EditableMesh, PartOperation, SurfaceAppearance or BaseWrap instances; if the place uses them, publish from Studio after changing them.";

const AGREE: Record<AssetKind, string[]> = {
  audio: ["Я согласен на публикацию звуков", "I agree to publish sounds"],
  image: ["Я согласен на публикацию картинок", "I agree to publish images"],
  animation: ["Я согласен на публикацию анимаций", "I agree to publish animations"],
};

const ASSET_TYPE: Record<AssetKind, string> = { audio: "Audio", image: "Decal", animation: "Animation" };

export const ANIMATION_ROOT_NOTE =
  "Roblox's docs list Animation as an uploadable .rbxm type but do not say what the file's root must be: a KeyframeSequence root is unconfirmed, and this route has not been exercised against the live API.";

const NO_UNIVERSE_NOTE =
  "Experience access: none, because no experience is known (pass universeId, set ROBLOX_UNIVERSE_ID, or publish the open place). The asset may not play in your game until you grant it access.";

/** What a person types can differ from the stored phrase in Unicode form and spacing only. */
export function samePhrase(typed: string, phrase: string): boolean {
  const norm = (x: string) => x.normalize("NFC").replace(/\s+/g, " ").trim();
  return norm(typed) === norm(phrase);
}

/** Own entries only: an id such as "__proto__" or "constructor" must not find anything. */
function preparedById(prepares: Record<string, Prepared>, prepareId: unknown): Prepared | undefined {
  return typeof prepareId === "string" && Object.hasOwn(prepares, prepareId) ? prepares[prepareId] : undefined;
}

function phrasesFor(kind: AssetKind, copyright: CopyrightResult): string[] {
  if (copyright.status === "match") return [`Я подтверждаю публикацию: ${copyright.title}`, `I confirm publishing: ${copyright.title}`];
  return AGREE[kind];
}

const CLASSES_BY_PROPERTY: Record<string, string[]> = {
  SoundId: ["Sound"],
  Texture: ["Decal", "Texture"],
  Image: ["ImageLabel", "ImageButton"],
};

export interface TargetArgs {
  path: string;
  property?: string;
  class?: string;
  place?: string;
}

/** Fills in defaults and refuses class/property pairs that make no sense. */
function normaliseTarget(kind: AssetKind, t: TargetArgs): Target {
  const p = t.path.trim();
  if (!p.includes("/") || /^[#@]/.test(p) || p.endsWith("/")) {
    throw new Error(`target.path must be a slash-separated instance path such as "Workspace/Music/Theme", got "${t.path}".`);
  }
  if (kind === "audio") {
    if ((t.class && t.class !== "Sound") || (t.property && t.property !== "SoundId")) throw new Error("Audio can only target Sound.SoundId.");
    return { path: p, class: "Sound", property: "SoundId", place: t.place };
  }
  if (t.property === "SoundId" || t.class === "Sound") throw new Error("An image cannot target Sound.SoundId; use Decal/Texture .Texture or ImageLabel/ImageButton .Image.");
  const property = t.property ?? (t.class === "ImageLabel" || t.class === "ImageButton" ? "Image" : "Texture");
  const allowed = CLASSES_BY_PROPERTY[property];
  if (!allowed) throw new Error(`Unsupported target.property "${property}". Use Texture or Image.`);
  const klass = t.class ?? allowed[0];
  if (!allowed.includes(klass)) throw new Error(`${klass}.${property} is not a valid image target. Use Decal/Texture .Texture or ImageLabel/ImageButton .Image.`);
  return { path: p, class: klass, property, place: t.place };
}

function copyrightLines(kind: AssetKind, c: CopyrightResult): string[] {
  if (kind !== "audio") return [`Copyright check: did not run (no automatic check exists for ${kind === "image" ? "images" : "animations"}).`];
  const scope = c.partial ? ` Only the first ${(c.checkedBytes! / 1e6).toFixed(1)} MB of the file was checked.` : "";
  switch (c.status) {
    case "not_run":
      return ["Copyright check: did not run (no provider configured; set AUDD_API_TOKEN or the ACRCLOUD_* variables)."];
    case "error":
      return [`Copyright check: did not run, the provider could not be reached or refused the request (${(c.errors ?? []).join("; ")}).`];
    case "no_match":
      return [`Copyright check: ${c.provider} found no match.${scope} This does not mean the sound is free of copyright; these databases are incomplete.`];
    case "match":
      return [
        `WARNING: this sound matches a copyrighted track: "${c.title}" by ${c.artist} (via ${c.provider}).${scope}`,
        "Publishing it may lead to a copyright strike on the account.",
      ];
  }
}

export interface PublisherDeps {
  config: PublishConfig;
  store: StateStore;
  cloud?: OpenCloud;
  rolink: RoLinkClient;
  poller: Poller;
  providers: CopyrightProvider[];
  redactor: Redactor;
  log: Log;
  confirm: NativeConfirm;
}

export class Publisher {
  private providers: CopyrightProvider[];

  constructor(private deps: PublisherDeps) {
    this.providers = deps.providers;
  }

  setCopyrightProviders(providers: CopyrightProvider[]) {
    this.providers = providers;
  }

  private publishing(): { cloud: OpenCloud; creator: Creator } {
    const { cloud } = this.deps;
    const creator = this.deps.config.creator;
    if (!cloud || !creator) throw new Error("Publishing needs ROBLOX_PUBLISH_API_KEY and ROBLOX_CREATOR_USER_ID (or ROBLOX_CREATOR_GROUP_ID) in this server's environment.");
    return { cloud, creator };
  }

  private creatorText(): string {
    const c = this.deps.config.creator;
    if (c?.groupId) return `Roblox group ${c.groupId}`;
    if (c?.userId) return `Roblox user ${c.userId}`;
    return "not configured";
  }

  /** Which experience gets Use access: the caller's, the configured one, else the open Studio's. */
  private async resolveUniverse(explicit: number | undefined, target: Target | undefined): Promise<number | undefined> {
    if (explicit !== undefined) {
      if (!Number.isSafeInteger(explicit) || explicit <= 0) throw new Error("universeId must be a positive integer.");
      return explicit;
    }
    if (this.deps.config.universeId) return this.deps.config.universeId;
    const sessions = await this.deps.rolink.editSessions();
    const wanted = target?.place?.toLowerCase();
    const session = wanted ? sessions.find((s) => s.placeName.toLowerCase().includes(wanted) || String(s.placeId) === wanted) : sessions[0];
    return session?.gameId || undefined;
  }

  async prepareAsset(args: { path: string; kind: AssetKind; name: string; description?: string; target?: TargetArgs; universeId?: number }) {
    if (args.kind === "animation" && args.target) throw new Error("An animation cannot take a target: use the asset id in an Animation instance after it is published.");
    const name = (args.name ?? "").trim();
    if (!name) throw new Error("name is required.");
    if (name.length > NAME_MAX) throw new Error(`name is too long (limit ${NAME_MAX} characters).`);
    const description = args.description ?? name;
    if (description.length > DESCRIPTION_MAX) throw new Error(`description is too long (limit ${DESCRIPTION_MAX} characters).`);
    const target = args.target ? normaliseTarget(args.kind, args.target) : undefined;
    const universeId = await this.resolveUniverse(args.universeId, target);

    const media = await inspectMedia(args.path, args.kind);
    const fileName = path.basename(media.file);
    const copyright: CopyrightResult =
      args.kind === "audio" ? await runCopyrightCheck(this.providers, media.data, fileName, this.deps.redactor, this.deps.log) : { status: "not_run" };

    const prepareId = randomUUID();
    const acceptedPhrases = phrasesFor(args.kind, copyright);
    const prepared: Prepared = {
      prepareId,
      file: media.file,
      fileName,
      kind: args.kind,
      name,
      description,
      sha256: media.sha256,
      contentType: media.contentType,
      target,
      copyright,
      acceptedPhrases,
      universeId,
      createdAt: Date.now(),
    };
    await this.deps.store.mutate((s) => void (s.prepares[prepareId] = prepared));
    this.deps.log("prepared", prepareId, args.kind);

    const measure =
      args.kind === "audio" ? `Duration: ${media.durationSeconds!.toFixed(1)} s` : args.kind === "image" ? `Dimensions: ${media.width}x${media.height}` : "Format: binary .rbxm";
    const noun = args.kind === "audio" ? "a sound" : args.kind === "image" ? "an image" : "an animation";
    const summary = [
      `Ready to publish ${noun} to Roblox. Nothing has been uploaded yet.`,
      `Name: ${name}`,
      `Description: ${description}`,
      `File: ${media.file}`,
      `Size: ${media.sizeBytes} bytes`,
      measure,
      `SHA-256: ${media.sha256}`,
      `Account: ${this.creatorText()}`,
      target ? `Target: ${target.path} (${target.class}.${target.property}), placeholder until moderation approves` : "Target: none",
      universeId ? `Experience access: after the upload, experience ${universeId} gets permission to use this asset.` : NO_UNIVERSE_NOTE,
      ...(args.kind === "animation" ? [ANIMATION_ROOT_NOTE] : []),
      ...copyrightLines(args.kind, copyright),
      RESPONSIBILITY_NOTICE,
      ...(this.deps.cloud && this.deps.config.creator ? [] : ["Publishing is not configured yet: set ROBLOX_PUBLISH_API_KEY and a creator id before publish_asset."]),
      `To go ahead, the user must type exactly: ${acceptedPhrases[0]}`,
    ].join("\n");

    return {
      prepareId,
      kind: args.kind,
      name,
      sizeBytes: media.sizeBytes,
      sha256: media.sha256,
      durationSeconds: media.durationSeconds,
      width: media.width,
      height: media.height,
      target,
      copyright,
      universeId,
      requiredPhrase: acceptedPhrases[0],
      acceptedPhrases,
      summary,
    };
  }

  async publishAsset(args: { prepareId: string; confirmation: string }) {
    if (preparedById(this.deps.store.read().prepares, args.prepareId)?.kind === "animation") throw new Error("This prepareId is an animation: use publish_animation.");
    return this.publishPrepared(args);
  }

  async publishAnimation(args: { prepareId: string; confirmation: string }) {
    const prepared = preparedById(this.deps.store.read().prepares, args.prepareId);
    if (prepared && prepared.kind !== "animation") throw new Error(`This prepareId is ${prepared.kind === "audio" ? "a sound" : "an image"}: use publish_asset.`);
    return { ...(await this.publishPrepared(args)), note: `The animation is now in Roblox moderation; publish_status shows progress. ${ANIMATION_ROOT_NOTE}` };
  }

  private async publishPrepared(args: { prepareId: string; confirmation: string }) {
    const { prepareId } = args;
    const p = preparedById(this.deps.store.read().prepares, prepareId);
    if (!p) throw new Error(`Unknown prepareId "${prepareId}". Call prepare_asset first.`);
    if (p.usedAt) throw new Error("This prepareId was already used. Call prepare_asset again.");
    if (!p.acceptedPhrases.some((phrase) => samePhrase(String(args.confirmation ?? ""), phrase))) {
      throw new Error(`Confirmation phrase does not match. Show the summary to the user and wait for them to type exactly: ${p.acceptedPhrases[0]}`);
    }
    const { cloud, creator } = this.publishing();

    // the bytes hashed here are the bytes uploaded
    const data = await fsp.readFile(p.file).catch(() => undefined);
    if (!data || sha256(data) !== p.sha256) throw new Error("The file changed or went missing after prepare_asset. Call prepare_asset again.");

    const now = Date.now();
    await this.deps.store.mutate((s) => {
      const cur = s.prepares[prepareId];
      if (cur.usedAt) throw new Error("This prepareId was already used. Call prepare_asset again.");
      cur.usedAt = now;
      s.queue.push({ prepareId, kind: p.kind, name: p.name, status: "uploading", target: p.target, universeId: p.universeId, createdAt: now, updatedAt: now });
    });

    let op;
    try {
      op = await cloud.createAsset(p.kind, {
        assetType: ASSET_TYPE[p.kind],
        displayName: p.name,
        description: p.description,
        creator,
        data,
        contentType: p.contentType,
        fileName: p.fileName,
      });
      if (!op.path) throw new Error("Open Cloud accepted the upload but returned no operation path.");
    } catch (e: any) {
      const reason = this.deps.redactor.text(String(e?.message ?? e));
      this.deps.log("upload refused", prepareId, reason);
      await this.deps.store.update(prepareId, { status: "failed", reason });
      throw new Error(`${reason}\nThis prepareId is spent; call prepare_asset again to retry.`);
    }

    this.deps.log("uploaded", prepareId, op.path);
    const note = "The asset is now in Roblox moderation. publish_status shows progress; a background poller applies it when approved.";
    try {
      await this.deps.store.update(prepareId, { status: "processing", operationPath: op.path });
      await this.deps.poller.processEntry(prepareId, op);
      const entry = this.deps.store.read().queue.find((q) => q.prepareId === prepareId)!;
      return { ...this.view(entry), note };
    } catch (e: any) {
      // the upload went through: an error here (a locked state file, say) must not read as a failed publish
      const reason = this.deps.redactor.text(String(e?.message ?? e));
      this.deps.log("upload accepted, local bookkeeping failed", prepareId, reason);
      return { prepareId, kind: p.kind, name: p.name, status: "processing", operationPath: op.path, note: `${note} Roblox accepted the upload, but recording it locally failed (${reason}); the poller retries. Do not upload this file again.` };
    }
  }

  private view(e: QueueEntry) {
    return {
      prepareId: e.prepareId,
      kind: e.kind,
      name: e.name,
      status: e.status,
      assetId: e.assetId,
      contentId: e.assetId ? `rbxassetid://${e.assetId}` : undefined,
      reason: e.reason,
      lastError: e.lastError,
      target: e.target,
      place: e.place,
      placeholder: e.placeholder,
      universeId: e.universeId === undefined ? undefined : String(e.universeId),
      grant: e.grant,
      createdAt: new Date(e.createdAt).toISOString(),
      updatedAt: new Date(e.updatedAt).toISOString(),
    };
  }

  async publishStatus(args: { prepareId?: string }) {
    const queue = this.deps.store.read().queue.filter((e) => !args.prepareId || e.prepareId === args.prepareId);
    return { queue: queue.map((e) => this.view(e)) };
  }

  private async readPlace(args: { universeId: number; placeId: number; file: string }) {
    for (const key of ["universeId", "placeId"] as const) {
      if (!Number.isSafeInteger(args[key]) || args[key] <= 0) throw new Error(`${key} must be a positive integer.`);
    }
    if (!path.isAbsolute(args.file)) throw new Error(`file must be an absolute path: ${args.file}`);
    const ext = path.extname(args.file).toLowerCase();
    if (ext !== ".rbxl" && ext !== ".rbxlx") throw new Error("file must be a .rbxl or .rbxlx place file.");
    const data = await fsp.readFile(args.file).catch(() => undefined);
    if (!data) throw new Error(`File not found: ${args.file}`);
    const head = data.toString("latin1", 0, 16).replace(/^﻿|^\xEF\xBB\xBF/, "").trimStart();
    const valid = ext === ".rbxl" ? head.startsWith("<roblox!") : head.startsWith("<roblox");
    if (!valid) throw new Error(`${path.basename(args.file)} does not look like a Roblox place file.`);
    return { data, contentType: ext === ".rbxl" ? "application/octet-stream" : "application/xml" };
  }

  private async uploadPlace(args: { universeId: number; placeId: number; file: string }, versionType: "Saved" | "Published", data: Buffer, contentType: string) {
    const { cloud } = this.publishingKeyOnly();
    const versionNumber = await cloud.uploadPlace(args.universeId, args.placeId, versionType, data, contentType);
    this.deps.log("place upload", versionType, args.placeId, versionNumber);
    return { versionType, versionNumber, universeId: args.universeId, placeId: args.placeId, file: args.file, note: PLACE_API_NOTE };
  }

  /** Places only need the key: the owner comes from the experience. */
  private publishingKeyOnly(): { cloud: OpenCloud } {
    if (!this.deps.cloud) throw new Error("Place uploads need ROBLOX_PUBLISH_API_KEY in this server's environment.");
    return { cloud: this.deps.cloud };
  }

  async placeSave(args: { universeId: number; placeId: number; file: string }) {
    this.publishingKeyOnly();
    const { data, contentType } = await this.readPlace(args);
    return this.uploadPlace(args, "Saved", data, contentType);
  }

  async placePublish(args: { universeId: number; placeId: number; file: string }) {
    this.publishingKeyOnly();
    const { data, contentType } = await this.readPlace(args);
    const text = [
      `Experience (universe) ${args.universeId}, place ${args.placeId}.`,
      `The place will be replaced by ${cleanLine(path.basename(args.file), 120)} (${data.length} bytes) and published.`,
      "If this experience is already public, the new version goes live for players at once.",
      "Если игра уже открыта для всех, новая версия сразу станет доступна игрокам.",
    ].join("\n\n");

    await requireNativeYes(this.deps.confirm, this.deps.redactor, { title: "Publish this place to Roblox?", text, confirmLabel: "Publish now", timeoutMs: DIALOG_TIMEOUT_MS }, "Nothing was uploaded.");
    return this.uploadPlace(args, "Published", data, contentType);
  }
}
