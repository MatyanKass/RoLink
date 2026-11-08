// The live mirror against a fake Studio on a real disk. Build first: `npm run build`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MirrorSession } from "../dist/mirror.js";

class FakeStudio {
  constructor() {
    this.nodes = new Map();
    this.next = 100;
    this.applies = [];
  }
  add(p, c, n, extra = {}) {
    const i = this.next++;
    this.nodes.set(i, { i, p, c, n, props: {}, ...extra });
    return i;
  }
  wire(i) {
    return JSON.parse(JSON.stringify(this.nodes.get(i)));
  }
  find(name) {
    return [...this.nodes.values()].find((x) => x.n === name);
  }
  send = async (op, args) => {
    if (op === "mirror") {
      if (args.action === "start") return { services: args.services, others: ["Players"] };
      if (args.action === "next") return { nodes: [...this.nodes.keys()].map((i) => this.wire(i)), done: true };
      return {};
    }
    assert.equal(op, "mirror_apply");
    this.applies.push(args.ops);
    const created = [];
    const nodes = [];
    const errors = [];
    const tmp = new Map();
    const id = (x) => (x < 0 ? tmp.get(x) : x);
    for (const o of args.ops) {
      if (o.op === "create") {
        if (o.class === "Bogus" || (o.csg && o.csg.parts.some((p) => p.Size?.[0] === 0))) {
          errors.push({ where: o.name, message: `cannot create ${o.class}` });
          continue;
        }
        const i = this.add(id(o.parent), o.class, o.name, { props: o.props ?? {}, attrs: o.attrs, tags: o.tags, src: o.source });
        tmp.set(o.t, i);
      } else if (o.op === "set") {
        const n = this.nodes.get(id(o.id));
        if (o.name !== undefined) n.n = o.name;
        if (o.parent !== undefined) n.p = id(o.parent);
        if (o.source !== undefined) n.src = o.source;
        Object.assign(n.props, o.props ?? {});
        nodes.push(this.wire(id(o.id)));
      } else {
        const kill = (i) => {
          for (const c of [...this.nodes.values()]) if (c.p === i) kill(c.i);
          this.nodes.delete(i);
        };
        kill(o.id);
      }
    }
    for (const [t, i] of tmp) created.push({ t, node: this.wire(i) });
    return { created, nodes, errors };
  };
}

const CF = (y) => ({ p: [0, y, 0] });
function place() {
  const s = new FakeStudio();
  const ws = s.add(0, "Workspace", "Workspace");
  s.add(ws, "Part", "Baseplate", { props: { CFrame: CF(-10), Size: [512, 20, 512] } });
  const tower = s.add(ws, "Model", "Tower", { props: { Pivot: CF(0) } });
  const door = s.add(tower, "Part", "Door", { props: { CFrame: CF(3), Size: [4, 7, 1], Color: "#112233" } });
  s.add(door, "Script", "Open", { src: "print('open')\n" });
  s.add(door, "ProximityPrompt", "ProximityPrompt", { props: { ActionText: "Go" } });
  s.add(tower, "Part", "Wall", { props: { CFrame: CF(10), Size: [1, 1, 1] } });
  s.add(tower, "Part", "Wall", { props: { CFrame: CF(20), Size: [1, 1, 1] } });
  const rs = s.add(0, "ReplicatedStorage", "ReplicatedStorage");
  s.add(rs, "ModuleScript", "Util", { src: "return 1\n" });
  const box = s.add(rs, "Folder", "Box");
  for (let i = 0; i < 40; i++) s.add(box, "IntValue", `V${i}`, { props: { Value: i } });
  s.add(rs, "ModuleScript", "../../escape", { src: "return 'x'\n" });
  s.add(rs, "Folder", "C:\\evil");
  const sg = s.add(0, "StarterGui", "StarterGui");
  const hud = s.add(sg, "ScreenGui", "Hud");
  const frame = s.add(hud, "Frame", "Panel", { props: { Size: [0, 100, 0, 50] } });
  s.add(frame, "UICorner", "Corner");
  s.add(hud, "LocalScript", "Click", { src: "-- click\n" });
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await sleep(20);
  }
  assert.fail(`timed out: ${what}`);
}

