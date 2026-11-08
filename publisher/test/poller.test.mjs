import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RU_AUDIO, RU_IMAGE, doneOp, setup } from "./helpers.mjs";

const PATH = "Workspace/Theme";

async function published(ctx, target = { path: PATH }) {
  const r = await ctx.prepare({ path: ctx.audio(), kind: "audio", name: "Theme", target });
  const pub = await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  return { prepareId: r.prepareId, pub };
}
const inst = (ctx, p = PATH) => ctx.rl.instances.get(p);
const entry = async (ctx, id) => (await ctx.app.publisher.publishStatus({ prepareId: id })).queue[0];

test("target: creates the missing instance with an empty id and the pending attribute", async (t) => {
  const ctx = await setup(t);
  const { prepareId, pub } = await published(ctx);
  const i = inst(ctx);
  assert.equal(i.class, "Sound");
  assert.equal(i.props.SoundId ?? "", "");
  assert.equal(i.attrs.RoLinkPendingAsset, prepareId);
  assert.equal(pub.placeholder.created, true);
});

test("no placeholder is created when the upload is refused", async (t) => {
  const ctx = await setup(t);
  ctx.cloud.createResponse = () => new Response("{}", { status: 400 });
  const r = await ctx.prepare({ path: ctx.audio(), kind: "audio", name: "T", target: { path: PATH } });
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }));
  assert.equal(inst(ctx), undefined);
});

test("an existing instance keeps its current id until approval", async (t) => {
  const ctx = await setup(t);
  ctx.rl.instances.set(PATH, { class: "Sound", props: { SoundId: "rbxassetid://1" }, attrs: {} });
  const { prepareId } = await published(ctx);
  assert.equal(inst(ctx).props.SoundId, "rbxassetid://1");
  assert.equal(inst(ctx).attrs.RoLinkPendingAsset, prepareId);
  assert.equal(ctx.rl.ops("build").length, 0);
});

test("an existing instance of the wrong class is reported, not overwritten", async (t) => {
  const ctx = await setup(t);
  ctx.rl.instances.set(PATH, { class: "Folder", props: {}, attrs: {} });
  const { pub } = await published(ctx);
  assert.equal(pub.placeholder.created, false);
  assert.match(pub.placeholder.error, /Folder/);
  assert.deepEqual(inst(ctx).attrs, {});
});

test("poller: approval swaps in the real id and removes the attribute", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  ctx.cloud.operation = doneOp("MODERATION_STATE_REVIEWING");
  await ctx.app.poller.tick();
  assert.equal((await entry(ctx, prepareId)).status, "reviewing");
  assert.equal(inst(ctx).props.SoundId ?? "", "");
  ctx.cloud.moderation = { moderationState: "Approved" };
  await ctx.app.poller.tick();
  const i = inst(ctx);
  assert.equal(i.props.SoundId, "rbxassetid://777");
  assert.equal(i.attrs.RoLinkPendingAsset, undefined);
  const e = await entry(ctx, prepareId);
  assert.equal(e.status, "applied");
  assert.equal(e.assetId, "777");
});

test("poller: approval in the operation response is enough", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  ctx.cloud.operation = doneOp("MODERATION_STATE_APPROVED");
  await ctx.app.poller.tick();
  assert.equal(inst(ctx).props.SoundId, "rbxassetid://777");
  assert.equal((await entry(ctx, prepareId)).status, "applied");
});

test("poller: images go to Decal.Texture by default", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare({ path: ctx.image(), kind: "image", name: "L", target: { path: "Workspace/D" } });
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_IMAGE });
  assert.equal(inst(ctx, "Workspace/D").class, "Decal");
  ctx.cloud.operation = doneOp("Approved");
  await ctx.app.poller.tick();
  assert.equal(inst(ctx, "Workspace/D").props.Texture, "rbxassetid://777");
});

