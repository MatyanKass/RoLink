// Call a RoLink tool on the running bridge: node tools/live.mjs <tool> '<json args>' [imgOutDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [tool, json = "{}", outDir] = process.argv.slice(2);
const port = process.env.ROLINK_PORT ?? 34872;
// same rule as tokenDir() in server/src/bridge.ts: per-user temp on Windows, a 0700 folder elsewhere
const tokenDir =
  process.platform === "win32" ? os.tmpdir() : process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, "rolink") : path.join(os.homedir(), ".rolink");
const tokenFile = path.join(tokenDir, `rolink-${port}.token`);
const mine = (st) => process.platform === "win32" || (st.uid === process.getuid() && (st.mode & 0o077) === 0);
let token;
try {
  const st = fs.lstatSync(tokenFile);
  if (!st.isFile() || !mine(st) || !mine(fs.lstatSync(tokenDir))) throw new Error("not private");
  token = fs.readFileSync(tokenFile, "utf8").trim();
} catch {
  console.log(`ERROR: no token file at ${tokenFile}; is the RoLink server running on port ${port}?`);
  process.exit(1);
}
const r = await fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", headers: { "content-type": "application/json", "x-rolink-token": token }, body: JSON.stringify({ tool, args: JSON.parse(json) }) });
const b = await r.json();
if (!b.ok) { console.log("ERROR:", b.error); process.exit(1); }
console.log(b.result.text);
(b.result.images ?? []).forEach((img, i) => {
  const f = path.join(outDir ?? ".", `shot-${i}.jpg`);
  fs.writeFileSync(f, Buffer.from(img.data, "base64"));
  console.log("image:", f, img.label);
});
