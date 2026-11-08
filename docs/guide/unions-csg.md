# Unions and CSG

> Boolean geometry through build nodes and mirror entries: operations, placement, colours, limits.

## When to use

Real cut-outs and merged solids: door holes, arches, windows. Plain parts are cheaper and stay editable, so use CSG only where it is needed.

## In a build node

The node is the base part. The `with` parts are placed relative to it.

```call
build {"items":[{"name":"Wall","size":[12,10,1],"at":[0,5,0],"material":"Brick","color":"#AA6644","csg":{"op":"subtract","with":[{"size":[4,7,2],"at":[-3,-1.5,0]},{"shape":"Cylinder","size":[2,3,3],"at":[3.5,1,0],"rot":[0,90,0]}]}}]}
```

`op` is `subtract` (the default), `union` or `intersect`. Only geometry keys are read from `with` entries: `class`, `shape`, `size`, `at`, `rot`, `cf`, `origin`, `span`, `thickness`, `mesh`.

`color` and `material` on a `with` entry are ignored, so those tools keep the default colour. If a hole's inner faces show the wrong colour, recolour the union as shown below.

The result is a UnionOperation with the node's name. `Anchored`, attributes and tags are copied from the base.

## In a mirror file

A child entry in `model.json`, or a new `Name.UnionOperation.json`. Coordinates are world. The first part is the base.

```json file=Workspace/House.model/model.json
{
  "children": [
    {"name":"Arch","class":"UnionOperation","UsePartColor":true,"Color":"#AA8866",
     "csg":{"op":"subtract","parts":[
       {"class":"Part","CFrame":{"p":[0,5,0]},"Size":[8,10,2],"Color":"#AA8866","Material":"Brick"},
       {"class":"Part","CFrame":{"p":[0,3,0]},"Size":[4,6,4]}
     ]}}
  ]
}
```

`op` is `union`, `subtract`, `intersect` or `negate`. Each part accepts `class`, `CFrame`, `Size`, `Shape`. `Color` and `Material` are used on the first part only. `negate` takes one part and produces a NegateOperation through `Plugin:Negate`. The other ops need at least two parts.

`csg` is used once, at creation. It then vanishes from the file and the entry is an ordinary one whose geometry is preserved while you change `Color`, `Material` or `CFrame`.

## How it runs

`GeometryService:UnionAsync`, `SubtractAsync` or `IntersectAsync` with `PreciseConvexDecomposition` collision and `Precise` rendering, falling back to the older `BasePart` API. A temporary `Workspace/__RoLinkCSG` folder holds the inputs and is removed afterwards.

## Colours

A union keeps the colours of its input parts. To give the whole thing one colour, set `UsePartColor` to true and then `Color`:

```call
set {"path":"Workspace/Wall","props":{"UsePartColor":true,"Color":"#AA6644"}}
```

## Changing the shape

Geometry cannot be edited through properties. Create a new union under a new name, or delete and re-create it. In a mirror, `csg` on an existing name is rejected with a message saying so.

## Saving

Unions cannot be rebuilt from JSON. `inspect` marks them `opaque:true`, and `export` to `.model.json` warns. Use `.rbxm`.

```call
export {"path":"Workspace/Wall","file":"D:/work/Wall.rbxm"}
```

## Gotchas

- Failures abort a build: the error names the node, and nothing is created. In the mirror the failure goes to `_errors.log`.
- `csg` works only on part nodes.
- A `UnionOperation` entry with no `csg` is rejected at creation.
- Open Cloud place publishing does not update `PartOperation` instances, according to Roblox's guide. See [publishing-places-datastores](publishing-places-datastores.md).
- Terrain is not supported by GeometryService.
- Very complex unions can be slow, and Studio freezes while they compute. Build timeouts are 180 s.
