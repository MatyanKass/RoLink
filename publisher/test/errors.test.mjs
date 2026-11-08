import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { KEY, RU_AUDIO, RU_IMAGE, doneOp, json, setup, wav } from "./helpers.mjs";

const prep = (ctx) => ctx.prepare({ path: ctx.audio(), kind: "audio", name: "T" });

test("audio quota: reason, limit and manual-upload hint", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.createResponse = () => json(429, { message: "You have reached your monthly audio upload quota" });
  const r = await prep(ctx);
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), (e) => {
    assert.match(e.message, /quota/i);
    assert.match(e.message, /100/);
    assert.match(e.message, /10\b/);
    assert.match(e.message, /yourself|manually/i);
    return true;
  });
});

test("image quota message does not invent an audio number", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.createResponse = () => json(403, { message: "Quota exceeded for decals" });
  const r = await ctx.prepare({ path: ctx.image(), kind: "image", name: "P" });
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_IMAGE }), (e) => {
    assert.match(e.message, /quota/i);
    assert.doesNotMatch(e.message, /100 uploads/);
    assert.match(e.message, /yourself|manually/i);
    return true;
  });
});

test("plain rate limit: names the per-minute limit and Retry-After", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.createResponse = () => json(429, { message: "Too many requests" }, { "retry-after": "30" });
  const r = await prep(ctx);
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), (e) => {
    assert.match(e.message, /rate limit/i);
    assert.match(e.message, /120/);
    assert.match(e.message, /30 ?s/);
    assert.match(e.message, /yourself|manually/i);
    return true;
  });
});

test("quota error inside a finished operation is also explained", async (t) => {
  const ctx = await setup(t);
  const r = await prep(ctx);
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  ctx.cloud.operation = { path: "operations/op1", done: true, error: { code: 429, message: "Upload quota exceeded" } };
  await ctx.app.poller.tick();
  const e = (await ctx.app.publisher.publishStatus({ prepareId: r.prepareId })).queue[0];
  assert.equal(e.status, "failed");
  assert.match(e.reason, /quota/i);
  assert.match(e.reason, /yourself|manually/i);
});

test("a key without scopes gets a permissions hint", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.createResponse = () => json(403, { message: "Forbidden" });
  const r = await prep(ctx);
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), /asset:write|permission/i);
});

test("after a failed upload the prepareId is spent and says to prepare again", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.createResponse = () => json(500, { message: "oops" });
  const r = await prep(ctx);
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), /prepare_asset/);
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), /already used/i);
  assert.equal(ctx.cloud.uploads.length, 1);
});

test("the key never reaches logs, results, RPC bodies or the state file", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare({ path: ctx.audio(), kind: "audio", name: "T", target: { path: "Workspace/S" } });
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  ctx.cloud.operation = doneOp("Approved");
  await ctx.app.poller.tick();
  const status = await ctx.app.publisher.publishStatus({});
  const place = await ctx.app.publisher.placeSave({ universeId: 1, placeId: 2, file: ctx.audio("p.rbxl", Buffer.from("<roblox!xxxx")) });

  const haystack = JSON.stringify([ctx.logs, ctx.results, status, place, ctx.rl.rawBodies, fs.readFileSync(`${ctx.stateDir}/state.json`, "utf8")]);
  assert.ok(ctx.rl.calls.length > 0, "RoLink must have been used for the scan to mean anything");
  assert.ok(ctx.logs.length > 0, "something must have been logged");
  assert.ok(!haystack.includes(KEY));
  for (const c of ctx.cloud.requests) assert.equal(c.key, KEY);
});

test("the key is scrubbed when an upstream error echoes it", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.createResponse = () => json(401, { message: `Invalid API key ${KEY}` });
  const r = await prep(ctx);
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), (e) => {
    assert.ok(!e.message.includes(KEY), e.message);
    return true;
  });
  assert.ok(!ctx.logs.join("\n").includes(KEY));
});

test("the key is scrubbed from network errors and queue entries", async (t) => {
  const ctx = await setup(t);
  const r = await prep(ctx);
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  ctx.cloud.throwWith = `connect failed, header x-api-key=${KEY}`;
  await ctx.app.poller.tick();
  const text = JSON.stringify(await ctx.app.publisher.publishStatus({})) + fs.readFileSync(`${ctx.stateDir}/state.json`, "utf8") + ctx.logs.join("\n");
  assert.match(text, /connect failed/);
  assert.ok(!text.includes(KEY));
});

test("copyright provider secrets are scrubbed too", async (t) => {
  const ctx = await setup(t, { env: { AUDD_API_TOKEN: "AUDD-SECRET-TOKEN" } });
  ctx.cloud.throwWith = "provider failed AUDD-SECRET-TOKEN";
  const r = await ctx.prepare({ path: ctx.audio("x.wav", wav(1)), kind: "audio", name: "T" });
  assert.ok(!JSON.stringify(r).includes("AUDD-SECRET-TOKEN"));
  assert.ok(!ctx.logs.join("\n").includes("AUDD-SECRET-TOKEN"));
  assert.equal(r.copyright.status, "error");
});
