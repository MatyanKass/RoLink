// Experience access grants, quota, animation publish, server restart, data stores.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EN_ANIMATION, RBXM, RU_ANIMATION, RU_AUDIO, RU_IMAGE, doneOp, json, setup, writeFile } from "./helpers.mjs";

const audio = (ctx, extra = {}) => ({ path: ctx.audio(), kind: "audio", name: "Theme", ...extra });
const anim = (ctx, data = RBXM, name = "Walk.rbxm") => ({ path: writeFile(ctx.dir, name, data), kind: "animation", name: "Walk" });
const tools = (ctx) => ctx.app.tools;
const seed = (ctx, id, value, extra = {}) => ctx.cloud.entries.set(id, { id: id.split("/").pop(), state: "ACTIVE", revisionId: "r1", value, ...extra });

// ------------------------------------------------------------------ item 1: grant Use to the experience

test("after upload the configured universe gets Use access through the documented request", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_UNIVERSE_ID: "321" } });
  ctx.cloud.createResponse = () => json(200, doneOp("Approved"));
  const r = await ctx.prepare(audio(ctx));
  assert.match(r.summary, /321/);
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  assert.equal(ctx.cloud.grants.length, 1);
  const { body, contentType } = ctx.cloud.grants[0];
  assert.equal(body.subjectType, "Universe");
  assert.equal(body.subjectId, "321");
  assert.equal(body.action, "Use");
  assert.deepEqual(body.requests.map((x) => x.assetId), [777]);
  assert.equal(body.assetIds, undefined, "assetIds is deprecated");
  assert.equal(contentType, "application/json-patch+json");
  const entry = (await ctx.app.publisher.publishStatus({ prepareId: r.prepareId })).queue[0];
  assert.equal(entry.universeId, "321");
  assert.equal(entry.grant.status, "granted");
});

test("prepare_asset universeId beats the configured one", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_UNIVERSE_ID: "321" } });
  ctx.cloud.createResponse = () => json(200, doneOp("Approved"));
  const r = await ctx.prepare(audio(ctx, { universeId: 654 }));
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  assert.equal(ctx.cloud.grants[0].body.subjectId, "654");
});

test("without configuration the connected Studio's experience is used and named in the summary", async (t) => {
  const ctx = await setup(t); // the fake session has gameId 9
  ctx.cloud.createResponse = () => json(200, doneOp("Approved"));
  const r = await ctx.prepare(audio(ctx));
  assert.match(r.summary, /experience 9\b/);
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  assert.equal(ctx.cloud.grants[0].body.subjectId, "9");
});

test("an unpublished place gives no universe: nothing is granted and the summary says so", async (t) => {
  const ctx = await setup(t);
  ctx.rl.sessions[0].gameId = 0;
  ctx.cloud.createResponse = () => json(200, doneOp("Approved"));
  const r = await ctx.prepare(audio(ctx));
  assert.match(r.summary, /may not play/i);
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  assert.equal(ctx.cloud.grants.length, 0);
});

test("a rejected asset is not granted", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_UNIVERSE_ID: "321" } });
  ctx.cloud.createResponse = () => json(200, doneOp("Rejected"));
  const r = await ctx.prepare(audio(ctx));
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  assert.equal(ctx.cloud.grants.length, 0);
});

test("a 403 on the grant names the missing permission and leaves the upload alone", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_UNIVERSE_ID: "321" } });
  ctx.cloud.createResponse = () => json(200, doneOp("Approved"));
  ctx.cloud.grantResponse = () => json(403, { message: "Forbidden" });
  const r = await ctx.prepare(audio(ctx));
  const out = await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  assert.equal(out.status, "approved");
  const entry = (await ctx.app.publisher.publishStatus({ prepareId: r.prepareId })).queue[0];
  assert.equal(entry.grant.status, "failed");
  assert.match(entry.grant.error, /asset-permissions:write/);
  const before = ctx.cloud.grants.length;
  await ctx.app.poller.tick();
  assert.equal(ctx.cloud.grants.length, before, "a permission failure is not retried");
});

