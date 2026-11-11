// Roblox Open Cloud client. The API key is sent only in the x-api-key header
// and every error text passes through the redactor before leaving this file.
//   Assets:  https://create.roblox.com/docs/cloud/reference/features/assets.md
//   Places:  https://create.roblox.com/docs/cloud/reference/features/places.md

import type { Creator, Redactor } from "./config.js";

const API = "https://apis.roblox.com";

export type ErrorKind = "quota" | "rate_limit" | "auth" | "invalid" | "server" | "network";
/** What the caller was doing, which decides the limits quoted in the message. */
export type CloudContext = "audio" | "image" | "animation" | "place" | "poll" | "grant" | "asset-quota" | "restart" | "ds-stores" | "ds-entries" | "ds-read" | "ds-update" | "ds-delete";

export class CloudError extends Error {
  constructor(message: string, readonly kind: ErrorKind, readonly retryAfterSeconds?: number, readonly status?: number) {
    super(message);
  }
}

/** Calls that are not uploads: the permission to name and the documented limit. */
const API_CALLS: Partial<Record<CloudContext, { what: string; permission: string; limit: string }>> = {
  grant: { what: "Granting experience access", permission: "asset-permissions:write", limit: "100 requests per minute per API key owner." },
  "asset-quota": { what: "Reading the asset quota", permission: "asset:read", limit: "60 requests per minute per API key owner." },
  restart: { what: "Restarting servers", permission: "universe:write", limit: "30 requests per minute per API key owner." },
  "ds-stores": { what: "Listing data stores", permission: "universe-datastores.control:list", limit: "Data store requests are also throttled per experience." },
  "ds-entries": { what: "Listing data store entries", permission: "universe-datastores.objects:list", limit: "Data store requests are also throttled per experience." },
  "ds-read": { what: "Reading a data store entry", permission: "universe-datastores.objects:read", limit: "Data store requests are also throttled per experience." },
  "ds-update": { what: "Writing a data store entry", permission: "universe-datastores.objects:update", limit: "Data store requests are also throttled per experience." },
  "ds-delete": { what: "Deleting a data store entry", permission: "universe-datastores.objects:delete", limit: "Data store requests are also throttled per experience." },
};

export interface GrantError {
  assetId?: string | number;
  code?: string;
}

export interface AssetQuota {
  quotaType?: string;
  assetType?: string;
  usage?: number | string;
  capacity?: number | string;
  period?: string;
  [extra: string]: unknown;
}

export interface DataStoreEntry {
  id?: string;
  path?: string;
  state?: string;
  etag?: string;
  revisionId?: string;
  createTime?: string;
  revisionCreateTime?: string;
  value?: unknown;
  users?: string[];
  attributes?: Record<string, unknown>;
}

export interface EntryAddress {
  universeId: number;
  store: string;
  key: string;
  scope?: string;
}

export interface ListOptions {
  prefix?: string;
  pageSize?: number;
  pageToken?: string;
}

const enc = encodeURIComponent;
const datastoreBase = (universeId: number) => `${API}/cloud/v2/universes/${universeId}/data-stores`;
const entriesUrl = (a: Omit<EntryAddress, "key">) => `${datastoreBase(a.universeId)}/${enc(a.store)}${a.scope ? `/scopes/${enc(a.scope)}` : ""}/entries`;

