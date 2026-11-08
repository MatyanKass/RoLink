// Unit + property tests for the file mirror. Build first: `npm run build`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { assignTokens, decodeToken, encodeName, splitDup } from "../dist/mirrorname.js";
import { formatJson, parseDoc } from "../dist/mirrorformat.js";

// tiny seeded generator (the project has no PBT library; deterministic, prints the seed on failure)
function rng(seed) {
  let s = seed >>> 0;
  return (n) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 8) % n;
  };
}
const TRICKY = ["..", ".", "/", "\\", ":", "*", "?", '"', "<", ">", "|", "%", "~", "+", "@", " ", "\t", "\u0000", "\u007f", "é", "日本", "😀", "CON", "con", "nul", "COM1", "LPT9", "server", "client", "init", "model", "_props", "_model", "_tree", "_errors", "AGENTS", "a", "Z", "0", "~2", "%41", ".model", ".json"];
function genName(r) {
  let out = "";
  for (let i = r(5); i >= 0; i--) out += r(2) ? TRICKY[r(TRICKY.length)] : String.fromCharCode(32 + r(95));
  return out;
}
function property(name, fn, runs = 3000) {
  test(name, () => {
    for (let seed = 1; seed <= runs; seed++) {
      try {
        fn(rng(seed * 7919));
      } catch (e) {
        e.message = `seed ${seed}: ${e.message}`;
        throw e;
      }
    }
  });
}

property("encoded names decode back exactly", (r) => {
  const name = genName(r);
  assert.equal(decodeToken(encodeName(name)), name);
});

property("an encoded name is one safe path component for any input", (r) => {
  const t = encodeName(genName(r));
  assert.ok(t.length > 0);
  assert.doesNotMatch(t, /[\/\\:*?"<>|\x00-\x1f\x7f.~]/);
  assert.doesNotMatch(t, /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|server|client|init|model|gui|_props|_model|_tree|_errors|agents)$/i);
  assert.doesNotMatch(t, /^ | $/);
});

property("sibling tokens are unique ignoring case and keep their names", (r) => {
  const pool = [genName(r), genName(r), "Wall", "wall", "WALL"];
  const names = Array.from({ length: 1 + r(12) }, () => pool[r(pool.length)]);
  const tokens = assignTokens(names);
  assert.equal(new Set(tokens.map((t) => t.toLowerCase())).size, names.length);
  tokens.forEach((t, i) => assert.equal(decodeToken(splitDup(t).base), names[i]));
});

test("duplicates get ~N in order and literal tildes cannot collide", () => {
  assert.deepEqual(assignTokens(["Wall", "Wall", "Wall"]), ["Wall", "Wall~2", "Wall~3"]);
  assert.deepEqual(splitDup("Wall~3"), { base: "Wall", n: 3 });
  assert.equal(encodeName("Wall~2"), "Wall%7E2");
});

test("empty name and malformed escapes", () => {
  assert.equal(decodeToken(encodeName("")), "");
  assert.equal(decodeToken("50%off"), "50%off"); // hand-written file: stray % stays literal
});

// ---------------------------------------------------------------- JSON
function genValue(r, depth = 0) {
  switch (r(depth > 3 ? 4 : 6)) {
    case 0:
      return r(2) === 0;
    case 1:
      return r(20000) / 100 - 100;
    case 2:
      return genName(r);
    case 3:
      return null;
    case 4:
      return Array.from({ length: r(5) }, () => genValue(r, depth + 1));
    default:
      return Object.fromEntries(Array.from({ length: r(5) }, () => [genName(r) + "k", genValue(r, depth + 1)]));
  }
}
property("formatJson output parses back to the same value", (r) => {
  const v = genValue(r);
  assert.deepEqual(JSON.parse(formatJson(v)), v);
});

test("formatJson keeps a small part on one line and expands the root", () => {
  const text = formatJson({ children: [{ name: "A", class: "Part", Size: [1, 2, 3] }] });
  assert.ok(text.includes('{"name":"A","class":"Part","Size":[1,2,3]}'));
  assert.ok(text.split("\n").length >= 4);
});

test("parseDoc rejects broken and hostile documents with a reason", () => {
  assert.match(parseDoc("{nope").error, /JSON/i);
  assert.match(parseDoc("[1]").error, /object/);
  assert.match(parseDoc('{"Foo":1,"__proto__":{"x":1}}').error, /__proto__/);
  assert.match(parseDoc('{"Parent":"x"}').error, /Parent/);
  assert.match(parseDoc('{"children":[{"class":"Part"}]}').error, /name/);
  assert.match(parseDoc('{"bogus":1}').error, /bogus/);
});

test("parseDoc ignores _info and returns the rest", () => {
  const d = parseDoc('{"Anchored":false,"attrs":{"A":1},"tags":["T"],"children":[{"name":"P","class":"Part","Size":[1,1,1]}],"_info":{"x":1}}').doc;
  assert.deepEqual(d.props, { Anchored: false });
  assert.deepEqual(d.attrs, { A: 1 });
  assert.deepEqual(d.tags, ["T"]);
  assert.equal(d.children[0].name, "P");
  assert.equal(d.children[0].props.Size[2], 1);
});