test("a per-asset error inside a 200 counts as a failed grant", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_UNIVERSE_ID: "321" } });
  ctx.cloud.createResponse = () => json(200, doneOp("Approved"));
  ctx.cloud.grantResponse = () => json(200, { successAssetIds: [], errors: [{ assetId: 777, code: "AssetNotOwned" }] });
  const r = await ctx.prepare(audio(ctx));
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  const entry = (await ctx.app.publisher.publishStatus({ prepareId: r.prepareId })).queue[0];
  assert.equal(entry.grant.status, "failed");
  assert.match(entry.grant.error, /AssetNotOwned/);
});

test("a rate-limited grant stays pending and backs off instead of retrying at once", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_UNIVERSE_ID: "321" } });
  ctx.cloud.createResponse = () => json(200, doneOp("Approved"));
  ctx.cloud.grantResponse = () => json(429, { message: "slow down" }, { "retry-after": "60" });
  const r = await ctx.prepare(audio(ctx));
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  const entry = (await ctx.app.publisher.publishStatus({ prepareId: r.prepareId })).queue[0];
  assert.equal(entry.grant.status, "pending");
  assert.match(entry.grant.error, /100 requests per minute/);
  await ctx.app.poller.tick();
  assert.equal(ctx.cloud.grants.length, 1, "the poller honours the back-off");
});

test("a grant that hit a server error stays pending and the poller retries it", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_UNIVERSE_ID: "321" } });
  ctx.cloud.createResponse = () => json(200, doneOp("Approved"));
  ctx.cloud.grantResponse = () => json(503, { message: "try later" });
  const r = await ctx.prepare(audio(ctx));
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  let entry = (await ctx.app.publisher.publishStatus({ prepareId: r.prepareId })).queue[0];
  assert.equal(entry.grant.status, "pending");
  ctx.cloud.grantResponse = (body) => json(200, { successAssetIds: body.requests.map((x) => x.assetId), errors: [] });
  await ctx.app.poller.tick();
  entry = (await ctx.app.publisher.publishStatus({ prepareId: r.prepareId })).queue[0];
  assert.equal(entry.grant.status, "granted");
});

test("universeId must be a positive integer", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(ctx.prepare(audio(ctx, { universeId: 1.5 })), /universeId/);
});

// ------------------------------------------------------------------ item 2: quota

test("asset_quota reads usage and capacity from the API, with the remaining count", async (t) => {
  const ctx = await setup(t);
  const r = await tools(ctx).assetQuota({ assetType: "Audio" });
  assert.equal(ctx.cloud.quotaRequests[0].userId, "42");
  assert.equal(ctx.cloud.quotaRequests[0].filter, "assetType == Audio");
  assert.deepEqual(r.quotas[0], { quotaType: "RateLimitUpload", assetType: "Audio", usage: 3, capacity: 10, remaining: 7, period: "Month" });
});

test("asset_quota follows pages", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.quotaPages = [
    { assetQuotas: [{ quotaType: "A", assetType: "Audio", usage: 1, capacity: 2 }], nextPageToken: "1" },
    { assetQuotas: [{ quotaType: "B", assetType: "Decal", usage: 1, capacity: 2 }] },
  ];
  const r = await tools(ctx).assetQuota({});
  assert.equal(r.quotas.length, 2);
  assert.equal(ctx.cloud.quotaRequests[0].filter, null);
});

test("asset_quota takes an explicit user and refuses a filter that is not a plain name", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_CREATOR_USER_ID: "", ROBLOX_CREATOR_GROUP_ID: "9" } });
  await assert.rejects(tools(ctx).assetQuota({}), /user/i);
  const r = await tools(ctx).assetQuota({ userId: 77 });
  assert.equal(ctx.cloud.quotaRequests[0].userId, "77");
  assert.ok(r.quotas);
  await assert.rejects(tools(ctx).assetQuota({ userId: 77, assetType: 'Audio" || x' }), /assetType/);
});

