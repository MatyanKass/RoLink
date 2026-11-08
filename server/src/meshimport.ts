// Local 3D model files -> chunked triangle meshes the plugin can turn into
// EditableMesh-backed MeshParts ("preview" import, see docs/IMPORT_MODEL.md).
//
// Supported: .obj (+ .mtl colors), .stl (ascii + binary), .gltf / .glb.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** One material group: indexed triangles. */
export interface MeshGroup {
  name: string;
  color?: [number, number, number]; // 0..1
  transparency?: number; // 0..1
  positions: number[]; // xyz
  normals?: number[]; // xyz, same count as positions
  uvs?: number[]; // uv, same count as positions
  indices: number[];
}

export interface Chunk {
  name: string;
  color?: [number, number, number];
  transparency?: number;
  center: [number, number, number]; // in model space (studs, after scale)
  size: [number, number, number];
  vertexCount: number;
  triangleCount: number;
  positions: string; // base64 Float32 xyz, relative to center
  normals?: string; // base64 Float32 xyz
  uvs?: string; // base64 Float32 uv
  indices: string; // base64 Uint32
}

// EditableMesh / CreateMeshPartAsync accept at most 20k triangles and 60k
// vertices per mesh; stay well below.
export const MAX_TRIS_PER_CHUNK = 18_000;
export const MAX_VERTS_PER_CHUNK = 50_000;
export const MAX_TOTAL_TRIS = 1_000_000;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const PREVIEW_EXTS = [".obj", ".stl", ".gltf", ".glb"];
export const UPLOAD_EXTS = [".fbx", ".gltf", ".glb", ".obj"];

export function validateModelPath(p: string, exts: string[]): { file: string; ext: string; bytes: number } {
  if (!p || typeof p !== "string") throw new Error("path is required");
  const file = path.resolve(p);
  if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`not a file: ${file}`);
  const ext = path.extname(file).toLowerCase();
  if (!exts.includes(ext)) throw new Error(`unsupported extension "${ext}" (allowed: ${exts.join(", ")})`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`file is ${(st.size / 1048576).toFixed(1)} MB; limit is ${MAX_FILE_BYTES / 1048576} MB`);
  if (st.size === 0) throw new Error(`file is empty: ${file}`);
  return { file, ext, bytes: st.size };
}

// ------------------------------------------------------------------ OBJ

export function parseMtl(text: string): Map<string, { color?: [number, number, number]; transparency?: number }> {
  const out = new Map<string, { color?: [number, number, number]; transparency?: number }>();
  let cur: { color?: [number, number, number]; transparency?: number } | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const [k, ...rest] = line.split(/\s+/);
    if (k === "newmtl") out.set(rest.join(" "), (cur = {}));
    else if (!cur) continue;
    else if (k === "Kd") cur.color = [+rest[0], +rest[1], +rest[2]].map((x) => (Number.isFinite(x) ? x : 1)) as [number, number, number];
    else if (k === "d") cur.transparency = 1 - +rest[0];
    else if (k === "Tr") cur.transparency = +rest[0];
  }
  return out;
}

