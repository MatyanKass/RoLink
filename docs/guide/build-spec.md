# Build spec

> The JSON node format of the build tool: frames, repeat, mirror, span, CSG, references, options, results.

## When to use

Creating many instances at once with relative coordinates. `inspect` and `export` produce the same format. The file-based alternative is `model.json` in the mirror, which uses world coordinates. Code: `plugin/src/Build.lua`, `plugin/src/Serialize.lua`.

## Call

```call
build {"parent":"Workspace","items":[{"class":"Model","name":"Crate","primary":"Body","at":[10,0,5],"children":[{"name":"Body","size":[4,4,4],"at":[0,2,0],"color":"#8A5A2B","material":"WoodPlanks"}]}]}
```

| Argument | Default | Meaning |
|---|---|---|
| `items` | required | Array of nodes, or one node |
| `parent` | `Workspace` | Parent path |
| `origin` | world origin | CFrame of the frame top-level items are placed in |
| `defaults` | none | Applied to every new BasePart first. `color`, `material`, `anchored` map to their properties, others must be property names |
| `replace` | false | Destroy existing children of `parent` with the same name as a built item, of any class |
| `select` | true | Select the result in Studio |

Result: `{created:[{path,id,class,s?,p?}], warnings:[...], instances, parts, csg, bounds:{center,size}}`.

The call is one undo step. An error rolls everything back. Warnings do not.

## Node keys

| Key | Meaning |
|---|---|
| `class` | Any creatable class. See "Class inference" |
| `name` | Name. `%d` becomes the repeat index, from 1. Default: the class |
| `at`, `rot` | Position and orientation in the parent frame. `rot` in degrees, Y-X-Z order |
| `cf`, `origin` | A full CFrame in the parent frame, instead of `at` and `rot`. `cf` wins over `origin`, both win over `at` |
| `size` | `[x,y,z]` on parts, a UDim2 on GUI objects |
| `color` | Sets `Color`, parts only |
| `material` | Sets `Material` |
| `shape` | `Block`, `Ball`, `Sphere`, `Cylinder` (axis is local X). Without `class`: `Wedge` makes a WedgePart, `CornerWedge` a CornerWedgePart |
| `transparency` | Sets `Transparency` |
| `props` | Object of properties |
| any `PascalCase` key | A property, same as inside `props` |
| `attrs` | Attributes, see [attributes-tags](attributes-tags.md) |
| `tags` | Array of tags |
| `children` | Child nodes |
| `source` | Script source |
| `repeat`, `mirror`, `span`, `thickness`, `csg` | See below |
| `primary` | (Model) Name or relative path of the PrimaryPart |
| `weld` | (Model) `true` makes a WeldConstraint from every part to the PrimaryPart |
| `scale` | (Model) `Model:ScaleTo` factor after building |
| `mesh` | MeshPart asset id. If it cannot be created you get a warning, and that node and its children are skipped |
| `asset` | Inserts an asset by id at this placement, **with no quarantine** |
| `comment`, `id`, `lines`, `more`, `opaque` | Ignored, so `inspect` output can be fed back |

Other lowercase keys are ignored.

### Class inference, when `class` is missing

`shape` of Wedge or CornerWedge gives those parts. Otherwise `mesh` gives MeshPart, `asset` Model. Any of `size`, `span`, `shape`, `csg`, `color`, `material` gives Part. Only `children` gives Model. Anything else is a Part.

## Frames

- Top-level nodes are placed relative to `origin`.
- A Model opens a frame at its own placement, which also becomes its pivot.
- A Part opens a frame at its own CFrame, for details stuck to it.
- An Attachment or Bone's `at` and `rot` are its CFrame relative to its parent part, and its children stay in the outer frame.
- Other instances do not have a placement.

Build a model around its own origin, bottom-centre at `[0,0,0]`. Then move all of it by changing only the model's `at`, or `origin`.

**Do not set `CFrame`, `Position` or `Orientation` as PascalCase keys on a part.** Placement runs after properties and overwrites them. Use `cf`, or `at` and `rot`.

