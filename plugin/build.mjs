// Packs plugin/src into RoLink.rbxmx (a Folder with the Main Script and its
// ModuleScripts) and, with --install, copies it into Studio's plugins folder.
//   node plugin/build.mjs [--install]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "src");
const dist = path.join(here, "dist");
const out = path.join(dist, "RoLink.rbxmx");

const cdata = (s) => "<![CDATA[" + s.replaceAll("]]>", "]]]]><![CDATA[>") + "]]>";
const esc = (s) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

let ref = 0;
function item(cls, name, source, children = "") {
  const props = [`<string name="Name">${esc(name)}</string>`];
  if (source !== undefined) props.push(`<ProtectedString name="Source">${cdata(source)}</ProtectedString>`);
  return `<Item class="${cls}" referent="RBX${ref++}"><Properties>${props.join("")}</Properties>${children}</Item>`;
}

const files = fs.readdirSync(src).filter((f) => f.endsWith(".lua") || f.endsWith(".luau")).sort();
let kids = "";
for (const f of files) {
  const text = fs.readFileSync(path.join(src, f), "utf8");
  const m = /^(.*?)(\.server)?\.(lua|luau)$/.exec(f);
  kids += item(m[2] ? "Script" : "ModuleScript", m[1], text);
}

const xml =
  `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
  `xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">` +
  item("Folder", "RoLink", undefined, kids) +
  `</roblox>`;

fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(out, xml);
console.log(`built ${out} (${files.length} scripts, ${xml.length} bytes)`);

if (process.argv.includes("--install")) {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error("LOCALAPPDATA not set");
  const dir = path.join(local, "Roblox", "Plugins");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(out, path.join(dir, "RoLink.rbxmx"));
  console.log(`installed to ${path.join(dir, "RoLink.rbxmx")} — restart Studio (or reopen the place) to load it`);
}
