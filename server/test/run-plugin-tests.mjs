// Runs the plugin's Lune test suite (plugin/tests/run.luau) on any OS.
//   npm run test:plugin
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const testsDir = path.join(repo, "plugin", "tests");
const local = path.join(repo, "tools", "bin", process.platform === "win32" ? "lune.exe" : "lune");
const lune = fs.existsSync(local) ? local : "lune";

const r = spawnSync(lune, ["run", "run.luau"], { cwd: testsDir, stdio: "inherit" });
if (r.error) {
  console.error(`could not start ${lune}: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
