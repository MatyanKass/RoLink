// HTTP bridge between this process and the RoLink Studio plugin.
//
// The plugin cannot accept connections, so it long-polls us:
//   POST /plugin/hello   -> registers a session (one per Studio DataModel: edit / play-server / play-client)
//   GET  /plugin/poll    -> held open until commands are queued (or POLL_HOLD_MS passes)
//   POST /plugin/result  -> answer to a command (may arrive in several chunks)
//   POST /plugin/event   -> unsolicited events (script edited in Studio, etc.)
// Other RoLink processes (a second Claude session) talk to us through POST /rpc.

import http from "node:http";
import { randomUUID } from "node:crypto";
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
}

export class PluginError extends Error {}

type RpcHandler = (tool: string, args: unknown) => Promise<unknown>;
type ApiProvider = () => Promise<unknown>;

export class Bridge extends EventEmitter {
  private sessions = new Map<string, Session>();
  private server?: http.Server;
  rpcHandler?: RpcHandler;
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
   */
  pick(context: Context = "edit", place?: string): SessionInfo {
    let candidates = [...this.sessions.values()].filter((s) => s.context === context);
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

  private drop(s: Session, why: string) {
    this.sessions.delete(s.id);
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
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse) {
    // Browsers always send Origin on cross-site requests; Studio's HttpService and
    // Node's fetch do not. Refusing Origin blocks drive-by requests from web pages.
    if (req.headers.origin) return sendJson(res, 403, { error: "forbidden" });

    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const route = `${req.method} ${url.pathname}`;

    switch (route) {
      case "GET /health":
        return sendJson(res, 200, { rolink: true, version: VERSION, sessions: this.list() });

      case "POST /plugin/hello": {
        const b = (await readJson(req)) as Partial<SessionInfo> & { replaces?: string };
        if (b.replaces) {
          const old = this.sessions.get(b.replaces);
          if (old) this.drop(old, "reconnected");
        }
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
        };
        this.sessions.set(s.id, s);
        log(`session ${s.placeName} [${s.context}] connected`);
        this.emit("session", publicInfo(s));
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

        let msg = b;
        if (b.chunks && b.chunks > 1) {
          // Big results arrive as several string pieces of one JSON document.
          p.chunks ??= [];
          p.chunks[b.chunk ?? 0] = b.data ?? "";
          const got = p.chunks.filter((x) => x !== undefined).length;
          if (got < b.chunks) return sendJson(res, 200, { ok: true });
          msg = JSON.parse(p.chunks.join(""));
        } else if (b.chunks === 1 && typeof b.data === "string") {
          msg = JSON.parse(b.data);
        }

        s.pending.delete(b.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new PluginError(msg.error ?? "plugin error"));
        return sendJson(res, 200, { ok: true });
      }

      case "POST /plugin/event": {
        const b = (await readJson(req)) as { s: string; type: string; [k: string]: unknown };
        const s = this.sessions.get(b.s);
        if (!s) return sendJson(res, 410, { error: "unknown session" });
        s.lastSeen = Date.now();
        this.emit("plugin-event", publicInfo(s), b);
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

function publicInfo(s: Session | SessionInfo): SessionInfo {
  const { id, context, placeName, placeId, gameId, pluginVersion, connectedAt, lastSeen } = s;
  return { id, context, placeName, placeId, gameId, pluginVersion, connectedAt, lastSeen };
}

const MAX_BODY = 256 * 1024 * 1024;

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
