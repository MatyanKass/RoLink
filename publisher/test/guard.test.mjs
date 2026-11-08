// Process-level handling: run in a child so a failure cannot take the test runner with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const guard = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "guard.js")).href;
const run = (body) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", `const { installProcessGuards } = await import(${JSON.stringify(guard)});\n${body}`], { encoding: "utf8", timeout: 20_000 });

test("after startup a stray rejection or exception is logged and the process continues", () => {
  const r = run(`
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
  const r = run(`
    installProcessGuards((...a) => console.error(...a));
    setTimeout(() => { throw new Error("broken at startup"); }, 5);
    setTimeout(() => { console.log("alive"); process.exit(0); }, 200);
  `);
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stdout, /alive/);
  assert.match(r.stderr, /broken at startup/);
});
