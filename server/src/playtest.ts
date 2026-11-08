// Play-test tools: start/stop/observe a normal Studio test and drive it by
// script. The plugin in the edit DataModel owns start and is the authority on
// whether a test runs (StudioTestService.EditModeActive); only the play-test's
// server DataModel can end it.

import { PluginError, type Bridge, type Context, type SessionInfo } from "./bridge.js";
import { POLL_HOLD_MS } from "./config.js";

type Args = Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STATUS_TIMEOUT_MS = 3_000;
const START_ANSWER_MS = 8_000;
const STOP_WAIT_MS = 20_000;
/** after the server context is up, how long we keep waiting for the client */
const CLIENT_GRACE_MS = 10_000;
/** a live session polls at least this often */
const LIVE_WINDOW_MS = POLL_HOLD_MS + 5_000;

const askToPress = (key: string) => `Ask the user to press ${key} in Studio`;
const PRESS: Record<string, string> = { run: "Run (F8)", multiplayer: "Start under the Test tab's Clients and Servers" };
const ASK_PLAY = (mode: string) => `${askToPress(PRESS[mode] ?? "Play (F5)")}, then call playtest_status until running is true.`;
/** Each extra client window takes Studio noticeably longer to bring up. */
const GRACE_PER_EXTRA_CLIENT_MS = 5_000;

export interface PlaytestStatus {
  running: boolean;
  mode?: string;
  contexts: { edit: boolean; server: boolean; client: boolean };
  clients?: number;
  players?: string[];
  lastResult?: unknown;
  lastError?: string;
  note?: string;
}

export class Playtests {
  constructor(private readonly bridge: Bridge) {}

  private live(context: Context, place?: string): SessionInfo[] {
    const now = Date.now();
    let list = this.bridge.list().filter((s) => s.context === context && now - s.lastSeen <= LIVE_WINDOW_MS);
    if (place) {
      const p = place.toLowerCase();
      list = list.filter((s) => s.placeName.toLowerCase().includes(p) || String(s.placeId) === place);
    }
    return list.sort((a, b) => b.connectedAt - a.connectedAt);
  }

  private editSession(place?: string): SessionInfo | undefined {
    try {
      return this.bridge.pick("edit", place);
    } catch {
      return undefined;
    }
  }

  private async ask(session: SessionInfo | undefined, op: string, timeoutMs = STATUS_TIMEOUT_MS): Promise<any> {
    if (!session) return undefined;
    return this.bridge.send(session.id, op, {}, timeoutMs).catch(() => undefined);
  }

  async status(args: Args): Promise<PlaytestStatus> {
    const edit = this.editSession(args.place);
    const e = await this.ask(edit, "playtest_status");
    const server = this.live("server", args.place)[0];
    const client = this.live("client", args.place)[0];
    // the edit DataModel knows for sure; session lists alone can lag behind a dead test
    const running = e ? e.running === true || e.editModeActive === false : !!(server || client);
    const out: PlaytestStatus = {
      running,
      contexts: { edit: !!edit, server: running && !!server, client: running && !!client },
    };
    if (e?.lastResult !== undefined && e?.lastResult !== null) out.lastResult = e.lastResult;
    if (e?.lastError) out.lastError = e.lastError;
    if (running) {
      const s = await this.ask(server, "playtest_status");
      out.clients = this.live("client", args.place).length;
      // only the edit DataModel knows it asked for multiplayer; the server just sees players
      out.mode = e?.mode === "multiplayer" ? e.mode : (s?.mode ?? e?.mode);
      if (s?.players) out.players = s.players;
      if (!server) out.note = "A test is running but the plugin has not connected from it yet; call playtest_status again in a moment.";
    } else {
      out.note = edit
        ? "No play-test is running. Start one with playtest_start, or ask the user to press Play (F5) / Run (F8) in Studio."
        : "Roblox Studio is not connected.";
    }
    return out;
  }

  async start(args: Args): Promise<Args> {
    const mode: string = args.mode;
    if (mode !== "play" && mode !== "run" && mode !== "multiplayer") throw new Error('mode must be "play" or "run"');
    const edit = this.bridge.pick("edit", args.place);
    const expected = mode === "multiplayer" ? Number(args.clients) : mode === "play" ? 1 : 0;
    const timeoutMs = Math.min(Math.max(1, Number(args.timeout ?? (mode === "multiplayer" ? 120 : 60))), 300) * 1000;
    const clientGrace = CLIENT_GRACE_MS + Math.max(0, expected - 1) * GRACE_PER_EXTRA_CLIENT_MS;
    const t0 = Date.now();

    // the plugin refuses when a test already runs; a lost answer is not a
    // refusal, so keep waiting for the contexts in that case
    const payload = mode === "multiplayer" ? { mode, clients: expected } : { mode };
    await this.bridge.send(edit.id, "playtest_start", payload, START_ANSWER_MS).catch((e: any) => {
      if (!/did not answer/.test(String(e?.message))) throw e;
    });

    const deadline = t0 + timeoutMs;
    let serverAt = 0;
    let lastPoll = 0;
    let server: SessionInfo | undefined;
    let clients: SessionInfo[] = [];
    while (Date.now() < deadline) {
      server = this.live("server", args.place).find((s) => s.connectedAt >= t0);
      clients = this.live("client", args.place).filter((s) => s.connectedAt >= t0);
      if (server && clients.length >= expected) break;
      if (server) {
        serverAt ||= Date.now();
        if (Date.now() - serverAt > clientGrace) break;
      } else if (Date.now() - lastPoll >= 1000) {
        lastPoll = Date.now();
        const st = await this.ask(edit, "playtest_status", 2_000);
        if (st?.lastError) throw new PluginError(`The play-test could not start: ${st.lastError}. ${ASK_PLAY(mode)}`);
      }
      await sleep(100);
    }
    if (!server) {
      throw new PluginError(
        `The play-test did not connect within ${Math.round(timeoutMs / 1000)}s: the RoLink plugin must be enabled for play-test DataModels. If Studio shows no test running, ${ASK_PLAY(mode)}`,
      );
    }
    const out: Args = { started: true, mode, contexts: { edit: true, server: !!server, client: clients.length > 0 } };
    if (mode === "multiplayer") out.clients = clients.length;
    if (mode === "play" && clients.length === 0) out.note = "The client context has not connected; scenarios and output_read can still use the server context.";
    if (mode === "multiplayer" && clients.length < expected) out.note = `Only ${clients.length} of ${expected} clients have connected so far; call playtest_status to see the rest join.`;
    return out;
  }

