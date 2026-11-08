// Tools that act on the experience rather than upload a file: quota, server
// restart and data stores. Reads are free; anything that changes live state
// waits for a button press in Studio.

import type { Log, PublishConfig, Redactor } from "./config.js";
import { CloudError, type AssetQuota, type DataStoreEntry, type EntryAddress, type OpenCloud } from "./opencloud.js";
import type { RoLinkClient } from "./rolink.js";

const DIALOG_SECONDS = 120;
const PREVIEW_CHARS = 300;
const NAME_RE = /^\w+$/;

export interface CloudToolsDeps {
  config: PublishConfig;
  cloud?: OpenCloud;
  rolink: RoLinkClient;
  redactor: Redactor;
  log: Log;
}

interface EntryArgs {
  universeId: number;
  store: string;
  key: string;
  scope?: string;
}

interface SetArgs extends EntryArgs {
  value: unknown;
  users?: (string | number)[];
  attributes?: Record<string, unknown>;
  create?: boolean;
}

function positive(name: string, v: unknown): number {
  if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Error(`${name} must be a positive integer.`);
  return v as number;
}

function text(name: string, v: unknown): string {
  if (typeof v !== "string" || !v) throw new Error(`${name} is required.`);
  return v;
}

/** JSON keeps line breaks in a value from being laid out as dialog text. */
function preview(v: unknown): string {
  const s = JSON.stringify(v) ?? "null";
  return s.length > PREVIEW_CHARS ? `${s.slice(0, PREVIEW_CHARS)}… (${s.length} characters in total)` : s;
}

function userPath(u: string | number): string {
  if (typeof u === "number" && Number.isSafeInteger(u) && u > 0) return `users/${u}`;
  if (typeof u === "string" && /^users\/\d+$/.test(u)) return u;
  throw new Error(`users must be user ids or "users/<id>" paths, got ${JSON.stringify(u)}.`);
}

function viewEntry(e: DataStoreEntry) {
  const { id, state, revisionId, createTime, revisionCreateTime, etag, value, users, attributes } = e;
  return { id, state, revisionId, createTime, revisionCreateTime, etag, value, users, attributes };
}

export class CloudTools {
  constructor(private deps: CloudToolsDeps) {}

  private cloud(): OpenCloud {
    if (!this.deps.cloud) throw new Error("This tool needs ROBLOX_PUBLISH_API_KEY in this server's environment.");
    return this.deps.cloud;
  }

  /** True only for a real press of the confirm button in a connected Studio. */
  private async confirm(universeId: number, title: string, body: string, confirmLabel: string, nothingDone: string) {
    const sessions = await this.deps.rolink.editSessions();
    if (sessions.length === 0) throw new Error("Refused: Roblox Studio is not connected through RoLink, so the confirmation dialog cannot be shown.");
    const own = sessions.find((s) => s.gameId === universeId);
    const place = own ? (own.placeId ? String(own.placeId) : own.placeName) : await this.deps.rolink.currentPlace();
    let answer;
    try {
      answer = await this.deps.rolink.call("confirm_dialog", { title, text: body, confirmLabel, timeout: DIALOG_SECONDS, place }, (DIALOG_SECONDS + 30) * 1000);
    } catch (e: any) {
      throw new Error(`Refused: the Studio confirmation dialog could not be shown (${this.deps.redactor.text(String(e?.message ?? e))}).`);
    }
    if (answer?.confirmed !== true) throw new Error(`Not confirmed: the dialog in Studio was declined, closed or timed out${answer?.reason ? ` (${answer.reason})` : ""}. ${nothingDone}`);
  }

  async assetQuota(args: { userId?: number; assetType?: string; quotaType?: string }) {
    const cloud = this.cloud();
    if (args.userId !== undefined) positive("userId", args.userId);
    const userId = args.userId !== undefined ? String(args.userId) : this.deps.config.creator?.userId;
    if (!userId) throw new Error("Roblox documents asset quotas per user only. Pass userId, or set ROBLOX_CREATOR_USER_ID.");
    for (const key of ["assetType", "quotaType"] as const) {
      if (args[key] !== undefined && !NAME_RE.test(args[key]!)) throw new Error(`${key} must be a plain name such as Audio or RateLimitUpload.`);
    }
    const filter = [args.quotaType && `quotaType == ${args.quotaType}`, args.assetType && `assetType == ${args.assetType}`].filter(Boolean).join(" && ");
    const quotas = (await cloud.assetQuotas(userId, filter || undefined)).map((q: AssetQuota) => {
      const usage = Number(q.usage);
      const capacity = Number(q.capacity);
      return { quotaType: q.quotaType, assetType: q.assetType, usage: q.usage, capacity: q.capacity, remaining: Number.isFinite(usage) && Number.isFinite(capacity) ? capacity - usage : undefined, period: q.period };
    });
    return { userId, quotas, note: "Numbers come straight from Roblox for this account at this moment." };
  }

  async serverRestart(args: { universeId: number }) {
    const universeId = positive("universeId", args.universeId);
    const cloud = this.cloud();
    await this.confirm(
      universeId,
      "Restart live servers?",
      [
        `Servers of experience ${universeId} that run an older version of a place will be restarted.`,
        "Players on those servers are disconnected from them.",
        "Игроки на этих серверах будут отключены от них.",
      ].join("\n\n"),
      "Restart servers",
      "No servers were restarted.",
    );
    const response = await cloud.restartServers(universeId);
    this.deps.log("servers restarted", universeId);
    return { restarted: true, universeId, response, note: "Only servers on an older place version are restarted; a server already on the latest version keeps running." };
  }

