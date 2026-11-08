import { test } from "node:test";
import assert from "node:assert/strict";
import { editorTool, scriptOutline } from "../dist/editor.js";

test("outline lists functions with their line numbers", () => {
  const o = scriptOutline(`local M = {}

local function helper(a)
end

function M.run(x, y)
end

function M.sub.deep:method()
end

M.handler = function(z) end

local cb = function() end

return M`);
  assert.deepEqual(
    o.functions.map((f) => [f.name, f.line, f.params, f.local]),
    [
      ["helper", 3, "a", true],
      ["M.run", 6, "x, y", false],
      ["M.sub.deep:method", 9, "", false],
      ["M.handler", 12, "z", false],
      ["cb", 14, "", true],
    ],
  );
});

test("outline finds services and requires", () => {
  const o = scriptOutline(`local Players = game:GetService("Players")
local Util = require(script.Parent.Util)
local Other = require(game.ReplicatedStorage.Other)`);
  assert.deepEqual(o.services, [{ name: "Players", line: 1 }]);
  assert.deepEqual(o.requires, [
    { target: "script.Parent.Util", line: 2 },
    { target: "game.ReplicatedStorage.Other", line: 3 },
  ]);
});

test("outline lists top-level locals but not nested ones", () => {
  const o = scriptOutline(`local Speed = 10
local a, b = 1, 2
function f()
  local inner = 1
  if x then
    local deeper = 2
  end
end
local After = 3`);
  assert.deepEqual(o.locals.map((l) => [l.name, l.line]), [["Speed", 1], ["a", 2], ["b", 2], ["After", 9]]);
});

test("outline ignores code inside comments and strings", () => {
  const o = scriptOutline(`-- function commented()
--[[ function blockComment()
end ]]
local s = "function inString()"
local long = [[
function longString()
]]
--[==[ function levelled() ]==]
function real() end`);
  assert.deepEqual(o.functions.map((f) => f.name), ["real"]);
  assert.equal(o.lines, 9);
});

test("outline keeps correct line numbers after a multi-line string", () => {
  const o = scriptOutline(`local a = [[
one
two]]
function after() end`);
  assert.equal(o.functions[0].line, 4);
});

test("a block keyword in a string does not unbalance the nesting", () => {
  const o = scriptOutline(`function f()
  print("if then do")
end
local Top = 1`);
  assert.deepEqual(o.locals.map((l) => l.name), ["Top"]);
});

test("script_outline reads the source through get and parses it", async () => {
  const calls = [];
  const r = await editorTool("script_outline", { path: "ServerScriptService/Main" }, async (op, payload) => {
    calls.push({ op, payload });
    return { path: "ServerScriptService/Main", class: "Script", props: { Source: "function go() end" } };
  });
  assert.equal(calls[0].op, "get");
  assert.equal(calls[0].payload.path, "ServerScriptService/Main");
  assert.deepEqual(calls[0].payload.props, []);
  const out = JSON.parse(r.text);
  assert.equal(out.path, "ServerScriptService/Main");
  assert.equal(out.class, "Script");
  assert.equal(out.functions[0].name, "go");
});

test("script_outline on something without Source says so", async () => {
  await assert.rejects(editorTool("script_outline", { path: "Workspace/Part" }, async () => ({ path: "Workspace/Part", class: "Part", props: {} })), /script/i);
});

test("the plugin-backed tools forward their arguments and nothing else", async () => {
  const calls = [];
  const op = async (name, payload, timeoutMs) => {
    calls.push({ name, payload, timeoutMs });
    return { ok: name };
  };
  const cases = [
    ["align", { paths: ["a"], axis: "x", to: "max", relativeTo: "first", value: 2, place: "p", context: "edit" }, { paths: ["a"], axis: "x", to: "max", relativeTo: "first", value: 2 }],
    ["distribute", { paths: ["a"], axis: "y", spacing: 1, place: "p" }, { paths: ["a"], axis: "y", spacing: 1 }],
    ["weld_model", { path: "M", root: "R", unanchor: true }, { path: "M", root: "R", unanchor: true }],
    ["set_collision_groups", { register: ["A"], rules: [], assign: [] }, { register: ["A"], rules: [], assign: [] }],
    ["select_and_focus", { paths: "a", view: "top", distance: 2 }, { paths: "a", view: "top", distance: 2 }],
    ["script_search", { query: "q", root: "game", pattern: true, caseSensitive: true, limit: 5 }, { query: "q", root: "game", pattern: true, caseSensitive: true, limit: 5 }],
    ["script_diagnostics", { path: "x", paths: ["y"] }, { path: "x", paths: ["y"] }],
    ["generate_model", { prompt: "p", image: 1, name: "n", parent: "W", size: [1, 2, 3], maxTriangles: 9, textures: false, parts: ["a"], predefined: "Car5", at: [0, 0, 0] }, { prompt: "p", image: 1, name: "n", parent: "W", size: [1, 2, 3], maxTriangles: 9, textures: false, parts: ["a"], predefined: "Car5", at: [0, 0, 0] }],
  ];
  for (const [tool, args, expected] of cases) {
    const r = await editorTool(tool, args, op);
    const call = calls.at(-1);
    assert.equal(call.name, tool);
    assert.deepEqual(call.payload, expected, tool);
    assert.deepEqual(JSON.parse(r.text), { ok: tool });
  }
});

test("generate_model waits longer than an ordinary command", async () => {
  let waited = 0;
  await editorTool("generate_model", { prompt: "p" }, async (_o, _p, t) => {
    waited = t;
    return {};
  });
  assert.ok(waited >= 240_000, `waited ${waited}`);
});

test("an unknown editor tool is an error", async () => {
  await assert.rejects(editorTool("nope", {}, async () => ({})), /unknown/);
});