export function parseObj(text: string, mtl?: Map<string, { color?: [number, number, number]; transparency?: number }>): MeshGroup[] {
  const v: number[] = [];
  const vt: number[] = [];
  const vn: number[] = [];
  const groups = new Map<string, MeshGroup & { keys: Map<string, number>; hasN: boolean; hasT: boolean }>();
  let objName = "Mesh";
  let material = "";
  let cur: (MeshGroup & { keys: Map<string, number>; hasN: boolean; hasT: boolean }) | undefined;

  const group = () => {
    const key = objName + "\u0000" + material;
    let g = groups.get(key);
    if (!g) {
      const m = mtl?.get(material);
      g = { name: material ? `${objName}_${material}` : objName, positions: [], normals: [], uvs: [], indices: [], keys: new Map(), hasN: true, hasT: true, color: m?.color, transparency: m?.transparency };
      groups.set(key, g);
    }
    return g;
  };
  const idx = (s: string, len: number) => {
    const n = parseInt(s, 10);
    if (!Number.isFinite(n) || n === 0) return -1;
    return n < 0 ? len + n : n - 1;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const parts = line.split(/\s+/);
    const k = parts[0];
    if (k === "v") v.push(+parts[1], +parts[2], +parts[3]);
    else if (k === "vt") vt.push(+parts[1], parts[2] !== undefined ? +parts[2] : 0);
    else if (k === "vn") vn.push(+parts[1], +parts[2], +parts[3]);
    else if (k === "o" || k === "g") {
      objName = parts.slice(1).join(" ") || "Mesh";
      cur = undefined;
    } else if (k === "usemtl") {
      material = parts.slice(1).join(" ");
      cur = undefined;
    } else if (k === "f") {
      cur ??= group();
      const g = cur;
      const corner: number[] = [];
      for (let i = 1; i < parts.length; i++) {
        const key = parts[i];
        let id = g.keys.get(key);
        if (id === undefined) {
          const [a, b, c] = key.split("/");
          const pi = idx(a, v.length / 3);
          if (pi < 0 || pi * 3 >= v.length) throw new Error(`OBJ: bad vertex index in "${line}"`);
          const ti = b ? idx(b, vt.length / 2) : -1;
          const ni = c ? idx(c, vn.length / 3) : -1;
          id = g.positions.length / 3;
          g.positions.push(v[pi * 3], v[pi * 3 + 1], v[pi * 3 + 2]);
          if (ti >= 0) g.uvs!.push(vt[ti * 2], 1 - vt[ti * 2 + 1]);
          else {
            g.uvs!.push(0, 0);
            g.hasT = false;
          }
          if (ni >= 0) g.normals!.push(vn[ni * 3], vn[ni * 3 + 1], vn[ni * 3 + 2]);
          else {
            g.normals!.push(0, 0, 0);
            g.hasN = false;
          }
          g.keys.set(key, id);
        }
        corner.push(id);
      }
      // fan triangulation of (convex) n-gons
      for (let i = 1; i + 1 < corner.length; i++) g.indices.push(corner[0], corner[i], corner[i + 1]);
    }
  }
  const out: MeshGroup[] = [];
  for (const g of groups.values()) {
    if (g.indices.length === 0) continue;
    const { keys: _k, hasN, hasT, ...rest } = g;
    if (!hasN) delete rest.normals;
    if (!hasT) delete rest.uvs;
    out.push(rest);
  }
  if (out.length === 0) throw new Error("OBJ: no faces found");
  return out;
}

// ------------------------------------------------------------------ STL

export function parseStl(buf: Buffer): MeshGroup[] {
  const positions: number[] = [];
  const normals: number[] = [];
  const isBinary = (() => {
    if (buf.length < 84) return false;
    const n = buf.readUInt32LE(80);
    if (84 + n * 50 === buf.length) return true;
    return !buf.subarray(0, 5).toString("ascii").toLowerCase().startsWith("solid");
  })();
  if (isBinary) {
    const n = buf.readUInt32LE(80);
    if (84 + n * 50 > buf.length) throw new Error("STL: truncated binary file");
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50;
      const nx = buf.readFloatLE(o), ny = buf.readFloatLE(o + 4), nz = buf.readFloatLE(o + 8);
      for (let k = 0; k < 3; k++) {
        const p = o + 12 + k * 12;
        positions.push(buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8));
        normals.push(nx, ny, nz);
      }
    }
  } else {
    const text = buf.toString("utf8");
    let n: number[] = [0, 0, 0];
    const re = /(facet\s+normal|vertex)\s+(\S+)\s+(\S+)\s+(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const xyz = [+m[2], +m[3], +m[4]];
      if (m[1] === "vertex") {
        positions.push(...xyz);
        normals.push(...n);
      } else n = xyz;
    }
    if (positions.length % 9 !== 0) throw new Error("STL: vertex count is not a multiple of 3");
  }
  if (positions.length === 0) throw new Error("STL: no triangles found");
  // STL is Z-up by convention: (x, y, z) -> (x, z, -y)
  const swap = (a: number[]) => {
    for (let i = 0; i < a.length; i += 3) {
      const y = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = -y;
    }
  };
  swap(positions);
  swap(normals);
  const zero = normals.every((x) => x === 0);
  return [{ name: "Mesh", positions, normals: zero ? undefined : normals, indices: positions.map((_, i) => i).slice(0, positions.length / 3) }];
}

