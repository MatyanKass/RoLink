// Reversible Instance name <-> file name encoding for the mirror.
//
// A token is one instance name as it appears in a path. Every "." in a file
// name is structural, so "." is escaped inside a name; likewise "~" (duplicate
// suffix), "%" (escape) and "+" (owner path separator). Anything illegal on
// Windows is escaped the same way as %XX, so a token can never traverse paths.

import { createHash } from "node:crypto";
import { safeFileName } from "./sync.js";

const ESCAPE = /[<>:"/\\|?*%~.+\x00-\x1f\x7f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|server|client|init|model|gui|_props|_model|_tree|_errors|agents)$/i;
const hex = (c: string) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");

export function encodeName(name: string): string {
  if (name === "") return "%_";
  let t = name.replace(ESCAPE, hex);
  if (t.startsWith(" ")) t = "%20" + t.slice(1);
  if (t.endsWith(" ")) t = t.slice(0, -1) + "%20";
  if (RESERVED.test(t)) t = hex(t[0]) + t.slice(1);
  return t;
}

export function decodeToken(token: string): string {
  if (token === "%_") return "";
  return token.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function splitDup(token: string): { base: string; n: number } {
  const m = /^(.*)~(\d+)$/.exec(token);
  return m ? { base: m[1], n: Number(m[2]) } : { base: token, n: 1 };
}

/** Longest token; with a class suffix or owner prefix a file name stays under safeFileName's limit. */
export const MAX_TOKEN = 100;

export const shortHash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** Over-long encodings keep their start plus a hash of the name: stable and collision-free in practice. */
function fitToken(name: string, t: string): string {
  if (t.length <= MAX_TOKEN) return t;
  const suffix = `~h${shortHash(name)}`;
  let cut = MAX_TOKEN - suffix.length;
  // never end inside a %XX escape or a surrogate pair
  if (t[cut - 1] === "%") cut -= 1;
  else if (t[cut - 2] === "%") cut -= 2;
  const last = t.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return t.slice(0, cut) + suffix;
}

/**
 * File tokens for siblings, in order: the 2nd "Wall" is "Wall~2". Unique ignoring case (NTFS).
 * `longNames` receives, for every shortened token, its decoded form -> the real name, because a
 * shortened token cannot be decoded back on its own.
 */
export function assignTokens(names: string[], longNames?: Map<string, string>): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const encoded = encodeName(name);
    const t = fitToken(name, encoded);
    if (t !== encoded) longNames?.set(decodeToken(t).toLowerCase(), name);
    const k = t.toLowerCase();
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? t : `${t}~${n}`;
  });
}

/** Last line of defence for anything derived from Studio before it touches the disk. */
export function safeComponent(fileName: string): boolean {
  return safeFileName(fileName);
}

/** A name that arrived from a file (agents write these). Roblox limits names to 100 chars. */
export function nameProblem(name: string): string | null {
  if (name.length === 0) return "empty name";
  if (name.length > 100) return "name longer than 100 characters";
  if (/[\x00-\x1f\x7f]/.test(name)) return "control characters in name";
  return null;
}
