import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { EN_AUDIO, EN_IMAGE, RU_AUDIO, RU_IMAGE, jpeg, png, setup, wav } from "./helpers.mjs";

const audioArgs = (ctx, extra = {}) => ({ path: ctx.audio(), kind: "audio", name: "Theme", ...extra });
const imageArgs = (ctx, extra = {}) => ({ path: ctx.image(), kind: "image", name: "Logo", ...extra });

test("prepare_asset returns id, hash, phrase and the responsibility notice", async (t) => {
  const ctx = await setup(t);
  const data = wav(2);
  const r = await ctx.prepare({ path: ctx.audio("s.wav", data), kind: "audio", name: "Theme" });
  assert.ok(r.prepareId);
  assert.equal(r.sha256, crypto.createHash("sha256").update(data).digest("hex"));
  assert.equal(r.requiredPhrase, RU_AUDIO);
  assert.match(r.summary, new RegExp(RU_AUDIO));
  assert.match(r.summary, new RegExp(r.sha256));
  assert.match(r.summary, /responsible/i);
  assert.match(r.summary, /agent/i);
  assert.equal(ctx.cloud.uploads.length, 0, "prepare must not upload");
});

test("the image phrase differs from the audio phrase", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare(imageArgs(ctx));
  assert.equal(r.requiredPhrase, RU_IMAGE);
});

test("a wrong phrase is refused, uploads nothing and does not burn the id", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare(audioArgs(ctx));
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: "да" }), /phrase/i);
  assert.equal(ctx.cloud.uploads.length, 0);
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  assert.equal(ctx.cloud.uploads.length, 1);
});

test("the image phrase does not unlock audio", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare(audioArgs(ctx));
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_IMAGE }), /phrase/i);
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: EN_IMAGE }), /phrase/i);
});

test("a near-miss phrase is refused", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare(audioArgs(ctx));
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO.toLowerCase() }), /phrase/i);
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO + "!" }), /phrase/i);
});

test("English audio phrase is accepted", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare(audioArgs(ctx));
  await ctx.publish({ prepareId: r.prepareId, confirmation: EN_AUDIO });
  assert.equal(ctx.cloud.uploads.length, 1);
});

test("English image phrase is accepted", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare(imageArgs(ctx));
  await ctx.publish({ prepareId: r.prepareId, confirmation: EN_IMAGE });
  assert.equal(ctx.cloud.uploads.length, 1);
});

test("a prepareId works once", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare(audioArgs(ctx));
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), /already used/i);
  assert.equal(ctx.cloud.uploads.length, 1);
});

test("two simultaneous publishes upload once", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare(audioArgs(ctx));
  const out = await Promise.allSettled([
    ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }),
    ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }),
  ]);
  assert.equal(out.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(ctx.cloud.uploads.length, 1);
});

test("an unknown prepareId is refused", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(ctx.publish({ prepareId: "nope", confirmation: RU_AUDIO }), /unknown prepareId/i);
});

test("a file changed after prepare is refused", async (t) => {
  const ctx = await setup(t);
  const args = audioArgs(ctx);
  const r = await ctx.prepare(args);
  fs.writeFileSync(args.path, wav(3));
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), /changed/i);
  assert.equal(ctx.cloud.uploads.length, 0);
});

test("a file deleted after prepare is refused", async (t) => {
  const ctx = await setup(t);
  const args = audioArgs(ctx);
  const r = await ctx.prepare(args);
  fs.rmSync(args.path);
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), /changed|missing/i);
});

test("audio upload sends the documented request to the user's account", async (t) => {
  const ctx = await setup(t);
  const data = wav(2);
  const r = await ctx.prepare({ path: ctx.audio("t.wav", data), kind: "audio", name: "Theme", description: "Main" });
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  const up = ctx.cloud.uploads[0];
  assert.equal(up.request.assetType, "Audio");
  assert.equal(up.request.displayName, "Theme");
  assert.equal(up.request.description, "Main");
  assert.deepEqual(up.request.creationContext.creator, { userId: "42" });
  assert.equal(up.type, "audio/wav");
  assert.deepEqual(up.bytes, data);
  assert.equal(ctx.cloud.requests[0].key, "SECRET-OPEN-CLOUD-KEY-abc123");
});

test("image upload uses assetType Decal and the group creator when set", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_CREATOR_USER_ID: "", ROBLOX_CREATOR_GROUP_ID: "9001" } });
  const r = await ctx.prepare({ path: ctx.image("l.jpg", jpeg()), kind: "image", name: "Logo" });
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_IMAGE });
  const up = ctx.cloud.uploads[0];
  assert.equal(up.request.assetType, "Decal");
  assert.deepEqual(up.request.creationContext.creator, { groupId: "9001" });
  assert.equal(up.type, "image/jpeg");
});

test("prepare works without a key but says publishing needs one", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_PUBLISH_API_KEY: "" } });
  const r = await ctx.prepare(audioArgs(ctx));
  assert.match(r.summary, /ROBLOX_PUBLISH_API_KEY/);
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), /ROBLOX_PUBLISH_API_KEY/);
});

test("name and description are validated", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(ctx.prepare(audioArgs(ctx, { name: "" })), /name/i);
  await assert.rejects(ctx.prepare(audioArgs(ctx, { name: "x".repeat(51) })), /50/);
  await assert.rejects(ctx.prepare(audioArgs(ctx, { description: "x".repeat(1001) })), /1000/);
});

test("target class must fit the asset kind", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(ctx.prepare(audioArgs(ctx, { target: { path: "Workspace/D", class: "Decal" } })), /Sound/);
  await assert.rejects(ctx.prepare(imageArgs(ctx, { target: { path: "Workspace/S", property: "SoundId" } })), /image/i);
  await assert.rejects(ctx.prepare(imageArgs(ctx, { target: { path: "Workspace/S", class: "ImageLabel", property: "Texture" } })), /Image/);
});

test("the png fixture stays accepted so these tests are meaningful", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare({ path: ctx.image("x.png", png(8, 8)), kind: "image", name: "X" });
  assert.match(r.summary, /8.?x.?8|8×8/);
});
