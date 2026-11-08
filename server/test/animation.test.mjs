// import_animation: glTF sampling, space conversion, bone -> rig mapping.
//   npm run build && node --test test/animation.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import {
  loadClip, convertClip, mapBones, canonicalBone, chunkKeyframes, RIGS, validateAnimationPath, q,
} from "../dist/animation.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rolink-anim-"));
let n = 0;
const S = Math.SQRT1_2;
const qx90 = [S, 0, 0, S]; // +90 about X
const qz90 = [0, 0, S, S];
const ident = [0, 0, 0, 1];

/** bones: [{name, parent?, t?, r?, s?}], tracks: [{bone, path, times, values, interp?}] */
async function makeGlb(bones, tracks, clipName = "Walk", extra) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("S");
  const nodes = {};
  for (const b of bones) {
    const node = doc.createNode(b.name);
    if (b.t) node.setTranslation(b.t);
    if (b.r) node.setRotation(b.r);
    if (b.s) node.setScale(b.s);
    nodes[b.name] = node;
    if (b.parent) nodes[b.parent].addChild(node);
    else scene.addChild(node);
  }
  if (tracks.length) {
    const anim = doc.createAnimation(clipName);
    for (const t of tracks) {
      const input = doc.createAccessor().setType("SCALAR").setArray(new Float32Array(t.times)).setBuffer(buffer);
      const type = t.path === "rotation" ? "VEC4" : "VEC3";
      const output = doc.createAccessor().setType(type).setArray(new Float32Array(t.values.flat())).setBuffer(buffer);
      const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(t.interp ?? "LINEAR");
      anim.addSampler(sampler);
      anim.addChannel(doc.createAnimationChannel().setTargetNode(nodes[t.bone]).setTargetPath(t.path).setSampler(sampler));
    }
  }
  extra?.(doc, scene, nodes, buffer);
  const file = path.join(tmp, `a${n++}.glb`);
  await new NodeIO().write(file, doc);
  return file;
}

const near = (a, b, msg, eps = 1e-4) => {
  assert.equal(a.length, b.length, msg);
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < eps, `${msg}: got [${a}], want [${b}]`));
};
// q and -q are the same rotation
const nearQ = (a, b, msg) => {
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  near(dot < 0 ? a.map((x) => -x) : a, b, msg);
};
const poseAt = (out, t, part) => {
  const frame = out.keyframes.find((k) => Math.abs(k.t - t) < 1e-6);
  assert.ok(frame, `no keyframe at ${t}`);
  return frame.p[part];
};
const rot = (arr) => arr.slice(3);
const pos = (arr) => arr.slice(0, 3);
const convert = (clip, o = {}) => convertClip(clip, { rig: RIGS.R15, ...o });

const twoBone = (track, childRest) =>
  makeGlb(
    [{ name: "LeftUpperArm", t: [0, 1, 0] }, { name: "LeftLowerArm", parent: "LeftUpperArm", t: [0, -1, 0], r: childRest }],
    track,
  );

test("reads clip names, duration and channels", async () => {
  const f = await twoBone([{ bone: "LeftUpperArm", path: "rotation", times: [0, 1], values: [ident, qx90] }]);
  const clip = await loadClip(f);
  assert.equal(clip.name, "Walk");
  assert.deepEqual(clip.clips, ["Walk"]);
  near([clip.duration], [1], "duration");
  assert.deepEqual(clip.nodes.map((x) => x.name).sort(), ["LeftLowerArm", "LeftUpperArm"]);
});

test("glTF +Z-facing rotation about X becomes the opposite X rotation in Roblox", async () => {
  const f = await twoBone([{ bone: "LeftUpperArm", path: "rotation", times: [0, 1], values: [ident, qx90] }]);
  const out = convert(await loadClip(f), { fps: 2 });
  nearQ(rot(poseAt(out, 0, "LeftUpperArm")), ident, "t0");
  nearQ(rot(poseAt(out, 1, "LeftUpperArm")), [-S, 0, 0, S], "t1");
  const mid = Math.sin(Math.PI / 8);
  nearQ(rot(poseAt(out, 0.5, "LeftUpperArm")), [-mid, 0, 0, Math.cos(Math.PI / 8)], "slerp midpoint");
});

