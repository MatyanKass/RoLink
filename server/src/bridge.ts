// HTTP bridge between this process and the RoLink Studio plugin.
//
// The plugin cannot accept connections, so it long-polls us:
//   POST /plugin/hello   -> registers a session (one per Studio DataModel: edit / play-server / play-client)
//   GET  /plugin/poll    -> held open until commands are queued (or POLL_HOLD_MS passes)
//   POST /plugin/result  -> answer to a command (may arrive in several chunks)
//   POST /plugin/event   -> unsolicited events (script edited in Studio, etc.)
// Other RoLink processes (a second Claude session) talk to us through POST /rpc.

import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { COMMAND_TIMEOUT_MS, HOST, POLL_HOLD_MS, PORT, SESSION_TTL_MS, VERSION, log } from "./config.js";

export type Context = "edit" | "server" | "client";

export interface SessionInfo {
  id: string;
  context: Context;
  placeName: string;
  placeId: number;
  gameId: number;
  pluginVersion: string;
  connectedAt: number;
  lastSeen: number;
  /** a later session for a place that was already live: receives no commands */
  duplicate?: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  op: string;
  chunks?: string[];
}

interface Session extends SessionInfo {
  queue: { id: string; op: string; args: unknown }[];
  waiter?: { res: http.ServerResponse; timer: NodeJS.Timeout };
  pending: Map<string, Pending>;
  /** id of the live session for this place that it arrived behind */
  duplicateOf?: string;
  /** the same for every session of one plugin connection, across reconnects */
  lineage: string;
  /** large events still being received, by event id */
  eventChunks: Map<string, { parts: string[]; got: number; bytes: number }>;
}

export class PluginError extends Error {}

/** One Studio's edit session across reconnects. Opaque to callers; see Bridge.bind. */
export interface SessionBinding {
  lineage: string;
  placeId: number;
  placeName: string;
}

/** Where the port owner stores the /rpc token (user-only file in the user's temp dir). */
export function tokenFile(port = PORT) {
  return path.join(os.tmpdir(), `rolink-${port}.token`);
}

