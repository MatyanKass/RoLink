// Audited failures: session binding, chunked events, API dump, crash guards, tooling.
// Build first: `npm run build`. Nothing here needs Studio or the network.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PORT = 40000 + (process.pid % 9000);
process.env.ROLINK_PORT = String(PORT);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

const { Bridge } = await import("../dist/bridge.js");
const { Core } = await import("../dist/core.js");
const { SyncSession } = await import("../dist/sync.js");
const apidump = await import("../dist/apidump.js");

const bridge = new Bridge();
assert.equal(await bridge.listen(), true);
test.after(() => {
  bridge.server?.close();
  bridge.server?.closeAllConnections();
});

const BASE = `http://127.0.0.1:${PORT}`;
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const postJson = async (p, body) => (await post(p, body)).json();
let placeSeq = 1000;
const hello = (placeName, placeId, extra = {}) => postJson("/plugin/hello", { context: "edit", placeName, placeId, gameId: 2, pluginVersion: "t", ...extra }).then((b) => b.session);
const bye = (s) => post("/plugin/bye", { s });

test("hello cleans the place name and plugin version before an agent can read them", async () => {
  const id = ++placeSeq;
  const s = await postJson("/plugin/hello", { context: "edit", placeName: "Line\n• Fake [edit]​" + "x".repeat(500), placeId: id, gameId: 2, pluginVersion: "v\r\n2" });
  const health = await (await fetch(BASE + "/health")).json();
  const info = health.sessions.find((x) => x.placeId === id);
  assert.ok(info.placeName.startsWith("Line • Fake [edit]"));
  assert.ok(!/[\n\r​]/.test(info.placeName));
  assert.ok(info.placeName.length <= 101);
  assert.equal(info.pluginVersion, "v 2");
  await bye(s.session);
});

// ---------------------------------------------------------------- session binding

test("a binding keeps its own place when a newer place has a similar name", async () => {
  const id = ++placeSeq;
  const a = await hello("Game", id);
  const b = await hello("Game Test", ++placeSeq);
  const binding = bridge.bind(a);
  assert.equal(bridge.resolve(binding).id, a);
  assert.equal(bridge.isBound(binding, a), true);
  assert.equal(bridge.isBound(binding, b), false);
  await bye(a);
  await bye(b);
});

test("a binding follows a live reconnect through replaces", async () => {
  const id = ++placeSeq;
  const a = await hello("Reconn", id);
  const binding = bridge.bind(a);
  const a2 = await hello("Reconn", id, { replaces: a });
  assert.notEqual(a2, a);
  assert.equal(bridge.resolve(binding).id, a2);
  const a3 = await hello("Reconn", id, { replaces: a2 });
  assert.equal(bridge.resolve(binding).id, a3);
  assert.equal(bridge.isBound(binding, a3), true);
  await bye(a3);
});

test("a binding follows replaces even when the old session was already dropped", async () => {
  const id = ++placeSeq;
  const a = await hello("Dropped", id);
  const binding = bridge.bind(a);
  await bye(a);
  assert.throws(() => bridge.resolve(binding), /no longer connected/);
  const a2 = await hello("Dropped", id, { replaces: a });
  assert.equal(bridge.resolve(binding).id, a2);
  await bye(a2);
});

test("the same place opened by another Studio is not the bound session", async () => {
  const id = ++placeSeq;
  const a = await hello("Same", id);
  const binding = bridge.bind(a);
  await bye(a);
  const other = await hello("Same", id);
  assert.throws(() => bridge.resolve(binding), /no longer connected/);
  assert.equal(bridge.isBound(binding, other), false);
  await bye(other);
});

test("a reconnect that changes placeId does not satisfy the binding", async () => {
  const a = await hello("Moved", ++placeSeq);
  const binding = bridge.bind(a);
  const a2 = await hello("Moved", ++placeSeq, { replaces: a });
  assert.throws(() => bridge.resolve(binding), /no longer connected/);
  assert.equal(bridge.isBound(binding, a2), false);
  await bye(a2);
});

