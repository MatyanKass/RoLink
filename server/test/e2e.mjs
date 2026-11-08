// End-to-end test of the MCP server + bridge + sync with a mock Studio plugin.
//   node test/e2e.mjs        (run `npm run build` first)

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Document, NodeIO } from "@gltf-transform/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 34999;
const BASE = `http://127.0.0.1:${PORT}`;
const entry = path.join(here, "..", "dist", "index.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
};

async function client() {
  const c = new Client({ name: "e2e", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, ROLINK_PORT: String(PORT), ROBLOX_API_KEY: "" }, stderr: "ignore" }));
  return c;
}
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

// ---------------------------------------------------------------- mock plugin
const mirrorNodes = [
  { i: 1, p: 0, c: "Workspace", n: "Workspace", props: {} },
  { i: 2, p: 1, c: "Part", n: "Baseplate", props: { Size: [512, 20, 512], CFrame: { p: [0, -10, 0] } } },
  { i: 3, p: 0, c: "ReplicatedStorage", n: "ReplicatedStorage", props: {} },
  { i: 4, p: 3, c: "ModuleScript", n: "../../escape", props: {}, src: "return 'x'\n" },
  { i: 5, p: 3, c: "Folder", n: "Box", props: {} },
  ...Array.from({ length: 30 }, (_, k) => ({ i: 100 + k, p: 5, c: "IntValue", n: `V${k}`, props: { Value: k } })),
];
const received = [];
let session;
let stop = false;
async function post(p, body) {
  const r = await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
async function reply(id, ok, result) {
  const body = JSON.stringify(ok ? { ok: true, result } : { ok: false, error: result });
  const CH = 1000;
  const n = Math.max(1, Math.ceil(body.length / CH));
  for (let i = 0; i < n; i++) await post("/plugin/result", { s: session, id, chunk: i, chunks: n, data: body.slice(i * CH, (i + 1) * CH) });
}
function handle(cmd) {
  received.push(cmd);
  switch (cmd.op) {
    case "tree":
      return { roots: [{ path: "Workspace", n: "Workspace", c: "Workspace", id: 1, k: 2, ch: [{ n: "Baseplate", c: "Part", id: 2, s: [512, 20, 512], p: [0, -10, 0], k: 0 }, { n: "Fin", c: "Part", x: 6, id: 3, s: [0.2, 3, 4] }] }], nodes: 3 };
    case "build":
      return { created: [{ path: "Workspace/" + cmd.args.items[0].name, id: 9, class: "Model" }], warnings: [], parts: 1, big: "x".repeat(5000) };
    case "mirror":
      if (cmd.args.action === "start") return { services: cmd.args.services, others: ["Players"] };
      if (cmd.args.action === "next") return { nodes: mirrorNodes, done: true };
      return {};
    case "mirror_apply":
      return { created: cmd.args.ops.filter((o) => o.op === "create").map((o, i) => ({ t: o.t, node: { i: 9000 + i, p: o.parent, c: o.class, n: o.name, props: o.props ?? {}, src: o.source } })), nodes: [], errors: [] };
    case "boom":
      throw "kaboom";
    case "toolbox_search":
      return { results: [{ id: 7, name: "Tree", creator: "Maker" }] };
    case "toolbox_insert":
      return {
        assetId: cmd.args.assetId, name: "Tree", creator: { id: 1, name: "Maker" }, path: `ServerStorage/RoLinkQuarantine/Tree_${cmd.args.assetId}`, loader: "LoadAsset",
        counts: { instances: 3, parts: 1 }, assetRefs: [], uncheckedRefs: 0,
        scripts: [{ path: "Main", name: "Main", class: "Script", enabled: false, wasEnabled: true, runContext: "Legacy", parentClass: "Model", source: "require(1234567)" }],
      };
    case "toolbox_release":
      return { moved: { path: "Workspace/Tree", id: 3, class: "Model" }, enabled: 0, disabled: 1, unknownScripts: 0 };
    case "animation_stage":
      return { staged: cmd.args.index };
    case "animation_build":
      return { created: { path: "ServerStorage/RoLinkAnimations/" + cmd.args.name, id: 8, class: "KeyframeSequence" }, keyframes: 2, poses: 6, length: 1 };
    case "animation_discard":
      return { discarded: true };
    default:
      return { op: cmd.op, args: cmd.args };
  }
}
async function plugin() {
  const h = await post("/plugin/hello", { context: "edit", placeName: "TestPlace", placeId: 1, gameId: 2, pluginVersion: "test" });
  session = h.session;
  while (!stop) {
    const r = await fetch(`${BASE}/plugin/poll?s=${session}`).catch(() => null);
    if (!r) {
      await sleep(100);
      continue;
    }
    const b = await r.json();
    for (const cmd of b.commands ?? []) {
      if (cmd.op === "run" && cmd.args.code === "badjson") {
        await post("/plugin/result", { s: session, id: cmd.id, chunk: 0, chunks: 2, data: '{"ok":tr' });
        await post("/plugin/result", { s: session, id: cmd.id, chunk: 1, chunks: 2, data: "XX" });
        continue;
      }
      if (cmd.op === "run" && cmd.args.code === "badchunk") {
        await post("/plugin/result", { s: session, id: cmd.id, chunk: 5, chunks: 2, data: "{}" });
        continue;
      }
      try {
        await reply(cmd.id, true, handle(cmd));
      } catch (e) {
        await reply(cmd.id, false, String(e));
      }
    }
  }
}

// ---------------------------------------------------------------- run
const c1 = await client();
await sleep(400);

// the bridge only answers requests addressed to loopback by name and port
const rawGet = (host) => new Promise((res, rej) => {
  http.get({ host: "127.0.0.1", port: PORT, path: "/health", headers: { Host: host } }, (x) => {
    x.resume();
    res(x.statusCode);
  }).on("error", rej);
});
ok((await rawGet(`127.0.0.1:${PORT}`)) === 200, "Host 127.0.0.1:PORT accepted");
ok((await rawGet(`localhost:${PORT}`)) === 200, "Host localhost:PORT accepted");
ok((await rawGet(`evil.example:${PORT}`)) === 403, "foreign Host refused");
ok((await rawGet("127.0.0.1")) === 403, "Host without the port refused");
ok((await rawGet(`127.0.0.1:${PORT + 1}`)) === 403, "Host with another port refused");

let r = await c1.callTool({ name: "status", arguments: {} });
ok(text(r).includes("No Studio connected"), "status before plugin");

r = await c1.callTool({ name: "tree", arguments: {} });
ok(r.isError && text(r).includes("not connected"), "tree without studio errors clearly");

plugin();
await sleep(300);

r = await c1.callTool({ name: "status", arguments: {} });
ok(text(r).includes("TestPlace [edit]"), "status lists session");

r = await c1.callTool({ name: "tree", arguments: { depth: 1 } });
ok(text(r).includes("Baseplate [Part] 512×20×512 @(0, -10, 0)"), "tree rendering");
ok(text(r).includes("Fin [Part] ×6"), "collapsed siblings");
ok(received.at(-1).args.depth === 1, "args forwarded");

r = await c1.callTool({ name: "build", arguments: { items: [{ name: "Tower" }] } });
ok(JSON.parse(text(r)).big.length === 5000, "chunked result reassembled");

r = await c1.callTool({ name: "build", arguments: { items: [{ name: "X" }], place: "nope" } });
ok(r.isError && text(r).includes("No edit session"), "place filter");

// second MCP process proxies to the first
const c2 = await client();
await sleep(300);
r = await c2.callTool({ name: "status", arguments: {} });
ok(text(r).includes("TestPlace [edit]"), "second process proxies");
r = await c2.callTool({ name: "tree", arguments: {} });
ok(text(r).includes("Baseplate"), "proxied tree");

// browsers are refused
const evil = await fetch(`${BASE}/rpc`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: "{}" });
ok(evil.status === 403, "Origin header refused");