test("asset_quota 403 names asset:read, not an upload quota problem", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.quotaResponse = () => json(403, { message: "no access to asset-quotas" });
  await assert.rejects(tools(ctx).assetQuota({}), (e) => /asset:read/.test(e.message) && !/used up/.test(e.message));
});

// ------------------------------------------------------------------ item 3: animation

test("an animation goes through prepare and the animation phrase, uploaded as Animation", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare(anim(ctx));
  assert.equal(r.requiredPhrase, RU_ANIMATION);
  assert.match(r.summary, /KeyframeSequence/);
  assert.match(r.summary, /unconfirmed|not confirmed/i);
  assert.equal(ctx.cloud.uploads.length, 0);
  const out = await ctx.app.publisher.publishAnimation({ prepareId: r.prepareId, confirmation: RU_ANIMATION });
  const up = ctx.cloud.uploads[0];
  assert.equal(up.request.assetType, "Animation");
  assert.equal(up.type, "model/x-rbxm");
  assert.deepEqual(up.bytes, RBXM);
  assert.match(out.note, /KeyframeSequence/);
});

test("the English animation phrase works and other phrases do not", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare(anim(ctx));
  await assert.rejects(ctx.app.publisher.publishAnimation({ prepareId: r.prepareId, confirmation: RU_AUDIO }), /phrase/i);
  await assert.rejects(ctx.app.publisher.publishAnimation({ prepareId: r.prepareId, confirmation: RU_IMAGE }), /phrase/i);
  assert.equal(ctx.cloud.uploads.length, 0);
  await ctx.app.publisher.publishAnimation({ prepareId: r.prepareId, confirmation: EN_ANIMATION });
  assert.equal(ctx.cloud.uploads.length, 1);
});

test("publish_animation and publish_asset do not cross over", async (t) => {
  const ctx = await setup(t);
  const a = await ctx.prepare(anim(ctx));
  await assert.rejects(ctx.publish({ prepareId: a.prepareId, confirmation: RU_ANIMATION }), /publish_animation/);
  const s = await ctx.prepare(audio(ctx));
  await assert.rejects(ctx.app.publisher.publishAnimation({ prepareId: s.prepareId, confirmation: RU_AUDIO }), /publish_asset/);
  assert.equal(ctx.cloud.uploads.length, 0);
});

test("only .rbxm binary files are accepted for animations", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(ctx.prepare(anim(ctx, RBXM, "Walk.rbxmx")), /\.rbxm/);
  await assert.rejects(ctx.prepare(anim(ctx, Buffer.from("not a model"), "Bad.rbxm")), /rbxm/i);
});

test("an animation cannot take an instance target", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(ctx.prepare({ ...anim(ctx), target: { path: "Workspace/A" } }), /target/i);
});

test("a changed animation file is refused", async (t) => {
  const ctx = await setup(t);
  const args = anim(ctx);
  const r = await ctx.prepare(args);
  writeFile(ctx.dir, "Walk.rbxm", Buffer.concat([RBXM, Buffer.from("x")]));
  await assert.rejects(ctx.app.publisher.publishAnimation({ prepareId: r.prepareId, confirmation: RU_ANIMATION }), /changed/i);
});

// ------------------------------------------------------------------ item 4: restart

test("server_restart asks in Studio, then posts restartServers", async (t) => {
  const ctx = await setup(t);
  const r = await tools(ctx).serverRestart({ universeId: 9 });
  assert.equal(ctx.cloud.restarts.length, 1);
  assert.equal(ctx.cloud.restarts[0].universeId, "9");
  assert.deepEqual(ctx.cloud.restarts[0].body, {});
  const dlg = ctx.rl.ops("confirm_dialog");
  assert.equal(dlg.length, 1);
  assert.match(dlg[0].args.text, /\b9\b/);
  assert.match(dlg[0].args.text, /players/i);
  assert.ok(dlg[0].args.confirmLabel);
  assert.equal(r.restarted, true);
});

