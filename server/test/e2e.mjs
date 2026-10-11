// End-to-end test of the MCP server + bridge + sync with a mock Studio plugin.
//   node test/e2e.mjs        (run `npm run build` first)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, ROLINK_PORT: String(PORT) }, stderr: "ignore" }));
  return c;
}
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

// ---------------------------------------------------------------- mock plugin
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
    case "boom":
      throw "kaboom";
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

// no echo: our own write must not bounce back as a patch
const echoStart = received.length;
await sleep(800);
ok(!received.slice(echoStart).some((c) => c.op === "sync" && c.args.upsert?.some((u) => u.path.join("/") === "ServerScriptService/Main")), "no echo of Studio edits");

r = await c1.callTool({ name: "sync_stop", arguments: {} });
ok(text(r).includes("stopped"), "sync_stop");

stop = true;
await c2.close();
await c1.close();
fs.rmSync(proj, { recursive: true, force: true });
console.log(`e2e: ${passed} checks passed`);
process.exit(0);