  async datastoreList(args: { universeId: number; store?: string; scope?: string; prefix?: string; limit?: number; pageToken?: string }) {
    const universeId = positive("universeId", args.universeId);
    const cloud = this.cloud();
    if (args.prefix !== undefined && /["\\]/.test(args.prefix)) throw new Error("prefix cannot contain quotes or backslashes.");
    const o = { prefix: args.prefix, pageToken: args.pageToken, pageSize: args.limit };
    if (!args.store) {
      const r = await cloud.listDataStores(universeId, o);
      return { universeId, dataStores: r.dataStores ?? [], nextPageToken: r.nextPageToken || undefined };
    }
    const r = await cloud.listEntries({ universeId, store: args.store, scope: args.scope }, o);
    return { universeId, store: args.store, scope: args.scope, entries: r.dataStoreEntries ?? [], nextPageToken: r.nextPageToken || undefined };
  }

  private address(args: EntryArgs): EntryAddress {
    return { universeId: positive("universeId", args.universeId), store: text("store", args.store), key: text("key", args.key), scope: args.scope };
  }

  /** The entry, or undefined when it is absent or soft-deleted. */
  private async current(cloud: OpenCloud, a: EntryAddress): Promise<DataStoreEntry | undefined> {
    try {
      const e = await cloud.getEntry(a);
      return e.state === "DELETED" ? undefined : e;
    } catch (e) {
      if (e instanceof CloudError && e.status === 404) return undefined;
      throw e;
    }
  }

  private where(a: EntryAddress) {
    return `Experience ${a.universeId}, data store ${JSON.stringify(a.store)}${a.scope ? `, scope ${JSON.stringify(a.scope)}` : ""}, key ${JSON.stringify(a.key)}.`;
  }

  private notFound(a: EntryAddress) {
    return new Error(`No entry found for key ${JSON.stringify(a.key)} in data store ${JSON.stringify(a.store)}${a.scope ? ` (scope ${JSON.stringify(a.scope)})` : ""}.`);
  }

  /** "name@revision" addresses a revision, and writes through it would create a junk key. */
  private refuseRevision(a: EntryAddress) {
    if (a.key.includes("@")) throw new Error(`Refused: a key containing "@" addresses a revision (${JSON.stringify(a.key)}); writes must use the plain key.`);
  }

  private assertUnchanged(before: DataStoreEntry | undefined, after: DataStoreEntry | undefined, a: EntryAddress) {
    if (before?.revisionId !== after?.revisionId) throw new Error(`Refused: ${JSON.stringify(a.key)} changed while the dialog was open. Nothing was written; read it again and retry.`);
  }

  async datastoreGet(args: EntryArgs) {
    const a = this.address(args);
    const e = await this.current(this.cloud(), a);
    if (!e) throw this.notFound(a);
    return { universeId: a.universeId, store: a.store, scope: a.scope, ...viewEntry(e) };
  }

  async datastoreSet(args: SetArgs) {
    const a = this.address(args);
    this.refuseRevision(a);
    if (args.value === undefined || args.value === null) throw new Error("value is required: Open Cloud has no partial update.");
    const users = args.users?.map(userPath);
    const cloud = this.cloud();

    const before = await this.current(cloud, a);
    if (!before && !args.create) throw new Error(`${this.notFound(a).message} Pass create:true to create it.`);

    const preserved: string[] = [];
    const entry: Pick<DataStoreEntry, "value" | "users" | "attributes"> = { value: args.value };
    for (const [field, given] of [["users", users], ["attributes", args.attributes]] as const) {
      const kept = before?.[field];
      const v = given ?? kept;
      if (v !== undefined) (entry as any)[field] = v;
      if (given === undefined && kept !== undefined) preserved.push(field);
    }

    await this.confirm(
      a.universeId,
      "Change live player data?",
      [
        this.where(a),
        before ? `Current value: ${preview(before.value)}` : "This is a new entry: the key does not exist yet.",
        `New value: ${preview(args.value)}`,
        "Это изменит данные в живом хранилище игры.",
      ].join("\n\n"),
      "Write value",
      "Nothing was written.",
    );

    this.assertUnchanged(before, await this.current(cloud, a), a);
    const saved = await cloud.updateEntry(a, entry, !before);
    this.deps.log("datastore write", a.universeId, a.store);
    return { updated: true, universeId: a.universeId, store: a.store, scope: a.scope, key: a.key, created: !before, revisionId: saved.revisionId, preserved };
  }

  async datastoreDelete(args: EntryArgs) {
    const a = this.address(args);
    this.refuseRevision(a);
    const cloud = this.cloud();
    const before = await this.current(cloud, a);
    if (!before) throw this.notFound(a);

    await this.confirm(
      a.universeId,
      "Delete live player data?",
      [
        this.where(a),
        `Current value: ${preview(before.value)}`,
        "Roblox purges a deleted entry after 30 days.",
        "Это удалит запись из живого хранилища игры.",
      ].join("\n\n"),
      "Delete entry",
      "Nothing was deleted.",
    );

    this.assertUnchanged(before, await this.current(cloud, a), a);
    await cloud.deleteEntry(a);
    this.deps.log("datastore delete", a.universeId, a.store);
    return { deleted: true, universeId: a.universeId, store: a.store, scope: a.scope, key: a.key, note: "Soft-deleted: Roblox removes it permanently after 30 days." };
  }
}