// ------------------------------------------------------------------ glTF

export async function parseGltf(file: string): Promise<MeshGroup[]> {
  const { NodeIO } = await import("@gltf-transform/core");
  const io = new NodeIO();
  let doc;
  try {
    doc = await io.read(file);
  } catch (e: any) {
    throw new Error(`glTF: ${e?.message ?? e} (Draco/meshopt-compressed files are not supported in preview mode)`);
  }
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const out: MeshGroup[] = [];
  const visit = (node: any) => {
    const mesh = node.getMesh();
    if (mesh) {
      const m: number[] = node.getWorldMatrix();
      const nm = normalMatrix(m);
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue; // TRIANGLES only
        const pos = prim.getAttribute("POSITION");
        if (!pos) continue;
        const nrm = prim.getAttribute("NORMAL");
        const uv = prim.getAttribute("TEXCOORD_0");
        const count = pos.getCount();
        const positions: number[] = [];
        const normals: number[] | undefined = nrm ? [] : undefined;
        const uvs: number[] | undefined = uv ? [] : undefined;
        const t: number[] = [];
        for (let i = 0; i < count; i++) {
          pos.getElement(i, t);
          positions.push(...xform(m, t[0], t[1], t[2], 1));
          if (nrm && normals) {
            nrm.getElement(i, t);
            normals.push(...xform(nm, t[0], t[1], t[2], 0));
          }
          if (uv && uvs) {
            uv.getElement(i, t);
            uvs.push(t[0], t[1]);
          }
        }
        const ind = prim.getIndices();
        let indices: number[];
        if (ind) indices = Array.from(ind.getArray() as ArrayLike<number>);
        else indices = Array.from({ length: count }, (_, i) => i);
        if (det3(m) < 0) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
        const mat = prim.getMaterial();
        const f = mat?.getBaseColorFactor();
        out.push({
          name: (mesh.getName() || node.getName() || "Mesh") + (mat?.getName() ? `_${mat.getName()}` : ""),
          color: f ? [f[0], f[1], f[2]].map(linearToSrgb) as [number, number, number] : undefined,
          transparency: f && mat?.getAlphaMode() === "BLEND" ? 1 - f[3] : undefined,
          positions,
          normals,
          uvs,
          indices,
        });
      }
    }
    for (const c of node.listChildren()) visit(c);
  };
  for (const n of scene ? scene.listChildren() : []) visit(n);
  if (out.length === 0) throw new Error("glTF: no triangle meshes found");
  return out;
}

const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function xform(m: number[], x: number, y: number, z: number, w: number): [number, number, number] {
  // column-major 4x4
  return [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w];
}
function det3(m: number[]) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}
function normalMatrix(m: number[]): number[] {
  // inverse-transpose of the upper 3x3, embedded in a column-major 4x4
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; // row-major
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C || 1;
  // inverse = adj^T / det; inverse-transpose = cofactor / det (row-major [A B C; D E F; G H I])
  const r = [A, B, C, D, E, F, G, H, I].map((x) => x / det);
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, 0, 0, 0, 1];
}

// ------------------------------------------------------------------ loading

export async function loadModel(file: string, ext: string): Promise<MeshGroup[]> {
  if (ext === ".obj") {
    const text = await fsp.readFile(file, "utf8");
    let mtl: ReturnType<typeof parseMtl> | undefined;
    for (const m of text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)) {
      const p = path.resolve(path.dirname(file), m[1]);
      if (fs.existsSync(p)) {
        mtl ??= new Map();
        for (const [k, val] of parseMtl(await fsp.readFile(p, "utf8"))) mtl.set(k, val);
      }
    }
    return parseObj(text, mtl);
  }
  if (ext === ".stl") return parseStl(await fsp.readFile(file));
  if (ext === ".gltf" || ext === ".glb") return parseGltf(file);
  throw new Error(`preview import does not support ${ext}`);
}

// ------------------------------------------------------------------ chunking

export interface PrepareOptions {
  scale?: number;
  fitSize?: number; // largest dimension in studs
  flipFaces?: boolean;
}