test("server_restart without a confirmed dialog does nothing", async (t) => {
  const ctx = await setup(t);
  ctx.rl.dialog = { confirmed: false, reason: "cancelled" };
  await assert.rejects(tools(ctx).serverRestart({ universeId: 9 }), /not confirmed|declined/i);
  ctx.rl.dialog = { confirmed: "yes" };
  await assert.rejects(tools(ctx).serverRestart({ universeId: 9 }), /not confirmed|declined/i);
  assert.equal(ctx.cloud.restarts.length, 0);
});

test("server_restart refuses when Studio is not connected", async (t) => {
  const ctx = await setup(t, { rolink: { online: false } });
  await assert.rejects(tools(ctx).serverRestart({ universeId: 9 }), /Studio/);
  assert.equal(ctx.cloud.restarts.length, 0);
});

test("server_restart prefers the Studio that has this experience open", async (t) => {
  const ctx = await setup(t);
  ctx.rl.sessions = [
    { context: "edit", placeName: "Other", placeId: 99, gameId: 1, pluginVersion: "t", connectedAt: 9, lastSeen: 9 },
    { context: "edit", placeName: "Mine", placeId: 22, gameId: 11, pluginVersion: "t", connectedAt: 1, lastSeen: 9 },
  ];
  await tools(ctx).serverRestart({ universeId: 11 });
  assert.equal(ctx.rl.ops("confirm_dialog")[0].args.place, "22");
});

test("server_restart 403 names universe:write", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.restartResponse = () => json(403, { message: "Forbidden" });
  await assert.rejects(tools(ctx).serverRestart({ universeId: 9 }), /universe:write/);
});

test("server_restart validates the id and needs a key", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(tools(ctx).serverRestart({ universeId: -1 }), /universeId/);
  const noKey = await setup(t, { env: { ROBLOX_PUBLISH_API_KEY: "" } });
  await assert.rejects(tools(noKey).serverRestart({ universeId: 9 }), /ROBLOX_PUBLISH_API_KEY/);
});

// ------------------------------------------------------------------ item 5: data stores

test("datastore_list lists stores, or the entries of one store with a prefix", async (t) => {
  const ctx = await setup(t);
  const stores = await tools(ctx).datastoreList({ universeId: 9, prefix: "Co" });
  assert.deepEqual(stores.dataStores.map((s) => s.id), ["Coins"]);
  seed(ctx, "Coins/-/a");
  seed(ctx, "Coins/-/b");
  const entries = await tools(ctx).datastoreList({ universeId: 9, store: "Coins" });
  assert.deepEqual(entries.entries.map((e) => e.id).sort(), ["a", "b"]);
  assert.equal(ctx.rl.ops("confirm_dialog").length, 0, "reads ask nothing");
});

test("datastore_list refuses a prefix that would break out of the filter", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(tools(ctx).datastoreList({ universeId: 9, prefix: 'x") || (y' }), /prefix/);
});

test("datastore_get returns the value, with no dialog", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", { gold: 5 }, { users: ["users/1"], attributes: { a: 1 } });
  const r = await tools(ctx).datastoreGet({ universeId: 9, store: "Coins", key: "p1" });
  assert.deepEqual(r.value, { gold: 5 });
  assert.deepEqual(r.users, ["users/1"]);
  assert.equal(ctx.rl.ops("confirm_dialog").length, 0);
});

test("datastore_get uses the scoped path and encodes names", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Co ins/global/a/b", 1);
  const r = await tools(ctx).datastoreGet({ universeId: 9, store: "Co ins", key: "a/b", scope: "global" });
  assert.equal(r.value, 1);
});