## Repeat

```json
{"name":"Rail%d","size":[0.3,3,0.3],"at":[-10,1.5,4],"repeat":{"count":11,"step":[2,0,0]}}
```

```json
{"name":"Column%d","size":[1,8,1],"at":[6,4,0],"repeat":{"count":8,"rotStep":[0,45,0]}}
```

`step` translates each copy, `rotStep` rotates each copy around the parent frame's origin. Together they make spirals.

## Mirror

```json
{"name":"Leg","size":[1,4,1],"at":[3,2,2],"mirror":["x","z"]}
```

Adds reflected copies across the parent frame's planes, every combination of the listed axes: `["x","z"]` makes 4 copies. It is correct for symmetric shapes. Wedges keep their handedness. All copies of a repeat step share one name, so address them as `Leg[2]`.

## Span

```json
{"name":"Pipe","shape":"Cylinder","span":[[0,5,0],[0,5,20]],"thickness":1.2}
```

```json
{"name":"Beam","span":[[0,10,0],[12,14,0]],"thickness":[0.6,1]}
```

A part from point A to point B, both in the parent frame. `thickness` is a diameter, or `[width,height]`, default 1. Good for pipes, rails and struts. Identical endpoints are an error.

## CSG

```json
{"name":"Wall","size":[12,10,1],"at":[0,5,0],"material":"Brick","csg":{"op":"subtract","with":[{"size":[4,7,2],"at":[-3,-1.5,0]}]}}
```

See [unions-csg](unions-csg.md).

## References

Any property that takes an Instance, resolved after everything is built:

```json
{"class":"WeldConstraint","Part0":{"ref":"./Base"},"Part1":{"ref":"./Arm"}}
```

`.` is the top-level built node, `./X` is relative to it, and any other path is tried relative to it and then absolute.

## GUI nodes

`size` works as a UDim2. Everything else uses real property names, because `color`, `at` and `rot` mean nothing on GUI objects:

```call
build {"parent":"StarterGui","items":[{"class":"ScreenGui","name":"Hud","children":[{"class":"Frame","name":"Bar","size":[0,200,0,30],"Position":[0,10,0,10],"BackgroundColor3":"#202028"}]}]}
```

## Limits

50,000 instances per call. 200 warnings per call are kept.

## What aborts and what warns

Aborts, nothing created: a class that cannot be created, a bad mirror axis, identical span points, a failed CSG, over 50,000 instances, a node that is not an object, `source` that Studio refuses.

Warns, build continues: unknown property (with "did you mean"), bad value, a failed reference, a `primary` that is not a part inside the model, a mesh that failed to load, a failed attribute.

## Round trip with `inspect` and `export`

```call
inspect {"path":"Workspace/Crate","source":true}
```

Output is a node with children relative to the parent frame, only changed properties, plus `path`, `id`, `bounds`, `instances` on the root. The result can be edited and sent back to `build`.

**It is not a faithful copy for every class.** `inspect` and JSON `export` cover the properties in the class table, so use `.rbxm` for an exact copy. Unions come back as `opaque:true` and cannot be rebuilt from JSON.

## Quality checklist

1. Look first: `tree`, `find`, or a `screenshot` of the area. Match its materials and scale.
2. Plan dimensions in studs from player scale.
3. One Model per object, named, with its origin at bottom-centre and a `primary`.
4. Silhouette first, then secondary shapes, then small detail.
5. Two or three main colours and one accent. `Neon` only for glowing bits.
6. Offset coplanar faces by 0.01 to 0.05 to avoid flicker.
7. Verify with `screenshot {"targets":"Workspace/Crate","views":["iso","front","top"]}`.
8. Iterate with `replace:true`.

## Gotchas

- `shape` does not know `Capsule`. Use `"Shape":"Capsule"`.
- `color`, `material` and `transparency` on a non-part give a warning.
- Mirrored parts in a Model are real rotated copies, so their `Size` is unchanged.
- `replace` matches by name only, and destroys the old instance whatever its class.
