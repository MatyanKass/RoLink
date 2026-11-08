# Tweens and animation import

> Runtime tweens, importing skeletal animation from glTF, previewing it, publishing it and playing it.

## When to use

Smooth property changes in a running game, or a character animation made in Blender.

## Tweens are game code

There is no tween tool or file format, because `TweenInfo` is not a property. Write a script:

```lua file=Workspace/Lift.model/Platform.Move.server.luau
local TweenService = game:GetService("TweenService")
local platform = script.Parent

local info = TweenInfo.new(2, Enum.EasingStyle.Sine, Enum.EasingDirection.InOut, -1, true)
local goal = { CFrame = platform.CFrame + Vector3.new(0, 12, 0) }

TweenService:Create(platform, info, goal):Play()
```

`EasingStyle`: Linear, Sine, Back, Quad, Quart, Quint, Bounce, Elastic, Exponential, Circular, Cubic. The arguments of `TweenInfo.new` are time, style, direction, repeat count (-1 is forever), reverses, delay.

To tween a whole Model, tween a `CFrameValue` and call `PivotTo` from its `Changed` event, or weld everything to one tweened anchored part.

Tweens only run in a play-test. Verify with a scenario:

```lua
T.step("lift rises", function()
  local p = workspace.Lift.Platform
  local y0 = p.Position.Y
  T.wait(1)
  T.assert(p.Position.Y > y0, "platform did not move")
end)
```

## Import an animation

Export from Blender as glTF with Animation enabled. FBX is not supported here.

```call
import_animation {"path":"C:/Anim/walk.glb","rig":"R15","name":"Walk","loop":true,"priority":"Movement"}
```

| Argument | Default | Meaning |
|---|---|---|
| `path` | required | Absolute path of `.glb` or `.gltf` |
| `rig` | `R15` | `R15`, `R6`, or a Studio path to a rig, whose real joints are read |
| `name` | clip name | KeyframeSequence name |
| `target` | `ServerStorage/RoLinkAnimations` | Parent. Created if default |
| `fps` | 30 | Sample rate, 1 to 120 |
| `animation` | first | Clip name or index |
| `boneMap` | | `{"mixamorig:Hips":"LowerTorso"}`, wins over automatic mapping |
| `scale` | 1/0.28 | Bone translation scale, metres to studs. Use 1 for a rig built at 1 unit = 1 stud |
| `facing` | `+z` | Direction the character faces in the file |
| `loop` | false | `KeyframeSequence.Loop` |
| `priority` | Action | Idle, Movement, Action, Action2, Action3, Action4, Core |
| `replace` | false | Replace a same-named sequence, otherwise an error |
| `preview` | false | Play once on the rig. `rig` must be a Studio path |
| `previewSeconds` | clip length | At most 15 |

Result: `{created, keyframes, poses, length, clip, availableClips, fps, positionScale, rig, mappedBones, mergedBones, unmappedBones, rigPartsWithoutData, sampled, note, preview?}`.

**Check `unmappedBones` and `rigPartsWithoutData`.** Bones are matched ignoring case and punctuation, after removing prefixes such as `Armature|`, `mixamorig:`, `DEF-`. Mixamo and Blender conventions are known. When several bones map to one part, the deepest wins on R15 and the top one on R6. Unmatched bones between mapped bones still contribute motion.

If nothing maps, the error lists the bones and suggests `boneMap`.

Clip limits come from `server/src/animation.ts`, and an over-long clip fails with a message naming the limit. Lower `fps` when asked.

## Preview

```call
import_animation {"path":"C:/Anim/wave.glb","rig":"Workspace/Dummy","name":"Wave","preview":true,"previewSeconds":3}
```

Needs a rig with a Humanoid or AnimationController. The temporary id works only in this Studio session. Nothing about the preview is saved, and the rig's joints are reset afterwards.

## Publish, to get a real id

A KeyframeSequence exists only in the place until published.

```call
export {"path":"ServerStorage/RoLinkAnimations/Walk","file":"D:/work/Walk.rbxm","format":"rbxm"}

prepare_asset {"path":"D:/work/Walk.rbxm","kind":"animation","name":"Walk"}
```

Then show the summary, wait for the user's phrase, and call `publish_animation`. See [publishing-assets](publishing-assets.md). This route has not been tested against the live API, and whether Roblox accepts a KeyframeSequence root is unconfirmed. The manual route is Studio's Animation Editor: open the sequence on its rig, then **...** then **Publish to Roblox**.

## Play it

```lua
local animation = Instance.new("Animation")
animation.AnimationId = "rbxassetid://123"
local animator = humanoid:FindFirstChildOfClass("Animator")
local track = animator:LoadAnimation(animation)
track:Play()
```

An `Animation` instance can also live in the place, as `Walk.Animation.json` holding `{"AnimationId":"rbxassetid://123"}`.

## Gotchas

- An animation id works only for the experience owner or with granted access.
- Studio-only temporary ids do not work in published games.
- Replacing a default character animation needs the final keyframe named `End`.
- A KeyframeSequence in the mirror is one JSON file that can be large. Leave it alone unless needed.
- `import_animation` works in edit context only.
