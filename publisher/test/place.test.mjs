import { test } from "node:test";
import assert from "node:assert/strict";
import { json, setup, writeFile } from "./helpers.mjs";

const RBXL = Buffer.from("<roblox!\x89\xff\r\n\x1a\ndata", "latin1");
const RBXLX = Buffer.from('<roblox version="4"></roblox>');
const file = (ctx, name = "p.rbxl", data = RBXL) => writeFile(ctx.dir, name, data);
const place = (ctx, f) => ({ universeId: 11, placeId: 22, file: f ?? file(ctx) });

test("place_save uploads with versionType Saved and asks nothing", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.app.publisher.placeSave(place(ctx));
  assert.equal(r.versionNumber, 12);
  assert.equal(r.versionType, "Saved");
  const up = ctx.cloud.placeUploads[0];
  assert.equal(up.versionType, "Saved");
  assert.equal(up.universeId, "11");
  assert.equal(up.placeId, "22");
  assert.equal(up.contentType, "application/octet-stream");
  assert.deepEqual(up.bytes, RBXL);
  assert.equal(ctx.dialogs.length, 0);
});

test("place_save works with Studio closed", async (t) => {
  const ctx = await setup(t, { rolink: { online: false } });
  const r = await ctx.app.publisher.placeSave(place(ctx));
  assert.equal(r.versionNumber, 12);
});

test(".rbxlx is sent as application/xml", async (t) => {
  const ctx = await setup(t);
  await ctx.app.publisher.placeSave(place(ctx, file(ctx, "p.rbxlx", RBXLX)));
  assert.equal(ctx.cloud.placeUploads[0].contentType, "application/xml");
});

test("other file types and non-place content are refused", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(ctx.app.publisher.placeSave(place(ctx, file(ctx, "p.txt", RBXL))), /\.rbxl/);
  await assert.rejects(ctx.app.publisher.placeSave(place(ctx, file(ctx, "q.rbxl", Buffer.from("hello")))), /place file/i);
  assert.equal(ctx.cloud.placeUploads.length, 0);
});

test("place ids must be positive integers", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(ctx.app.publisher.placeSave({ universeId: 0, placeId: 2, file: file(ctx) }), /universeId/);
  await assert.rejects(ctx.app.publisher.placeSave({ universeId: 1, placeId: 2.5, file: file(ctx) }), /placeId/);
});

test("place_publish uploads Published only after the native dialog answers Yes", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.app.publisher.placePublish(place(ctx));
  assert.equal(r.versionType, "Published");
  assert.equal(ctx.cloud.placeUploads[0].versionType, "Published");
  assert.equal(ctx.dialogs.length, 1);
  assert.match(ctx.dialogs[0].text, /public/i);
  assert.match(ctx.dialogs[0].text, /players/i);
  assert.match(ctx.dialogs[0].text, /22/);
  assert.ok(ctx.dialogs[0].confirmLabel);
  assert.ok(ctx.dialogs[0].timeoutMs > 0);
});

test("place_publish refuses when the dialog is declined or times out", async (t) => {
  const ctx = await setup(t);
  ctx.dialog = { confirmed: false, reason: "timed out" };
  await assert.rejects(ctx.app.publisher.placePublish(place(ctx)), /not confirmed|declined/i);
  assert.equal(ctx.cloud.placeUploads.length, 0);
});

test("place_publish treats anything but confirmed:true as a refusal", async (t) => {
  const ctx = await setup(t);
  ctx.dialog = { confirmed: "yes" };
  await assert.rejects(ctx.app.publisher.placePublish(place(ctx)), /not confirmed|declined/i);
  assert.equal(ctx.cloud.placeUploads.length, 0);
});

test("place_publish does not need Studio: the dialog belongs to this process", async (t) => {
  const ctx = await setup(t, { rolink: { online: false } });
  await ctx.app.publisher.placePublish(place(ctx));
  assert.equal(ctx.cloud.placeUploads.length, 1);
  assert.equal(ctx.dialogs.length, 1);
});

test("a fake plugin session has no say in place_publish", async (t) => {
  const ctx = await setup(t);
  ctx.rl.sessions = [{ context: "edit", placeName: "Fake", placeId: 22, gameId: 11, pluginVersion: "t", connectedAt: 9, lastSeen: 9 }];
  ctx.dialog = { confirmed: false };
  await assert.rejects(ctx.app.publisher.placePublish(place(ctx)), /not confirmed/i);
  assert.equal(ctx.rl.calls.length, 0);
  assert.equal(ctx.cloud.placeUploads.length, 0);
});

test("place errors are explained: 409 and rate limit", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.placeResponse = () => json(409, { message: "conflict" });
  await assert.rejects(ctx.app.publisher.placeSave(place(ctx)), /not part of|universe/i);
  ctx.cloud.placeResponse = () => json(429, { message: "slow down" });
  await assert.rejects(ctx.app.publisher.placeSave(place(ctx)), /30.*minute|minute.*30/i);
});

test("place tools need a key", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_PUBLISH_API_KEY: "" } });
  await assert.rejects(ctx.app.publisher.placeSave(place(ctx)), /ROBLOX_PUBLISH_API_KEY/);
});

test("the result warns about instance types the API cannot update", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.app.publisher.placeSave(place(ctx));
  assert.match(r.note, /PartOperation/);
});
