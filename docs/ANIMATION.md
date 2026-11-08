# Importing animations from Blender (`import_animation`)

`import_animation {path, rig?, name?, target?, fps?, animation?, boneMap?, scale?, facing?, loop?, priority?, replace?, preview?}`

Reads a `.glb`/`.gltf` and builds a `KeyframeSequence` under `target` (default `ServerStorage/RoLinkAnimations`) in one undo step. FBX is not supported: in Blender use File > Export > glTF 2.0 with Animation enabled.

## How the conversion works

Both glTF and Roblox are right-handed and Y-up. They differ in which way a character faces: glTF +Z (what Blender's glTF export produces for a character modelled facing -Y), Roblox -Z. RoLink rotates 180 degrees about Y to reconcile them; use `facing: "-z"` for a file that already faces -Z.

A `Pose.CFrame` drives the joint's `Motor6D.Transform`, so it is a rotation in the joint's frame relative to the rest pose. Blender bones have their own rest orientation, so RoLink takes each bone's world-space motion relative to its rest pose, removes the motion of the nearest animated ancestor in the Roblox rig, and expresses the result in that joint's frame. Consequences:

- Bone roll in the Blender rest pose does not affect the result.
- Unmapped bones between two mapped bones still contribute to the child's motion.
- A rotated or scaled Armature object is accounted for.

Bone translations become Pose offsets scaled by `scale`, by default 1/0.28 (1 stud = 0.28 m). If the rig was built with 1 Blender unit = 1 stud, pass `scale: 1`.

Sampling is uniform at `fps` (default 30) with LINEAR, STEP and CUBICSPLINE honored; frames identical to both neighbours are dropped.

## Bone mapping

`rig` is `"R15"` (default), `"R6"`, or a path to a rig in Studio, in which case its real `Motor6D` and `Bone` joints are read.

Names are matched case- and punctuation-insensitively after removing `Armature|`, `mixamorig:`, `DEF-` style prefixes. Mixamo and Blender conventions (`upper_arm.L`, `LeftForeArm`, `RightUpLeg`, `Hips`, `Spine2`, ...) are understood. Pass `boneMap` for anything else; it takes precedence. When several bones land on one part, the deepest drives it on R15 and the top one on R6, and the others are listed under `mergedBones`. Bones that matched nothing are listed under `unmappedBones`, rig parts with no data under `rigPartsWithoutData`.

## Preview

With `preview: true` and `rig` set to a Studio path, RoLink registers the sequence with `KeyframeSequenceProvider:RegisterKeyframeSequence`, plays it through `Animator:StepAnimations` and resets the rig. The id is temporary: per the Roblox docs it "cannot be used outside of Studio".

## Publishing

The KeyframeSequence lives only in the place until it is published. Roblox documents two routes.

### Open Cloud (no Studio click)

Roblox's Assets API lists Animation as an uploadable asset type with `.rbxm`/`.rbxmx` files.

1. Export the sequence: `export {path: "ServerStorage/RoLinkAnimations/Walk", file: "C:/tmp/Walk.rbxm", format: "rbxm"}`.
2. Create an Open Cloud API key with `asset:read` and `asset:write`.
3. Upload:

   ```
   curl -X POST https://apis.roblox.com/assets/v1/assets \
     -H "x-api-key: $ROBLOX_API_KEY" \
     -F 'request={"assetType":"Animation","displayName":"Walk","description":"Walk cycle","creationContext":{"creator":{"userId":"<your user id>"}}};type=application/json' \
     -F "fileContent=@C:/tmp/Walk.rbxm;type=model/x-rbxm"
   ```

4. Poll the returned operation until done: `GET https://apis.roblox.com/assets/v1/operations/{operationId}` (scope `asset:read`). The finished response holds the asset id.

The Roblox docs warn that files "edited outside Roblox Studio might not upload or function"; the `.rbxm` above is written by Studio itself. RoLink has not exercised this route against the live API; if it is rejected, use Studio.

### Studio

Roblox's documented manual path is the Animation Editor: open the animation on its rig, click the "..." button, choose **Publish to Roblox**, fill in the Asset Configuration window and click **Submit**. The asset id can then be copied from the Toolbox. If it replaces a default character animation, first rename the final keyframe to `End`.

`Plugin:SaveSelectedToRoblox` also exists (Plugin security) and opens an upload prompt for the selection; RoLink does not call it because it needs a person at the window.

References:
[Assets API usage](https://create.roblox.com/docs/cloud/guides/usage-assets),
[Assets API reference](https://create.roblox.com/docs/cloud/reference/features/assets),
[Animation Editor](https://create.roblox.com/docs/animation/editor),
[KeyframeSequenceProvider](https://create.roblox.com/docs/reference/engine/classes/KeyframeSequenceProvider).
