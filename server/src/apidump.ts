// Roblox API dump → a compact class/property table.
//
// The plugin uses it to (a) know the value type of every property so JSON values
// can be decoded precisely, and (b) know which properties to emit when it
// serializes an existing instance back to JSON. The dump is downloaded once and
// cached; Studio has no reliable reflection API of its own.

import fs from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR, log } from "./config.js";

const DUMP_URL = "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/API-Dump.json";
const DUMP_FILE = path.join(CACHE_DIR, "API-Dump.json");
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

export interface ReadDumpOptions {
  file?: string;
  fetchFn?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  retryDelayMs?: number;
}

/** prop name → type string. Types: "bool" "number" "string" "ref" "Enum:<Name>" or a datatype name. */
export interface CompactClass {
  super: string | null;
  props: Record<string, string>;
}
export interface CompactApi {
  version: number;
  classes: Record<string, CompactClass>;
}

const SKIP_TYPES = new Set([
  "Content", // newer twin of ContentId properties; we use the ContentId side
  "ProtectedString", // Source is handled explicitly
  "BinaryString",
  "UniqueId",
  "SecurityCapabilities",
  "DateTime",
  "Path2DControlPoint",
  "Region3int16",
  "QFont",
  "QDir",
  "User",
  "TweenInfo",
  "Ray",
]);
const SKIP_PROPS = new Set(["Parent", "Name", "Archivable", "SourceAssetId", "Capabilities", "Sandboxed"]);
const RUNTIME_PROPS = new Set(["Rotation", "TimePosition", "Transform", "Health", "Jump", "CurrentAngle"]);
const OK_SECURITY =new Set(["None", "PluginSecurity"]);

let cached: Promise<CompactApi> | undefined;

export function getApi(): Promise<CompactApi> {
  cached ??= load().catch((e) => {
    cached = undefined;
    throw e;
  });
  return cached;
}

async function load(): Promise<CompactApi> {
  const raw = await readDump();
  return compact(raw);
}

export async function readDump(opts: ReadDumpOptions = {}): Promise<any> {
  const file = opts.file ?? DUMP_FILE;
  const fetchFn = opts.fetchFn ?? fetch;
  const delay = opts.retryDelayMs ?? RETRY_DELAY_MS;
  let stale = true;
  try {
    const st = await fs.stat(file);
    stale = Date.now() - st.mtimeMs > MAX_AGE_MS;
  } catch {}
  let failure: unknown;
  for (let attempt = 1; stale && attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      log("downloading Roblox API dump…");
      const r = await fetchFn(DUMP_URL);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = await r.text();
      JSON.parse(text); // validate before caching
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
      failure = undefined;
      break;
    } catch (e) {
      failure = e;
      log(`API dump download failed (attempt ${attempt}/${FETCH_ATTEMPTS}):`, String(e));
      if (attempt < FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, delay * attempt));
    }
  }
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    throw new Error(`the Roblox API dump is unavailable: nothing cached at ${file} and the download failed (${String(failure)})`);
  }
  return JSON.parse(text);
}

function typeOf(vt: { Category: string; Name: string }): string | null {
  switch (vt.Category) {
    case "Primitive":
      if (vt.Name === "bool") return "bool";
      if (vt.Name === "string") return "string";
      return "number";
    case "Enum":
      return `Enum:${vt.Name}`;
    case "Class":
      return "ref";
    case "DataType":
      return SKIP_TYPES.has(vt.Name) ? null : vt.Name;
  }
  return null;
}

function compact(raw: any): CompactApi {
  const classes: Record<string, CompactClass> = {};
  for (const c of raw.Classes) {
    const props: Record<string, string> = {};
    for (const m of c.Members) {
      if (m.MemberType !== "Property" || SKIP_PROPS.has(m.Name)) continue;
      const tags: string[] = m.Tags ?? [];
      if (tags.includes("ReadOnly") || tags.includes("NotScriptable") || tags.includes("Deprecated") || tags.includes("Hidden"))
        continue;
      if (!m.Serialization?.CanLoad) continue;
      if (!m.Serialization.CanSave) {
        // Canonical props whose saved form is an internal twin (Size/"size",
        // Color/Color3uint8, Shape/"shape") — keep those, drop derived/runtime state.
        if (/Derived|Assembly/.test(m.Category ?? "") || RUNTIME_PROPS.has(m.Name)) continue;
        if (m.ValueType?.Name === "BrickColor") continue;
      }
      const sec = m.Security ?? {};
      if (!OK_SECURITY.has(sec.Read) || !OK_SECURITY.has(sec.Write)) continue;
      if (c.Name.startsWith("Plugin")) continue;
      const t = typeOf(m.ValueType);
      if (t) props[m.Name] = t;
    }
    classes[c.Name] = { super: c.Superclass && c.Superclass !== "<<<ROOT>>>" ? c.Superclass : null, props };
  }
  return { version: 1, classes };
}

/** All serializable props of a class including inherited ones. */
export function propsOf(api: CompactApi, className: string): Record<string, string> {
  const out: Record<string, string> = {};
  const chain: CompactClass[] = [];
  let c: string | null = className;
  while (c && api.classes[c]) {
    chain.push(api.classes[c]);
    c = api.classes[c].super;
  }
  for (const k of chain.reverse()) Object.assign(out, k.props);
  return out;
}

export function isA(api: CompactApi, className: string, base: string): boolean {
  let c: string | null = className;
  while (c) {
    if (c === base) return true;
    c = api.classes[c]?.super ?? null;
  }
  return false;
}
