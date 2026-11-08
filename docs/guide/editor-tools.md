# Editor tools

> align, distribute, select_and_focus, camera, screenshot, script search and outline, generate_model.

## When to use

Things a person does by hand in Studio's interface.

## align

Line up models and parts on one axis by their bounding boxes.

```call
align {"paths":["Workspace/A","Workspace/B","Workspace/C"],"axis":"y","to":"min"}

align {"paths":["Workspace/A","Workspace/B"],"axis":"x","to":"center","relativeTo":"first"}

align {"paths":"@selection","axis":"z","to":"max","value":40}
```

`to` is `min`, `center` or `max`. `relativeTo` is `all` (the bounds of all targets, default) or `first` (the first target stays put). `value` is a world coordinate that overrides both. Result: `{moved, axis, value}`. One undo step. Every target must be a Model, part or other PVInstance with parts.

## distribute

```call
distribute {"paths":["Workspace/A","Workspace/B","Workspace/C","Workspace/D"],"axis":"x"}

distribute {"paths":["Workspace/A","Workspace/B"],"axis":"x","spacing":4}
```

Without `spacing`: the outermost two stay, gaps become equal, at least 3 targets. With `spacing`: each follows the previous one edge to edge at that gap, at least 2 targets. Targets are ordered by centre along the axis. Result: `{moved, axis, gap}`.

## select_and_focus

```call
select_and_focus {"paths":"Workspace/Tower","view":"iso","distance":1.2}
```

Selects and moves the user's camera, and the camera stays there. Use this to show the user something.

## selection

```call
selection {}

selection {"set":["Workspace/A","Workspace/B"]}
```

## screenshot

Frames the camera, captures Studio's window, crops to the 3D viewport and returns JPEG images. Windows only.

```call
screenshot {"targets":"Workspace/Tower","views":["iso","front","top"]}

screenshot {"position":[0,50,80],"lookAt":[0,10,0],"fov":50}

screenshot {"view":"current","maxWidth":1920}
```

| Argument | Default | Meaning |
|---|---|---|
| `targets` | whole Workspace content | What to frame |
| `view`, `views` | `iso` with targets, else `current` | front, back, left, right, top, bottom, iso, iso_back, iso_left, bird, current |
| `position`, `lookAt` | | Explicit camera |
| `cframe` | | Explicit camera CFrame |
| `distance` | 1 | Multiplier on the fitted distance, 0.6 is closer |
| `fov` | current | Field of view |
| `maxWidth` | 1280 | At most 2560 |
| `restore` | true | Put the camera back |
| `hideSelection` | true | Hide the selection outline while capturing |

Views follow the orientation of a single target's pivot. "Whole Workspace" skips Terrain, the Camera, a part named Baseplate, and very large flat parts.

Studio must not be covered in a way that blocks capture. A minimised window is restored first. The notes in the result say so if the viewport markers were not found and the whole window came back.

GUIs in `StarterGui` appear in the capture, see [gui](gui.md).

## camera

```call
camera {}

camera {"set":{"targets":"Workspace/Tower","view":"front"}}
```

Reads `{cframe, focus, fov, viewport}`. `set` takes the same options as screenshot.

## Script navigation

`script_search`, `script_outline` and `script_diagnostics` are in [scripts](scripts.md). `script_search` returns `{matches:[{path,line,text}], total, scripts, truncated}`. Plain text by default and case-insensitive. With `pattern:true` it is a Lua pattern and always case-sensitive. Default limit 200, at most 2000. Lines are cut to 200 characters.

## weld_model and set_collision_groups

See [welds-constraints](welds-constraints.md).

## generate_model

```call
generate_model {"prompt":"low poly pine tree","name":"Pine","parent":"Workspace","at":[10,0,10],"size":[6,14,6],"maxTriangles":800}
```

Needs `prompt` or `image` (asset id). `parts` splits the model into named groups, or `predefined` uses a built-in schema, `Car5` or `Body1`. Do not pass both. Result: `{created, uuid}`. Roblox's documentation does not confirm plugins may call this. If Studio refuses, the error says so.

## Undo

```call
undo {}

undo {"steps":3}

undo {"redo":true}
```

Undo fails during a play-test.

## Gotchas

- `align` and `distribute` refuse a target with no parts.
- Moving by bounding box shifts pivots, so a rotated model stays rotated.
- There is no tool for `Material Generator`, gizmos, or other Studio UI. See [limits-and-known-gaps](limits-and-known-gaps.md).