test("a session id cannot be read back from the binding's lineage over /health", async () => {
  const a = await hello("Quiet", ++placeSeq);
  const h = await (await fetch(`${BASE}/health`)).text();
  assert.ok(!h.includes(a));
  assert.ok(!h.includes("lineage"));
  await bye(a);
});

function fakePlugin(session) {
  const ops = [];
  let stop = false;
  const done = (async () => {
    while (!stop) {
      const r = await fetch(`${BASE}/plugin/poll?s=${session}`);
      if (r.status !== 200) return;
      const { commands } = await r.json();
      for (const c of commands) {
        ops.push(c);
        let result = {};
        if (c.op === "mirror" && c.args.action === "start") result = { services: c.args.services, others: [] };
        if (c.op === "mirror" && c.args.action === "next") result = { nodes: [{ i: 1, p: 0, c: "Workspace", n: "Workspace", props: {} }], done: true };
        await postJson("/plugin/result", { s: session, id: c.id, ok: true, result });
      }
    }
  })();
  return { ops, end: async () => { stop = true; await bye(session); await done; } };
}

const mirrorDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rolink-bind-")), "m");

test("mirror commands and deltas stay with the Studio it started on", async () => {
  const core = new Core(bridge, async () => ({ version: 1, classes: {} }));
  const a = fakePlugin(await hello("Game", ++placeSeq));
  const dir = mirrorDir();
  const r = await core.call("mirror_start", { dir, services: ["Workspace"], place: "Game" });
  assert.ok(JSON.parse(r.text).dir);
  const sessionB = await hello("Game Test", ++placeSeq);
  const b = fakePlugin(sessionB);
  await new Promise((res) => setTimeout(res, 700));
  assert.equal(b.ops.filter((o) => o.op === "mirror").length, 0, "no resync of the other Studio");
  await post("/plugin/event", { s: sessionB, type: "mirror_delta", upserts: [{ i: 50, p: 1, c: "Part", n: "Foreign", props: {} }] });
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(JSON.parse((await core.call("mirror_status", {})).text).instances, 1, "another Studio's delta is ignored");
  await core.call("mirror_stop", {});
  assert.equal(b.ops.filter((o) => o.op === "mirror").length, 0, "stop did not go to the newer place");
  assert.ok(a.ops.some((o) => o.op === "mirror" && o.args.action === "stop"), "stop reached the bound Studio");
  await a.end();
  await b.end();
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, what) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await pause(20);
  }
  assert.fail(`timed out: ${what}`);
}