async function withMirror(fn, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-mirror-"));
  const studio = place();
  const m = new MirrorSession({ dir, services: ["Workspace", "ReplicatedStorage", "StarterGui"], debounceMs: 30, ...opts }, studio.send, "P");
  await m.start();
  const f = (...p) => path.join(dir, ...p);
  const read = (...p) => fs.readFileSync(f(...p), "utf8");
  try {
    await fn({ m, studio, dir, f, read });
  } finally {
    await m.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const errorsLog = (read) => {
  try {
    return read("_errors.log");
  } catch {
    return "";
  }
};

test("initial dump: layout, sub-files, _info, root files", () =>
  withMirror(async ({ f, read, dir }) => {
    assert.ok(fs.existsSync(f("Workspace", "Baseplate.Part.json")));
    const model = JSON.parse(read("Workspace", "Tower.model", "model.json"));
    assert.deepEqual(model.children.map((c) => c.name), ["Door", "Wall", "Wall"]);
    assert.equal(model._info.partCount, 3);
    assert.equal(read("Workspace", "Tower.model", "Door.Open.server.luau"), "print('open')\n");
    assert.equal(JSON.parse(read("Workspace", "Tower.model", "Door.ProximityPrompt.json")).ActionText, "Go");
    assert.ok(model._info.attached.some((a) => a.file === "Door.ProximityPrompt.json" && a.owner === "Door"));
    assert.ok(read("AGENTS.md").includes("Cookbook"));
    assert.ok(read("_tree.txt").includes("Tower [Model]"));
    assert.ok(read("_tree.txt").includes("Players"));
    assert.equal(JSON.parse(read("StarterGui", "Hud.gui", "gui.json")).children[0].children[0].class, "UICorner");
    assert.equal(read("StarterGui", "Hud.gui", "Click.client.luau"), "-- click\n");
    // names that try to climb out stay inside as one encoded file
    assert.ok(fs.existsSync(f("ReplicatedStorage", "%2E%2E%2F%2E%2E%2Fescape.luau")));
    assert.ok(fs.existsSync(f("ReplicatedStorage", "C%3A%5Cevil")));
    assert.ok(!fs.existsSync(path.join(dir, "..", "escape.luau")));
  }));

test("a one-property edit sends one set with only that property, and does not echo", () =>
  withMirror(async ({ studio, f, read }) => {
    const file = f("Workspace", "Tower.model", "model.json");
    const doc = JSON.parse(read("Workspace", "Tower.model", "model.json"));
    doc.children[0].Color = "#FF0000";
    doc._info = { junk: 1 };
    fs.writeFileSync(file, JSON.stringify(doc));
    await until(() => studio.applies.length === 1, "apply");
    assert.deepEqual(studio.applies[0], [{ op: "set", id: studio.find("Door").i, props: { Color: "#FF0000" } }]);
    await until(() => read("Workspace", "Tower.model", "model.json").includes("partCount"), "_info regenerated");
    await sleep(350);
    assert.equal(studio.applies.length, 1, "no echo");
  }));

test("Studio delta rewrites the file and a repeat of the same state changes nothing", () =>
  withMirror(async ({ m, studio, read }) => {
    const u = studio.find("Util");
    u.src = "return 2\n";
    m.onDelta({ upserts: [studio.wire(u.i)] });
    await until(() => read("ReplicatedStorage", "Util.luau") === "return 2\n", "script updated");
    m.onDelta({ upserts: [studio.wire(u.i)] });
    await sleep(300);
    assert.equal(studio.applies.length, 0, "no echo back to Studio");
  }));

test("Studio rename and removal move and remove files", () =>
  withMirror(async ({ m, studio, f }) => {
    const u = studio.find("Util");
    m.onDelta({ upserts: [{ ...studio.wire(u.i), n: "Helpers" }] });
    await until(() => fs.existsSync(f("ReplicatedStorage", "Helpers.luau")) && !fs.existsSync(f("ReplicatedStorage", "Util.luau")), "renamed");
    m.onDelta({ removed: [u.i] });
    await until(() => !fs.existsSync(f("ReplicatedStorage", "Helpers.luau")), "removed");
    assert.equal(studio.applies.length, 0);
  }));

test("renaming a file keeps the instance; moving one reparents it", () =>
  withMirror(async ({ studio, f }) => {
    const id = studio.find("Util").i;
    fs.renameSync(f("ReplicatedStorage", "Util.luau"), f("ReplicatedStorage", "Tools.luau"));
    await until(() => studio.applies.length === 1, "rename");
    assert.deepEqual(studio.applies[0], [{ op: "set", id, name: "Tools" }]);
    fs.renameSync(f("ReplicatedStorage", "Tools.luau"), f("ReplicatedStorage", "Box", "Tools.luau"));
    await until(() => studio.applies.length === 2, "move");
    assert.deepEqual(studio.applies[1], [{ op: "set", id, parent: studio.find("Box").i }]);
  }));

test("renaming a model directory keeps identity and destroys nothing", () =>
  withMirror(async ({ studio, f }) => {
    const id = studio.find("Tower").i;
    fs.renameSync(f("Workspace", "Tower.model"), f("Workspace", "Keep.model"));
    await until(() => studio.applies.length === 1, "rename");
    assert.deepEqual(studio.applies[0], [{ op: "set", id, name: "Keep" }]);
  }));

test("new script, part in model.json, loose object, and owned object are created", () =>
  withMirror(async ({ studio, f, read }) => {
    fs.writeFileSync(f("ReplicatedStorage", "Main.server.luau"), "print(1)\n");
    await until(() => studio.find("Main"), "script");
    assert.equal(studio.find("Main").c, "Script");
    fs.writeFileSync(f("ReplicatedStorage", "Buy.RemoteEvent.json"), "{}");
    await until(() => studio.find("Buy")?.c === "RemoteEvent", "remote");
    fs.writeFileSync(f("Workspace", "Tower.model", "Door.ClickDetector.json"), '{"MaxActivationDistance":10}');
    await until(() => studio.find("ClickDetector"), "detector on part");
    assert.equal(studio.find("ClickDetector").p, studio.find("Door").i);
    const doc = JSON.parse(read("Workspace", "Tower.model", "model.json"));
    doc.children.push({ name: "Roof", class: "Part", CFrame: CF(30), Size: [2, 2, 2] });
    fs.writeFileSync(f("Workspace", "Tower.model", "model.json"), JSON.stringify(doc));
    await until(() => studio.find("Roof"), "new part");
    await until(() => read("Workspace", "Tower.model", "model.json").includes('"Roof"'), "rendered");
  }));

test("a GUI directory under StarterGui creates the whole tree, class from gui.json", () =>
  withMirror(async ({ studio, f, read }) => {
    fs.mkdirSync(f("StarterGui", "Menu.gui"));
    fs.writeFileSync(
      f("StarterGui", "Menu.gui", "gui.json"),
      JSON.stringify({ class: "ScreenGui", children: [{ name: "F", class: "Frame", Size: [0, 10, 0, 10], children: [{ name: "L", class: "TextLabel", Text: "Hi" }] }] }),
    );
    await until(() => studio.find("L"), "label");
    assert.equal(studio.find("Menu").c, "ScreenGui");
    assert.equal(studio.find("F").p, studio.find("Menu").i);
    await until(() => read("StarterGui", "Menu.gui", "gui.json").includes('"Hi"'), "rendered");
    assert.ok(!errorsLog(read).includes("REJECTED"), errorsLog(read));
  }));

test("csg entries go to the plugin; a failed one is logged and does not stick", () =>
  withMirror(async ({ studio, f, read }) => {
    const parts = [
      { class: "Part", CFrame: CF(0), Size: [4, 4, 4] },
      { class: "Part", CFrame: CF(1), Size: [2, 2, 2] },
    ];
    fs.writeFileSync(f("Workspace", "Arch.UnionOperation.json"), JSON.stringify({ Color: "#AA0000", csg: { op: "subtract", parts } }));
    await until(() => studio.find("Arch"), "union");
    assert.equal(studio.applies[0][0].csg.op, "subtract");
    await until(() => !read("Workspace", "Arch.UnionOperation.json").includes("csg"), "recipe gone after creation");
    fs.writeFileSync(f("Workspace", "Bad.UnionOperation.json"), JSON.stringify({ csg: { op: "union", parts: [{ Size: [0, 1, 1] }, { Size: [1, 1, 1] }] } }));
    await until(() => errorsLog(read).includes("Bad"), "logged");
    assert.equal(studio.find("Bad"), undefined);
    assert.ok(fs.existsSync(f("Workspace", "Bad.UnionOperation.json")), "the failed file is left to fix");
  }));

test("unknown class goes to _errors.log, Studio untouched by it", () =>
  withMirror(async ({ studio, f, read }) => {
    fs.writeFileSync(f("ReplicatedStorage", "X.Bogus.json"), "{}");
    await until(() => errorsLog(read).includes("Bogus"), "logged");
    assert.equal(studio.find("X"), undefined);
  }));

test("invalid JSON leaves Studio untouched and the file in place, logged once", () =>
  withMirror(async ({ studio, f, read }) => {
    fs.writeFileSync(f("Workspace", "Baseplate.Part.json"), "{ oops");
    await until(() => errorsLog(read).includes("invalid JSON"), "logged");
    assert.equal(studio.applies.length, 0);
    assert.equal(read("Workspace", "Baseplate.Part.json"), "{ oops");
  }));

test("deleting a file destroys one instance", () =>
  withMirror(async ({ studio, f }) => {
    const id = studio.find("Baseplate").i;
    fs.rmSync(f("Workspace", "Baseplate.Part.json"));
    await until(() => studio.applies.length === 1, "destroy");
    assert.deepEqual(studio.applies[0], [{ op: "destroy", id }]);
  }));

test("a mass delete is refused, reported and restored", () =>
  withMirror(async ({ m, studio, f, read }) => {
    fs.rmSync(f("ReplicatedStorage", "Box"), { recursive: true });
    await until(() => m.status().refusedDeletes.length === 1, "refused");
    assert.equal(studio.applies.length, 0);
    await until(() => errorsLog(read).includes("REFUSED"), "logged");
    await until(() => fs.existsSync(f("ReplicatedStorage", "Box", "V7.IntValue.json")), "restored");
  }));

test("removing a service directory or the whole mirror is refused", () =>
  withMirror(async ({ m, studio, f, dir, read }) => {
    fs.rmSync(f("StarterGui"), { recursive: true });
    await until(() => m.status().refusedDeletes.length === 1, "service refused");
    await until(() => fs.existsSync(f("StarterGui", "Hud.gui", "gui.json")), "service restored");
    fs.rmSync(dir, { recursive: true, force: true });
    await until(() => fs.existsSync(f("AGENTS.md")) && m.status().refusedDeletes.length === 2, "root refused and restored");
    assert.equal(studio.applies.length, 0);
    await until(() => errorsLog(read).includes("REFUSED"), "logged");
  }));

test("links inside the mirror are not followed", () =>
  withMirror(async ({ studio, f }) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-out-"));
    fs.writeFileSync(path.join(outside, "S.server.luau"), "print('x')");
    fs.symlinkSync(outside, f("ReplicatedStorage", "Linked"), "junction");
    await sleep(400);
    assert.equal(studio.find("S"), undefined);
    assert.equal(studio.find("Linked"), undefined);
    fs.rmSync(f("ReplicatedStorage", "Linked"), { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }));

test("a non-empty folder that is not a mirror is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-mirror-"));
  fs.writeFileSync(path.join(dir, "thesis.docx"), "mine");
  const m = new MirrorSession({ dir }, place().send, "P");
  await assert.rejects(m.start(), /not empty/);
  assert.equal(fs.readFileSync(path.join(dir, "thesis.docx"), "utf8"), "mine");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- API coverage
test("every writable property type in the API dump is handled by the codec", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const api = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "plugin", "tests", "api.json"), "utf8"));
  const codec = fs.readFileSync(path.join(here, "..", "..", "plugin", "src", "Codec.lua"), "utf8");
  const decode = codec.slice(codec.indexOf("function Codec.decode"), codec.indexOf("function Codec.encode"));
  const handled = new Set([...decode.matchAll(/t == "([^"]+)"/g)].map((m) => m[1]));
  const seen = new Map();
  for (const [cls, c] of Object.entries(api.classes)) {
    for (const [prop, t] of Object.entries(c.props)) {
      if (t.startsWith("Enum:") || handled.has(t)) continue;
      if (!seen.has(t)) seen.set(t, `${cls}.${prop}`);
    }
  }
  const missing = Object.fromEntries(seen);
  console.log("property types the codec does not decode:", JSON.stringify(missing));
  assert.deepEqual(Object.keys(missing).sort(), []);
});
