// Copies docs/ into dist/docs so a built server carries its guide with it.
// Runs after tsc in `npm run build`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.resolve(server, "..", "docs");
const to = path.join(server, "dist", "docs");

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(path.join(to, "guide"), { recursive: true });

let copied = 0;
for (const dir of ["", "guide"]) {
  for (const entry of fs.readdirSync(path.join(from, dir), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    fs.copyFileSync(path.join(from, dir, entry.name), path.join(to, dir, entry.name));
    copied++;
  }
}
console.log(`copied ${copied} guide files to ${path.relative(server, to)}`);
