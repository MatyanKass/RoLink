// Shared fixtures: a scriptable Open Cloud fake, a real local HTTP stand-in for
// RoLink's /health + /rpc, and builders for small valid media files.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createPublisher } from "../dist/app.js";

export const KEY = "SECRET-OPEN-CLOUD-KEY-abc123";
export const RU_AUDIO = "Я согласен на публикацию звуков";
export const RU_IMAGE = "Я согласен на публикацию картинок";
export const EN_AUDIO = "I agree to publish sounds";
export const EN_IMAGE = "I agree to publish images";

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rolink-pub-"));
}

// ------------------------------------------------------------------ media

/** 16-bit mono PCM WAV whose byte rate makes it last `seconds`. */
export function wav(seconds = 1, { extra = 0 } = {}) {
  const sampleRate = 8; // tiny rate keeps long durations in a small file
  const byteRate = sampleRate * 2;
  const dataSize = seconds * byteRate + extra * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + dataSize, 4);
  b.write("WAVE", 8, "latin1");
  b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(byteRate, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(dataSize, 40);
  return b;
}

/** `frames` MPEG1 Layer III, 128 kbps, 44.1 kHz CBR frames after an ID3v2 tag. */
export function mp3(frames) {
  const id3 = Buffer.alloc(10 + 20);
  id3.write("ID3", 0, "latin1");
  id3[3] = 4;
  id3[9] = 20; // syncsafe size
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG1, Layer III, no CRC
  frame[2] = 0x90; // 128 kbps, 44100 Hz, no padding
  frame[3] = 0x00;
  return Buffer.concat([id3, ...Array(frames).fill(frame)]);
}

export function flac(seconds, sampleRate = 44100) {
  const b = Buffer.alloc(4 + 4 + 34);
  b.write("fLaC", 0, "latin1");
  b[4] = 0x80; // last-metadata-block flag, type 0 (STREAMINFO)
  b[7] = 34;
  const total = seconds * sampleRate;
  b[18] = (sampleRate >> 12) & 0xff;
  b[19] = (sampleRate >> 4) & 0xff;
  b[20] = ((sampleRate & 0x0f) << 4) | 0x02; // mono-ish channel bits
  b[21] = 0xf0 | Math.floor(total / 2 ** 32);
  b.writeUInt32BE(total >>> 0, 22);
  return b;
}

function oggPage(granule, packet, serial = 7) {
  const head = Buffer.alloc(27);
  head.write("OggS", 0, "latin1");
  head.writeBigUInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial, 14);
  head[26] = 1;
  return Buffer.concat([head, Buffer.from([packet.length]), packet]);
}

export function oggVorbis(seconds, sampleRate = 48000) {
  const id = Buffer.alloc(30);
  id[0] = 1;
  id.write("vorbis", 1, "latin1");
  id[11] = 2;
  id.writeUInt32LE(sampleRate, 12);
  return Buffer.concat([oggPage(0, id), oggPage(seconds * sampleRate, Buffer.from([1, 2, 3]))]);
}

export function oggOpus(seconds, preSkip = 312) {
  const id = Buffer.alloc(19);
  id.write("OpusHead", 0, "latin1");
  id[8] = 1;
  id[9] = 2;
  id.writeUInt16LE(preSkip, 10);
  return Buffer.concat([oggPage(0, id), oggPage(seconds * 48000 + preSkip, Buffer.from([1, 2, 3]))]);
}

export function png(w = 16, h = 16) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

export function jpeg(w = 20, h = 10) {
  // SOI, APP0 (empty payload), SOF0
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3]);
}

export function bmp(w = 4, h = -3) {
  const b = Buffer.alloc(30);
  b.write("BM", 0, "latin1");
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  return b;
}

export function tga(w = 5, h = 6) {
  const b = Buffer.alloc(18);
  b[2] = 2;
  b.writeUInt16LE(w, 12);
  b.writeUInt16LE(h, 14);
  b[16] = 32;
  return b;
}

export function writeFile(dir, name, data) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, data);
  return f;
}

// ------------------------------------------------------------------ Open Cloud fake

export function fakeCloud() {
  const cloud = {
    requests: [],
    uploads: [],
    placeUploads: [],
    /** what the next Create Asset returns, or a Response factory */
    createResponse: () => json(200, { path: "operations/op1" }),
    operation: { path: "operations/op1", done: false },
    /** moderation returned by Get Asset Version, undefined = field absent */
    moderation: { moderationState: "Reviewing" },
    placeResponse: () => json(200, { versionNumber: 12 }),
    throwWith: undefined,
  };
  cloud.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = new Headers(init.headers);
    const rec = { method: init.method ?? "GET", url: u, key: headers.get("x-api-key"), contentType: headers.get("content-type") };
    cloud.requests.push(rec);
    if (cloud.throwWith) throw new Error(cloud.throwWith);
    if (u.hostname !== "apis.roblox.com") throw new Error(`unexpected host ${u.hostname}`);
    if (rec.method === "POST" && u.pathname === "/assets/v1/assets") {
      const form = init.body;
      const file = form.get("fileContent");
      cloud.uploads.push({
        request: JSON.parse(form.get("request")),
        type: file.type,
        name: file.name,
        bytes: Buffer.from(await file.arrayBuffer()),
      });
      return cloud.createResponse();
    }
    if (u.pathname === "/assets/v1/operations/op1") return cloud.operationResponse ? cloud.operationResponse() : json(200, cloud.operation);
    const version = /^\/assets\/v1\/assets\/(\d+)\/versions\/(\d+)$/.exec(u.pathname);
    if (version) return json(200, cloud.moderation === undefined ? { path: u.pathname.slice(10) } : { moderationResult: cloud.moderation });
    const place = /^\/universes\/v1\/(\d+)\/places\/(\d+)\/versions$/.exec(u.pathname);
    if (rec.method === "POST" && place) {
      cloud.placeUploads.push({ universeId: place[1], placeId: place[2], versionType: u.searchParams.get("versionType"), contentType: rec.contentType, bytes: Buffer.from(init.body) });
      return cloud.placeResponse();
    }
    return json(404, { message: `no fake route ${rec.method} ${u.pathname}` });
  };
  return cloud;
}

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function doneOp(moderationState = "MODERATION_STATE_REVIEWING", extra = {}) {
  return {
    path: "operations/op1",
    done: true,
    response: { assetId: "777", revisionId: "1", ...(moderationState ? { moderationResult: { moderationState } } : {}), ...extra },
  };
}

