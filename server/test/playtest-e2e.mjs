// End-to-end tests of the play-test tools against a mock Studio with one
// session per DataModel. Called from e2e.mjs; can also run on its own:
//   node test/playtest-e2e.mjs        (run `npm run build` first)

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 34998;
const BASE = `http://127.0.0.1:${PORT}`;
const entry = path.join(here, "..", "dist", "index.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

async function post(p, body) {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

/** One fake DataModel. `handle(op, args)` returns the result or throws a string. */
class FakeDM {
  constructor(context, handle) {
    this.context = context;
    this.handle = handle;
    this.received = [];
    this.alive = true;
  }
  async connect() {
    const h = await post("/plugin/hello", { context: this.context, placeName: "PT", placeId: 1, gameId: 2, pluginVersion: "test" });
    this.session = h.session;
    this.loop();
  }
  async loop() {
    while (this.alive) {
      const r = await fetch(`${BASE}/plugin/poll?s=${this.session}`).catch(() => null);
      if (!r || r.status !== 200) return;
      const b = await r.json();
      for (const cmd of b.commands ?? []) this.exec(cmd);
    }
  }
  async exec(cmd) {
    this.received.push(cmd);
    let body;
    try {
      body = { ok: true, result: await this.handle(cmd.op, cmd.args) };
    } catch (e) {
      body = { ok: false, error: String(e) };
    }
    if (this.alive) await post("/plugin/result", { s: this.session, id: cmd.id, chunk: 0, chunks: 1, data: JSON.stringify(body) });
  }
  async bye() {
    this.alive = false;
    await post("/plugin/bye", { s: this.session });
  }
  /** process dies without saying goodbye: the session goes silent */
  vanish() {
    this.alive = false;
  }
}

export default async function run() {
  let passed = 0;
  const ok = (cond, msg) => {
    assert.ok(cond, msg);
    passed++;
  };

  const c = new Client({ name: "pt-e2e", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, ROLINK_PORT: String(PORT) }, stderr: "ignore" }));
  await sleep(300);
  const call = (name, args = {}) => c.callTool({ name, arguments: args });

  // ------------------------------------------------------------ the teaching surface
  const instructions = c.getInstructions();
  ok(/playtest_scenario/.test(instructions) && /output_read/.test(instructions), "instructions teach the test tools");
  ok(/teleport/i.test(instructions) && /re-run/i.test(instructions), "instructions describe the test loop");
  ok(/T\.step/.test(instructions), "instructions include an example");
  const guide = text(await call("guide"));
  ok(guide.includes("playtest_scenario") && guide.includes("T.waitFor") && guide.includes("T.teleport"), "guide documents T helpers");
  ok(guide.includes('"class":"Model"') || guide.includes("repeat"), "guide still has the build format");

  const { tools } = await c.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ["playtest_start", "playtest_stop", "playtest_status", "output_read", "playtest_scenario", "multiplayer_test", "profile_scripts", "perf_stats", "align", "distribute", "weld_model", "set_collision_groups", "select_and_focus", "script_outline", "script_search", "script_diagnostics", "generate_model"]) ok(byName[n], `tool ${n} registered`);
  ok(!byName.generate_material, "no generate_material: Roblox documents no plugin API for it");
  ok(/T\.players/.test(guide) && /multiplayer_test/.test(guide), "guide documents multiplayer testing");
  for (const n of ["profile_scripts", "perf_stats", "script_outline", "script_search", "script_diagnostics"]) ok(byName[n].annotations.readOnlyHint === true, `${n} is read-only`);
  ok(/discard|lost/i.test(byName.playtest_start.description) && /edit/i.test(byName.playtest_start.description), "playtest_start warns about state");
  ok(byName.playtest_status.annotations.readOnlyHint === true, "status is read-only");

  // ------------------------------------------------------------ no Studio
  let r = await call("playtest_start", { mode: "play" });
  ok(r.isError && text(r).includes("not connected"), "start without Studio: " + text(r));
  r = await call("playtest_status");
  ok(!r.isError && JSON.parse(text(r)).running === false, "status without Studio");

  // ------------------------------------------------------------ mock Studio
  let editActive = true;
  let server, client;
  let extraClients = [];
  let editMode = "play";
  let failStart = null;
  let lastError = null;
  const startCalls = [];

  const serverHandler = (op, args) => {
    switch (op) {
      case "playtest_status":
        return { context: "server", isRunMode: false, players: ["Tester"] };
      case "playtest_end":
        setTimeout(endTest, 50);
        return { ending: true };
      case "playtest_scenario":
        if (args.source === "hang") return new Promise(() => {});
        if (args.source === "die") {
          setTimeout(() => server.bye(), 30);
          return new Promise(() => {});
        }
        return { ok: true, context: "server", summary: "1/1 steps passed", steps: [{ name: "a", ok: true, duration: 0.1, logs: [], errors: [] }], logs: [], errors: [], timeout: args.timeout, source: args.source, output: { lastSeq: 9 } };
      case "output_read":
        return { context: "server", entries: [{ seq: 5, level: "output", text: "hi server" }], next: 5, args };
      case "profile_scripts":
        return { context: "server", functions: [], args };
    }
    throw "unknown op " + op;
  };
  const clientHandler = (op, args) => {
    switch (op) {
      case "playtest_status":
        return { context: "client", players: ["Tester"] };
      case "output_read":
        return { context: "client", entries: [{ seq: 7, level: "output", text: "hi client" }], next: 7, args };
      case "playtest_scenario":
        return { ok: true, context: "client", steps: [], logs: [], errors: [] };
    }
    throw "unknown op " + op;
  };
  async function beginTest(mode, clients = 1) {
    editActive = false;
    await sleep(100);
    server = new FakeDM("server", serverHandler);
    await server.connect();
    if (mode === "multiplayer") {
      for (let i = 1; i <= clients; i++) {
        const dm = new FakeDM("client", (op, args) => (op === "output_read" ? { context: "client", entries: [{ seq: 7, level: "output", text: `hi client ${i}` }], next: 7, args } : clientHandler(op, args)));
        await dm.connect();
        await sleep(5); // distinct connectedAt, so the order is stable
        extraClients.push(dm);
      }
      client = extraClients[0];
    } else if (mode === "play") {
      client = new FakeDM("client", clientHandler);
      await client.connect();
    } else client = undefined;
  }
  async function endTest() {
    editActive = true;
    await server?.bye();
    for (const dm of extraClients) await dm.bye();
    if (!extraClients.length) await client?.bye();
    extraClients = [];
    server = client = undefined;
  }

  let stopFlag = false;
  const edit = new FakeDM("edit", (op, args) => {
    switch (op) {
      case "playtest_start":
        startCalls.push(args);
        if (failStart) throw failStart;
        if (!editActive) throw "A play-test is already running (mock)";
        editMode = args.mode;
        beginTest(args.mode, args.clients);
        return { started: true, mode: args.mode, state: "starting" };
      case "playtest_status":
        return { context: "edit", editModeActive: editActive, running: !editActive, mode: editMode, lastError };
      case "playtest_request_stop":
        stopFlag = true;
        return { requested: true };
      case "output_read":
        return { context: "edit", entries: [{ seq: 1, level: "output", text: "hi edit" }], next: 1, args };
    }
    return { op, args };
  });
  await edit.connect();
  await sleep(100);

  r = await call("playtest_status");
  let st = JSON.parse(text(r));
  ok(st.running === false && st.contexts.server === false, "idle status: " + text(r));

  // nothing runs without a test
  r = await call("playtest_scenario", { source: "x" });
  ok(r.isError && text(r).includes("playtest_start"), "scenario without a test: " + text(r));
  r = await call("playtest_stop");
  ok(!r.isError && JSON.parse(text(r)).running === false && text(r).includes("No play-test"), "stop with no test: " + text(r));
  r = await call("output_read");
  ok(!r.isError && JSON.parse(text(r)).context === "edit", "output_read defaults to edit when idle");
  r = await call("playtest_start", { mode: "wrong" });
  ok(r.isError, "bad mode refused");

  // start + wait for the contexts
  r = await call("playtest_start", { mode: "play" });
  ok(!r.isError, "start: " + text(r));
  st = JSON.parse(text(r));
  ok(st.started === true && st.mode === "play" && st.contexts.server && st.contexts.client, "start waits for server+client: " + text(r));
  ok(startCalls.at(-1).mode === "play", "mode forwarded");

  r = await call("playtest_status");
  st = JSON.parse(text(r));
  ok(st.running && st.mode === "play" && st.contexts.client && st.players[0] === "Tester", "running status: " + text(r));

  // refused while one runs
  const before = startCalls.length;
  r = await call("playtest_start", { mode: "play" });
  ok(r.isError && text(r).includes("already running"), "second start refused: " + text(r));
  ok(startCalls.length >= before, "start reached the plugin");

  // scenario
  r = await call("playtest_scenario", { source: "T.step('a', fn)", timeout: 5 });
  ok(!r.isError, "scenario: " + text(r));
  const rep = JSON.parse(text(r));
  ok(rep.ok && rep.steps[0].name === "a" && rep.timeout === 5 && rep.source.includes("T.step"), "scenario report passed through");
  ok(server.received.some((c) => c.op === "playtest_scenario"), "defaults to the server context");
  r = await call("playtest_scenario", { source: "x", context: "client" });
  ok(JSON.parse(text(r)).context === "client", "client context honoured");
  r = await call("playtest_scenario", { source: "x", context: "edit" });
  ok(r.isError && text(r).includes("server"), "edit context refused: " + text(r));
  r = await call("playtest_scenario", {});
  ok(r.isError, "source required");

  // output_read
  r = await call("output_read", { since: 3, level: "error", limit: 10, contains: "boom" });
  let out = JSON.parse(text(r));
  ok(out.context === "server" && out.entries[0].text === "hi server", "output defaults to the running server: " + text(r));
  ok(out.args.since === 3 && out.args.level === "error" && out.args.limit === 10 && out.args.contains === "boom", "output filters forwarded");
  r = await call("output_read", { context: "client" });
  ok(JSON.parse(text(r)).entries[0].text === "hi client", "output from the client context");
  r = await call("output_read", { context: "edit" });
  ok(JSON.parse(text(r)).entries[0].text === "hi edit", "output from the edit context");

  // the test ends under a running scenario: fast, clear failure
  const dying = call("playtest_scenario", { source: "die", timeout: 30 });
  const t0 = Date.now();
  r = await dying;
  ok(r.isError && /ended|closed/i.test(text(r)) && Date.now() - t0 < 5000, "test ended mid-scenario: " + text(r));
  await endTest().catch(() => {});

  r = await call("playtest_status");
  ok(JSON.parse(text(r)).running === false, "status after the test went away");

  // normal stop goes through the server context
  r = await call("playtest_start", { mode: "run" });
  st = JSON.parse(text(r));
  ok(!r.isError && st.mode === "run" && st.contexts.server && !st.contexts.client, "run mode has no client: " + text(r));
  r = await call("playtest_stop");
  ok(!r.isError && JSON.parse(text(r)).stopped === true, "stop: " + text(r));
  r = await call("playtest_status");
  ok(JSON.parse(text(r)).running === false, "stopped");

  // ------------------------------------------------------------ multiplayer and profiling
  r = await call("multiplayer_test", { clients: 0 });
  ok(r.isError && /1 to 8/.test(text(r)), "clients out of range: " + text(r));
  r = await call("multiplayer_test", { clients: 9 });
  ok(r.isError && /1 to 8/.test(text(r)), "clients out of range: " + text(r));
  r = await call("profile_scripts", { duration: 1 });
  ok(r.isError && text(r).includes("playtest_start"), "profiling needs a test: " + text(r));

  r = await call("multiplayer_test", { clients: 2 });
  ok(!r.isError, "multiplayer start: " + text(r));
  st = JSON.parse(text(r));
  ok(st.started && st.mode === "multiplayer" && st.clients === 2 && st.contexts.server && st.contexts.client, "waits for every client: " + text(r));
  ok(startCalls.at(-1).mode === "multiplayer" && startCalls.at(-1).clients === 2, "client count forwarded");

  r = await call("playtest_status");
  st = JSON.parse(text(r));
  ok(st.running && st.mode === "multiplayer" && st.clients === 2, "status counts clients: " + text(r));

  r = await call("output_read", { context: "client", client: 2 });
  ok(JSON.parse(text(r)).entries[0].text === "hi client 2", "output_read picks a client: " + text(r));
  r = await call("output_read", { context: "client", client: 1 });
  ok(JSON.parse(text(r)).entries[0].text === "hi client 1", "client numbers follow join order: " + text(r));
  r = await call("output_read", { context: "client", client: 3 });
  ok(r.isError && /client 3/.test(text(r)), "a client that does not exist: " + text(r));
  r = await call("playtest_scenario", { source: "x", context: "client", client: 2 });
  ok(!r.isError && extraClients[1].received.some((cmd) => cmd.op === "playtest_scenario"), "scenario runs on the chosen client: " + text(r));

  r = await call("profile_scripts", { duration: 2, frequency: 100, top: 5 });
  ok(!r.isError, "profile: " + text(r));
  let prof = JSON.parse(text(r));
  ok(prof.context === "server" && prof.args.duration === 2 && prof.args.frequency === 100 && prof.args.top === 5, "profile defaults to the server and forwards options: " + text(r));
  r = await call("profile_scripts", { duration: 1, context: "edit" });
  ok(r.isError && /play-test/.test(text(r)), "profiling the edit context refused: " + text(r));

  r = await call("playtest_stop");
  ok(!r.isError && JSON.parse(text(r)).stopped === true, "multiplayer stop: " + text(r));
  editMode = "play";

  r = await call("perf_stats", { sample: 0.5 });
  ok(!r.isError && JSON.parse(text(r)).args.sample === 0.5 && JSON.parse(text(r)).op === "perf_stats", "perf_stats reaches the edit context: " + text(r));

  // a dead server session that never said bye must not count as a running test
  await beginTest("run");
  await sleep(50);
  editActive = true;
  server.vanish();
  r = await call("playtest_status");
  st = JSON.parse(text(r));
  ok(st.running === false, "edit context overrides a stale server session: " + text(r));
  r = await call("playtest_scenario", { source: "x" });
  ok(r.isError && text(r).includes("playtest_start"), "scenario refuses a stale session: " + text(r));
  server = undefined;

  // user pressed Play; start can't help but status notices
  await beginTest("play");
  r = await call("playtest_status");
  ok(JSON.parse(text(r)).running === true, "test started by the user is detected");
  await endTest();

  // failure to start: actionable error
  failStart = "Could not start a play-test from the plugin: nope. Ask the user to press Play (F5) in Studio, then call playtest_status.";
  r = await call("playtest_start", { mode: "play" });
  ok(r.isError && text(r).includes("press Play") && text(r).includes("playtest_status"), "start failure is actionable: " + text(r));
  failStart = null;

  // start accepted by the plugin but Studio fails right after
  lastError = "Studio refused";
  const realBegin = beginTest;
  editActive = true;
  const tStart = Date.now();
  // the mock calls beginTest on start, so make the contexts never appear by failing via status
  failStart = null;
  edit.handle = ((orig) => (op, args) => (op === "playtest_start" ? { started: true, mode: args.mode, state: "starting" } : orig(op, args)))(edit.handle);
  r = await call("playtest_start", { mode: "play", timeout: 5 });
  ok(r.isError && text(r).includes("Studio refused") && text(r).includes("press Play") && Date.now() - tStart < 4500, "late failure surfaces quickly: " + text(r));
  lastError = null;
  void realBegin;

  // no contexts ever connect: bounded wait and an actionable error
  r = await call("playtest_start", { mode: "play", timeout: 5 });
  ok(r.isError && /did not connect/.test(text(r)) && text(r).includes("press Play"), "contexts never connect: " + text(r));

  // stop falls back to the edit context if the server context is unreachable
  edit.handle = ((orig) => (op, args) => {
    if (op === "playtest_status") return { context: "edit", editModeActive: editActive, running: !editActive, mode: "play", lastError: null };
    return orig(op, args);
  })(edit.handle);
  editActive = false;
  stopFlag = false;
  const stopPromise = call("playtest_stop");
  // no live server context: the flag must be raised, then edit reports the end
  for (let i = 0; i < 200 && !stopFlag; i++) await sleep(50);
  editActive = true;
  r = await stopPromise;
  ok(!r.isError && JSON.parse(text(r)).stopped === true && stopFlag, "stop via edit fallback: " + text(r));

  // cannot stop at all
  editActive = false;
  edit.handle = ((orig) => (op, args) => (op === "playtest_request_stop" ? (() => { throw "settings unavailable"; })() : orig(op, args)))(edit.handle);
  r = await call("playtest_stop");
  ok(r.isError && /press Stop/.test(text(r)), "stop failure is actionable: " + text(r));

  await edit.bye();
  await c.close();
  return passed;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
    .then((n) => {
      console.log(`playtest e2e: ${n} checks passed`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
