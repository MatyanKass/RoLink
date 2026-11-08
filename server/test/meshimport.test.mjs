// Unit tests for the local model parsers / chunker / upload client.
//   npm run build && node --test test/meshimport.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseObj, parseMtl, parseStl, prepareChunks, validateModelPath, loadModel, MAX_TRIS_PER_CHUNK, MAX_TOTAL_TRIS, MAX_REFERENCED_BYTES,
} from "../dist/meshimport.js";
import { uploadConfig, uploadModel } from "../dist/assetupload.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-mesh-"));
const f32 = (b64) => { const b = Buffer.from(b64, "base64"); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
const u32 = (b64) => { const b = Buffer.from(b64, "base64"); return new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };

const OBJ = `mtllib m.mtl
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
o Quad
usemtl Red
f 1/1/1 2/2/1 3/3/1 4/4/1
o Tri
usemtl Blue
f -5 -4 -1
`;
const MTL = `newmtl Red\nKd 1 0 0\nnewmtl Blue\nKd 0 0 1\nd 0.5\n`;

test("OBJ: objects, materials, n-gon fan triangulation, uv flip", () => {
  const g = parseObj(OBJ, parseMtl(MTL));
  assert.equal(g.length, 2);
  assert.equal(g[0].name, "Quad_Red");
  assert.deepEqual(g[0].indices, [0, 1, 2, 0, 2, 3]);
  assert.deepEqual(g[0].color, [1, 0, 0]);
  assert.deepEqual(g[0].uvs.slice(0, 2), [0, 1]); // v flipped
  assert.equal(g[0].normals.length, 12);
  assert.equal(g[1].indices.length, 3);
  assert.equal(g[1].transparency, 0.5);
  assert.equal(g[1].normals, undefined); // no vn on that face set -> computed later
  assert.deepEqual(g[1].positions.slice(6), [0, 0, 1]); // negative index
});

test("OBJ: loadModel reads mtllib next to the file", async () => {
  fs.writeFileSync(path.join(tmp, "a.obj"), OBJ);
  fs.writeFileSync(path.join(tmp, "m.mtl"), MTL);
  const g = await loadModel(path.join(tmp, "a.obj"), ".obj");
  assert.deepEqual(g[1].color, [0, 0, 1]);
});

test("OBJ: bad index errors", () => {
  assert.throws(() => parseObj("v 0 0 0\nf 1 2 3\n"), /bad vertex index/);
  assert.throws(() => parseObj("v 0 0 0\n"), /no faces/);
});

function binaryStl(tris) {
  const b = Buffer.alloc(84 + tris.length * 50);
  b.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const o = 84 + i * 50;
    [0, 0, 1, ...t.flat()].forEach((v, k) => b.writeFloatLE(v, o + k * 4));
  });
  return b;
}

test("STL binary + ascii, Z-up converted to Y-up", () => {
  const tri = [[0, 0, 0], [1, 0, 0], [0, 1, 2]];
  const bin = parseStl(binaryStl([tri]));
  assert.deepEqual(bin[0].positions.slice(6), [0, 2, -1]);
  assert.deepEqual(bin[0].normals.slice(0, 3), [0, 1, -0]);
  const ascii = parseStl(Buffer.from(
    "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 2\nendloop\nendfacet\nendsolid t\n"));
  assert.deepEqual(ascii[0].positions, bin[0].positions);
  assert.deepEqual(ascii[0].indices, [0, 1, 2]);
});

test("chunking: fitSize, centering, per-chunk limits", () => {
  // grid of 2*N*N triangles > one chunk
  const N = 120;
  const positions = [], indices = [];
  for (let z = 0; z <= N; z++) for (let x = 0; x <= N; x++) positions.push(x, 0, z);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
    const a = z * (N + 1) + x, b = a + 1, c = a + N + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const p = prepareChunks([{ name: "Grid", positions, indices }], { fitSize: 12 });
  assert.equal(p.triangles, 2 * N * N);
  assert.ok(p.chunks.length >= 2);
  let tris = 0;
  for (const c of p.chunks) {
    assert.ok(c.triangleCount <= MAX_TRIS_PER_CHUNK);
    const pos = f32(c.positions), ind = u32(c.indices);
    assert.equal(pos.length, c.vertexCount * 3);
    assert.equal(ind.length, c.triangleCount * 3);
    assert.ok(Math.max(...ind) < c.vertexCount);
    for (let i = 0; i < pos.length; i++) assert.ok(Math.abs(pos[i]) <= c.size[i % 3] / 2 + 1e-4);
    tris += c.triangleCount;
  }
  assert.equal(tris, p.triangles);
  assert.ok(Math.abs(p.size[0] - 12) < 1e-9 && Math.abs(p.size[2] - 12) < 1e-9);
  // centered on x/z: chunk centers lie within [-6, 6]
  for (const c of p.chunks) assert.ok(Math.abs(c.center[0]) <= 6 && Math.abs(c.center[2]) <= 6);
});