test("mirror edits made while the bound Studio is gone are kept, reported on every tool result, and applied when it is back (field report)", async () => {
  const core = new Core(bridge, async () => ({ version: 1, classes: {} }));
  const id = ++placeSeq;
  const sid = await hello("Place1", id);
  const a = fakePlugin(sid);
  const dir = mirrorDir();
  await core.call("mirror_start", { dir, services: ["Workspace"], place: "Place1" });
  await a.end(); // Studio drops off the bridge
  const props = path.join(dir, "Workspace", "_props.json");
  fs.writeFileSync(props, '{"Gravity":10}');
  await waitUntil(() => core.mirror.status().unappliedCount > 0, "the edit is held");
  await pause(200);
  assert.equal(fs.readFileSync(props, "utf8"), '{"Gravity":10}', "the agent's edit is not overwritten");
  const r = await core.call("status", {});
  assert.match(r.text, /WARNING \(mirror\): .*NOT in Studio.*_props\.json/);
  assert.match(r.text, /not connected/);
  assert.match(r.text, /Studio did not take your file edits/, "the one-time alert");
  const again = await core.call("status", {});
  assert.match(again.text, /NOT in Studio/, "the standing warning repeats while the edit waits");
  assert.doesNotMatch(again.text, /did not take/, "the alert is given once");
  assert.match(JSON.parse((await core.call("mirror_status", {})).text.split("\n\n")[0]).studio.note, /not connected/);

  // the same Studio comes back under a new name (an unsaved place), as the plugin reconnects
  const sid2 = await hello("Place2", id, { replaces: sid });
  const b = fakePlugin(sid2);
  await waitUntil(() => core.mirror.status().unappliedCount === 0, "the held edit is applied after the reconnect");
  const apply = b.ops.find((o) => o.op === "mirror_apply");
  assert.ok(apply && JSON.stringify(apply.args).includes("Gravity"), JSON.stringify(b.ops.map((o) => o.op)));
  const after = await core.call("status", {});
  assert.doesNotMatch(after.text, /NOT in Studio/);
  assert.match(after.text, /reached Studio/);
  assert.match(after.text, /now named "Place2"/);
  const stop = await core.call("mirror_stop", {});
  assert.doesNotMatch(stop.text, /NOT applied/);
  await b.end();
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("a session busy with a long scenario is not dropped for not polling (field report: Studio session closed (timed out))", async () => {
  const sid = await postJson("/plugin/hello", { context: "client", placeName: "Slow", placeId: ++placeSeq, gameId: 2, pluginVersion: "t" }).then((b) => b.session);
  // Studio takes the command, then (slow, unfocused) does not poll again for longer than the TTL
  const running = bridge.send(sid, "playtest_scenario", { source: "" }, 120_000);
  const first = await (await fetch(`${BASE}/plugin/poll?s=${sid}`)).json();
  const cmd = first.commands.find((c) => c.op === "playtest_scenario");
  assert.ok(cmd);
  const s = bridge.sessions.get(sid);
  s.lastSeen -= 10 * 60_000;
  bridge.reap();
  assert.ok(bridge.sessions.has(sid), "kept while its command runs");
  assert.equal(bridge.list().find((x) => x.id === sid).busy, true);
  await postJson("/plugin/result", { s: sid, id: cmd.id, ok: true, result: { ok: true, summary: "1/1" } });
  assert.deepEqual(await running, { ok: true, summary: "1/1" });
  // idle and silent: dropped as before
  s.lastSeen -= 10 * 60_000;
  bridge.reap();
  assert.ok(!bridge.sessions.has(sid), "an idle silent session still times out");
});

test("mirror_stop names the edits that never reached Studio", async () => {
  const core = new Core(bridge, async () => ({ version: 1, classes: {} }));
  const sid = await hello("Gone", ++placeSeq);
  const a = fakePlugin(sid);
  const dir = mirrorDir();
  await core.call("mirror_start", { dir, services: ["Workspace"], place: "Gone" });
  await a.end();
  fs.writeFileSync(path.join(dir, "Workspace", "_props.json"), '{"Gravity":11}');
  await waitUntil(() => core.mirror.status().unappliedCount > 0, "held");
  const stop = await core.call("mirror_stop", {});
  assert.match(stop.text, /NOT applied to Studio.*Workspace\/_props\.json/);
  assert.equal(fs.readFileSync(path.join(dir, "Workspace", "_props.json"), "utf8"), '{"Gravity":11}');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("import: the cframe argument wins over the placement saved in a JSON file", async () => {
  const core = new Core(bridge, async () => ({ version: 1, classes: {} }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-import-"));
  const place = `Imp${++placeSeq}`;
  const a = fakePlugin(await hello(place, placeSeq));
  const wanted = { p: [9, 9, 9] };
  const cases = [
    { class: "Part", name: "P", cf: { p: [1, 1, 1] }, children: [{ class: "Attachment", name: "A" }] },
    { class: "Part", name: "Q", cf: { p: [1, 1, 1] } },
    { class: "Model", name: "M", origin: { p: [2, 2, 2] }, children: [] },
    { name: "R", at: [3, 3, 3], rot: [0, 90, 0], size: [1, 1, 1] },
  ];
  try {
    for (const [i, node] of cases.entries()) {
      const file = path.join(dir, `${i}.json`);
      fs.writeFileSync(file, JSON.stringify(node));
      await core.call("import", { file, cframe: wanted, place });
      const item = a.ops.filter((o) => o.op === "build").at(-1).args.items[0];
      const used = item.cf ?? item.origin;
      assert.deepEqual(used, wanted, node.name);
      assert.ok(!(item.cf && item.origin), `${node.name}: only one placement left`);
      assert.equal(item.at, undefined, node.name);
      assert.equal(item.rot, undefined, node.name);
    }
    const file = path.join(dir, "kept.json");
    fs.writeFileSync(file, JSON.stringify(cases[0]));
    await core.call("import", { file, place });
    assert.deepEqual(a.ops.filter((o) => o.op === "build").at(-1).args.items[0].cf, cases[0].cf, "without the argument the file decides");
  } finally {
    await a.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("set: a null property value is sent as a reference clear", async () => {
  const core = new Core(bridge, async () => ({ version: 1, classes: {} }));
  const place = `Clear${++placeSeq}`;
  const a = fakePlugin(await hello(place, placeSeq));
  try {
    await core.call("set", { place, path: "Workspace/W", props: { Part0: null, Transparency: 1 } });
    await core.call("set", { place, edits: [{ path: "Workspace/X", props: { Adornee: null } }] });
    const sets = a.ops.filter((o) => o.op === "set");
    assert.deepEqual(sets[0].args.props, { Part0: { ref: false }, Transparency: 1 });
    assert.deepEqual(sets[1].args.edits[0].props, { Adornee: { ref: false } });
  } finally {
    await a.end();
  }
});

// ---------------------------------------------------------------- API dump

test("mirror_start is refused with a clear message when the API dump is unavailable", async () => {
  const core = new Core(bridge, async () => {
    throw new Error("offline");
  });
  const a = fakePlugin(await hello("NoApi", ++placeSeq));
  const dir = mirrorDir();
  await assert.rejects(core.call("mirror_start", { dir, services: ["Workspace"], place: "NoApi" }), /API dump.*offline/s);
  assert.equal(fs.existsSync(dir), false, "no empty mirror was written");
  assert.equal(a.ops.length, 0);
  await a.end();
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

const DUMP = JSON.stringify({ Classes: [{ Name: "X", Superclass: "<<<ROOT>>>", Members: [] }] });
const tmpDump = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rolink-dump-")), "cache", "API-Dump.json");

test("the dump download is retried", async () => {
  const file = tmpDump();
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    if (calls < 3) throw new Error("reset");
    return { ok: true, status: 200, text: async () => DUMP };
  };
  const raw = await apidump.readDump({ file, fetchFn, retryDelayMs: 1 });
  assert.equal(calls, 3);
  assert.equal(raw.Classes[0].Name, "X");
  assert.ok(fs.existsSync(file), "cached");
});

test("no cache and no download fails clearly after the retries", async () => {
  const file = tmpDump();
  let calls = 0;
  await assert.rejects(
    apidump.readDump({
      file,
      retryDelayMs: 1,
      fetchFn: async () => {
        calls++;
        return { ok: false, status: 503, text: async () => "" };
      },
    }),
    /API dump.*503/s,
  );
  assert.equal(calls, 3);
  assert.equal(fs.existsSync(file), false);
});

test("a stale cache is used when the download fails", async () => {
  const file = tmpDump();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, DUMP);
  fs.utimesSync(file, new Date(0), new Date(0));
  const raw = await apidump.readDump({ file, retryDelayMs: 1, fetchFn: async () => { throw new Error("down"); } });
  assert.equal(raw.Classes[0].Name, "X");
});

// ---------------------------------------------------------------- chunked events

test("a chunked plugin event is delivered once, whole", async () => {
  const s = await hello("Chunky", ++placeSeq);
  const seen = [];
  const on = (info, ev) => seen.push(ev);
  bridge.on("plugin-event", on);
  const body = JSON.stringify({ s, type: "mirror_delta", upserts: [{ i: 1, n: "ж".repeat(10) }] });
  const mid = 12;
  const a = await post("/plugin/event", { s, type: "chunk", id: "e1", chunk: 0, chunks: 2, data: body.slice(0, mid) });
  assert.equal(a.status, 200);
  assert.equal(seen.length, 0, "nothing until complete");
  await post("/plugin/event", { s, type: "chunk", id: "e1", chunk: 1, chunks: 2, data: body.slice(mid) });
  bridge.off("plugin-event", on);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "mirror_delta");
  assert.equal(seen[0].upserts[0].n, "ж".repeat(10));
  await bye(s);
});

test("malformed event chunks are refused", async () => {
  const s = await hello("BadChunk", ++placeSeq);
  for (const bad of [{ chunk: 5, chunks: 2, data: "x" }, { chunk: 0, chunks: 0, data: "x" }, { chunk: 0, chunks: 2 }, { chunk: 0, chunks: 1e9, data: "x" }]) {
    const r = await post("/plugin/event", { s, type: "chunk", id: "e2", ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await post("/plugin/event", { s, type: "chunk", id: "e3", chunk: 0, chunks: 1, data: "{not json" })).status, 400);
  await bye(s);
});

// ---------------------------------------------------------------- watcher and process guards

test("a sync watcher error is logged, not thrown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-sync-"));
  const session = new SyncSession({ watchedPaths: async () => [dir] }, async () => ({}), "P");
  session.fullSync = async () => ({});
  await session.start();
  try {
    session.watcher.emit("error", new Error("watch failed"));
  } finally {
    await session.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runGuard(body) {
  const guard = pathToFileURL(path.join(here, "..", "dist", "guard.js")).href;
  const code = `const { installProcessGuards } = await import(${JSON.stringify(guard)});\n${body}`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20_000 });
}

test("after startup a stray rejection or exception is logged and the process continues", () => {
  const r = runGuard(`
    const g = installProcessGuards((...a) => console.error(...a));
    g.ready();
    Promise.reject(new Error("stray rejection"));
    setTimeout(() => { throw new Error("stray exception"); }, 5);
    setTimeout(() => { console.log("alive"); process.exit(0); }, 80);
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /alive/);
  assert.match(r.stderr, /stray rejection/);
  assert.match(r.stderr, /stray exception/);
});

test("before startup finishes an uncaught error is fatal", () => {
  const r = runGuard(`
    installProcessGuards((...a) => console.error(...a));
    setTimeout(() => { throw new Error("broken at startup"); }, 5);
    setTimeout(() => { console.log("alive"); process.exit(0); }, 200);
  `);
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stdout, /alive/);
  assert.match(r.stderr, /broken at startup/);
});

test("before startup finishes an unhandled rejection is fatal", () => {
  const r = runGuard(`
    installProcessGuards((...a) => console.error(...a));
    Promise.reject(new Error("rejected at startup"));
    setTimeout(() => { console.log("alive"); process.exit(0); }, 200);
  `);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /rejected at startup/);
});

// ---------------------------------------------------------------- tools and repo

test("tools/live.mjs sends the token from the token file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-live-"));
  const port = PORT + 1;
  fs.writeFileSync(path.join(dir, `rolink-${port}.token`), "tok-123\n");
  let header;
  const srv = http.createServer((req, res) => {
    header = req.headers["x-rolink-token"];
    res.end(JSON.stringify({ ok: true, result: { text: "pong" } }));
  });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  const child = spawn(process.execPath, [path.join(repo, "tools", "live.mjs"), "status", "{}"], { env: { ...process.env, ROLINK_PORT: String(port), TEMP: dir, TMP: dir, TMPDIR: dir } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("close", r));
  await new Promise((r) => srv.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0);
  assert.equal(header, "tok-123");
  assert.match(out, /pong/);
});

test("reports use neutral wording", () => {
  for (const f of ["toolbox.ts", "index.ts"]) assert.doesNotMatch(fs.readFileSync(path.join(here, "..", "src", f), "utf8"), /suspicious/i, f);
});

test(".gitignore covers .claude and every .env but .env.example", () => {
  const ignored = (p) => spawnSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: repo }).status === 0;
  assert.equal(ignored(".claude/worktrees/x"), true);
  assert.equal(ignored(".env"), true);
  assert.equal(ignored(".env.local"), true);
  assert.equal(ignored(".env.example"), false);
  assert.equal(ignored("publisher/.env.example"), false);
});

// ---------------------------------------------------------------- audit/server

test("a command that timed out before Studio polled it is not delivered later", async () => {
  const s = await hello("Late", ++placeSeq);
  await assert.rejects(bridge.send(s, "slow_op", {}, 50), /did not answer "slow_op"/);
  const second = bridge.send(s, "after", {}, 5_000);
  const r = await (await fetch(`${BASE}/plugin/poll?s=${s}`)).json();
  assert.deepEqual(r.commands.map((c) => c.op), ["after"], "the abandoned command is gone from the queue");
  await postJson("/plugin/result", { s, id: r.commands[0].id, ok: true, result: 1 });
  assert.equal(await second, 1);
  await bye(s);
});

test("a multi-step import stays on the Studio it started on when a newer one connects", async () => {
  const { RIGS } = await import("../dist/animation.js");
  const { Document, NodeIO } = await import("@gltf-transform/core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-pin-"));
  const doc = new Document();
  const buf = doc.createBuffer();
  const node = doc.createNode("LeftUpperArm");
  doc.createScene("S").addChild(node);
  const input = doc.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buf);
  const output = doc.createAccessor().setType("VEC4").setArray(new Float32Array([0, 0, 0, 1, 0.7071, 0, 0, 0.7071])).setBuffer(buf);
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output);
  doc.createAnimation("Wave").addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath("rotation").setSampler(sampler));
  const file = path.join(dir, "wave.glb");
  await new NodeIO().write(file, doc);

  const core = new Core(bridge, async () => ({ version: 1, classes: {} }));
  const place = `Pin${++placeSeq}`;
  const a = await hello(place, placeSeq);
  let b;
  const opsA = [];
  let stop = false;
  const loopA = (async () => {
    while (!stop) {
      const r = await fetch(`${BASE}/plugin/poll?s=${a}`);
      if (r.status !== 200) return;
      for (const c of (await r.json()).commands) {
        opsA.push(c.op);
        let result = {};
        if (c.op === "animation_rig_info") {
          // a second Studio with a similar name connects while the import runs
          b ??= await hello(`${place} copy`, ++placeSeq);
          result = { ...RIGS.R15 };
        }
        if (c.op === "animation_build") result = { created: { path: "ServerStorage/Wave" } };
        await postJson("/plugin/result", { s: a, id: c.id, ok: true, result });
      }
    }
  })();
  try {
    const r = await core.call("import_animation", { path: file, rig: "Workspace/Rig", place });
    assert.match(r.text, /ServerStorage\/Wave/);
    assert.deepEqual(opsA.filter((o) => o !== "animation_stage"), ["animation_rig_info", "animation_build"]);
    assert.ok(opsA.includes("animation_stage"), "chunks went to the same Studio");
  } finally {
    stop = true;
    await bye(a);
    if (b) await bye(b);
    await loopA;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function syncProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-syncfix-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "default.project.json"), JSON.stringify({ name: "P", tree: { $className: "DataModel", ReplicatedStorage: { Shared: { $path: "src" } } } }));
  fs.writeFileSync(path.join(dir, "src", "Data.json"), '{"a":1}\n');
  fs.writeFileSync(path.join(dir, "src", "Mod.luau"), "return 1\n");
  return dir;
}

test("a Studio edit of a ModuleScript made from a .json file does not write Luau into the .json", async () => {
  const { Project } = await import("../dist/sync.js");
  const dir = syncProject();
  const session = new SyncSession(new Project(path.join(dir, "default.project.json")), async () => ({ created: 0, updated: 0, removed: 0 }), "P");
  await session.start();
  try {
    await session.onPluginEvent({ type: "source", path: ["ReplicatedStorage", "Shared", "Data"], class: "ModuleScript", source: "return { a = 2 }" });
    assert.equal(fs.readFileSync(path.join(dir, "src", "Data.json"), "utf8"), '{"a":1}\n');
    await session.onPluginEvent({ type: "source", path: ["ReplicatedStorage", "Shared", "Mod"], class: "ModuleScript", source: "return 2\n" });
    assert.equal(fs.readFileSync(path.join(dir, "src", "Mod.luau"), "utf8"), "return 2\n", "real script files still get Studio edits");
  } finally {
    await session.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a sync_start that fails after stopping the old sync does not leave the stopped sync active", async () => {
  const core = new Core(bridge, async () => ({ version: 1, classes: {} }));
  const dir = syncProject();
  const place = `SyncFail${++placeSeq}`;
  const s = await hello(place, placeSeq);
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const r = await fetch(`${BASE}/plugin/poll?s=${s}`);
      if (r.status !== 200) return;
      for (const c of (await r.json()).commands) {
        if (c.op === "sync" && c.args.action === "stop") {
          // Studio goes away while the old sync is being stopped
          await bye(s);
          return;
        }
        await postJson("/plugin/result", { s, id: c.id, ok: true, result: { created: 0, updated: 0, removed: 0 } });
      }
    }
  })();
  try {
    await core.call("sync_start", { project: dir, place });
    await assert.rejects(core.call("sync_start", { project: dir, place }), /disconnected|closed/);
    assert.match((await core.call("status", {})).text, /Sync: off/);
    assert.deepEqual(JSON.parse((await core.call("sync_status", {})).text), { active: false });
  } finally {
    stop = true;
    await bye(s);
    await loop;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated API dump cache is downloaded again instead of failing for a week", async () => {
  const file = tmpDump();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, DUMP.slice(0, 20));
  let calls = 0;
  const raw = await apidump.readDump({ file, retryDelayMs: 1, fetchFn: async () => (calls++, { ok: true, status: 200, text: async () => DUMP }) });
  assert.equal(calls, 1);
  assert.equal(raw.Classes[0].Name, "X");
  assert.equal(fs.readFileSync(file, "utf8"), DUMP);
});

test("forwarded tool calls use a client without fetch's 300 s response limit", async () => {
  const { postRpc } = await import("../dist/rpcclient.js");
  const port = PORT + 2;
  let got;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got = { token: req.headers["x-rolink-token"], body: JSON.parse(body) };
      setTimeout(() => res.end(JSON.stringify({ ok: true, result: { text: "ж done" } })), 50);
    });
  });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  try {
    const r = await postRpc("127.0.0.1", port, "tok", { tool: "run", args: { code: "ж" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, result: { text: "ж done" } });
    assert.deepEqual(got, { token: "tok", body: { tool: "run", args: { code: "ж" } } });
  } finally {
    await new Promise((r) => srv.close(r));
  }
  // the owner being gone must still be recognisable, so the caller can take the port over
  await assert.rejects(postRpc("127.0.0.1", port, "tok", {}), (e) => e.code === "ECONNREFUSED");
  assert.doesNotMatch(fs.readFileSync(path.join(here, "..", "src", "index.ts"), "utf8"), /fetch\(`http:\/\/\$\{HOST\}:\$\{PORT\}\/rpc/);
});

test("sync: a $path outside the project and links out of it are not read", async () => {
  const { Project } = await import("../dist/sync.js");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-escape-"));
  const dir = path.join(base, "repo");
  const outside = path.join(base, "secret");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "Stolen.luau"), "SECRET\n");
  fs.writeFileSync(path.join(dir, "src", "Ok.luau"), "return 1\n");
  fs.symlinkSync(outside, path.join(dir, "src", "Linked"), "junction");
  fs.writeFileSync(
    path.join(dir, "default.project.json"),
    JSON.stringify({ name: "P", tree: { $className: "DataModel", ReplicatedStorage: { Shared: { $path: "src" }, Up: { $path: "../secret" }, Abs: { $path: outside } } } }),
  );
  try {
    const project = new Project(path.join(dir, "default.project.json"));
    const snap = await project.snapshot();
    const names = snap.items.map((i) => i.path.join("/"));
    assert.ok(names.includes("ReplicatedStorage/Shared/Ok"), names.join(","));
    assert.ok(!snap.items.some((i) => (i.source ?? "").includes("SECRET")), names.join(","));
    assert.ok(!names.some((n) => /Up|Abs|Linked/.test(n)), names.join(","));
    assert.equal(snap.warnings.filter((w) => /outside the project/.test(w)).length, 2, snap.warnings.join("\n"));
    assert.ok(snap.warnings.some((w) => /symbolic links are not followed/.test(w)));
    const watched = await project.watchedPaths();
    assert.ok(!watched.some((w) => w.startsWith(outside)), watched.join(","));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("sync: a Studio edit is never written through a link to a file outside the project", async (t) => {
  const { Project } = await import("../dist/sync.js");
  const dir = syncProject();
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rolink-outside-")), "bashrc");
  fs.writeFileSync(outside, "original\n");
  const session = new SyncSession(new Project(path.join(dir, "default.project.json")), async () => ({ created: 0, updated: 0, removed: 0 }), "P");
  await session.start();
  try {
    const mod = path.join(dir, "src", "Mod.luau");
    fs.rmSync(mod);
    try {
      fs.symlinkSync(outside, mod, "file");
    } catch (e) {
      t.skip(`cannot create file symlinks here (${e.code})`);
      return;
    }
    await session.onPluginEvent({ type: "source", path: ["ReplicatedStorage", "Shared", "Mod"], class: "ModuleScript", source: "pwned\n" });
    assert.equal(fs.readFileSync(outside, "utf8"), "original\n");
    assert.ok(session.status().recent.some((l) => /refused to write/.test(l)));
  } finally {
    await session.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(outside), { recursive: true, force: true });
  }
});

test("sync: a Studio edit is never written into a folder that now links outside the project", async () => {
  const { Project } = await import("../dist/sync.js");
  const dir = syncProject();
  fs.mkdirSync(path.join(dir, "src", "Sub"));
  fs.writeFileSync(path.join(dir, "src", "Sub", "X.luau"), "return 'x'\n");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-outside-"));
  fs.writeFileSync(path.join(outside, "X.luau"), "original\n");
  const session = new SyncSession(new Project(path.join(dir, "default.project.json")), async () => ({ created: 0, updated: 0, removed: 0 }), "P");
  await session.start();
  try {
    fs.rmSync(path.join(dir, "src", "Sub"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, "src", "Sub"), "junction");
    await session.onPluginEvent({ type: "source", path: ["ReplicatedStorage", "Shared", "Sub", "X"], class: "ModuleScript", source: "pwned\n" });
    assert.equal(fs.readFileSync(path.join(outside, "X.luau"), "utf8"), "original\n");
    assert.ok(session.status().recent.some((l) => /refused to write/.test(l)));
  } finally {
    await session.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("screenshot: PowerShell is run by absolute path and the place name cannot become a parameter", async () => {
  const { powershellPath, titleArg } = await import("../dist/screenshot.js");
  const ps = powershellPath({ SystemRoot: String.raw`C:\Windows` });
  assert.equal(ps, String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`);
  assert.ok(path.win32.isAbsolute(powershellPath({})));
  assert.equal(titleArg("-Out C:/x"), "Out C:/x");
  assert.equal(titleArg(" --Dll"), "Dll");
  assert.equal(titleArg("—Title"), "Title");
  assert.equal(titleArg("My-Game"), "My-Game");
  const src = fs.readFileSync(path.join(here, "..", "src", "screenshot.ts"), "utf8");
  assert.doesNotMatch(src, /execFile\(\s*"powershell/);
});

test("rpc token: kept out of the shared /tmp on POSIX, per-user temp on Windows", async () => {
  const { tokenDir } = await import("../dist/bridge.js");
  assert.equal(tokenDir({}, "win32"), os.tmpdir());
  assert.equal(tokenDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux"), path.join("/run/user/1000", "rolink"));
  assert.equal(tokenDir({}, "darwin"), path.join(os.homedir(), ".rolink"));
  const live = fs.readFileSync(path.join(repo, "tools", "live.mjs"), "utf8");
  assert.match(live, /XDG_RUNTIME_DIR/, "tools/live.mjs follows the same rule");
});

test("rpc token: a bridge that cannot write its token file does not keep the port", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-tok-"));
  const notADir = path.join(dir, "file");
  fs.writeFileSync(notADir, "x");
  const port = PORT + 3;
  const env = { ...process.env, ROLINK_PORT: String(port), TEMP: notADir, TMP: notADir, TMPDIR: notADir, XDG_RUNTIME_DIR: notADir };
  const r = spawnSync(process.execPath, [path.join(here, "..", "dist", "index.js"), "--daemon"], { env, encoding: "utf8", timeout: 20_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /could not write the rpc token file/);
});
