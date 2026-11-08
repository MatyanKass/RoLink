import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { AcrCloudProvider, AuddProvider, providersFromEnv } from "../dist/copyright.js";
import { RU_AUDIO, json, setup, wav } from "./helpers.mjs";

const provider = (result) => ({ name: "fake", maxBytes: 1024 * 1024, check: async () => result });
const audio = (ctx) => ({ path: ctx.audio(), kind: "audio", name: "Song" });

test("no provider configured: says the check did not run", async (t) => {
  const ctx = await setup(t);
  const r = await ctx.prepare(audio(ctx));
  assert.equal(r.copyright.status, "not_run");
  assert.match(r.summary, /did not run/i);
  assert.doesNotMatch(r.summary, /no copyright|clean|safe/i);
});

test("images: states the check did not run", async (t) => {
  const ctx = await setup(t);
  ctx.app.publisher.setCopyrightProviders([provider({ kind: "match", title: "T", artist: "A" })]);
  const r = await ctx.prepare({ path: ctx.image(), kind: "image", name: "P" });
  assert.equal(r.copyright.status, "not_run");
  assert.match(r.summary, /did not run/i);
});

test("no match: never claims the sound is free of copyright", async (t) => {
  const ctx = await setup(t);
  ctx.app.publisher.setCopyrightProviders([provider({ kind: "no_match" })]);
  const r = await ctx.prepare(audio(ctx));
  assert.equal(r.copyright.status, "no_match");
  assert.match(r.summary, /does not (mean|prove)/i);
  assert.equal(r.requiredPhrase, RU_AUDIO);
});

test("provider failure: reports that the check did not complete", async (t) => {
  const ctx = await setup(t);
  ctx.app.publisher.setCopyrightProviders([{ name: "fake", maxBytes: 1024, check: async () => { throw new Error("boom"); } }]);
  const r = await ctx.prepare(audio(ctx));
  assert.equal(r.copyright.status, "error");
  assert.match(r.summary, /did not run|could not/i);
});

test("match: warns with title and artist and strike risk", async (t) => {
  const ctx = await setup(t);
  ctx.app.publisher.setCopyrightProviders([provider({ kind: "match", title: "Hello", artist: "Adele" })]);
  const r = await ctx.prepare(audio(ctx));
  assert.equal(r.copyright.status, "match");
  assert.match(r.summary, /Hello/);
  assert.match(r.summary, /Adele/);
  assert.match(r.summary, /copyright/i);
  assert.match(r.summary, /strike/i);
  assert.equal(r.requiredPhrase, "Я подтверждаю публикацию: Hello");
});

test("match: the base phrase no longer publishes", async (t) => {
  const ctx = await setup(t);
  ctx.app.publisher.setCopyrightProviders([provider({ kind: "match", title: "Hello", artist: "Adele" })]);
  const r = await ctx.prepare(audio(ctx));
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), /Я подтверждаю публикацию: Hello/);
  assert.equal(ctx.cloud.uploads.length, 0);
});

test("match: the phrase naming the title publishes", async (t) => {
  const ctx = await setup(t);
  ctx.app.publisher.setCopyrightProviders([provider({ kind: "match", title: "Hello", artist: "Adele" })]);
  const r = await ctx.prepare(audio(ctx));
  await ctx.publish({ prepareId: r.prepareId, confirmation: "Я подтверждаю публикацию: Hello" });
  assert.equal(ctx.cloud.uploads.length, 1);
});

test("match: the English title phrase also publishes", async (t) => {
  const ctx = await setup(t);
  ctx.app.publisher.setCopyrightProviders([provider({ kind: "match", title: "Hello", artist: "Adele" })]);
  const r = await ctx.prepare(audio(ctx));
  await ctx.publish({ prepareId: r.prepareId, confirmation: "I confirm publishing: Hello" });
  assert.equal(ctx.cloud.uploads.length, 1);
});

test("match survives a restart", async (t) => {
  const ctx = await setup(t);
  ctx.app.publisher.setCopyrightProviders([provider({ kind: "match", title: "Hello", artist: "Adele" })]);
  const r = await ctx.prepare(audio(ctx));
  ctx.app.close();
  ctx.reopen();
  await assert.rejects(ctx.publish({ prepareId: r.prepareId, confirmation: RU_AUDIO }), /phrase/i);
});

