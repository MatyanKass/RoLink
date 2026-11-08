// The guide tool and the documents it serves: every topic loads, every tool of both
// servers is documented, links resolve, and examples match the real tool schemas.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REFERENCE_PAGES, TOPIC_ORDER, docsRoot, guideText, listTopics, parseHeader, searchGuide, splitSections, topicIds } from "../dist/guide.js";
import { AGENTS_MD, parseDoc } from "../dist/mirrorformat.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, "..");
const repo = path.resolve(server, "..");
const guideDir = path.join(repo, "docs", "guide");
const PORT = 34997;

const REQUIRED = [
  "overview", "install-and-connect", "plugin-internals", "mirror-basics", "mirror-reference", "scripts", "gui", "models-and-parts", "unions-csg",
  "meshes-and-import-model", "materials-textures-decals", "proximity-prompt", "click-detector", "events-remotes-bindables", "sounds",
  "lights-particles-effects", "welds-constraints", "attributes-tags", "terrain", "lighting-atmosphere", "tween-animation-import",
  "playtest-and-scenarios", "output-and-debugging", "editor-tools", "perf", "toolbox-quarantine", "publishing-assets",
  "publishing-places-datastores", "property-types", "sync-rojo", "security-and-trust", "troubleshooting", "limits-and-known-gaps", "tools-reference",
];

const files = fs.readdirSync(guideDir).filter((f) => f.endsWith(".md"));
const docs = files.map((f) => ({ file: f, text: fs.readFileSync(path.join(guideDir, f), "utf8") }));

/** Fenced blocks of a markdown text: { info, body }. */
function fences(text) {
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^```(.*)$/.exec(line);
    if (m && !cur) cur = { info: m[1].trim(), lines: [] };
    else if (m) {
      out.push({ info: cur.info, body: cur.lines.join("\n") });
      cur = null;
    } else if (cur) cur.lines.push(line);
  }
  assert.equal(cur, null, "unterminated code fence");
  return out;
}

const withoutFences = (text) => text.replace(/^```[\s\S]*?^```/gm, "");

/** GitHub's heading anchor. */
const slug = (h) => h.trim().toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

function anchorsOf(text) {
  return new Set([...withoutFences(text).matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => slug(m[1])));
}

/** Tool names registered in a server's source. */
function registeredTools(file, pattern) {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(pattern)].map((m) => m[1]);
}

const rolinkTools = registeredTools(path.join(server, "src", "index.ts"), /(?:^|\n)\s*(?:reg\(\s*|server\.registerTool\(\s*)"([a-z_]+)"/g);
const publishTools = registeredTools(path.join(repo, "publisher", "src", "index.ts"), /\nregister\(\s*"([a-z_]+)"/g);

test("the source scan found the tools", () => {
  for (const t of ["guide", "status", "build", "mirror_start", "playtest_scenario", "generate_model"]) assert.ok(rolinkTools.includes(t), t);
  for (const t of ["prepare_asset", "place_publish", "datastore_delete"]) assert.ok(publishTools.includes(t), t);
});

test("the built server carries its docs", () => {
  assert.equal(path.resolve(docsRoot()), path.join(server, "dist", "docs"));
  for (const f of files) assert.equal(fs.readFileSync(path.join(server, "dist", "docs", "guide", f), "utf8"), fs.readFileSync(path.join(guideDir, f), "utf8"), `${f} is stale in dist; run npm run build`);
});

test("every required topic exists and every file is in the reading order", () => {
  const ids = files.map((f) => f.slice(0, -3));
  for (const t of REQUIRED) assert.ok(ids.includes(t), `missing topic ${t}`);
  assert.deepEqual([...ids].sort(), [...TOPIC_ORDER].sort());
});

test("every topic loads and has a title and a one-line summary", () => {
  for (const id of topicIds()) {
    const text = guideText({ topic: id });
    const { title, summary } = parseHeader(text);
    assert.ok(text.startsWith("# "), `${id} starts with a title`);
    assert.ok(title.length > 0, `${id} title`);
    assert.ok(summary.length > 10 && summary.length < 160, `${id} summary: "${summary}"`);
  }
});

test("guide() lists every topic with its summary and keeps the quick reference", () => {
  const index = guideText();
  for (const t of listTopics()) assert.ok(index.includes(`- ${t.id}: ${t.summary}`), t.id);
  for (const needle of ["repeat", "T.waitFor", "T.teleport", "T.players", "multiplayer_test", "playtest_scenario"]) assert.ok(index.includes(needle), needle);
});

test("topic ids are forgiving and older reference pages still load", () => {
  assert.equal(guideText({ topic: "GUI" }), guideText({ topic: "gui" }));
  assert.equal(guideText({ topic: "gui.md" }), guideText({ topic: "gui" }));
  for (const p of REFERENCE_PAGES) assert.ok(guideText({ topic: p }).length > 100, p);
});

test("a bad topic explains itself", () => {
  assert.throws(() => guideText({ topic: "mirror" }), /no guide topic.*mirror-basics/);
  assert.throws(() => guideText({ topic: "zzzz" }), /Call guide\(\)/);
});

test("section returns only the matching part", () => {
  const out = guideText({ topic: "gui", section: "UIGridLayout" });
  assert.ok(out.includes("CellSize"));
  assert.ok(!out.includes("# GUI\n"));
  assert.throws(() => guideText({ topic: "gui", section: "nothing like this" }), /no section matching.*Its sections/);
  assert.throws(() => guideText({ section: "x" }), /section needs a topic/);
  // a ## heading brings its ### parts along
  assert.ok(guideText({ topic: "gui", section: "Layouts" }).includes("UITableLayout"));
});

test("search returns matching sections from several topics", () => {
  const { hits, total } = searchGuide("AnchorPoint");
  assert.ok(total >= 1);
  assert.ok(hits.every((h) => h.text.toLowerCase().includes("anchorpoint")));
  const text = guideText({ search: "HingeConstraint" });
  assert.match(text, /--- welds-constraints > /);
  // a "## comment" inside a code fence is not a heading
  const parts = splitSections("# T\n\n## A\n\n```bash\n## not a heading\n```\n\n## B\n", "T");
  assert.deepEqual(parts.map((s) => s.path), ["T", "A", "B"]);
});