// ------------------------------------------------------------------ RoLink stand-in

/** Real HTTP server speaking RoLink's /health and /rpc, with a tiny instance model. */
export async function fakeRoLink({ online = true } = {}) {
  const rl = {
    online,
    sessions: [{ context: "edit", placeName: "Game", placeId: 55, gameId: 9, pluginVersion: "t", connectedAt: 1, lastSeen: 2 }],
    instances: new Map(),
    calls: [],
    rawBodies: [],
    dialog: { confirmed: true },
    badToken: 0,
  };
  const token = crypto.randomBytes(8).toString("hex");
  const answer = (tool, args) => {
    if (!rl.online) throw new Error("Roblox Studio is not connected.");
    switch (tool) {
      case "get": {
        const i = rl.instances.get(args.path);
        if (!i) throw new Error(`not found: ${args.path}`);
        return { text: JSON.stringify({ path: args.path, class: i.class, props: i.props, attrs: i.attrs }) };
      }
      case "build": {
        if (args.parent !== "Workspace" && !rl.instances.has(args.parent)) throw new Error(`not found: ${args.parent}`);
        for (const n of args.items) {
          const props = {};
          for (const [k, v] of Object.entries(n)) if (!["class", "name", "attrs"].includes(k)) props[k] = v;
          rl.instances.set(`${args.parent}/${n.name}`, { class: n.class, props, attrs: { ...n.attrs } });
        }
        return { text: JSON.stringify({ created: args.items.length }) };
      }
      case "set": {
        for (const e of args.edits) {
          const i = rl.instances.get(e.path);
          if (!i) throw new Error(`not found: ${e.path}`);
          Object.assign(i.props, e.props);
          for (const [k, v] of Object.entries(e.attrs ?? {})) {
            if (v === false && e.removeFalseAttrs) delete i.attrs[k];
            else i.attrs[k] = v;
          }
        }
        return { text: JSON.stringify({ updated: args.edits.length, warnings: [] }) };
      }
      case "confirm_dialog":
        return { text: JSON.stringify(rl.dialog) };
    }
    throw new Error(`unknown tool ${tool}`);
  };
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") return send(200, { rolink: true, version: "t", sessions: rl.online ? rl.sessions : [] });
    if (req.method === "POST" && req.url === "/rpc") {
      if (req.headers["x-rolink-token"] !== token) {
        rl.badToken++;
        return send(401, { error: "bad token" });
      }
      let text = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (text += c));
      req.on("end", () => {
        rl.rawBodies.push(text);
        const b = JSON.parse(text);
        rl.calls.push(b);
        try {
          send(200, { ok: true, result: answer(b.tool, b.args) });
        } catch (e) {
          send(200, { ok: false, error: e.message });
        }
      });
      return;
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  rl.port = server.address().port;
  const tokenFile = path.join(os.tmpdir(), `rolink-${rl.port}.token`);
  fs.writeFileSync(tokenFile, token);
  rl.close = () =>
    new Promise((r) => {
      fs.rmSync(tokenFile, { force: true });
      server.close(r);
      server.closeAllConnections();
    });
  rl.ops = (tool) => rl.calls.filter((c) => c.tool === tool);
  return rl;
}

// ------------------------------------------------------------------ harness

/** One publisher wired to the fakes; `reopen()` simulates a process restart. */
export async function setup(t, { env = {}, rolink = {}, stateDir = tmpDir() } = {}) {
  const rl = await fakeRoLink(rolink);
  const cloud = fakeCloud();
  const logs = [];
  const results = [];
  const dir = tmpDir();
  const fullEnv = { ROBLOX_PUBLISH_API_KEY: KEY, ROBLOX_CREATOR_USER_ID: "42", ROLINK_PORT: String(rl.port), ...env };
  const open = () =>
    createPublisher({ env: fullEnv, stateDir, fetchImpl: cloud.fetch, logSink: (line) => logs.push(line) });
  const ctx = { rl, cloud, logs, results, dir, stateDir, app: open() };
  ctx.reopen = () => (ctx.app = open());
  // records every result so the secrets test can scan them
  ctx.prepare = async (args) => {
    const r = await ctx.app.publisher.prepareAsset(args);
    results.push(r);
    return r;
  };
  ctx.publish = async (args) => {
    const r = await ctx.app.publisher.publishAsset(args);
    results.push(r);
    return r;
  };
  ctx.audio = (name = "a.wav", data = wav(2)) => writeFile(dir, name, data);
  ctx.image = (name = "a.png", data = png()) => writeFile(dir, name, data);
  t.after(async () => {
    ctx.app.close();
    await rl.close();
  });
  return ctx;
}