test("facing -z keeps the axes", async () => {
  const f = await twoBone([{ bone: "LeftUpperArm", path: "rotation", times: [0, 1], values: [ident, qx90] }]);
  const out = convert(await loadClip(f), { fps: 1, facing: "-z" });
  nearQ(rot(poseAt(out, 1, "LeftUpperArm")), qx90, "unflipped");
});

test("a child inherits nothing of its parent's motion in its own pose", async () => {
  const f = await twoBone([{ bone: "LeftUpperArm", path: "rotation", times: [0, 1], values: [ident, qx90] }]);
  const out = convert(await loadClip(f), { fps: 1 });
  nearQ(rot(poseAt(out, 1, "LeftLowerArm")), ident, "lower arm stays at rest relative to upper");
});

test("bone roll in the rest pose does not change the resulting joint rotation", async () => {
  // child rest is rolled 90 about Z; its local +X rotation is world +Y once rolled
  const f = await twoBone([{ bone: "LeftLowerArm", path: "rotation", times: [0, 1], values: [qz90, q.mul(qz90, qx90)] }], qz90);
  const out = convert(await loadClip(f), { fps: 1 });
  // world delta = +90 about glTF +Y -> Roblox (x,y,z,w) -> (-x, y, -z, w) keeps Y
  nearQ(rot(poseAt(out, 1, "LeftLowerArm")), [0, S, 0, S], "rolled child");
});

test("motion of an unmapped bone between two mapped bones reaches the child", async () => {
  const f = await makeGlb(
    [{ name: "LeftUpperArm" }, { name: "Twist", parent: "LeftUpperArm" }, { name: "LeftLowerArm", parent: "Twist" }],
    [{ bone: "Twist", path: "rotation", times: [0, 1], values: [ident, qx90] }],
  );
  const out = convert(await loadClip(f), { fps: 1 });
  nearQ(rot(poseAt(out, 1, "LeftLowerArm")), [-S, 0, 0, S], "intermediate carried");
  assert.deepEqual(out.report.unmappedBones, ["Twist"]);
});

test("a rotated Armature parent does not leak into joint rotations", async () => {
  const f = await makeGlb(
    [{ name: "Armature", r: qx90 }, { name: "LeftUpperArm", parent: "Armature" }],
    [{ bone: "LeftUpperArm", path: "rotation", times: [0, 1], values: [ident, qz90] }],
  );
  const out = convert(await loadClip(f), { fps: 1 });
  // local Z under a +90 X parent is world -Y; flip keeps Y sign
  nearQ(rot(poseAt(out, 1, "LeftUpperArm")), [0, -S, 0, S], "world-space delta");
});

test("translations are scaled, flipped, and relative to rest", async () => {
  const f = await makeGlb(
    [{ name: "LowerTorso", t: [0, 1, 0] }],
    [{ bone: "LowerTorso", path: "translation", times: [0, 1], values: [[0, 1, 0], [1, 1, 2]] }],
  );
  const out = convert(await loadClip(f), { fps: 1, scale: 10 });
  near(pos(poseAt(out, 0, "LowerTorso")), [0, 0, 0], "no offset at rest");
  near(pos(poseAt(out, 1, "LowerTorso")), [-10, 0, -20], "flipped & scaled");
});

test("default position scale is metres to studs (1 stud = 0.28 m)", async () => {
  const f = await makeGlb([{ name: "LowerTorso" }], [{ bone: "LowerTorso", path: "translation", times: [0, 1], values: [[0, 0, 0], [0, 0.28, 0]] }]);
  const out = convert(await loadClip(f), { fps: 1 });
  near(pos(poseAt(out, 1, "LowerTorso")), [0, 1, 0], "0.28 m = 1 stud");
  near([out.report.positionScale], [1 / 0.28], "reported");
});

test("R6 joints are rotated into the joint frame", async () => {
  const f = await makeGlb([{ name: "Right Arm" }], [{ bone: "Right Arm", path: "rotation", times: [0, 1], values: [ident, qx90] }]);
  const out = convertClip(await loadClip(f), { rig: RIGS.R6, fps: 1 });
  // Right Shoulder C0 rotation R: world X axis in joint space is R^T * (-1,0,0)
  const j = RIGS.R6.joints["Right Arm"].r;
  const w = [-S, 0, 0];
  const expected = [j[0] * w[0] + j[3] * w[1] + j[6] * w[2], j[1] * w[0] + j[4] * w[1] + j[7] * w[2], j[2] * w[0] + j[5] * w[1] + j[8] * w[2], S];
  nearQ(rot(poseAt(out, 1, "Right Arm")), expected, "joint frame");
});