test("chunking: scale + bottom at y=0 + computed normals", () => {
  const p = prepareChunks([{ name: "T", positions: [0, 5, 0, 2, 5, 0, 0, 7, 0], indices: [0, 1, 2] }], { scale: 2 });
  const c = p.chunks[0];
  assert.deepEqual(p.size, [4, 4, 0]);
  assert.deepEqual(c.center, [0, 2, 0]);
  const n = f32(c.normals);
  assert.ok(Math.abs(n[2] - 1) < 1e-6);
  assert.throws(() => prepareChunks([{ name: "x", positions: [0, 0, 0], indices: [] }]), /no triangles/);
});

test("path validation", () => {
  assert.throws(() => validateModelPath(path.join(tmp, "nope.obj"), [".obj"]), /not found/);
  fs.writeFileSync(path.join(tmp, "x.txt"), "x");
  assert.throws(() => validateModelPath(path.join(tmp, "x.txt"), [".obj"]), /unsupported extension/);
  const v = validateModelPath(path.join(tmp, "a.obj"), [".obj"]);
  assert.equal(v.ext, ".obj");
  assert.ok(path.isAbsolute(v.file));
});

test("upload config + Open Cloud flow with mocked fetch (key never leaks)", async () => {
  assert.equal(uploadConfig({ ROBLOX_API_KEY: "k" }), undefined);
  const cfg = uploadConfig({ ROBLOX_API_KEY: "SECRET", ROBLOX_CREATOR_USER_ID: "42" });
  assert.equal(cfg.userId, "42");
  const fbx = path.join(tmp, "m.fbx");
  fs.writeFileSync(fbx, "fbxdata");
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ url, init });
    if (init?.method === "POST") {
      const req = JSON.parse(init.body.get("request"));
      assert.equal(req.assetType, "Model");
      assert.equal(req.creationContext.creator.userId, "42");
      assert.equal(init.body.get("fileContent").type, "model/fbx");
      return new Response(JSON.stringify({ path: "operations/abc", done: false }), { status: 200 });
    }
    return new Response(JSON.stringify({ done: true, response: { assetId: "987" } }), { status: 200 });
  };
  const r = await uploadModel(cfg, fbx, ".fbx", "m", { fetchImpl: fake });
  assert.equal(r.assetId, "987");
  assert.equal(seen[1].url, "https://apis.roblox.com/assets/v1/operations/abc");
  assert.equal(seen[0].init.headers["x-api-key"], "SECRET");
  const bad = async () => new Response(JSON.stringify({ message: "bad key SECRET" }), { status: 401 });
  await assert.rejects(uploadModel(cfg, fbx, ".fbx", "m", { fetchImpl: bad }), (e) => !e.message.includes("SECRET") && /401/.test(e.message));
});

test("glTF/GLB: node transform, indices, base color", async () => {
  const { Document, NodeIO } = await import("@gltf-transform/core");
  const doc = new Document();
  const buf = doc.createBuffer();
  const pos = doc.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
  const idx = doc.createAccessor().setType("SCALAR").setArray(new Uint16Array([0, 1, 2])).setBuffer(buf);
  const mat = doc.createMaterial("Green").setBaseColorFactor([0, 1, 0, 1]);
  const prim = doc.createPrimitive().setAttribute("POSITION", pos).setIndices(idx).setMaterial(mat);
  const mesh = doc.createMesh("Tri").addPrimitive(prim);
  const node = doc.createNode("N").setMesh(mesh).setTranslation([10, 0, 0]).setScale([2, 2, 2]);
  doc.createScene().addChild(node);
  const file = path.join(tmp, "t.glb");
  fs.writeFileSync(file, await new NodeIO().writeBinary(doc));
  const g = await loadModel(file, ".glb");
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].positions, [10, 0, 0, 12, 0, 0, 10, 2, 0]);
  assert.deepEqual(g[0].indices, [0, 1, 2]);
  assert.deepEqual(g[0].color.map((x) => Math.round(x * 1e6) / 1e6), [0, 1, 0]);
  assert.equal(g[0].name, "Tri_Green");
});

// ---------------------------------------------------------------- hostile model files