// /rpc needs the owner's token; /health leaks no session ids
const noTok = await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "status", args: {} }) });
ok(noTok.status === 401, "rpc without token refused");
const badTok = await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json", "x-rolink-token": "nope" }, body: JSON.stringify({ tool: "status", args: {} }) });
ok(badTok.status === 401, "rpc with wrong token refused");
const health = await (await fetch(`${BASE}/health`)).json();
ok(health.rolink && health.sessions.length === 1 && !("id" in health.sessions[0]), "health has no session ids");
ok(!JSON.stringify(health).includes(session), "session id not in health");

// confirm_dialog is for rolink-publish over /rpc only: not an agent-callable MCP tool
const rpcToken = fs.readFileSync(path.join(os.tmpdir(), `rolink-${PORT}.token`), "utf8").trim();
const dlg = await (await fetch(`${BASE}/rpc`, { method: "POST", headers: { "content-type": "application/json", "x-rolink-token": rpcToken }, body: JSON.stringify({ tool: "confirm_dialog", args: { title: "T", text: "B", confirmLabel: "Go", timeout: 7 } }) })).json();
ok(dlg.ok && received.at(-1).op === "confirm_dialog", "confirm_dialog forwarded to the plugin: " + JSON.stringify(dlg));
ok(received.at(-1).args.timeout === 7 && received.at(-1).args.confirmLabel === "Go" && received.at(-1).args.text === "B", "confirm_dialog args forwarded");
ok(!(await c1.listTools()).tools.some((t) => t.name === "confirm_dialog"), "confirm_dialog is not an MCP tool");