test("a rig from Studio supplies its own joint frames and hierarchy", async () => {
  const rig = { type: "custom", root: "Base", joints: { Base: { parent: null, r: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, Arm: { parent: "Base", r: [0, -1, 0, 1, 0, 0, 0, 0, 1] } } };
  const f = await makeGlb([{ name: "Arm" }], [{ bone: "Arm", path: "rotation", times: [0, 1], values: [ident, qx90] }]);
  const out = convertClip(await loadClip(f), { rig, fps: 1 });
  assert.equal(out.tree.Arm, "Base");
  // J maps world -X into joint space (J^T * v); J^T = [0,1,0; -1,0,0; 0,0,1]
  nearQ(rot(poseAt(out, 1, "Arm")), [0, S, 0, S], "custom joint");
});

test("step and cubic interpolation are honored", async () => {
  const stepF = await twoBone([{ bone: "LeftUpperArm", path: "rotation", times: [0, 1], values: [ident, qx90], interp: "STEP" }]);
  nearQ(rot(poseAt(convert(await loadClip(stepF), { fps: 2 }), 0.5, "LeftUpperArm")), ident, "step holds");

  const zero = [0, 0, 0];
  const cubicF = await makeGlb(
    [{ name: "LowerTorso" }],
    [{ bone: "LowerTorso", path: "translation", times: [0, 1], values: [zero, zero, zero, zero, [0, 1, 0], zero], interp: "CUBICSPLINE" }],
  );
  // Hermite with zero tangents at t=0.5 is exactly the midpoint
  near(pos(poseAt(convert(await loadClip(cubicF), { fps: 2, scale: 1 }), 0.5, "LowerTorso")), [0, 0.5, 0], "cubic midpoint");
});

test("frames with no change are dropped but boundaries stay", async () => {
  const f = await twoBone([{ bone: "LeftUpperArm", path: "rotation", times: [0, 1, 3], values: [ident, qx90, qx90] }]);
  const out = convert(await loadClip(f), { fps: 2 });
  const times = out.keyframes.map((k) => k.t);
  assert.ok(times.includes(0) && times.includes(1) && times.includes(3));
  assert.ok(!times.includes(2), "constant middle dropped");
  assert.ok(out.keyframes.length < 7);
});

test("clip selection by name or index, with a clear error", async () => {
  const f = await makeGlb([{ name: "LowerTorso" }], [], "x", (doc, _s, nodes, buffer) => {
    for (const name of ["Idle", "Run"]) {
      const a = doc.createAnimation(name);
      const input = doc.createAccessor().setType("SCALAR").setArray(new Float32Array([0, name === "Run" ? 2 : 1])).setBuffer(buffer);
      const output = doc.createAccessor().setType("VEC3").setArray(new Float32Array(6)).setBuffer(buffer);
      const s = doc.createAnimationSampler().setInput(input).setOutput(output);
      a.addSampler(s);
      a.addChannel(doc.createAnimationChannel().setTargetNode(nodes.LowerTorso).setTargetPath("translation").setSampler(s));
    }
  });
  near([(await loadClip(f)).duration], [1], "first by default");
  near([(await loadClip(f, "Run")).duration], [2], "by name");
  near([(await loadClip(f, 1)).duration], [2], "by index");
  await assert.rejects(() => loadClip(f, "Nope"), /Idle, Run/);
});

test("file without animations gives a clear error", async () => {
  const f = await makeGlb([{ name: "LowerTorso" }], []);
  await assert.rejects(() => loadClip(f), /no animation/i);
});

test("FBX is refused with Blender export instructions", () => {
  const f = path.join(tmp, "x.fbx");
  fs.writeFileSync(f, "FBX");
  assert.throws(() => validateAnimationPath(f), /glTF.*Blender|Blender.*glTF/s);
});

test("no bones mapping to the rig is an error naming the bones", async () => {
  const f = await makeGlb([{ name: "Foo" }], [{ bone: "Foo", path: "rotation", times: [0, 1], values: [ident, qx90] }]);
  const clip = await loadClip(f);
  assert.throws(() => convert(clip), /Foo.*boneMap/s);
});

// ---------------------------------------------------------------- mapping

test("bone name aliases: Blender, Mixamo, exact", () => {
  for (const [bone, part] of [
    ["LeftUpperArm", "LeftUpperArm"], ["upper_arm.L", "LeftUpperArm"], ["DEF-upper_arm.R", "RightUpperArm"],
    ["mixamorig:LeftArm", "LeftUpperArm"], ["mixamorig:LeftForeArm", "LeftLowerArm"], ["mixamorig:RightUpLeg", "RightUpperLeg"],
    ["mixamorig:RightLeg", "RightLowerLeg"], ["Armature|Hips", "LowerTorso"], ["hand_l", "LeftHand"], ["Foot.R", "RightFoot"], ["head", "Head"],
  ]) assert.equal(canonicalBone(bone, RIGS.R15), part, bone);
});

test("R6 name mapping folds limb segments", () => {
  assert.equal(canonicalBone("LeftUpperArm", RIGS.R6), "Left Arm");
  assert.equal(canonicalBone("upper_leg.R", RIGS.R6), "Right Leg");
  assert.equal(canonicalBone("Hips", RIGS.R6), "Torso");
  assert.equal(canonicalBone("LeftHand", RIGS.R6), undefined);
});

const node = (name, parent) => ({ name, parent });

test("an explicit boneMap wins and unknown targets are rejected", () => {
  const m = mapBones([node("Foo"), node("LeftUpperArm")], RIGS.R15, { Foo: "Head", LeftUpperArm: "RightUpperArm" });
  assert.deepEqual(m.map, { Foo: "Head", LeftUpperArm: "RightUpperArm" });
  assert.throws(() => mapBones([node("Foo")], RIGS.R15, { Foo: "Nonexistent" }), /Nonexistent/);
  assert.throws(() => mapBones([node("Foo")], RIGS.R15, { Bar: "Head" }), /Bar/);
});

test("several bones on one part: the deepest drives it, others are reported", () => {
  const nodes = [node("mixamorig:Spine", undefined), node("mixamorig:Spine1", "mixamorig:Spine"), node("mixamorig:Spine2", "mixamorig:Spine1")];
  const m = mapBones(nodes, RIGS.R15, {});
  assert.deepEqual(m.map, { "mixamorig:Spine2": "UpperTorso" });
  assert.deepEqual(m.merged.sort(), ["mixamorig:Spine", "mixamorig:Spine1"]);
});

test("rig parts with no data are reported and tree reaches the root", async () => {
  const f = await twoBone([{ bone: "LeftLowerArm", path: "rotation", times: [0, 1], values: [ident, qx90] }]);
  const out = convert(await loadClip(f), { fps: 1 });
  assert.ok(out.report.rigPartsWithoutData.includes("Head"));
  assert.equal(out.tree.LeftLowerArm, "LeftUpperArm");
  assert.equal(out.tree.LeftUpperArm, "UpperTorso");
  assert.equal(out.tree.LowerTorso, "HumanoidRootPart");
  assert.equal(out.root, "HumanoidRootPart");
});

test("keyframes are split into bounded chunks without loss", () => {
  const keyframes = Array.from({ length: 5000 }, (_, i) => ({ t: i / 30, p: { A: [0, 0, 0, 0, 0, 0, 1] } }));
  const chunks = chunkKeyframes(keyframes, 20000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => JSON.stringify(c).length <= 20000));
  assert.equal(chunks.flat().length, 5000);
  assert.equal(chunks.flat()[4999].t, 4999 / 30);
});

// Property: joint rotations stay unit quaternions for arbitrary rotations
test("output rotations stay normalized for arbitrary animated rotations", async () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  const unit = () => { const v = [rnd(), rnd(), rnd(), rnd()]; const l = Math.hypot(...v); return v.map((x) => x / l); };
  for (let i = 0; i < 25; i++) {
    const f = await twoBone([{ bone: "LeftUpperArm", path: "rotation", times: [0, 1], values: [unit(), unit()] }, { bone: "LeftLowerArm", path: "rotation", times: [0, 1], values: [unit(), unit()] }], unit());
    const out = convert(await loadClip(f), { fps: 4 });
    for (const k of out.keyframes) for (const p of Object.values(k.p)) assert.ok(Math.abs(Math.hypot(...p.slice(3)) - 1) < 1e-5);
  }
});