for (const [klass, property] of [["ImageLabel", "Image"], ["ImageButton", "Image"], ["Texture", "Texture"]]) {
  test(`poller: ${klass}.${property} target`, async (t) => {
    const ctx = await setup(t);
    const r = await ctx.prepare({ path: ctx.image(), kind: "image", name: "L", target: { path: "Workspace/X", class: klass, property } });
    await ctx.publish({ prepareId: r.prepareId, confirmation: RU_IMAGE });
    ctx.cloud.operation = doneOp("Approved");
    await ctx.app.poller.tick();
    assert.equal(inst(ctx, "Workspace/X").class, klass);
    assert.equal(inst(ctx, "Workspace/X").props[property], "rbxassetid://777");
  });
}

test("poller: rejection keeps the placeholder and records the reason", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  ctx.cloud.operation = doneOp("Rejected", { moderationResult: { moderationState: "Rejected", moderationNote: "Contains banned audio" } });
  await ctx.app.poller.tick();
  const e = await entry(ctx, prepareId);
  assert.equal(e.status, "rejected");
  assert.match(e.reason, /banned audio/);
  assert.equal(inst(ctx).attrs.RoLinkPendingAsset, prepareId);
  assert.equal(inst(ctx).props.SoundId ?? "", "");
});

test("poller: rejection without a reason says Roblox gave none", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  ctx.cloud.operation = doneOp("Rejected");
  await ctx.app.poller.tick();
  assert.match((await entry(ctx, prepareId)).reason, /no reason|did not (give|return)/i);
});

test("poller: an absent moderation field is never treated as approved", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  ctx.cloud.operation = doneOp(null);
  ctx.cloud.moderation = undefined;
  await ctx.app.poller.tick();
  assert.equal((await entry(ctx, prepareId)).status, "reviewing");
  assert.equal(inst(ctx).props.SoundId ?? "", "");
});

test("poller: an operation error fails the entry and keeps the reason", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  ctx.cloud.operation = { path: "operations/op1", done: true, error: { code: 400, message: "Audio file is corrupt" } };
  await ctx.app.poller.tick();
  const e = await entry(ctx, prepareId);
  assert.equal(e.status, "failed");
  assert.match(e.reason, /corrupt/);
});

test("a finished entry is not polled again", async (t) => {
  const ctx = await setup(t);
  await published(ctx);
  ctx.cloud.operation = doneOp("Approved");
  await ctx.app.poller.tick();
  const n = ctx.cloud.requests.length;
  await ctx.app.poller.tick();
  assert.equal(ctx.cloud.requests.length, n);
});

test("no target: approval still ends in the queue, nothing touches Studio", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare({ path: ctx.audio(), kind: "audio", name: "T" });
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO });
  ctx.cloud.operation = doneOp("Approved");
  await ctx.app.poller.tick();
  assert.equal((await entry(ctx, r.prepareId)).status, "approved");
  assert.equal(ctx.rl.calls.length, 0);
});

test("Studio offline at publish: placeholder appears once it connects", async (t) => {
  const ctx = await setup(t, { rolink: { online: false } });
  const { prepareId, pub } = await published(ctx);
  assert.equal(pub.placeholder.created, false);
  assert.match(pub.placeholder.note, /Studio/);
  assert.equal(inst(ctx), undefined);
  await ctx.app.poller.tick();
  assert.equal(inst(ctx), undefined);
  ctx.rl.online = true;
  await ctx.app.poller.tick();
  assert.equal(inst(ctx).attrs.RoLinkPendingAsset, prepareId);
});

test("Studio offline at approval: the swap waits and then happens", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  ctx.rl.online = false;
  ctx.cloud.operation = doneOp("Approved");
  await ctx.app.poller.tick();
  assert.equal((await entry(ctx, prepareId)).status, "approved");
  ctx.rl.online = true;
  await ctx.app.poller.tick();
  assert.equal(inst(ctx).props.SoundId, "rbxassetid://777");
  assert.equal((await entry(ctx, prepareId)).status, "applied");
});

test("restart: the queue is on disk and resumes, including the swap", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  ctx.rl.online = false;
  ctx.app.close();
  ctx.reopen();
  const q = await entry(ctx, prepareId);
  assert.equal(q.prepareId, prepareId);
  ctx.cloud.operation = doneOp("Approved");
  await ctx.app.poller.tick();
  ctx.app.close();
  ctx.reopen();
  ctx.rl.online = true;
  await ctx.app.poller.tick();
  assert.equal(inst(ctx).props.SoundId, "rbxassetid://777");
  assert.equal((await entry(ctx, prepareId)).status, "applied");
});

