// Drives the real bin over stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RU_AUDIO, tmpDir, wav, writeFile } from "./helpers.mjs";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const text = (r) => r.content.map((c) => c.text).join("\n");

async function connect(t, env = {}) {
  const c = new Client({ name: "t", version: "0" });
  const clean = { ...process.env, ROLINK_PUBLISH_STATE_DIR: tmpDir(), ROLINK_PORT: "1", ...env };
  delete clean.ROBLOX_PUBLISH_API_KEY;
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: clean, stderr: "ignore" }));
  t.after(() => c.close());
  return c;
}

test("exposes exactly the agreed tools", async (t) => {
  const c = await connect(t);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ["place_publish", "place_save", "prepare_asset", "publish_asset", "publish_status"]);
});

test("no tool can change privacy or make a game public", async (t) => {
  const c = await connect(t);
  const { tools } = await c.listTools();
  for (const x of tools) assert.doesNotMatch(x.name, /privacy|public|visib|activate/i);
});

test("descriptions tell the agent to wait for the user's typed phrase", async (t) => {
  const c = await connect(t);
  const { tools } = await c.listTools();
  for (const name of ["prepare_asset", "publish_asset"]) {
    const d = tools.find((x) => x.name === name).description;
    assert.match(d, /show .*summary.* user/i, name);
    assert.match(d, /wait/i, name);
    assert.match(d, /type/i, name);
  }
});

test("prepare_asset over stdio returns the summary and the phrase", async (t) => {
  const c = await connect(t);
  const f = writeFile(tmpDir(), "s.wav", wav(2));
  const r = await c.callTool({ name: "prepare_asset", arguments: { path: f, kind: "audio", name: "S" } });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), new RegExp(RU_AUDIO));
  assert.match(text(r), /did not run/i);
});

test("errors come back as tool errors", async (t) => {
  const c = await connect(t);
  const r = await c.callTool({ name: "publish_asset", arguments: { prepareId: "x", confirmation: "y" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /unknown prepareId/i);
});