  async multiplayer(args: Args): Promise<Args> {
    const clients = args.clients;
    if (!Number.isInteger(clients) || clients < 1 || clients > 8) throw new Error("clients must be a whole number from 1 to 8.");
    return this.start({ ...args, mode: "multiplayer" });
  }

  async profile(args: Args): Promise<Args> {
    const context: Context = args.context ?? "server";
    if (context === "edit") throw new PluginError('Script profiling works inside a play-test: use context "server" or "client".');
    const duration = Math.min(Math.max(0.01, Number(args.duration ?? 5)), 60);
    const s = await this.runningSession(context, args.place, args.client);
    return this.bridge.send(s.id, "profile_scripts", { ...pick(args, ["frequency", "top"]), duration }, (duration + 30) * 1000);
  }

  async stop(args: Args): Promise<Args> {
    const st = await this.status(args);
    if (!st.running) return { stopped: false, running: false, note: "No play-test is running." };

    const server = this.live("server", args.place)[0];
    const edit = this.editSession(args.place);
    // playtest_end is answered right away (it skips the plugin's queue), so a silent server context is a dead one
    const requested = (await this.ask(server, "playtest_end")) ?? (await this.ask(edit, "playtest_request_stop"));
    if (!requested) throw new PluginError("Could not reach the play-test to end it. Ask the user to press Stop (Shift+F5) in Studio.");

    const deadline = Date.now() + STOP_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(300);
      if (!(await this.status(args)).running) return { stopped: true, running: false };
    }
    throw new PluginError("The stop request was sent but the test is still running. Ask the user to press Stop (Shift+F5) in Studio.");
  }

  /** A session of a test that is really running, or an actionable error. */
  private async runningSession(context: Context, place?: string, client?: number): Promise<SessionInfo> {
    const st = await this.status({ place });
    if (!st.running) throw new PluginError("No play-test is running. Call playtest_start first (or ask the user to press Play in Studio).");
    if (context === "client" && client !== undefined) {
      const joined = this.live("client", place).sort((a, b) => a.connectedAt - b.connectedAt);
      const chosen = joined[client - 1];
      if (!chosen) throw new PluginError(`There is no client ${client}: ${joined.length} client(s) are connected.`);
      return chosen;
    }
    const s = this.live(context, place)[0];
    if (!s) {
      throw new PluginError(
        `No ${context} context is connected for this play-test.${context === "client" ? ' A test in mode "run" has no client; use mode "play".' : " Call playtest_status again in a moment."}`,
      );
    }
    return s;
  }

  async scenario(args: Args): Promise<Args> {
    const context: Context = args.context ?? "server";
    if (context === "edit") throw new PluginError('playtest_scenario runs inside a play-test: use context "server" or "client" (use run for edit-mode Luau).');
    if (typeof args.source !== "string") throw new Error("source (Luau code) is required");
    const timeout = Math.min(Math.max(1, Number(args.timeout ?? 60)), 600);
    const s = await this.runningSession(context, args.place, args.client);
    // the plugin enforces `timeout` itself; we wait a bit longer for its report
    try {
      return await this.bridge.send(s.id, "playtest_scenario", { source: args.source, args: args.args, timeout }, (timeout + 15) * 1000);
    } catch (e: any) {
      if (/session closed|disconnected/.test(String(e?.message))) throw new PluginError(`The play-test ended while the scenario was running (${e.message}). Check output_read and start a new test.`);
      throw e;
    }
  }

  async outputRead(args: Args): Promise<Args> {
    let context: Context | undefined = args.context;
    if (!context) {
      const st = await this.status(args);
      context = st.contexts.server ? "server" : "edit";
    }
    const s = context === "edit" ? this.bridge.pick("edit", args.place) : await this.runningSession(context, args.place, args.client);
    const r = await this.bridge.send(s.id, "output_read", pick(args, ["since", "level", "limit", "contains"]), 15_000);
    return { context, ...r };
  }
}

function pick(a: Args, keys: string[]) {
  const o: Args = {};
  for (const k of keys) if (a[k] !== undefined) o[k] = a[k];
  return o;
}
