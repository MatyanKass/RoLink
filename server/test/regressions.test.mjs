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