export function readToken(port = PORT): string | undefined {
  try {
    return fs.readFileSync(tokenFile(port), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function sameToken(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A page that rebinds its own domain to 127.0.0.1 still sends that domain in Host. */
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

/** A session this quiet with no poll open is no reason to hold back a new one for its place. */
const LIVE_WINDOW_MS = POLL_HOLD_MS + 5_000;

const MAX_CHUNKS = 1000;
const MAX_RESULT_BYTES = 256 * 1024 * 1024;
const MAX_OPEN_EVENTS = 16;
/** lineages of closed sessions, so a reconnect that arrives after the drop still follows its `replaces` */
const MAX_RETIRED = 1024;

type RpcHandler = (tool: string, args: unknown) => Promise<unknown>;
type ApiProvider = () => Promise<unknown>;

export class Bridge extends EventEmitter {
  private sessions = new Map<string, Session>();
  private retired = new Map<string, string>();
  private server?: http.Server;
  rpcHandler?: RpcHandler;
  /** required in the x-rolink-token header of POST /rpc */
  readonly token = randomBytes(32).toString("hex");
  apiProvider?: ApiProvider;

  /** Try to own the port. Returns false if another process already does. */
  async listen(): Promise<boolean> {
    const server = http.createServer((req, res) => {
      this.route(req, res).catch((e) => {
        log("http error", e);
        sendJson(res, 500, { error: String(e?.message ?? e) });
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE") resolve(false);
        else {
          log("listen error", e);
          resolve(false);
        }
      });
      server.listen(PORT, HOST, () => resolve(true));
    });
    if (!ok) return false;
    this.server = server;
    try {
      const f = tokenFile();
      fs.rmSync(f, { force: true });
      fs.writeFileSync(f, this.token, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (e) {
      log("could not write rpc token file", e);
    }
    setInterval(() => this.reap(), 5_000).unref();
    log(`bridge listening on http://${HOST}:${PORT}`);
    return true;
  }

  get isListening() {
    return !!this.server;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map(publicInfo);
  }

  /**
   * Choose the session a command goes to. Defaults to the most recently
   * connected edit-mode Studio. `place` matches by place name substring.
   * A duplicate of a live session is never chosen: /plugin/hello has no
   * credential, so being newest must not be enough to receive commands.
   */
  pick(context: Context = "edit", place?: string): SessionInfo {
    let candidates = [...this.sessions.values()].filter((s) => s.context === context && !s.duplicateOf);
    if (place) {
      const p = place.toLowerCase();
      candidates = candidates.filter((s) => s.placeName.toLowerCase().includes(p) || String(s.placeId) === place);
    }
    candidates.sort((a, b) => b.connectedAt - a.connectedAt);
    const s = candidates[0];
    if (!s) {
      const all = this.list();
      if (all.length === 0) {
        throw new PluginError(
          "Roblox Studio is not connected. Open a place in Studio and make sure the RoLink plugin is enabled (toolbar: RoLink → Connect).",
        );
      }
      throw new PluginError(
        `No ${context} session${place ? ` for place "${place}"` : ""}. Connected: ` +
          all.map((x) => `${x.placeName} [${x.context}]`).join(", "),
      );
    }
    return publicInfo(s);
  }

  /** Ties long-lived work (a mirror, a sync) to this Studio, so it is never re-chosen by name. */
  bind(sessionId: string): SessionBinding {
    const s = this.sessions.get(sessionId);
    if (!s) throw new PluginError("Studio session disconnected");
    return { lineage: s.lineage, placeId: s.placeId, placeName: s.placeName };
  }

  private bound(b: SessionBinding): Session | undefined {
    return [...this.sessions.values()].find((s) => s.context === "edit" && !s.duplicateOf && s.lineage === b.lineage && s.placeId === b.placeId);
  }

  /** The bound Studio's current session: exact place id and the same line of reconnects. */
  resolve(b: SessionBinding): SessionInfo {
    const s = this.bound(b);
    if (!s) throw new PluginError(`The Studio session for "${b.placeName}" (place ${b.placeId}) is no longer connected. If it was closed, stop and start this again on the open Studio.`);
    return publicInfo(s);
  }

  isBound(b: SessionBinding, sessionId: string): boolean {
    return this.bound(b)?.id === sessionId;
  }

  send(sessionId: string, op: string, args: unknown, timeoutMs = COMMAND_TIMEOUT_MS): Promise<any> {
    const s = this.sessions.get(sessionId);
    if (!s) return Promise.reject(new PluginError("Studio session disconnected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(id);
        reject(new PluginError(`Studio did not answer "${op}" within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      s.pending.set(id, { resolve, reject, timer, op });
      s.queue.push({ id, op, args });
      this.flush(s);
    });
  }

  // ---------------------------------------------------------------- internals

  private flush(s: Session) {
    if (!s.waiter || s.queue.length === 0) return;
    const { res, timer } = s.waiter;
    s.waiter = undefined;
    clearTimeout(timer);
    sendJson(res, 200, { commands: s.queue.splice(0) });
  }

  private reap() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (now - s.lastSeen > SESSION_TTL_MS && !s.waiter) this.drop(s, "timed out");
    }
  }

  private drop(s: Session, why: string, promote = true) {
    this.sessions.delete(s.id);
    this.retired.set(s.id, s.lineage);
    if (this.retired.size > MAX_RETIRED) this.retired.delete(this.retired.keys().next().value!);
    for (const p of s.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new PluginError(`Studio session closed (${why}) while running "${p.op}"`));
    }
    if (s.waiter) {
      clearTimeout(s.waiter.timer);
      sendJson(s.waiter.res, 410, { error: "session closed" });
    }
    log(`session ${s.placeName} [${s.context}] ${why}`);
    this.emit("session-closed", publicInfo(s));
    if (promote) this.promoteDuplicates(s);
  }

  /** The first to arrive stays first; the others wait behind it. */
  private promoteDuplicates(gone: Session) {
    const waiting = [...this.sessions.values()].filter((d) => d.duplicateOf === gone.id).sort((a, b) => a.connectedAt - b.connectedAt);
    const [next, ...rest] = waiting;
    if (!next) return;
    next.duplicateOf = undefined;
    for (const d of rest) d.duplicateOf = next.id;
    log(`session ${next.placeName} [${next.context}] takes over from the one that closed`);
    this.emit("session", publicInfo(next));
  }

  private liveSessionFor(placeId: number): Session | undefined {
    if (placeId <= 0) return undefined; // every unsaved place has id 0: they are different places
    const now = Date.now();
    return [...this.sessions.values()].find((s) => s.context === "edit" && s.placeId === placeId && !s.duplicateOf && (s.waiter || now - s.lastSeen <= LIVE_WINDOW_MS));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!ALLOWED_HOSTS.has((req.headers.host ?? "").toLowerCase())) return sendJson(res, 403, { error: "forbidden" });

    // Browsers always send Origin on cross-site requests; Studio's HttpService and
    // Node's fetch do not. Refusing Origin blocks drive-by requests from web pages.
    if (req.headers.origin) return sendJson(res, 403, { error: "forbidden" });

    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const route = `${req.method} ${url.pathname}`;

    switch (route) {
      case "GET /health":
        // no session ids here: they are the plugin routes' only credential
        return sendJson(res, 200, {
          rolink: true,
          version: VERSION,
          sessions: this.list().map(({ id: _id, ...rest }) => rest),
        });

      case "POST /plugin/hello": {
        const b = (await readJson(req)) as Partial<SessionInfo> & { replaces?: string };
        // the same plugin coming back: whatever waited behind the old session waits behind the new one
        const replaced = b.replaces ? this.sessions.get(b.replaces) : undefined;
        if (replaced) this.drop(replaced, "reconnected", false);
        // session ids are never published, so naming one proves this is the same plugin coming back
        const inherited = typeof b.replaces === "string" ? this.retired.get(b.replaces) : undefined;
        if (inherited) this.retired.delete(b.replaces!);
        const now = Date.now();
        const s: Session = {
          id: randomUUID(),
          context: (b.context as Context) ?? "edit",
          placeName: String(b.placeName ?? "Place"),
          placeId: Number(b.placeId ?? 0),
          gameId: Number(b.gameId ?? 0),
          pluginVersion: String(b.pluginVersion ?? "?"),
          connectedAt: now,
          lastSeen: now,
          queue: [],
          pending: new Map(),
          lineage: inherited ?? randomUUID(),
          eventChunks: new Map(),
        };
        if (s.context === "edit") s.duplicateOf = this.liveSessionFor(s.placeId)?.id;
        this.sessions.set(s.id, s);
        if (replaced) {
          for (const d of this.sessions.values()) if (d.duplicateOf === replaced.id) d.duplicateOf = s.duplicateOf ?? s.id;
        }
        log(`session ${s.placeName} [${s.context}] connected${s.duplicateOf ? " as a duplicate of a live session" : ""}`);
        if (!s.duplicateOf) this.emit("session", publicInfo(s));
        return sendJson(res, 200, { session: s.id, serverVersion: VERSION });
      }

      case "GET /plugin/poll": {
        const s = this.sessions.get(url.searchParams.get("s") ?? "");
        if (!s) return sendJson(res, 410, { error: "unknown session" });
        s.lastSeen = Date.now();
        if (s.waiter) {
          clearTimeout(s.waiter.timer);
          sendJson(s.waiter.res, 200, { commands: [] });
          s.waiter = undefined;
        }
        if (s.queue.length > 0) return sendJson(res, 200, { commands: s.queue.splice(0) });
        const timer = setTimeout(() => {
          if (s.waiter?.res === res) s.waiter = undefined;
          s.lastSeen = Date.now();
          sendJson(res, 200, { commands: [] });
        }, POLL_HOLD_MS);
        s.waiter = { res, timer };
        res.on("close", () => {
          if (s.waiter?.res === res) {
            clearTimeout(timer);
            s.waiter = undefined;
            s.lastSeen = Date.now();
          }
        });
        return;
      }

      case "POST /plugin/result": {
        const b = (await readJson(req)) as {
          s: string;
          id: string;
          ok?: boolean;
          result?: unknown;
          error?: string;
          chunk?: number;
          chunks?: number;
          data?: string;
        };
        const s = this.sessions.get(b.s);
        if (!s) return sendJson(res, 410, { error: "unknown session" });
        s.lastSeen = Date.now();
        const p = s.pending.get(b.id);
        if (!p) return sendJson(res, 200, { ok: true, late: true });

        const fail = (why: string) => {
          s.pending.delete(b.id);
          clearTimeout(p.timer);
          p.reject(new PluginError(`bad result for "${p.op}": ${why}`));
          return sendJson(res, 400, { error: why });
        };
        let msg = b;
        if (b.chunks !== undefined) {
          const chunks = b.chunks;
          const chunk = b.chunk ?? 0;
          if (!Number.isInteger(chunks) || !Number.isInteger(chunk) || chunks < 1 || chunks > MAX_CHUNKS || chunk < 0 || chunk >= chunks) {
            return fail(`invalid chunk ${chunk}/${chunks}`);
          }
          if (typeof b.data !== "string") return fail("chunk without data");
          let text: string;
          if (chunks > 1) {
            // Big results arrive as several string pieces of one JSON document.
            p.chunks ??= [];
            p.chunks[chunk] = b.data;
            const total = p.chunks.reduce((n, x) => n + (x?.length ?? 0), 0);
            if (total > MAX_RESULT_BYTES) return fail("result too large");
            let got = 0;
            for (let i = 0; i < chunks; i++) if (p.chunks[i] !== undefined) got++;
            if (got < chunks) return sendJson(res, 200, { ok: true });
            text = p.chunks.slice(0, chunks).join("");
          } else {
            text = b.data;
          }
          try {
            msg = JSON.parse(text);
          } catch (e: any) {
            return fail(`result is not valid JSON (${e?.message ?? e})`);
          }
          if (!msg || typeof msg !== "object") return fail("result is not an object");
        }

        s.pending.delete(b.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new PluginError(msg.error ?? "plugin error"));
        return sendJson(res, 200, { ok: true });
      }

      case "POST /plugin/event": {
        let b = (await readJson(req)) as { s: string; type: string; [k: string]: unknown };
        const s = this.sessions.get(b.s);
        if (!s) return sendJson(res, 410, { error: "unknown session" });
        s.lastSeen = Date.now();
        if (b.type === "chunk") {
          const r = addEventChunk(s, b);
          if (r.error) return sendJson(res, 400, { error: r.error });
          if (r.event === undefined) return sendJson(res, 200, { ok: true });
          b = { ...r.event, s: b.s };
        }
        if (!s.duplicateOf) this.emit("plugin-event", publicInfo(s), b);
        return sendJson(res, 200, { ok: true });
      }

      case "POST /plugin/bye": {
        const b = (await readJson(req)) as { s: string };
        const s = this.sessions.get(b.s);
        if (s) this.drop(s, "disconnected");
        return sendJson(res, 200, { ok: true });
      }

      case "GET /plugin/api": {
        if (!this.apiProvider) return sendJson(res, 404, { error: "no api" });
        return sendJson(res, 200, await this.apiProvider());
      }

      case "POST /rpc": {
        if (!this.rpcHandler) return sendJson(res, 404, { error: "no rpc" });
        const tok = req.headers["x-rolink-token"];
        if (typeof tok !== "string" || !sameToken(tok, this.token)) return sendJson(res, 401, { error: "bad token" });
        const b = (await readJson(req)) as { tool: string; args: unknown };
        try {
          const result = await this.rpcHandler(b.tool, b.args);
          return sendJson(res, 200, { ok: true, result });
        } catch (e: any) {
          return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) });
        }
      }
    }
    sendJson(res, 404, { error: `no route ${route}` });
  }
}

/** Events too big for one request arrive as string pieces of one JSON document, like results. */
function addEventChunk(s: Session, b: Record<string, unknown>): { error?: string; event?: { type: string; [k: string]: unknown } } {
  const { id, chunk, chunks, data } = b;
  if (typeof id !== "string" || !Number.isInteger(chunks) || !Number.isInteger(chunk) || (chunks as number) < 1 || (chunks as number) > MAX_CHUNKS || (chunk as number) < 0 || (chunk as number) >= (chunks as number)) {
    return { error: "invalid event chunk" };
  }
  if (typeof data !== "string") return { error: "event chunk without data" };
  let open = s.eventChunks.get(id);
  if (!open) {
    open = { parts: [], got: 0, bytes: 0 };
    s.eventChunks.set(id, open);
    if (s.eventChunks.size > MAX_OPEN_EVENTS) s.eventChunks.delete(s.eventChunks.keys().next().value!);
  }
  const i = chunk as number;
  if (open.parts[i] === undefined) open.got++;
  open.bytes += data.length - (open.parts[i]?.length ?? 0);
  open.parts[i] = data;
  if (open.bytes > MAX_RESULT_BYTES) {
    s.eventChunks.delete(id);
    return { error: "event too large" };
  }
  if (open.got < (chunks as number)) return {};
  s.eventChunks.delete(id);
  let event: unknown;
  try {
    event = JSON.parse(open.parts.slice(0, chunks as number).join(""));
  } catch (e: any) {
    return { error: `event is not valid JSON (${e?.message ?? e})` };
  }
  if (!event || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") return { error: "event is not an object with a type" };
  return { event: event as { type: string } };
}

function publicInfo(s: Session | SessionInfo): SessionInfo {
  const { id, context, placeName, placeId, gameId, pluginVersion, connectedAt, lastSeen } = s;
  // a flag, not the other session's id: ids are the plugin routes' only credential
  const duplicate = "duplicateOf" in s && s.duplicateOf ? { duplicate: true } : {};
  return { id, context, placeName, placeId, gameId, pluginVersion, connectedAt, lastSeen, ...duplicate };
}

const MAX_BODY = 64 * 1024 * 1024; // results and large events are chunked at ~700 KB; import_model sends only paths

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(parts).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error("bad json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}