const dist = (f) => pathToFileURL(path.join(here, "..", "dist", f)).href;
/** Runs in a small-heap child so a regression shows up as a crash, not a dead test runner. */
function isolated(body) {
  const code = `import(${JSON.stringify(dist("meshimport.js"))}).then(async ({loadModel,validateModelPath}) => { try { ${body} } catch (e) { console.log("REJECTED:" + e.message); } process.exit(0); });`;
  return spawnSync(process.execPath, ["--max-old-space-size=256", "-e", code], { encoding: "utf8", timeout: 120_000, env: { ...process.env } });
}
function gltfFile(dir, name, doc) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify({ asset: { version: "2.0" }, ...doc }));
  return f;
}
const zeroMesh = (count) => ({
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ componentType: 5126, type: "VEC3", count }],
});
const onePointMesh = (uri, byteLength = 12) => ({
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  buffers: [{ byteLength, uri }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength }],
  accessors: [{ bufferView: 0, componentType: 5126, type: "VEC3", count: 1, min: [0, 0, 0], max: [1, 1, 1] }],
});

test("zero-backed huge-count accessor is refused before any allocation (PoC: sparse)", () => {
  const f = gltfFile(path.join(tmp, "h1"), "a.gltf", zeroMesh(300_000_000));
  const r = isolated(`await loadModel(${JSON.stringify(f)}, ".gltf"); console.log("LOADED");`);
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.match(r.stdout, /REJECTED:.*(accessor|limit)/i);
});

test("accessor counts are summed across the file (PoC: multi, 8 x 40M)", () => {
  const n = 8;
  const f = gltfFile(path.join(tmp, "h2"), "m.gltf", {
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: Array.from({ length: n }, (_, i) => ({ attributes: { POSITION: i } })) }],
    accessors: Array.from({ length: n }, () => ({ componentType: 5126, type: "VEC3", count: 40_000_000 })),
  });
  const r = isolated(`await loadModel(${JSON.stringify(f)}, ".gltf"); console.log("LOADED");`);
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.match(r.stdout, /REJECTED:.*(accessor|limit)/i);
});

test("the same mesh instanced by many nodes cannot expand past the vertex limit", async () => {
  const nodes = 50;
  const f = gltfFile(path.join(tmp, "h3"), "inst.gltf", {
    scene: 0, scenes: [{ nodes: Array.from({ length: nodes }, (_, i) => i) }],
    nodes: Array.from({ length: nodes }, () => ({ mesh: 0 })),
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ componentType: 5126, type: "VEC3", count: 150_000 }],
  });
  await assert.rejects(loadModel(f, ".gltf"), /limit/i);
});

test("a huge face line in a 51 MB OBJ is refused without ballooning memory (PoC: obj)", () => {
  const dir = path.join(tmp, "h4");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "a.obj");
  const fd = fs.openSync(f, "w");
  fs.writeSync(fd, "v 0 0 0\nv 1 0 0\nv 0 1 0\nf");
  const blk = " 1".repeat(512 * 1024);
  for (let i = 0; i < 49; i++) fs.writeSync(fd, blk);
  fs.writeSync(fd, "\n");
  fs.closeSync(fd);
  const r = isolated(`await loadModel(${JSON.stringify(f)}, ".obj"); console.log("LOADED");`);
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.match(r.stdout, /REJECTED:/);
  fs.rmSync(f);
});

test("OBJ parsing stops as soon as the triangle limit is passed", () => {
  const text = "v 0 0 0\nv 1 0 0\nv 0 1 0\n" + "f 1 2 3\n".repeat(MAX_TOTAL_TRIS + 1) + "f 9 9 9\n";
  assert.throws(() => parseObj(text), /limit/i);
});

test("glTF buffer uris outside the model folder are refused (PoC: uri)", async () => {
  const dir = path.join(tmp, "h5", "models");
  fs.mkdirSync(dir, { recursive: true });
  const secret = path.join(tmp, "h5", "SECRET.bin");
  fs.writeFileSync(secret, Buffer.alloc(12));
  const bad = [
    "../SECRET.bin", "%2e%2e/SECRET.bin", "..%5CSECRET.bin", "sub/../../SECRET.bin", secret.split(path.sep).join("/"),
    "/etc/passwd", "//evil.example/share/x.bin", "\\\\evil.example\\share\\x.bin", "\\\\?\\C:\\Windows\\win.ini", "\\\\.\\COM1",
    "C:/Windows/win.ini", "C:evil.bin", "a.bin:stream", "file:///C:/Windows/win.ini", "http://example.com/x.bin", "https://example.com/x.bin",
    "CON", "sub/NUL.bin", "COM1.bin", "CONOUT$", ".. /SECRET.bin", "x./y.bin",
  ];
  for (const uri of bad) {
    const f = gltfFile(dir, "a.gltf", onePointMesh(uri));
    await assert.rejects(loadModel(f, ".gltf"), /relative/i, `uri ${uri} must be refused`);
  }
});

