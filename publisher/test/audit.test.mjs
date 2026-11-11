// Regressions for the security / correctness audit of the publisher.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RU_AUDIO, EN_AUDIO, json, setup } from "./helpers.mjs";
import { cleanTitle } from "../dist/copyright.js";
import { samePhrase } from "../dist/publisher.js";
import { visible } from "../dist/cloudtools.js";

const seed = (ctx, id, value, extra = {}) => ctx.cloud.entries.set(id, { id: id.split("/").pop(), state: "ACTIVE", revisionId: "r1", value, ...extra });

test("prototype names are not prepareIds", async (t) => {
  const ctx = await setup(t);
  for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    await assert.rejects(ctx.publish({ prepareId: id, confirmation: RU_AUDIO }), /Unknown prepareId/);
    await assert.rejects(ctx.app.publisher.publishAnimation({ prepareId: id, confirmation: RU_AUDIO }), /Unknown prepareId/);
  }
  assert.equal(ctx.cloud.uploads.length, 0);
});

test("the phrase matches across Unicode normalisation and spacing, and nothing looser", async () => {
  assert.ok(samePhrase("Я согласен на публикацию звуков", RU_AUDIO));
  assert.ok(samePhrase(" I  agree to\u00a0publish sounds ", EN_AUDIO));
  // e + combining acute typed, é stored
  assert.ok(samePhrase("I confirm publishing: Cafe\u0301", "I confirm publishing: Café"));
  assert.ok(!samePhrase("i agree to publish sounds", EN_AUDIO));
  assert.ok(!samePhrase("I agree to publish sounds!", EN_AUDIO));
});

test("a matched title keeps no invisible or bidi characters, so the phrase is typeable and shows what must be typed", () => {
  assert.equal(cleanTitle("Song\u200b Title"), "Song Title");
  assert.equal(cleanTitle("\u202eeltiT gnoS"), "eltiT gnoS");
  assert.equal(cleanTitle("A\u2028B\u0085C"), "A B C");
  assert.equal(cleanTitle("\u200b\u200d"), "Unknown title");
  assert.equal(Array.from(cleanTitle("𝄞".repeat(200))).length, 120, "cut by characters, not UTF-16 units");
});

test("invisible characters in a key are spelled out in the dialog, not dropped", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/Admin\u200b", 1);
  await ctx.app.tools.datastoreSet({ universeId: 9, store: "Coins", key: "Admin\u200b", value: 2 });
  assert.match(ctx.dialogs[0].text, /Admin\\u\{200B\}/);
  assert.equal(visible("a\u202eb\u0085c"), "a\\u{202E}b\\u{85}c");
});

test("a long new value says plainly that part of it is not shown", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", 1);
  const value = { note: "x".repeat(2000), admin: true };
  await ctx.app.tools.datastoreSet({ universeId: 9, store: "Coins", key: "p1", value });
  const text = ctx.dialogs[0].text;
  assert.match(text, /NOT shown/);
  assert.ok(text.length < 2000, "the whole request fits the dialog's own cap");
});

test("a field-length error is not reported as a used-up quota", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.createResponse = () => json(400, { message: "Description exceeded the limit of 1000 characters" });
  const r = await ctx.prepare({ path: ctx.audio(), kind: "audio", name: "Theme" });
  const e = await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }).catch((x) => x);
  assert.ok(e instanceof Error);
  assert.doesNotMatch(e.message, /quota is used up/);
  assert.match(e.message, /exceeded the limit/);
});

test("a 429 with limit wording is still a quota", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.createResponse = () => json(429, { message: "Upload limit exceeded for this period" });
  const r = await ctx.prepare({ path: ctx.audio(), kind: "audio", name: "Theme" });
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), /quota is used up/);
});

test("the timer and publish_asset never both create a placeholder", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare({ path: ctx.audio(), kind: "audio", name: "Theme", target: { path: "Workspace/Theme" } });
  // the timer fires while publish_asset is advancing the same entry
  ctx.onDialog = undefined;
  const publishing = ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  const ticks = [];
  for (let i = 0; i < 5; i++) {
    await new Promise((res) => setTimeout(res, 2));
    ticks.push(ctx.app.poller.processEntry(r.prepareId));
  }
  await publishing;
  await Promise.all(ticks);
  assert.equal(ctx.rl.ops("build").length, 1, JSON.stringify(ctx.rl.ops("build")));
});

// ------------------------------------------------------------------ /rpc token location (same rule as the server)
import path from "node:path";
import os from "node:os";
import { tokenDir, tokenFile, tokenFileTrusted } from "../dist/rolink.js";

test("token folder: temp on Windows, XDG_RUNTIME_DIR/rolink, else ~/.rolink", () => {
  assert.equal(tokenDir({}, "win32"), os.tmpdir());
  assert.equal(tokenDir({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux"), path.join("/run/user/1000", "rolink"));
  assert.equal(tokenDir({}, "darwin"), path.join(os.homedir(), ".rolink"));
  assert.equal(path.basename(tokenFile(34872, {}, "linux")), "rolink-34872.token");
});

test("POSIX: a token file is trusted only if it and its folder are this user's and private", () => {
  const st = (uid, mode, file = true) => ({ uid, mode, isFile: () => file });
  assert.ok(tokenFileTrusted(st(1000, 0o100600), st(1000, 0o40700), 1000, "linux"));
  assert.ok(!tokenFileTrusted(st(1001, 0o100600), st(1000, 0o40700), 1000, "linux"), "another user's file");
  assert.ok(!tokenFileTrusted(st(1000, 0o100600), st(1001, 0o40700), 1000, "linux"), "another user's folder");
  assert.ok(!tokenFileTrusted(st(1000, 0o100644), st(1000, 0o40700), 1000, "linux"), "readable by others");
  assert.ok(!tokenFileTrusted(st(1000, 0o100600), st(1000, 0o40777), 1000, "linux"), "folder writable by others");
  assert.ok(!tokenFileTrusted(st(1000, 0o120777, false), st(1000, 0o40700), 1000, "linux"), "a symlink is not a regular file");
  assert.ok(tokenFileTrusted(st(0, 0o100666), st(0, 0o40777), undefined, "win32"));
  assert.ok(!tokenFileTrusted(st(0, 0, false), st(0, 0), undefined, "win32"));
});