test("datastore_get on a missing or deleted entry reports not found", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(tools(ctx).datastoreGet({ universeId: 9, store: "Coins", key: "none" }), /not found|no entry|does not exist/i);
  seed(ctx, "Coins/-/gone", 1, { state: "DELETED" });
  await assert.rejects(tools(ctx).datastoreGet({ universeId: 9, store: "Coins", key: "gone" }), /not found|no entry|does not exist/i);
});

test("datastore_set shows store, key and value in the Studio dialog before writing", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", { gold: 5 });
  const r = await tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: { gold: 6 } });
  const dlg = ctx.rl.ops("confirm_dialog")[0].args.text;
  assert.match(dlg, /Coins/);
  assert.match(dlg, /p1/);
  assert.match(dlg, /"gold":6/);
  assert.match(dlg, /"gold":5/, "current value shown too");
  assert.deepEqual(ctx.cloud.patches[0].body.value, { gold: 6 });
  assert.equal(r.updated, true);
});

test("datastore_set keeps users and attributes the caller left out", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", 1, { users: ["users/1"], attributes: { a: 1 } });
  const r = await tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: 2 });
  const body = ctx.cloud.patches[0].body;
  assert.deepEqual(body.users, ["users/1"]);
  assert.deepEqual(body.attributes, { a: 1 });
  assert.deepEqual(r.preserved.sort(), ["attributes", "users"]);
});

test("datastore_set uses what the caller passes, normalising bare user ids", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", 1, { users: ["users/1"], attributes: { a: 1 } });
  await tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: 2, users: [5, "users/6"], attributes: { b: 2 } });
  const body = ctx.cloud.patches[0].body;
  assert.deepEqual(body.users, ["users/5", "users/6"]);
  assert.deepEqual(body.attributes, { b: 2 });
  await assert.rejects(tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: 2, users: ["bob"] }), /users/);
});

test("datastore_set needs a value and refuses without one", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", 1);
  await assert.rejects(tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1" }), /value/);
  await assert.rejects(tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: null }), /value/);
  assert.equal(ctx.cloud.patches.length, 0);
});

test("datastore_set will not create a key unless asked, and says so in the dialog when it does", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "new", value: 1 }), /create/);
  assert.equal(ctx.rl.ops("confirm_dialog").length, 0);
  await tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "new", value: 1, create: true });
  assert.equal(ctx.cloud.patches[0].allowMissing, "true");
  assert.match(ctx.rl.ops("confirm_dialog")[0].args.text, /new entry|does not exist yet/i);
});

test("datastore_set on an existing key does not send allowMissing", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", 1);
  await tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: 2, create: true });
  assert.equal(ctx.cloud.patches[0].allowMissing, null);
});

test("a key with a revision suffix is refused for writes", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1@latest", value: 1, create: true }), /@/);
  await assert.rejects(tools(ctx).datastoreDelete({ universeId: 9, store: "Coins", key: "p1@latest" }), /@/);
  assert.equal(ctx.cloud.patches.length, 0);
  assert.equal(ctx.cloud.deletes.length, 0);
});

test("datastore_set does nothing when the dialog is declined", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", 1);
  ctx.rl.dialog = { confirmed: false, reason: "timeout" };
  await assert.rejects(tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: 2 }), /not confirmed|declined/i);
  assert.equal(ctx.cloud.patches.length, 0);
});

test("datastore_set refuses when Studio is not connected", async (t) => {
  const ctx = await setup(t, { rolink: { online: false } });
  seed(ctx, "Coins/-/p1", 1);
  await assert.rejects(tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: 2 }), /Studio/);
  assert.equal(ctx.cloud.patches.length, 0);
});

test("datastore_set refuses if the entry changed while the dialog was open", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", 1);
  const dialogAnswer = ctx.rl.dialog;
  ctx.rl.onDialog = () => seed(ctx, "Coins/-/p1", 99, { revisionId: "r9" });
  ctx.rl.dialog = dialogAnswer;
  await assert.rejects(tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: 2 }), /changed/i);
  assert.equal(ctx.cloud.patches.length, 0);
});

