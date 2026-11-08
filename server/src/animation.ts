// glTF animation -> Roblox poses (see docs/ANIMATION.md).
//
// A Pose CFrame drives Motor6D.Transform: Part1 = Part0 * C0 * Transform * C1^-1.
// Bones in a Blender export have their own rest orientation (Y along the bone),
// so joint rotations cannot be copied. Instead each bone's motion is taken as a
// world-space offset from its rest pose, made relative to the nearest animated
// ancestor in the Roblox rig, and expressed in that joint's frame.

import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateModelPath } from "./meshimport.js";
import type { ToolResult } from "./core.js";

export type Quat = [number, number, number, number];
type Vec3 = [number, number, number];

export const q = {
  mul(a: number[], b: number[]): Quat {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  },
  conj: (a: number[]): Quat => [-a[0], -a[1], -a[2], a[3]],
  norm(a: number[]): Quat {
    const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l, a[3] / l];
  },
  rotate(a: number[], v: number[]): Vec3 {
    const r = q.mul(q.mul(a, [v[0], v[1], v[2], 0]), q.conj(a));
    return [r[0], r[1], r[2]];
  },
  slerp(a: number[], b0: number[], t: number): Quat {
    let dot = a[0] * b0[0] + a[1] * b0[1] + a[2] * b0[2] + a[3] * b0[3];
    const b = dot < 0 ? b0.map((x) => -x) : b0;
    dot = Math.abs(dot);
    if (dot > 0.9995) return q.norm(a.map((x, i) => x + (b[i] - x) * t));
    const th = Math.acos(Math.min(1, dot));
    const s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s;
    const wb = Math.sin(t * th) / s;
    return q.norm(a.map((x, i) => x * wa + b[i] * wb));
  },
  /** From a row-major 3x3 rotation matrix. */
  fromMat(m: number[]): Quat {
    const [a, b, c, d, e, f, g, h, i] = m;
    const tr = a + e + i;
    let v: number[];
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      v = [(h - f) / s, (c - g) / s, (d - b) / s, s / 4];
    } else if (a > e && a > i) {
      const s = Math.sqrt(1 + a - e - i) * 2;
      v = [s / 4, (b + d) / s, (c + g) / s, (h - f) / s];
    } else if (e > i) {
      const s = Math.sqrt(1 + e - a - i) * 2;
      v = [(b + d) / s, s / 4, (f + h) / s, (c - g) / s];
    } else {
      const s = Math.sqrt(1 + i - a - e) * 2;
      v = [(c + g) / s, (f + h) / s, s / 4, (d - b) / s];
    }
    return q.norm(v);
  },
};

// ------------------------------------------------------------------ rigs