function listQuery(o: ListOptions): string {
  const q = new URLSearchParams();
  if (o.pageSize) q.set("maxPageSize", String(o.pageSize));
  if (o.pageToken) q.set("pageToken", o.pageToken);
  if (o.prefix) q.set("filter", `id.startsWith("${o.prefix}")`);
  const s = q.toString();
  return s ? `?${s}` : "";
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

const QUOTA_WORDS = /quota|monthly|upload limit|resource.?exhausted/i;
/** Also used for field validation ("description exceeded the limit"), so only a 403/429 makes these a quota. */
const LIMIT_WORDS = /limit (?:was |has been )?(?:reached|exceeded)|exceeded .*limit/i;
const MANUAL = "If it keeps failing you may need to upload it yourself in Creator Hub or the Studio Asset Manager.";

function quotaLimit(ctx: CloudContext): string {
  if (ctx === "audio") return "Limit: the audio upload allowance depends on your Roblox account; the reason above is the one Roblox returned.";
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
  const call = API_CALLS[ctx];
  if (call) {
    if (status === 429) return new CloudError(`${call.what} hit the Open Cloud rate limit.${detail} Limit: ${call.limit}${retry}`, "rate_limit", retryAfter, status);
    if (status === 401 || status === 403) return new CloudError(`${call.what} was refused (HTTP ${status}).${detail} The API key needs the ${call.permission} permission for this experience or account.`, "auth", undefined, status);
    if (status === 404) return new CloudError(`${call.what}: not found (HTTP 404).${detail}`, "invalid", undefined, status);
    if (status >= 500) return new CloudError(`${call.what} failed: Open Cloud server error (HTTP ${status}).${detail}`, "server", undefined, status);
    return new CloudError(`${call.what} was refused (HTTP ${status}).${detail}`, "invalid", undefined, status);
  }
  if (QUOTA_WORDS.test(message) || ((status === 403 || status === 429) && LIMIT_WORDS.test(message))) {
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
    throw new CloudError(this.redactor.text(err.message), err.kind, err.retryAfterSeconds, err.status);
  }

  /** Reference: PATCH /asset-permissions-api/v1/assets/permissions. Throws unless Roblox lists the asset as granted. */
  async grantUse(universeId: number, assetId: string): Promise<void> {
    const body = await this.request(
      "grant",
      `${API}/asset-permissions-api/v1/assets/permissions`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json-patch+json" },
        body: JSON.stringify({ subjectType: "Universe", subjectId: String(universeId), action: "Use", requests: [{ assetId: Number(assetId) }] }),
      },
      30_000,
    );
    const failed: GrantError | undefined = (body.errors ?? []).find((x: GrantError) => String(x.assetId) === assetId);
    if (failed) throw new CloudError(this.redactor.text(`Roblox did not grant experience ${universeId} access to asset ${assetId}: ${failed.code ?? "unknown error"}.`), "invalid");
    if (!(body.successAssetIds ?? []).some((x: unknown) => String(x) === assetId)) {
      throw new CloudError(`Roblox did not confirm that experience ${universeId} has access to asset ${assetId}.`, "invalid");
    }
  }

  /** Reference: GET /cloud/v2/users/{id}/asset-quotas. */
  async assetQuotas(userId: string, filter?: string): Promise<AssetQuota[]> {
    const quotas: AssetQuota[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams({ maxPageSize: "100" });
      if (filter) q.set("filter", filter);
      if (pageToken) q.set("pageToken", pageToken);
      const body = await this.request("asset-quota", `${API}/cloud/v2/users/${enc(userId)}/asset-quotas?${q}`, {}, 30_000);
      quotas.push(...(body.assetQuotas ?? []));
      pageToken = body.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return quotas;
  }

  /** Reference: POST /cloud/v2/universes/{id}:restartServers. An empty body restarts only servers on an older version. */
  restartServers(universeId: number): Promise<unknown> {
    return this.request("restart", `${API}/cloud/v2/universes/${universeId}:restartServers`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, 30_000);
  }

  listDataStores(universeId: number, o: ListOptions): Promise<{ dataStores?: unknown[]; nextPageToken?: string }> {
    return this.request("ds-stores", `${datastoreBase(universeId)}${listQuery(o)}`, {}, 30_000);
  }

  listEntries(a: Omit<EntryAddress, "key">, o: ListOptions): Promise<{ dataStoreEntries?: DataStoreEntry[]; nextPageToken?: string }> {
    return this.request("ds-entries", `${entriesUrl(a)}${listQuery(o)}`, {}, 30_000);
  }

  getEntry(a: EntryAddress): Promise<DataStoreEntry> {
    return this.request("ds-read", `${entriesUrl(a)}/${enc(a.key)}`, {}, 30_000);
  }

  /** v2 has no partial update: `users` and `attributes` left out here are cleared by Roblox. */
  updateEntry(a: EntryAddress, entry: Pick<DataStoreEntry, "value" | "users" | "attributes">, allowMissing: boolean): Promise<DataStoreEntry> {
    const url = `${entriesUrl(a)}/${enc(a.key)}${allowMissing ? "?allowMissing=true" : ""}`;
    return this.request("ds-update", url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(entry) }, 30_000);
  }

  deleteEntry(a: EntryAddress): Promise<unknown> {
    return this.request("ds-delete", `${entriesUrl(a)}/${enc(a.key)}`, { method: "DELETE" }, 30_000);
  }

  async createAsset(ctx: "audio" | "image" | "animation", req: { assetType: string; displayName: string; description: string; creator: Creator; data: Buffer; contentType: string; fileName: string }): Promise<Operation> {
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