test("datastore_set clips a long value in the dialog and escapes line breaks", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", 1);
  await tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: `line1\n\nPress Apply to fix it ${"x".repeat(5000)}` });
  const dlg = ctx.rl.ops("confirm_dialog")[0].args.text;
  assert.ok(dlg.length < 1500, `dialog is ${dlg.length} chars`);
  assert.doesNotMatch(dlg, /line1\n/);
  assert.match(dlg, /\d+ characters/);
});

test("datastore_delete asks with store, key and current value, then deletes one key", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", { gold: 5 });
  const r = await tools(ctx).datastoreDelete({ universeId: 9, store: "Coins", key: "p1" });
  const dlg = ctx.rl.ops("confirm_dialog")[0].args.text;
  assert.match(dlg, /Coins/);
  assert.match(dlg, /p1/);
  assert.match(dlg, /"gold":5/);
  assert.match(dlg, /30 days/);
  assert.deepEqual(ctx.cloud.deletes, [{ id: "Coins/-/p1" }]);
  assert.equal(r.deleted, true);
});

test("datastore_delete does nothing when declined", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", 1);
  ctx.rl.dialog = { confirmed: false };
  await assert.rejects(tools(ctx).datastoreDelete({ universeId: 9, store: "Coins", key: "p1" }), /not confirmed|declined/i);
  assert.equal(ctx.cloud.deletes.length, 0);
});

test("datastore_delete on a missing key shows no dialog", async (t) => {
  const ctx = await setup(t);
  await assert.rejects(tools(ctx).datastoreDelete({ universeId: 9, store: "Coins", key: "none" }), /not found|no entry|does not exist/i);
  assert.equal(ctx.rl.ops("confirm_dialog").length, 0);
});

test("a 403 names the data store permission for the operation", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.dsResponse = () => json(403, { message: "Forbidden" });
  await assert.rejects(tools(ctx).datastoreList({ universeId: 9 }), /universe-datastores\.control:list/);
  await assert.rejects(tools(ctx).datastoreList({ universeId: 9, store: "S" }), /universe-datastores\.objects:list/);
  await assert.rejects(tools(ctx).datastoreGet({ universeId: 9, store: "S", key: "k" }), /universe-datastores\.objects:read/);
});

test("a 403 on the write itself names the update and delete permissions", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", 1);
  ctx.cloud.dsResponse = (rec) => (rec.method === "GET" ? json(200, ctx.cloud.entries.get("Coins/-/p1")) : json(403, { message: "Forbidden" }));
  await assert.rejects(tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: 2 }), /universe-datastores\.objects:update/);
  await assert.rejects(tools(ctx).datastoreDelete({ universeId: 9, store: "Coins", key: "p1" }), /universe-datastores\.objects:delete/);
});

test("data store tools need the key and a valid universe", async (t) => {
  const ctx = await setup(t, { env: { ROBLOX_PUBLISH_API_KEY: "" } });
  await assert.rejects(tools(ctx).datastoreList({ universeId: 9 }), /ROBLOX_PUBLISH_API_KEY/);
  const c2 = await setup(t);
  await assert.rejects(tools(c2).datastoreGet({ universeId: 0, store: "S", key: "k" }), /universeId/);
  await assert.rejects(tools(c2).datastoreGet({ universeId: 9, store: "", key: "k" }), /store/);
  await assert.rejects(tools(c2).datastoreGet({ universeId: 9, store: "S", key: "" }), /key/);
});

test("the API key never reaches a dialog or a result", async (t) => {
  const ctx = await setup(t);
  seed(ctx, "Coins/-/p1", 1);
  const r = await tools(ctx).datastoreSet({ universeId: 9, store: "Coins", key: "p1", value: 2 });
  await tools(ctx).serverRestart({ universeId: 9 });
  assert.ok(!JSON.stringify([r, ctx.rl.rawBodies]).includes("SECRET-OPEN-CLOUD-KEY"));
});