test("provider titles are sanitised before they reach the phrase", async (t) => {
  const ctx = await setup(t);
  ctx.app.publisher.setCopyrightProviders([provider({ kind: "match", title: "  A\n\tB\u0007  ", artist: "X" })]);
  const r = await ctx.prepare(audio(ctx));
  assert.equal(r.requiredPhrase, "Я подтверждаю публикацию: A B");
});

test("a file larger than the provider limit is checked partially and says so", async (t) => {
  const ctx = await setup(t);
  let seen = 0;
  ctx.app.publisher.setCopyrightProviders([{ name: "fake", maxBytes: 50, check: async (b) => { seen = b.length; return { kind: "no_match" }; } }]);
  const r = await ctx.prepare({ path: ctx.audio("l.wav", wav(30)), kind: "audio", name: "L" });
  assert.equal(seen, 50);
  assert.equal(r.copyright.partial, true);
  assert.match(r.summary, /first|part/i);
});

test("providersFromEnv picks adapters from env keys only", () => {
  assert.deepEqual(providersFromEnv({}, fetch), []);
  assert.deepEqual(providersFromEnv({ AUDD_API_TOKEN: "t" }, fetch).map((p) => p.name), ["AudD"]);
  assert.deepEqual(
    providersFromEnv({ ACRCLOUD_HOST: "h.example", ACRCLOUD_ACCESS_KEY: "k", ACRCLOUD_ACCESS_SECRET: "s" }, fetch).map((p) => p.name),
    ["ACRCloud"],
  );
  assert.deepEqual(providersFromEnv({ ACRCLOUD_HOST: "h.example" }, fetch), []);
});

test("AudD adapter maps a match", async () => {
  let form;
  const p = new AuddProvider("tok", async (url, init) => {
    assert.equal(String(url), "https://api.audd.io/");
    form = init.body;
    return json(200, { status: "success", result: { title: "Song", artist: "Band" } });
  });
  const r = await p.check(Buffer.from("x"), "a.mp3");
  assert.deepEqual(r, { kind: "match", title: "Song", artist: "Band" });
  assert.equal(form.get("api_token"), "tok");
});

test("AudD adapter maps null to no_match and an error status to a throw", async () => {
  const none = new AuddProvider("tok", async () => json(200, { status: "success", result: null }));
  assert.deepEqual(await none.check(Buffer.from("x"), "a.mp3"), { kind: "no_match" });
  const bad = new AuddProvider("tok", async () => json(200, { status: "error", error: { error_code: 900, error_message: "bad token" } }));
  await assert.rejects(bad.check(Buffer.from("x"), "a.mp3"), /bad token/);
});

test("ACRCloud adapter signs the request as documented and maps a match", async () => {
  let form;
  const p = new AcrCloudProvider("id.acrcloud.com", "akey", "asecret", async (url, init) => {
    assert.equal(String(url), "https://id.acrcloud.com/v1/identify");
    form = init.body;
    return json(200, { status: { code: 0, msg: "Success" }, metadata: { music: [{ title: "Hello", artists: [{ name: "Adele" }, { name: "Z" }] }] } });
  });
  const r = await p.check(Buffer.from("abcd"), "a.mp3");
  assert.deepEqual(r, { kind: "match", title: "Hello", artist: "Adele, Z" });
  const ts = form.get("timestamp");
  const expected = crypto.createHmac("sha1", "asecret").update(`POST\n/v1/identify\nakey\naudio\n1\n${ts}`).digest("base64");
  assert.equal(form.get("signature"), expected);
  assert.equal(form.get("sample_bytes"), "4");
  assert.equal(form.get("access_key"), "akey");
});

test("ACRCloud adapter maps code 1001 to no_match and others to a throw", async () => {
  const none = new AcrCloudProvider("h", "k", "s", async () => json(200, { status: { code: 1001, msg: "No result" } }));
  assert.deepEqual(await none.check(Buffer.from("x"), "a.mp3"), { kind: "no_match" });
  const bad = new AcrCloudProvider("h", "k", "s", async () => json(200, { status: { code: 3001, msg: "Missing/Invalid Access Key" } }));
  await assert.rejects(bad.check(Buffer.from("x"), "a.mp3"), /Invalid Access Key/);
});