test("search falls back to all words, can be scoped, and says when it finds nothing", () => {
  const words = searchGuide("acknowledgeFlags quarantine");
  assert.ok(words.hits.length > 0);
  assert.ok(words.hits.every((h) => /acknowledgeflags/i.test(h.text) && /quarantine/i.test(h.text)));
  const scoped = searchGuide("Anchored", { topic: "terrain" });
  assert.ok(scoped.hits.every((h) => h.topic === "terrain"));
  assert.match(guideText({ search: "qqqzzzxxx" }), /No section of the guide matches/);
  assert.throws(() => guideText({ search: "x".repeat(300) }), /longer than/);
});

test("every tool of both servers has a section with an example in tools-reference", () => {
  const ref = fs.readFileSync(path.join(guideDir, "tools-reference.md"), "utf8");
  const calls = fences(ref).filter((f) => f.info === "call").map((f) => f.body.trim().split(/\s/)[0]);
  for (const tool of [...rolinkTools, ...publishTools]) {
    assert.ok(ref.includes(`### \`${tool}\``), `tools-reference has no section for ${tool}`);
    assert.ok(calls.includes(tool), `tools-reference has no example for ${tool}`);
  }
  const known = new Set([...rolinkTools, ...publishTools]);
  for (const m of ref.matchAll(/^### `([a-z_]+)`$/gm)) assert.ok(known.has(m[1]), `${m[1]} is documented but not registered`);
});

test("every guide link resolves, anchors included", () => {
  const pages = [...docs, { file: "../../README.md", text: fs.readFileSync(path.join(repo, "README.md"), "utf8") }];
  for (const { file, text } of pages) {
    const base = path.dirname(path.join(guideDir, file));
    for (const m of withoutFences(text).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const link = m[1];
      if (/^https?:/.test(link)) continue;
      const [target, anchor] = link.split("#");
      const abs = target ? path.resolve(base, target) : path.join(guideDir, file);
      assert.ok(fs.existsSync(abs), `${file}: broken link ${link}`);
      if (anchor) assert.ok(anchorsOf(fs.readFileSync(abs, "utf8")).has(anchor), `${file}: broken anchor ${link}`);
    }
  }
});

test("topics named in the instructions text and in AGENTS.md exist", () => {
  const source = fs.readFileSync(path.join(server, "src", "index.ts"), "utf8");
  const instructions = /const INSTRUCTIONS = `([\s\S]*?)`;/.exec(source)[1];
  const ids = new Set(topicIds());
  const named = [...instructions.matchAll(/Topics?: ([a-z, -]+)/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean));
  assert.ok(named.length >= 8);
  for (const t of named) assert.ok(ids.has(t), `instructions name unknown topic ${t}`);
  const useful = /Useful topics: ([a-z,\s-]+)\./.exec(AGENTS_MD)[1].split(",").map((s) => s.trim());
  for (const t of useful) assert.ok(ids.has(t), `AGENTS.md names unknown topic ${t}`);
  assert.match(AGENTS_MD, /`guide\(\)`/);
});

test("JSON examples parse, and mirror examples are valid mirror files", () => {
  for (const { file, text } of docs) {
    for (const f of fences(text)) {
      const [lang, attr] = f.info.split(/\s+/);
      if (lang !== "json") continue;
      assert.doesNotThrow(() => JSON.parse(f.body), `${file}: bad JSON: ${f.body.slice(0, 80)}`);
      if (attr?.startsWith("file=")) {
        const r = parseDoc(f.body);
        assert.equal(r.error, undefined, `${file}: ${attr}: ${r.error}`);
      }
    }
  }
});

test("no personal paths or secrets in the docs", () => {
  const pages = [...docs, { file: "README.md", text: fs.readFileSync(path.join(repo, "README.md"), "utf8") }];
  for (const { file, text } of pages) {
    assert.doesNotMatch(text, /[A-Z]:[\\/]Users[\\/]/, `${file} has a user path`);
    assert.doesNotMatch(text, /\/home\/[a-z]+\/|\/Users\/[a-z]+\//, `${file} has a user path`);
  }
});

// ------------------------------------------------------------ live schemas

/** A small JSON-schema check, enough for the shapes the servers declare. */
function schemaError(schema, value, where) {
  if (schema.anyOf) return schema.anyOf.some((s) => !schemaError(s, value, where)) ? null : `${where}: matches no alternative`;
  if (schema.enum && !schema.enum.includes(value)) return `${where}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`;
  switch (schema.type) {
    case "string":
      return typeof value === "string" ? null : `${where}: expected a string`;
    case "number":
      return typeof value === "number" ? null : `${where}: expected a number`;
    case "integer":
      return Number.isInteger(value) ? null : `${where}: expected an integer`;
    case "boolean":
      return typeof value === "boolean" ? null : `${where}: expected a boolean`;
    case "array": {
      if (!Array.isArray(value)) return `${where}: expected an array`;
      for (let i = 0; i < value.length; i++) {
        const e = schema.items && schemaError(schema.items, value[i], `${where}[${i}]`);
        if (e) return e;
      }
      return null;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${where}: expected an object`;
      for (const k of schema.required ?? []) if (!(k in value)) return `${where}: missing ${k}`;
      if (schema.properties) {
        for (const [k, v] of Object.entries(value)) {
          if (!schema.properties[k]) {
            if (typeof schema.additionalProperties === "object") continue;
            return `${where}: unknown argument ${k}`;
          }
          const e = schemaError(schema.properties[k], v, `${where}.${k}`);
          if (e) return e;
        }
      }
      return null;
    }
  }
  return null;
}

let rolink;
let publish;
const schemas = new Map();
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-guide-test-"));

async function connect(entry, env) {
  const c = new Client({ name: "guide-test", version: "0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, ...env }, stderr: "ignore" }));
  return c;
}

before(async () => {
  rolink = await connect(path.join(server, "dist", "index.js"), { ROLINK_PORT: String(PORT), ROBLOX_API_KEY: "" });
  for (const t of (await rolink.listTools()).tools) schemas.set(t.name, t.inputSchema);
  const publisher = path.join(repo, "publisher", "dist", "index.js");
  if (fs.existsSync(publisher)) {
    publish = await connect(publisher, { ROLINK_PORT: String(PORT), ROLINK_PUBLISH_STATE_DIR: stateDir, ROBLOX_PUBLISH_API_KEY: "" });
    for (const t of (await publish.listTools()).tools) schemas.set(t.name, t.inputSchema);
  }
});

after(async () => {
  await rolink?.close();
  await publish?.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("the guide tool works over MCP", async () => {
  const index = await rolink.callTool({ name: "guide", arguments: {} });
  assert.match(index.content[0].text, /- gui: /);
  const topic = await rolink.callTool({ name: "guide", arguments: { topic: "terrain" } });
  assert.match(topic.content[0].text, /^# Terrain/);
  const found = await rolink.callTool({ name: "guide", arguments: { search: "ProximityPrompt" } });
  assert.match(found.content[0].text, /--- proximity-prompt > /);
  const bad = await rolink.callTool({ name: "guide", arguments: { topic: "nope" } });
  assert.equal(bad.isError, true);
});

test("the instructions are a compact index", () => {
  const text = rolink.getInstructions();
  assert.ok(text.length < 2200, `instructions are ${text.length} characters`);
  for (const needle of ["guide()", "mirror_start", "AGENTS.md", "untrusted"]) assert.ok(text.includes(needle), needle);
});

test("every tool example matches the tool's real schema", () => {
  let checked = 0;
  for (const { file, text } of docs) {
    for (const f of fences(text)) {
      if (f.info !== "call") continue;
      for (const block of f.body.split(/\n\s*\n/)) {
        const m = /^\s*([a-z_]+)\s+([\s\S]+)$/.exec(block);
        assert.ok(m, `${file}: malformed call block: ${block.slice(0, 80)}`);
        const [, tool, json] = m;
        assert.ok(rolinkTools.includes(tool) || publishTools.includes(tool), `${file}: unknown tool ${tool}`);
        let args;
        assert.doesNotThrow(() => (args = JSON.parse(json)), `${file}: bad JSON for ${tool}: ${json.slice(0, 80)}`);
        const schema = schemas.get(tool);
        if (!schema) continue; // publisher not built
        const e = schemaError(schema, args, tool);
        assert.equal(e, null, `${file}: ${e}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 100, `only ${checked} examples checked`);
});