test("restart: a used prepareId stays used", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  ctx.app.close();
  ctx.reopen();
  await assert.rejects(ctx.publish({ prepareId, confirmation: RU_AUDIO }), /already used/i);
});

test("the instance is recreated at swap time if Studio lost the placeholder", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  ctx.rl.instances.delete(PATH); // place closed without saving
  ctx.cloud.operation = doneOp("Approved");
  await ctx.app.poller.tick();
  assert.equal(inst(ctx).props.SoundId, "rbxassetid://777");
  assert.equal(inst(ctx).attrs.RoLinkPendingAsset, undefined);
  assert.equal((await entry(ctx, prepareId)).status, "applied");
});

test("a newer upload owning the placeholder is not overwritten by an older one", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  inst(ctx).attrs.RoLinkPendingAsset = "someone-else";
  ctx.cloud.operation = doneOp("Approved");
  await ctx.app.poller.tick();
  assert.equal(inst(ctx).props.SoundId ?? "", "");
  const e = await entry(ctx, prepareId);
  assert.equal(e.status, "approved");
  assert.match(e.placeholder.error, /another|someone-else/);
});

test("the entry stays bound to the place it was started in", async (t) => {
  const ctx = await setup(t);
  await published(ctx);
  assert.ok(ctx.rl.calls.every((c) => c.args.place === "55"), JSON.stringify(ctx.rl.calls));
  ctx.rl.sessions = [{ context: "edit", placeName: "Other", placeId: 66, gameId: 1, pluginVersion: "t", connectedAt: 3, lastSeen: 3 }];
  const before = ctx.rl.calls.length;
  ctx.cloud.operation = doneOp("Approved");
  await ctx.app.poller.tick();
  assert.equal(ctx.rl.calls.length, before, "must wait for its own place");
  assert.equal(inst(ctx).props.SoundId ?? "", "");
});

test("a play-test session does not count as Studio being ready", async (t) => {
  const ctx = await setup(t);
  ctx.rl.sessions = [{ context: "server", placeName: "Game", placeId: 55, gameId: 9, pluginVersion: "t", connectedAt: 1, lastSeen: 2 }];
  const { pub } = await published(ctx);
  assert.equal(pub.placeholder.created, false);
  assert.equal(ctx.rl.calls.length, 0);
});

test("publish_status lists every entry when no id is given", async (t) => {
  const ctx = await setup(t);
  await published(ctx);
  const r = await ctx.prepare({ path: ctx.image(), kind: "image", name: "L" });
  await ctx.publish({ prepareId: r.prepareId, confirmation: RU_IMAGE });
  const all = await ctx.app.publisher.publishStatus({});
  assert.equal(all.queue.length, 2);
});

test("an upload interrupted by a crash is marked failed after the grace period", async (t) => {
  const ctx = await setup(t);
  const stateFile = `${ctx.stateDir}/state.json`;
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.queue.push({ prepareId: "old", kind: "audio", name: "x", status: "uploading", createdAt: Date.now() - 3_600_000, updatedAt: 0 });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await ctx.app.poller.tick();
  const e = await entry(ctx, "old");
  assert.equal(e.status, "failed");
  assert.match(e.reason, /interrupted/i);
});

test("a 429 during polling leaves the entry alone and backs off", async (t) => {
  const ctx = await setup(t);
  const { prepareId } = await published(ctx);
  ctx.cloud.operationResponse = () => new Response("{}", { status: 429, headers: { "retry-after": "60" } });
  await ctx.app.poller.tick();
  const e = await entry(ctx, prepareId);
  assert.equal(e.status, "processing");
  assert.match(e.lastError, /limit/i);
  const n = ctx.cloud.requests.length;
  await ctx.app.poller.tick();
  assert.equal(ctx.cloud.requests.length, n, "paused until Retry-After");
});