// malformed chunked results reject the call instead of hanging / crashing
const badJson = c1.callTool({ name: "run", arguments: { code: "badjson" } });
r = await badJson;
ok(r.isError && text(r).includes("not valid JSON"), "bad chunked JSON rejects the call: " + text(r));
r = await c1.callTool({ name: "run", arguments: { code: "badchunk" } });
ok(r.isError && text(r).includes("invalid chunk"), "out-of-range chunk rejects the call: " + text(r));

// ---------------------------------------------------------------- sync
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-e2e-"));
fs.mkdirSync(path.join(proj, "src", "shared", "Util"), { recursive: true });
fs.mkdirSync(path.join(proj, "src", "server"), { recursive: true });
fs.writeFileSync(
  path.join(proj, "default.project.json"),
  JSON.stringify({
    name: "E2E",
    tree: {
      $className: "DataModel",
      ReplicatedStorage: { Shared: { $path: "src/shared" } },
      ServerScriptService: { $path: "src/server" },
      Workspace: { Baseplate: { $className: "Part", $properties: { Color: [0.5, 0.5, 0.5], Size: [512, 20, 512] } } },
      Lighting: { $properties: { Brightness: 2 } },
    },
  }),
);
fs.writeFileSync(path.join(proj, "src", "shared", "Items.lua"), "return {}\n");
fs.writeFileSync(path.join(proj, "src", "shared", "Util", "init.luau"), "return 1\n");
fs.writeFileSync(path.join(proj, "src", "shared", "Util", "Math.luau"), "return 2\n");
fs.writeFileSync(path.join(proj, "src", "server", "Main.server.lua"), "print('hi')\n");
fs.writeFileSync(path.join(proj, "src", "shared", "Crate.model.json"), JSON.stringify({ class: "Model", children: [{ name: "Box", size: [2, 2, 2] }] }));

r = await c1.callTool({ name: "sync_start", arguments: { project: proj } });
ok(!r.isError, "sync_start: " + text(r));
const full = received.filter((c) => c.op === "sync").at(-1).args;
ok(full.action === "full", "full sync sent");
const byPath = Object.fromEntries(full.items.map((i) => [i.path.join("/"), i]));
ok(byPath["ReplicatedStorage/Shared"].class === "Folder", "mapped folder");
ok(byPath["ReplicatedStorage/Shared/Items"].class === "ModuleScript", "module script");
ok(byPath["ReplicatedStorage/Shared/Util"].class === "ModuleScript" && byPath["ReplicatedStorage/Shared/Util"].source === "return 1\n", "init.luau makes the folder a module");
ok(byPath["ReplicatedStorage/Shared/Util/Math"], "child of init module");
ok(byPath["ServerScriptService/Main"].class === "Script", "server script under service");
ok(byPath["Workspace/Baseplate"].props.Color === "#808080", "Rojo Color3 floats -> hex");
ok(byPath["Lighting"].props.Brightness === 2, "service props");
ok(byPath["ReplicatedStorage/Shared/Crate"].spec.children[0].name === "Box", "model.json spec");
ok(!("file" in byPath["ReplicatedStorage/Shared/Items"]), "no local paths sent");
ok(full.roots.some((p) => p.join("/") === "ReplicatedStorage/Shared"), "roots");

