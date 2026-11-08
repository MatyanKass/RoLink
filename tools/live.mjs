// Call a RoLink tool on the running bridge: node tools/live.mjs <tool> '<json args>' [imgOutDir]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [tool, json = "{}", outDir] = process.argv.slice(2);
const port = process.env.ROLINK_PORT ?? 34872;
const tokenFile = path.join(os.tmpdir(), `rolink-${port}.token`);
let token;
try {
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
