# Models and parts

> Creating, placing, grouping, duplicating and reading parts and models, by file and by tool.

## When to use

Building or changing 3D objects. For complex relative layouts prefer [build-spec](build-spec.md). For small changes to what already exists prefer the mirror.

## Part classes

| Class | Notes |
|---|---|
| `Part` | `Shape`: Block, Ball, Cylinder, Wedge, CornerWedge, Capsule |
| `WedgePart`, `CornerWedgePart`, `TrussPart` | Dedicated shapes |
| `MeshPart` | See [meshes-and-import-model](meshes-and-import-model.md) |
| `UnionOperation`, `NegateOperation` | See [unions-csg](unions-csg.md) |
| `SpawnLocation` | Where players appear: `Neutral`, `TeamColor`, `Duration`, `AllowTeamChangeOnTouch` |
| `Seat`, `VehicleSeat` | Sittable |

Common BasePart properties: `CFrame`, `Size`, `Color`, `Material`, `Transparency`, `Reflectance`, `Anchored`, `CanCollide`, `CanTouch`, `CanQuery`, `CastShadow`, `Massless`, `Locked`, `CollisionGroup`, `CustomPhysicalProperties`, `PivotOffset`, `RootPriority`.

A cylinder's axis is its local X, so for a vertical cylinder rotate `[0,0,90]`. Or use `span` in a build node.

## Create a model with a file

`Workspace/Bench.model/model.json`. Coordinates are in the world frame, and `PrimaryPart` is a reference relative to the model:

```json file=Workspace/Bench.model/model.json
{
  "PrimaryPart": {"ref":"./Seat"},
  "children": [
    {"name":"Seat","class":"Part","CFrame":{"p":[0,2,0]},"Size":[6,0.5,2],"Color":"#8A5A2B","Material":"WoodPlanks"},
    {"name":"LegL","class":"Part","CFrame":{"p":[-2.5,1,0]},"Size":[0.5,2,2],"Color":"#3B3F45","Material":"Metal"},
    {"name":"LegR","class":"Part","CFrame":{"p":[2.5,1,0]},"Size":[0.5,2,2],"Color":"#3B3F45","Material":"Metal"}
  ]
}
```

Write the directory and `model.json` together. New parts are Anchored.

## Create a model with build

```call
build {"items":[{"class":"Model","name":"Bench","primary":"Seat","at":[0,0,0],"children":[{"name":"Seat","size":[6,0.5,2],"at":[0,2,0],"color":"#8A5A2B","material":"WoodPlanks"},{"name":"LegL","size":[0.5,2,2],"at":[-2.5,1,0],"color":"#3B3F45","material":"Metal"},{"name":"LegR","size":[0.5,2,2],"at":[2.5,1,0],"color":"#3B3F45","material":"Metal"}]}]}
```

## Read

| Need | Do |
|---|---|
| Compact outline | `tree`, or `_tree.txt` |
| Sizes, joints, neighbours of a model | `_info` in `model.json` |
| All properties of one instance | `get` |
| Search by class, name, tag, attribute | `find` |
| Look at it | `screenshot` |

```call
tree {"path":"Workspace","depth":3}

find {"class":"BasePart","name":"door","limit":20}

find {"class":"Model","within":{"min":[-50,0,-50],"max":[50,40,50]}}

get {"path":"Workspace/Bench/Seat","props":["Position","Orientation","Anchored"]}

screenshot {"targets":"Workspace/Bench","views":["iso","front","top"]}
```

`tree` collapses three or more siblings with the same name and class into one `×N` line.

## Move

```call
move {"paths":"Workspace/Bench","position":[20,0,5]}

move {"paths":"Workspace/Bench","by":[0,0,-4],"rotate":[0,45,0]}

move {"paths":"Workspace/Bench","ground":true}

move {"paths":["Workspace/A","Workspace/B"],"parent":"Workspace/Group"}
```

Applied in this order: `to`, `position`, `by`, `rotate` (around its own pivot), `orientation`, `ground`, `parent`. `ground` casts a ray down from 5000 studs above and rests the bottom on whatever it hits, ignoring the object itself.

In the mirror, change `Pivot` on the model or `CFrame` on a part.

## Duplicate

```call
clone {"path":"Workspace/Lamp","count":5,"offset":[10,0,0],"name":"Lamp%d"}
```

`offset` is a world offset per copy. The `cframe` argument works only with `count` 1. An instance with `Archivable=false` cannot be cloned.

In the mirror, copying a `Name.model/` directory to a new name creates a real copy, with the limits in [mirror-basics](mirror-basics.md) (MeshParts are the problem).

## Pivot

`Model:PivotTo` is how whole models move. A model built with `at` has its pivot there. In the mirror it is the `Pivot` key.

## Grouping and hierarchy

Put parts in a Model when they form one object, in a Folder when they are only organised together. `Folder` becomes a plain directory in the mirror, and its `children` are individual files. Models keep all parts in one `model.json`.

## Save a model to a file

```call
export {"path":"Workspace/Bench","file":"D:/work/Bench.rbxm"}

import {"file":"D:/work/Bench.rbxm","parent":"Workspace","cframe":{"p":[0,0,30]}}
```

`.rbxm` is an exact copy, including unions and meshes. `.model.json` is readable but lossy: see [build-spec](build-spec.md). A relative `file` needs an active sync project. An existing file outside the working folder or sync project needs `overwrite:true`.

## Selection and camera

```call
selection {"set":["Workspace/Bench"]}

select_and_focus {"paths":"Workspace/Bench","view":"iso"}
```

## Delete

```call
delete {"paths":["Workspace/OldBench"]}
```

Deleting a service is refused.

## Gotchas

- `find` with `near` currently centres its search on `[x,x,x]`, using only the first number. Use `within` with a box instead. See [limits-and-known-gaps](limits-and-known-gaps.md).
- `find` `name` is a case-insensitive substring. Starting with `^` it is a Lua pattern, and the pattern is lower-cased first, so `%S` becomes `%s`. Use lowercase classes only.
- `find` `attrValue` matches numbers, strings and booleans only.
- The default root of `find` is Workspace. Pass `root:"game"` for the whole place.
- Parts that overlap fight visually if their faces are coplanar.
- `Locked` parts can still be changed by tools. It only stops mouse selection in Studio.