export interface Prepared {
  chunks: Chunk[];
  size: [number, number, number];
  scale: number;
  triangles: number;
  vertices: number;
}

function computeNormals(g: MeshGroup): number[] {
  const n = new Array(g.positions.length).fill(0);
  const p = g.positions;
  for (let t = 0; t < g.indices.length; t += 3) {
    const [a, b, c] = [g.indices[t] * 3, g.indices[t + 1] * 3, g.indices[t + 2] * 3];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      n[k] += nx;
      n[k + 1] += ny;
      n[k + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

const b64 = (a: Float32Array | Uint32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");

/**
 * Scale + center the model (x/z centered, bottom at y=0) and split it into
 * chunks that each fit one EditableMesh.
 */
export function prepareChunks(groups: MeshGroup[], opts: PrepareOptions = {}): Prepared {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const g of groups) {
    for (let i = 0; i < g.positions.length; i++) {
      const x = g.positions[i];
      if (!Number.isFinite(x)) throw new Error(`non-finite vertex coordinate in ${g.name}`);
      min[i % 3] = Math.min(min[i % 3], x);
      max[i % 3] = Math.max(max[i % 3], x);
    }
    triangles += g.indices.length / 3;
  }
  if (triangles === 0) throw new Error("model has no triangles");
  if (triangles > MAX_TOTAL_TRIS) throw new Error(`model has ${triangles} triangles; preview limit is ${MAX_TOTAL_TRIS} (decimate it, or use upload mode)`);
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const largest = Math.max(...ext) || 1;
  const scale = opts.fitSize ? opts.fitSize / largest : (opts.scale ?? 1);
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error("scale must be a positive number");
  const off = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];

  const chunks: Chunk[] = [];
  let vertices = 0;
  for (const g of groups) {
    const normals = g.normals ?? computeNormals(g);
    let map = new Map<number, number>();
    let pos: number[] = [], nrm: number[] = [], uv: number[] = [], ind: number[] = [];
    let part = 0;
    const flush = () => {
      if (ind.length === 0) return;
      const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i++) {
        cmin[i % 3] = Math.min(cmin[i % 3], pos[i]);
        cmax[i % 3] = Math.max(cmax[i % 3], pos[i]);
      }
      const c: [number, number, number] = [(cmin[0] + cmax[0]) / 2, (cmin[1] + cmax[1]) / 2, (cmin[2] + cmax[2]) / 2];
      const rel = new Float32Array(pos.length);
      for (let i = 0; i < pos.length; i++) rel[i] = pos[i] - c[i % 3];
      const vc = pos.length / 3;
      vertices += vc;
      chunks.push({
        name: part === 0 ? g.name : `${g.name}_${part + 1}`,
        color: g.color,
        transparency: g.transparency,
        center: c,
        size: [cmax[0] - cmin[0], cmax[1] - cmin[1], cmax[2] - cmin[2]],
        vertexCount: vc,
        triangleCount: ind.length / 3,
        positions: b64(rel),
        normals: b64(new Float32Array(nrm)),
        uvs: g.uvs ? b64(new Float32Array(uv)) : undefined,
        indices: b64(new Uint32Array(ind)),
      });
      part++;
      map = new Map();
      pos = [];
      nrm = [];
      uv = [];
      ind = [];
    };
    for (let t = 0; t < g.indices.length; t += 3) {
      if (ind.length / 3 >= MAX_TRIS_PER_CHUNK || pos.length / 3 + 3 > MAX_VERTS_PER_CHUNK) flush();
      const tri = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
      if (opts.flipFaces) [tri[1], tri[2]] = [tri[2], tri[1]];
      for (const src of tri) {
        let id = map.get(src);
        if (id === undefined) {
          id = pos.length / 3;
          map.set(src, id);
          for (let k = 0; k < 3; k++) pos.push((g.positions[src * 3 + k] - off[k]) * scale);
          nrm.push(normals[src * 3], normals[src * 3 + 1], normals[src * 3 + 2]);
          if (g.uvs) uv.push(g.uvs[src * 2], g.uvs[src * 2 + 1]);
        }
        ind.push(id);
      }
    }
    flush();
  }
  return { chunks, size: [ext[0] * scale, ext[1] * scale, ext[2] * scale], scale, triangles, vertices };
}