const before = received.length;
fs.writeFileSync(path.join(proj, "src", "shared", "Items.lua"), "return { gold = 1 }\n");
for (let i = 0; i < 40 && !received.slice(before).some((c) => c.op === "sync"); i++) await sleep(100);
const patch = received.slice(before).find((c) => c.op === "sync")?.args;
ok(patch && patch.action === "patch", "file change -> patch");
ok(patch.upsert.length === 1 && patch.upsert[0].source.includes("gold"), "only the changed file is sent");

// Studio edits a script -> file
await post("/plugin/event", { s: session, type: "source", path: ["ServerScriptService", "Main"], class: "Script", source: "print('edited in studio')\n" });
await sleep(300);
ok(fs.readFileSync(path.join(proj, "src", "server", "Main.server.lua"), "utf8").includes("edited in studio"), "Studio edit written to file");
await post("/plugin/event", { s: session, type: "created", path: ["ReplicatedStorage", "Shared", "Util", "NewThing"], class: "ModuleScript", source: "return 3\n" });
await sleep(300);
ok(fs.existsSync(path.join(proj, "src", "shared", "Util", "NewThing.luau")), "script created in Studio gets a file");
for (const evilName of ["..", "../../escape", "a/b", "x\\y", "c:d", "q?"]) {
  await post("/plugin/event", { s: session, type: "created", path: ["ReplicatedStorage", "Shared", evilName], class: "ModuleScript", source: "return 'pwn'\n" });
}
await sleep(300);
ok(!fs.existsSync(path.join(proj, "escape.luau")) && !fs.existsSync(path.join(proj, "src", "escape.luau")), "path traversal names refused");
ok(!fs.readdirSync(path.join(proj, "src", "shared")).some((f) => f.includes("pwn") || f.startsWith("..") || f.startsWith("a") || f.startsWith("q")), "unsafe names not written");

// .json -> ModuleScript must survive "]==]" inside the data
fs.writeFileSync(path.join(proj, "src", "shared", "Data.json"), JSON.stringify({ s: "a]]b]=]c]==]d" }));
for (let i = 0; i < 40 && !received.some((c) => c.op === "sync" && c.args.upsert?.some((u) => u.path.join("/") === "ReplicatedStorage/Shared/Data")); i++) await sleep(100);
const dataItem = received.filter((c) => c.op === "sync").flatMap((c) => c.args.upsert ?? []).find((u) => u.path.join("/") === "ReplicatedStorage/Shared/Data");
ok(dataItem && dataItem.source.includes("[===[") && dataItem.source.endsWith("]===])"), "json long-bracket level avoids ]==]: " + dataItem?.source);

// no echo: our own write must not bounce back as a patch
const echoStart = received.length;
await sleep(800);
ok(!received.slice(echoStart).some((c) => c.op === "sync" && c.args.upsert?.some((u) => u.path.join("/") === "ServerScriptService/Main")), "no echo of Studio edits");

// export refuses to overwrite existing files outside cwd/sync root without overwrite:true
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-out-"));
const victim = path.join(outside, "victim.model.json");
fs.writeFileSync(victim, "keep me");
r = await c1.callTool({ name: "export", arguments: { path: "Workspace/Baseplate", file: victim } });
ok(r.isError && text(r).includes("overwrite"), "export refuses to clobber outside file");
ok(fs.readFileSync(victim, "utf8") === "keep me", "victim untouched");
fs.rmSync(outside, { recursive: true, force: true });

const mirrorDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rolink-mirror-e2e-")), "m");
r = await c1.callTool({ name: "mirror_start", arguments: { dir: mirrorDir } });
ok(r.isError && text(r).includes("cannot run on the same content"), "mirror refused while sync overlaps: " + text(r));