export interface Rig {
  type: string;
  root: string;
  joints: Record<string, { parent?: string | null; r?: number[] }>;
  /** Which of several bones on one part drives it. */
  pick?: "deepest" | "shallowest";
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const R15_PARENTS: Record<string, string | null> = {
  HumanoidRootPart: null, LowerTorso: "HumanoidRootPart", UpperTorso: "LowerTorso", Head: "UpperTorso",
  LeftUpperArm: "UpperTorso", LeftLowerArm: "LeftUpperArm", LeftHand: "LeftLowerArm",
  RightUpperArm: "UpperTorso", RightLowerArm: "RightUpperArm", RightHand: "RightLowerArm",
  LeftUpperLeg: "LowerTorso", LeftLowerLeg: "LeftUpperLeg", LeftFoot: "LeftLowerLeg",
  RightUpperLeg: "LowerTorso", RightLowerLeg: "RightUpperLeg", RightFoot: "RightLowerLeg",
};

// C0 rotations of the standard R6 Motor6Ds; R15 joints are axis-aligned.
const R6_LEFT = [0, 0, -1, 0, 1, 0, 1, 0, 0];
const R6_RIGHT = [0, 0, 1, 0, 1, 0, -1, 0, 0];
const R6_NECK_ROOT = [-1, 0, 0, 0, 0, 1, 0, 1, 0];

export const RIGS: Record<"R15" | "R6", Rig> = {
  R15: {
    type: "R15", root: "HumanoidRootPart", pick: "deepest",
    joints: Object.fromEntries(Object.entries(R15_PARENTS).map(([k, parent]) => [k, { parent, r: IDENTITY }])),
  },
  R6: {
    type: "R6", root: "HumanoidRootPart", pick: "shallowest",
    joints: {
      HumanoidRootPart: { parent: null, r: IDENTITY },
      Torso: { parent: "HumanoidRootPart", r: R6_NECK_ROOT },
      Head: { parent: "Torso", r: R6_NECK_ROOT },
      "Left Arm": { parent: "Torso", r: R6_LEFT },
      "Right Arm": { parent: "Torso", r: R6_RIGHT },
      "Left Leg": { parent: "Torso", r: R6_LEFT },
      "Right Leg": { parent: "Torso", r: R6_RIGHT },
    },
  },
};

const R15_ALIASES: Record<string, string> = {
  hips: "LowerTorso", hip: "LowerTorso", pelvis: "LowerTorso",
  spine: "UpperTorso", spine1: "UpperTorso", spine2: "UpperTorso", spine3: "UpperTorso", chest: "UpperTorso", upperchest: "UpperTorso", torso: "UpperTorso",
  root: "HumanoidRootPart", head: "Head",
};
const R15_LIMBS: Record<string, string> = {
  upperarm: "UpperArm", arm: "UpperArm", forearm: "LowerArm", lowerarm: "LowerArm", hand: "Hand",
  upperleg: "UpperLeg", thigh: "UpperLeg", upleg: "UpperLeg", leg: "LowerLeg", shin: "LowerLeg", calf: "LowerLeg", lowerleg: "LowerLeg", foot: "Foot",
};
const R6_ALIASES: Record<string, string> = { hips: "Torso", hip: "Torso", pelvis: "Torso", spine: "Torso", spine1: "Torso", spine2: "Torso", chest: "Torso", torso: "Torso", root: "HumanoidRootPart", head: "Head" };
const R6_LIMBS: Record<string, string> = { upperarm: "Arm", arm: "Arm", upperleg: "Leg", thigh: "Leg", upleg: "Leg" };

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Rig part a bone name stands for, or undefined. */
export function canonicalBone(bone: string, rig: Rig): string | undefined {
  let name = bone.includes("|") ? bone.slice(bone.lastIndexOf("|") + 1) : bone;
  if (name.includes(":")) name = name.slice(name.lastIndexOf(":") + 1);
  name = name.replace(/^(DEF|ORG|MCH)[-_.]/i, "").replace(/^mixamorig/i, "");

  const parts = Object.keys(rig.joints);
  const exact = parts.find((p) => normalize(p) === normalize(name));
  if (exact) return exact;
  if (rig.type !== "R15" && rig.type !== "R6") return undefined;

  let side = "";
  let stem = name;
  const suffix = /[._\- ]([lr])$/i.exec(stem);
  if (suffix) {
    side = suffix[1].toLowerCase() === "l" ? "Left" : "Right";
    stem = stem.slice(0, suffix.index);
  } else {
    const prefix = /^(left|right)[._\- ]?/i.exec(stem);
    if (prefix) {
      side = prefix[1].toLowerCase() === "left" ? "Left" : "Right";
      stem = stem.slice(prefix[0].length);
    }
  }
  const key = normalize(stem);
  const [aliases, limbs, sep] = rig.type === "R15" ? [R15_ALIASES, R15_LIMBS, ""] : [R6_ALIASES, R6_LIMBS, " "];
  if (side && limbs[key]) return `${side}${sep}${limbs[key]}`;
  if (!side && aliases[key]) return aliases[key];
  return undefined;
}

export interface BoneNode {
  name: string;
  parent?: string;
  animated?: boolean;
  joint?: boolean;
  mesh?: boolean;
}

export function mapBones(nodes: BoneNode[], rig: Rig, boneMap: Record<string, string> = {}) {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  for (const [bone, part] of Object.entries(boneMap)) {
    if (!byName.has(bone)) throw new Error(`boneMap names bone "${bone}", which is not in the file`);
    if (!rig.joints[part]) throw new Error(`boneMap target "${part}" is not a part of the rig (${Object.keys(rig.joints).join(", ")})`);
  }
  const depth = (n: BoneNode) => {
    let d = 0;
    for (let c = n.parent; c !== undefined && d < 1000; c = byName.get(c)?.parent) d++;
    return d;
  };
  const candidates = new Map<string, BoneNode[]>();
  for (const n of nodes) {
    const part = boneMap[n.name] ?? canonicalBone(n.name, rig);
    if (!part) continue;
    if (!candidates.has(part)) candidates.set(part, []);
    candidates.get(part)!.push(n);
  }
  const map: Record<string, string> = {};
  const merged: string[] = [];
  for (const [part, list] of candidates) {
    list.sort((a, b) => (rig.pick === "shallowest" ? depth(a) - depth(b) : depth(b) - depth(a)));
    map[list[0].name] = part;
    merged.push(...list.slice(1).map((n) => n.name));
  }
  return { map, merged };
}

// ------------------------------------------------------------------ glTF

interface Track {
  path: "translation" | "rotation" | "scale";
  times: number[];
  values: number[][];
  interp: string;
}

interface ClipNode extends BoneNode {
  parentIndex: number;
  t: Vec3;
  r: Quat;
  s: Vec3;
  tracks: Track[];
}

export interface Clip {
  name: string;
  clips: string[];
  duration: number;
  nodes: ClipNode[];
}

const FBX_HELP =
  "FBX animations are not supported. In Blender use File > Export > glTF 2.0 (.glb) with Animation enabled, then import that file.";

export function validateAnimationPath(p: string) {
  if (typeof p === "string" && path.extname(p).toLowerCase() === ".fbx") throw new Error(FBX_HELP);
  return validateModelPath(p, [".glb", ".gltf"]);
}

export async function loadClip(file: string, which?: string | number): Promise<Clip> {
  const { NodeIO } = await import("@gltf-transform/core");
  const doc = await new NodeIO().read(file);
  const root = doc.getRoot();
  const anims = root.listAnimations();
  if (!anims.length) throw new Error(`no animation in ${path.basename(file)}: export from Blender with Animation enabled`);
  const names = anims.map((a, i) => a.getName() || `animation_${i}`);
  let index = 0;
  if (typeof which === "number") index = which;
  else if (typeof which === "string") index = names.indexOf(which);
  if (index < 0 || index >= anims.length) throw new Error(`animation ${JSON.stringify(which)} not found; the file has: ${names.join(", ")}`);
  const anim = anims[index];

  const gltfNodes = root.listNodes();
  const indexOf = new Map(gltfNodes.map((n, i) => [n, i]));
  const parents = new Array<number>(gltfNodes.length).fill(-1);
  gltfNodes.forEach((n, i) => n.listChildren().forEach((c) => (parents[indexOf.get(c)!] = i)));
  const joints = new Set(root.listSkins().flatMap((s) => s.listJoints()));

  const nodes: ClipNode[] = gltfNodes.map((n, i) => ({
    name: n.getName() || `node_${i}`,
    parentIndex: parents[i],
    t: [...n.getTranslation()] as Vec3,
    r: q.norm([...n.getRotation()]),
    s: [...n.getScale()] as Vec3,
    tracks: [],
    joint: joints.has(n),
    mesh: !!n.getMesh(),
  }));
  nodes.forEach((n) => {
    if (n.parentIndex >= 0) n.parent = nodes[n.parentIndex].name;
  });

  let duration = 0;
  for (const ch of anim.listChannels()) {
    const target = ch.getTargetNode();
    const kind = ch.getTargetPath();
    const sampler = ch.getSampler();
    const input = sampler?.getInput();
    const output = sampler?.getOutput();
    if (!target || !input || !output || (kind !== "translation" && kind !== "rotation" && kind !== "scale")) continue;
    const times: number[] = [];
    for (let i = 0; i < input.getCount(); i++) times.push(input.getScalar(i));
    const values: number[][] = [];
    for (let i = 0; i < output.getCount(); i++) values.push([...output.getElement(i, [])]);
    if (times.length) duration = Math.max(duration, times[times.length - 1]);
    const node = nodes[indexOf.get(target)!];
    node.animated = true;
    node.tracks.push({ path: kind, times, values, interp: sampler!.getInterpolation() });
  }
  return { name: names[index], clips: names, duration, nodes };
}

function sampleTrack(tr: Track, time: number): number[] {
  const { times, values, interp } = tr;
  const cubic = interp === "CUBICSPLINE";
  const at = (i: number) => (cubic ? values[i * 3 + 1] : values[i]);
  if (time <= times[0]) return at(0);
  const last = times.length - 1;
  if (time >= times[last]) return at(last);
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const a = at(lo);
  const b = at(hi);
  if (interp === "STEP") return a;
  const dt = times[hi] - times[lo];
  const u = dt > 0 ? (time - times[lo]) / dt : 0;
  if (cubic) {
    const m0 = values[lo * 3 + 2];
    const m1 = values[hi * 3];
    const u2 = u * u;
    const u3 = u2 * u;
    const v = a.map((x, i) => (2 * u3 - 3 * u2 + 1) * x + (u3 - 2 * u2 + u) * dt * m0[i] + (-2 * u3 + 3 * u2) * b[i] + (u3 - u2) * dt * m1[i]);
    return tr.path === "rotation" ? q.norm(v) : v;
  }
  return tr.path === "rotation" ? q.slerp(a, b, u) : a.map((x, i) => x + (b[i] - x) * u);
}

interface Global {
  p: Vec3;
  r: Quat;
  s: Vec3;
}

/** Forward kinematics; with time undefined, the rest pose. */
function globals(nodes: ClipNode[], time?: number): Global[] {
  const out: (Global | undefined)[] = new Array(nodes.length);
  const compute = (i: number): Global => {
    const known = out[i];
    if (known) return known;
    const n = nodes[i];
    let t: number[] = n.t;
    let r: number[] = n.r;
    let s: number[] = n.s;
    if (time !== undefined) {
      for (const tr of n.tracks) {
        const v = sampleTrack(tr, time);
        if (tr.path === "translation") t = v;
        else if (tr.path === "rotation") r = v;
        else s = v;
      }
    }
    let g: Global;
    if (n.parentIndex < 0) g = { p: [t[0], t[1], t[2]], r: q.norm(r), s: [s[0], s[1], s[2]] };
    else {
      const p = compute(n.parentIndex);
      const off = q.rotate(p.r, [t[0] * p.s[0], t[1] * p.s[1], t[2] * p.s[2]]);
      g = { p: [p.p[0] + off[0], p.p[1] + off[1], p.p[2] + off[2]], r: q.norm(q.mul(p.r, r)), s: [p.s[0] * s[0], p.s[1] * s[1], p.s[2] * s[2]] };
    }
    out[i] = g;
    return g;
  };
  return nodes.map((_, i) => compute(i));
}

export interface ConvertOptions {
  rig: Rig;
  fps?: number;
  scale?: number;
  facing?: "+z" | "-z";
  boneMap?: Record<string, string>;
}

export interface Keyframe {
  t: number;
  p: Record<string, number[]>; // x y z qx qy qz qw
}

const samePose = (a: Keyframe, b: Keyframe) =>
  Object.keys(a.p).every((k) => a.p[k].every((x, i) => Math.abs(x - b.p[k][i]) < 1e-5));

export function convertClip(clip: Clip, o: ConvertOptions) {
  const { rig } = o;
  const fps = o.fps ?? 30;
  if (!(fps >= 1 && fps <= 120)) throw new Error("fps must be between 1 and 120");
  const scale = o.scale ?? 1 / 0.28;
  const flip = (o.facing ?? "+z") === "+z";

  const nodes = clip.nodes;
  // any non-mesh node can drive a part (it may simply follow an animated parent);
  // only real bones are worth reporting when they stay unmapped
  const bones = nodes.filter((n) => n.animated || n.joint);
  const { map, merged } = mapBones(nodes.filter((n) => !n.mesh), rig, o.boneMap ?? {});
  if (!Object.keys(map).length) {
    const list = bones.map((b) => b.name).join(", ") || "(none)";
    throw new Error(`none of the animated bones map to rig parts: ${list}. Pass boneMap, e.g. {"${bones[0]?.name ?? "Bone"}":"${rig.root}"}`);
  }

  const partIndex = new Map<string, number>();
  for (const [bone, part] of Object.entries(map)) partIndex.set(part, nodes.findIndex((n) => n.name === bone));

  const mappedAncestor = (part: string): string | undefined => {
    let cur = rig.joints[part]?.parent ?? undefined;
    for (let guard = 0; cur && guard < 1000; guard++) {
      if (partIndex.has(cur)) return cur;
      cur = rig.joints[cur]?.parent ?? undefined;
    }
    return undefined;
  };

  // parts that need a Pose: the mapped ones and everything between them and the root
  const tree: Record<string, string> = {};
  for (const part of partIndex.keys()) {
    let cur = part;
    for (let guard = 0; cur !== rig.root && guard < 1000; guard++) {
      const up = rig.joints[cur]?.parent;
      if (!up) break;
      tree[cur] = up;
      cur = up;
    }
  }

  const rest = globals(nodes);
  const count = Math.max(1, Math.ceil(clip.duration * fps - 1e-6));
  const keyframes: Keyframe[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i === count ? clip.duration : i / fps;
    const now = globals(nodes, t);
    const offset = (idx: number) => q.mul(now[idx].r, q.conj(rest[idx].r));
    const frame: Keyframe = { t: +t.toFixed(6), p: {} };
    for (const [part, idx] of partIndex) {
      const up = mappedAncestor(part);
      const upIdx = up !== undefined ? partIndex.get(up)! : -1;
      const upOffset: Quat = upIdx >= 0 ? offset(upIdx) : [0, 0, 0, 1];

      let w = q.mul(q.conj(upOffset), offset(idx));
      const a = now[idx].p;
      const b = upIdx >= 0 ? now[upIdx].p : ([0, 0, 0] as Vec3);
      const a0 = rest[idx].p;
      const b0 = upIdx >= 0 ? rest[upIdx].p : ([0, 0, 0] as Vec3);
      const rel = q.rotate(q.conj(upOffset), [a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
      let d: number[] = [(rel[0] - (a0[0] - b0[0])) * scale, (rel[1] - (a0[1] - b0[1])) * scale, (rel[2] - (a0[2] - b0[2])) * scale];

      if (flip) {
        // glTF characters face +Z, Roblox characters face -Z: 180 degrees about Y
        w = [-w[0], w[1], -w[2], w[3]];
        d = [-d[0], d[1], -d[2]];
      }
      const j = q.fromMat(rig.joints[part]?.r ?? IDENTITY);
      const jointRot = q.norm(q.mul(q.mul(q.conj(j), w), j));
      const jointPos = q.rotate(q.conj(j), d);
      frame.p[part] = [...jointPos.map((x) => +x.toFixed(5)), ...jointRot.map((x) => +x.toFixed(6))];
    }
    keyframes.push(frame);
  }

  const kept = keyframes.filter((k, i) => i === 0 || i === keyframes.length - 1 || !(samePose(k, keyframes[i - 1]) && samePose(k, keyframes[i + 1])));

  const unmappedBones = bones.filter((b) => !(b.name in map) && !merged.includes(b.name)).map((b) => b.name);
  const rigPartsWithoutData = Object.keys(rig.joints).filter((p) => !partIndex.has(p) && p !== rig.root);
  return {
    keyframes: kept,
    tree,
    root: rig.root,
    report: {
      clip: clip.name,
      availableClips: clip.clips,
      length: clip.duration,
      fps,
      positionScale: scale,
      rig: rig.type,
      mappedBones: map,
      mergedBones: merged,
      unmappedBones,
      rigPartsWithoutData,
      keyframes: kept.length,
      sampled: keyframes.length,
    },
  };
}

/** Splits keyframes so each chunk's JSON stays under maxChars. */
export function chunkKeyframes(keyframes: Keyframe[], maxChars = 700_000): Keyframe[][] {
  const chunks: Keyframe[][] = [];
  let cur: Keyframe[] = [];
  let size = 2;
  for (const k of keyframes) {
    const len = JSON.stringify(k).length + 1;
    if (cur.length && size + len > maxChars) {
      chunks.push(cur);
      cur = [];
      size = 2;
    }
    cur.push(k);
    size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// ------------------------------------------------------------------ tool

type Send = (op: string, payload: unknown, timeoutMs?: number) => Promise<any>;
type Args = Record<string, any>;

const PUBLISH_NOTE = "This KeyframeSequence lives in the place only. To get a real animation id, publish it: see docs/ANIMATION.md.";

export async function importAnimation(args: Args, send: Send): Promise<ToolResult> {
  if (args.context && args.context !== "edit") throw new Error("import_animation only works in edit mode (context: edit)");
  const v = validateAnimationPath(args.path);
  const clip = await loadClip(v.file, args.animation);

  const rigArg: string = args.rig ?? "R15";
  let rig: Rig;
  let rigPath: string | undefined;
  if (rigArg === "R15" || rigArg === "R6") rig = RIGS[rigArg];
  else {
    rigPath = rigArg;
    const info = await send("animation_rig_info", { rig: rigArg }, 30_000);
    rig = { ...info, pick: info.type === "R6" ? "shallowest" : "deepest" };
  }
  if (args.preview && !rigPath) throw new Error("preview needs rig to be a path to a rig in Studio");

  const out = convertClip(clip, { rig, fps: args.fps, scale: args.scale, facing: args.facing, boneMap: args.boneMap });
  const chunks = chunkKeyframes(out.keyframes);
  const importId = randomUUID();
  let built: any;
  try {
    for (let i = 0; i < chunks.length; i++) await send("animation_stage", { importId, index: i + 1, chunk: chunks[i] }, 60_000);
    built = await send(
      "animation_build",
      {
        importId, count: chunks.length, name: args.name ?? clip.name, target: args.target, root: out.root, tree: out.tree,
        loop: args.loop === true, priority: args.priority, replace: args.replace === true,
      },
      300_000,
    );
  } catch (e) {
    await send("animation_discard", { importId }, 15_000).catch(() => {});
    throw e;
  }

  const result: Record<string, unknown> = { ...built, ...out.report, note: PUBLISH_NOTE };
  if (args.preview) {
    try {
      result.preview = await send("animation_preview", { path: built.created.path, rig: rigPath, seconds: args.previewSeconds }, 40_000);
    } catch (e: any) {
      result.preview = { ok: false, error: e?.message ?? String(e) };
    }
  }
  return { text: JSON.stringify(result) };
}
