// Editor helpers that map one-to-one onto a plugin op, plus script_outline,
// which reads a script's Source and parses it here.

type Args = Record<string, any>;
type Op = (op: string, payload: unknown, timeoutMs?: number) => Promise<any>;

const FORWARDED: Record<string, string[]> = {
  align: ["paths", "path", "axis", "to", "relativeTo", "value"],
  distribute: ["paths", "path", "axis", "spacing"],
  weld_model: ["path", "root", "unanchor"],
  set_collision_groups: ["register", "rules", "assign"],
  select_and_focus: ["paths", "path", "view", "distance", "fov"],
  script_search: ["query", "root", "pattern", "caseSensitive", "limit"],
  script_diagnostics: ["paths", "path"],
  generate_model: ["prompt", "image", "name", "parent", "size", "maxTriangles", "textures", "parts", "predefined", "at"],
};

const TIMEOUT_MS: Record<string, number> = { generate_model: 300_000, script_search: 60_000, script_diagnostics: 120_000 };

function pick(a: Args, keys: string[]) {
  const o: Args = {};
  for (const k of keys) if (a[k] !== undefined) o[k] = a[k];
  return o;
}

export async function editorTool(tool: string, args: Args, op: Op): Promise<{ text: string }> {
  if (tool === "script_outline") {
    const r = await op("get", { path: args.path, props: [], source: true });
    const source = r?.props?.Source;
    if (typeof source !== "string") throw new Error(`${r?.path ?? args.path} is a ${r?.class ?? "non-script"}, not a script with Source.`);
    return { text: JSON.stringify({ path: r.path, class: r.class, ...scriptOutline(source) }) };
  }
  const keys = FORWARDED[tool];
  if (!keys) throw new Error(`unknown editor tool ${tool}`);
  return { text: JSON.stringify(await op(tool, pick(args, keys), TIMEOUT_MS[tool])) };
}

/**
 * Same length and same line breaks as `src`, with comments blanked and string
 * contents blanked but their quotes kept, so positions map back onto `src`.
 */
function blankLiterals(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  const longClose = (i: number): number | undefined => {
    const m = /^\[(=*)\[/.exec(src.slice(i, i + 16));
    if (!m) return undefined;
    const end = src.indexOf(`]${m[1]}]`, i + m[0].length);
    return end === -1 ? src.length : end + m[1].length + 2;
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "-" && src[i + 1] === "-") {
      const long = longClose(i + 2);
      const stop = long ?? ((src.indexOf("\n", i) + 1 || src.length + 1) - 1);
      blank(i, stop);
      i = stop;
    } else if (c === "[" && longClose(i) !== undefined) {
      const stop = longClose(i)!;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, src.length));
      i = Math.min(j, src.length) + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

export interface ScriptOutline {
  lines: number;
  functions: { name: string; line: number; params: string; local: boolean }[];
  locals: { name: string; line: number }[];
  services: { name: string; line: number }[];
  requires: { target: string; line: number }[];
}

const LOCAL_FUNCTION = /^\s*local\s+function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
const NAMED_FUNCTION = /(?:^|[\s;])function\s+([\w.:]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
const ASSIGNED_FUNCTION = /^\s*(local\s+)?([\w.:]+)\s*(?::[^=]*)?=\s*function\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
const LOCAL_NAMES = /^\s*local\s+([^=]+?)\s*(?:=|$)/;
const SERVICE = /GetService\(\s*["'`](\s*)["'`]\s*\)/g;
const REQUIRE = /\brequire\s*\(\s*([^)]*?)\s*\)/g;
const BLOCK = /\b(function|do|if|repeat|end|until)\b/g;

/** Pure text analysis of Luau source: no parser, so unusual formatting can be missed. */
export function scriptOutline(source: string): ScriptOutline {
  const clean = blankLiterals(source).split("\n");
  const raw = source.split("\n");
  const out: ScriptOutline = { lines: raw.length, functions: [], locals: [], services: [], requires: [] };
  let depth = 0;
  clean.forEach((text, i) => {
    const line = i + 1;
    let m: RegExpExecArray | null;
    if ((m = LOCAL_FUNCTION.exec(text))) out.functions.push({ name: m[1], line, params: m[2].trim(), local: true });
    else if ((m = NAMED_FUNCTION.exec(text))) out.functions.push({ name: m[1], line, params: m[2].trim(), local: false });
    else if (depth === 0 && (m = ASSIGNED_FUNCTION.exec(text))) out.functions.push({ name: m[2], line, params: m[3].trim(), local: !!m[1] });
    else if (depth === 0 && (m = LOCAL_NAMES.exec(text))) {
      const names = m[1].includes(":") ? [m[1].split(":")[0]] : m[1].split(",");
      for (const name of names.map((n) => n.trim().replace(/<.*$/, ""))) if (/^\w+$/.test(name)) out.locals.push({ name, line });
    }
    for (const s of text.matchAll(SERVICE)) {
      const open = s.index + s[0].search(/["'`]/) + 1;
      out.services.push({ name: raw[i].slice(open, open + s[1].length), line });
    }
    for (const r of text.matchAll(REQUIRE)) {
      const from = r.index + r[0].indexOf(r[1], "require".length);
      out.requires.push({ target: raw[i].slice(from, from + r[1].length), line });
    }
    for (const b of text.matchAll(BLOCK)) depth += b[1] === "end" || b[1] === "until" ? -1 : 1;
  });
  return out;
}