// toolbox: quarantine report, release defaults, search without a key
const toolNames = (await c1.listTools()).tools;
for (const n of ["toolbox_search", "toolbox_insert", "toolbox_release", "import_animation"]) ok(toolNames.some((t) => t.name === n), `tool ${n} registered`);
ok(/review/i.test(toolNames.find((t) => t.name === "toolbox_release").description), "release description asks for a review");
ok(!/malware|malicious|backdoor|virus|trojan/i.test(JSON.stringify(toolNames.filter((t) => t.name.startsWith("toolbox")))), "neutral wording");

r = await c1.callTool({ name: "toolbox_search", arguments: { query: "tree" } });
let body = JSON.parse(text(r));
ok(body.source === "studio" && body.results[0].id === 7 && body.results[0].verified === null, "search falls back to Studio");
ok(/untrusted data/i.test(body.notice), "search results labelled untrusted");
r = await c1.callTool({ name: "toolbox_search", arguments: { query: "tree", kind: "audio" } });
ok(r.isError && text(r).includes("creator-store-product:read"), "audio search without a key explains the scope");

r = await c1.callTool({ name: "toolbox_insert", arguments: { assetId: 77 } });
body = JSON.parse(text(r));
ok(body.path === "ServerStorage/RoLinkQuarantine/Tree_77", "insert reports quarantine path");
ok(body.flags.some((f) => f.id === "require_numeric"), "insert report carries scan flags");
ok(!text(r).includes('"source"'), "report has no full source field");
ok(received.at(-1).args.assetId === 77, "asset id forwarded");
r = await c1.callTool({ name: "toolbox_insert", arguments: { assetId: 77, context: "server" } });
ok(r.isError && text(r).includes("edit"), "toolbox refuses play-test contexts");

r = await c1.callTool({ name: "toolbox_release", arguments: { path: "ServerStorage/RoLinkQuarantine/Tree_77", target: "Workspace" } });
ok(!r.isError && received.at(-1).op === "toolbox_release" && received.at(-1).args.enableScripts === false, "scripts stay disabled unless asked");

// import_animation: glTF on disk -> staged keyframes -> one build command
const animDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-anim-e2e-"));
{
  const doc = new Document();
  const buffer = doc.createBuffer();
  const upper = doc.createNode("LeftUpperArm");
  const lower = doc.createNode("LeftLowerArm").setTranslation([0, -1, 0]);
  upper.addChild(lower);
  doc.createScene("S").addChild(upper);
  const input = doc.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer);
  const output = doc.createAccessor().setType("VEC4").setArray(new Float32Array([0, 0, 0, 1, Math.SQRT1_2, 0, 0, Math.SQRT1_2])).setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output);
  const anim = doc.createAnimation("Wave").addSampler(sampler);
  anim.addChannel(doc.createAnimationChannel().setTargetNode(upper).setTargetPath("rotation").setSampler(sampler));
  await new NodeIO().write(path.join(animDir, "wave.glb"), doc);
}
const beforeAnim = received.length;
r = await c1.callTool({ name: "import_animation", arguments: { path: path.join(animDir, "wave.glb"), fps: 2 } });
ok(!r.isError, "import_animation succeeds: " + text(r));
body = JSON.parse(text(r));
ok(body.created.class === "KeyframeSequence" && body.clip === "Wave" && body.mappedBones.LeftUpperArm === "LeftUpperArm", "import_animation report");
ok(/docs\/ANIMATION\.md/.test(body.note), "points at publishing instructions");
const animCmds = received.slice(beforeAnim);
ok(animCmds.at(-1).op === "animation_build" && animCmds.slice(0, -1).every((c) => c.op === "animation_stage"), "staged, then built once");
ok(animCmds.at(-1).args.tree.LeftUpperArm === "UpperTorso" && animCmds.at(-1).args.root === "HumanoidRootPart", "pose tree sent");
ok(animCmds.at(-1).args.count === animCmds.length - 1, "chunk count matches");

