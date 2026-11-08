import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inspectMedia, MAX_AUDIO_SECONDS, MAX_FILE_BYTES, MAX_IMAGE_SIDE } from "../dist/media.js";
import { bmp, flac, jpeg, mp3, oggOpus, oggVorbis, png, tga, tmpDir, wav, writeFile } from "./helpers.mjs";

const dir = tmpDir();

test("published limits match the Roblox docs", () => {
  assert.equal(MAX_AUDIO_SECONDS, 420);
  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_IMAGE_SIDE, 8000);
});

test("wav duration comes from the data chunk", async () => {
  const m = await inspectMedia(writeFile(dir, "ok.wav", wav(90)), "audio");
  assert.equal(m.durationSeconds, 90);
  assert.equal(m.contentType, "audio/wav");
});

test("audio of exactly 7 minutes is allowed", async () => {
  const m = await inspectMedia(writeFile(dir, "max.wav", wav(420)), "audio");
  assert.equal(m.durationSeconds, 420);
});

test("audio longer than 7 minutes is refused", async () => {
  await assert.rejects(inspectMedia(writeFile(dir, "long.wav", wav(421)), "audio"), /7 min/);
});

test("mp3 duration is summed from frames past the ID3 tag", async () => {
  const m = await inspectMedia(writeFile(dir, "a.mp3", mp3(100)), "audio");
  assert.ok(Math.abs(m.durationSeconds - (100 * 1152) / 44100) < 0.01, String(m.durationSeconds));
  assert.equal(m.contentType, "audio/mpeg");
});

test("flac duration comes from STREAMINFO", async () => {
  const m = await inspectMedia(writeFile(dir, "a.flac", flac(33)), "audio");
  assert.equal(m.durationSeconds, 33);
  assert.equal(m.contentType, "audio/flac");
});

test("flac without a sample count is refused rather than guessed", async () => {
  await assert.rejects(inspectMedia(writeFile(dir, "z.flac", flac(0)), "audio"), /duration/i);
});

test("ogg vorbis duration uses the last page granule", async () => {
  const m = await inspectMedia(writeFile(dir, "v.ogg", oggVorbis(12, 44100)), "audio");
  assert.equal(m.durationSeconds, 12);
});

test("ogg opus duration subtracts pre-skip at 48 kHz", async () => {
  const m = await inspectMedia(writeFile(dir, "o.ogg", oggOpus(8)), "audio");
  assert.equal(m.durationSeconds, 8);
});

test("unsupported extension is refused with the allowed list", async () => {
  await assert.rejects(inspectMedia(writeFile(dir, "x.m4a", wav(1)), "audio"), /\.mp3.*\.ogg.*\.wav.*\.flac/);
});

test("an image extension is refused for kind audio", async () => {
  await assert.rejects(inspectMedia(writeFile(dir, "p.png", png()), "audio"), /not supported/i);
});

test("content that does not match the extension is refused", async () => {
  await assert.rejects(inspectMedia(writeFile(dir, "fake.wav", png()), "audio"), /not a valid/i);
});

test("a file over 20 MiB is refused without reading it", async () => {
  const f = path.join(dir, "big.wav");
  const h = fs.openSync(f, "w");
  fs.ftruncateSync(h, MAX_FILE_BYTES + 1);
  fs.closeSync(h);
  await assert.rejects(inspectMedia(f, "audio"), /20 MB/);
});

test("a relative path is refused", async () => {
  await assert.rejects(inspectMedia("rel/a.wav", "audio"), /absolute/i);
});

test("a missing file gives a readable error", async () => {
  await assert.rejects(inspectMedia(path.join(dir, "nope.wav"), "audio"), /not found|does not exist/i);
});

for (const [name, data, w, h, type] of [
  ["i.png", png(100, 50), 100, 50, "image/png"],
  ["i.jpg", jpeg(20, 10), 20, 10, "image/jpeg"],
  ["i.jpeg", jpeg(21, 11), 21, 11, "image/jpeg"],
  ["i.bmp", bmp(4, -3), 4, 3, "image/bmp"],
  ["i.tga", tga(5, 6), 5, 6, "image/tga"],
]) {
  test(`${name} dimensions and content type`, async () => {
    const m = await inspectMedia(writeFile(dir, name, data), "image");
    assert.deepEqual([m.width, m.height, m.contentType], [w, h, type]);
  });
}

test("images must be smaller than 8000x8000", async () => {
  await assert.rejects(inspectMedia(writeFile(dir, "w.png", png(8000, 10)), "image"), /8000/);
  const m = await inspectMedia(writeFile(dir, "ok.png", png(7999, 7999)), "image");
  assert.equal(m.width, 7999);
});