test("glTF relative uris in the folder and subfolders, and data: uris, still load", async () => {
  const dir = path.join(tmp, "h6");
  fs.mkdirSync(path.join(dir, "sub dir"), { recursive: true });
  const bytes = Buffer.alloc(12);
  bytes.writeFloatLE(7, 0);
  fs.writeFileSync(path.join(dir, "here.bin"), bytes);
  fs.writeFileSync(path.join(dir, "sub dir", "b.bin"), bytes);
  for (const uri of ["here.bin", "./here.bin", "sub%20dir/b.bin", "data:application/octet-stream;base64," + bytes.toString("base64")]) {
    const f = gltfFile(dir, "ok.gltf", onePointMesh(uri));
    const g = await loadModel(f, ".gltf");
    assert.equal(g[0].positions[0], 7, uri);
  }
});

test("a directory link inside the model folder cannot reach outside it", async (t) => {
  const dir = path.join(tmp, "h7", "models");
  const outside = path.join(tmp, "h7", "outside");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "s.bin"), Buffer.alloc(12));
  try {
    fs.symlinkSync(outside, path.join(dir, "link"), "junction");
  } catch {
    return t.skip("cannot create a link here");
  }
  const f = gltfFile(dir, "a.gltf", onePointMesh("link/s.bin"));
  await assert.rejects(loadModel(f, ".gltf"), /outside/i);
});

test("total referenced bytes are capped before anything is read (PoC: bigfile)", async () => {
  const dir = path.join(tmp, "h8");
  fs.mkdirSync(dir, { recursive: true });
  const big = path.join(dir, "big.bin");
  const fd = fs.openSync(big, "w");
  fs.ftruncateSync(fd, MAX_REFERENCED_BYTES + 1);
  fs.closeSync(fd);
  const f = gltfFile(dir, "u.gltf", onePointMesh("big.bin", 12));
  const before = process.memoryUsage().rss;
  await assert.rejects(loadModel(f, ".gltf"), /referenced/i);
  assert.ok(process.memoryUsage().rss - before < 100 * 1048576, "must not read the file");
  fs.rmSync(big);
});

test("OBJ mtllib outside the folder is refused; a subfolder is fine (PoC: objmtl)", async () => {
  const dir = path.join(tmp, "h9", "models");
  fs.mkdirSync(path.join(dir, "mats"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "h9", "x.mtl"), "newmtl X\nKd 1 0 0\n");
  fs.writeFileSync(path.join(dir, "mats", "m.mtl"), "newmtl Good\nKd 0 1 0\n");
  const f = path.join(dir, "a.obj");
  const obj = (lib) => `mtllib ${lib}\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl Good\nf 1 2 3\n`;
  for (const lib of ["../x.mtl", "..\\x.mtl", "C:/Windows/win.ini", "/etc/passwd", "\\\\evil.example\\s\\x.mtl", "//evil.example/s/x.mtl", "http://example.com/x.mtl", "NUL"]) {
    fs.writeFileSync(f, obj(lib));
    await assert.rejects(loadModel(f, ".obj"), /relative/i, `mtllib ${lib} must be refused`);
  }
  fs.writeFileSync(f, obj("mats/m.mtl"));
  const g = await loadModel(f, ".obj");
  assert.deepEqual(g[0].color, [0, 1, 0]);
});

test("upload mode opens and packs nothing outside the folder", async () => {
  const dir = path.join(tmp, "h10", "models");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(tmp, "h10", "SECRET.bin"), Buffer.alloc(12));
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("{}", { status: 200 });
  };
  const cfg = { apiKey: "K", userId: "1" };
  const f = gltfFile(dir, "a.gltf", onePointMesh("../SECRET.bin"));
  await assert.rejects(uploadModel(cfg, f, ".gltf", "x", { fetchImpl }), /relative/i);
  const huge = gltfFile(dir, "b.gltf", zeroMesh(300_000_000));
  await assert.rejects(uploadModel(cfg, huge, ".gltf", "x", { fetchImpl }), /accessor|limit/i);
  const o = path.join(dir, "o.obj");
  fs.writeFileSync(o, "mtllib ../SECRET.bin\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  await assert.rejects(uploadModel(cfg, o, ".obj", "x", { fetchImpl }), /relative/i);
  assert.equal(calls, 0);
});