fs.writeFileSync(path.join(animDir, "x.fbx"), "FBX");
r = await c1.callTool({ name: "import_animation", arguments: { path: path.join(animDir, "x.fbx") } });
ok(r.isError && /glTF/.test(text(r)) && /Blender/.test(text(r)), "fbx explained");
fs.rmSync(animDir, { recursive: true, force: true });

r = await c1.callTool({ name: "sync_stop", arguments: {} });
ok(text(r).includes("stopped"), "sync_stop");

// ---------------------------------------------------------------- mirror
r = await c1.callTool({ name: "mirror_start", arguments: { dir: mirrorDir } });
ok(!r.isError, "mirror_start: " + text(r));
const inMirror = (...p) => path.join(mirrorDir, ...p);
ok(fs.existsSync(inMirror("Workspace", "Baseplate.Part.json")), "mirror wrote a loose part");
ok(fs.existsSync(inMirror("AGENTS.md")) && fs.existsSync(inMirror("_tree.txt")), "root files");
ok(fs.existsSync(inMirror("ReplicatedStorage", "%2E%2E%2F%2E%2E%2Fescape.luau")), "traversal name stays one encoded file");
ok(!fs.existsSync(path.join(mirrorDir, "..", "..", "escape.luau")) && !fs.existsSync(path.join(mirrorDir, "..", "escape.luau")), "nothing escaped the root");

r = await c1.callTool({ name: "sync_start", arguments: { project: proj } });
ok(r.isError && text(r).includes("cannot run on the same content"), "sync refused while mirror overlaps: " + text(r));

const applied = () => received.filter((c) => c.op === "mirror_apply");
fs.writeFileSync(inMirror("ReplicatedStorage", "Buy.RemoteEvent.json"), "{}");
for (let i = 0; i < 60 && applied().length === 0; i++) await sleep(100);
ok(applied()[0]?.args.ops[0].class === "RemoteEvent", "new file creates an instance");

const bad = inMirror("Workspace", "Baseplate.Part.json");
fs.writeFileSync(bad, "{ broken");
for (let i = 0; i < 60 && !(fs.existsSync(inMirror("_errors.log")) && fs.readFileSync(inMirror("_errors.log"), "utf8").includes("invalid JSON")); i++) await sleep(100);
ok(fs.readFileSync(inMirror("_errors.log"), "utf8").includes("invalid JSON"), "bad JSON logged");
ok(applied().length === 1, "bad JSON sends nothing to Studio");

fs.rmSync(inMirror("ReplicatedStorage", "Box"), { recursive: true });
let mirrorSt;
for (let i = 0; i < 60; i++) {
  mirrorSt = JSON.parse(text(await c1.callTool({ name: "mirror_status", arguments: {} })));
  if (mirrorSt.refusedDeletes.length) break;
  await sleep(100);
}
ok(mirrorSt.refusedDeletes.length === 1, "mass delete refused and reported in status");
ok(applied().length === 1, "mass delete sent nothing to Studio");
for (let i = 0; i < 40 && !fs.existsSync(inMirror("ReplicatedStorage", "Box", "V5.IntValue.json")); i++) await sleep(100);
ok(fs.existsSync(inMirror("ReplicatedStorage", "Box", "V5.IntValue.json")), "mass-deleted files restored");

await post("/plugin/event", { s: session, type: "mirror_delta", upserts: [{ ...mirrorNodes[4], n: "Crate" }] });
for (let i = 0; i < 40 && !fs.existsSync(inMirror("ReplicatedStorage", "Crate", "V5.IntValue.json")); i++) await sleep(100);
ok(fs.existsSync(inMirror("ReplicatedStorage", "Crate", "V5.IntValue.json")) && !fs.existsSync(inMirror("ReplicatedStorage", "Box")), "Studio rename moves the directory");

r = await c1.callTool({ name: "mirror_stop", arguments: {} });
ok(text(r).includes("stopped"), "mirror_stop");
fs.rmSync(path.dirname(mirrorDir), { recursive: true, force: true });

stop = true;
await c2.close();
await c1.close();
fs.rmSync(proj, { recursive: true, force: true });
const playtestChecks = await (await import("./playtest-e2e.mjs")).default();
console.log(`e2e: ${passed} checks passed, playtest: ${playtestChecks}`);
process.exit(0);
