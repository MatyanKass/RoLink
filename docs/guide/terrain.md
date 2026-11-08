# Terrain

> Sculpting voxel terrain with the terrain tool, water and grass settings, and reading voxels.

## When to use

Landscapes. Terrain voxels are not in the mirror, so this tool is the route.

## The tool

`terrain {ops:[...]}`. All ops run in one undo step, in order. `material` defaults to Grass.

| `op` | Arguments | Effect |
|---|---|---|
| `block` | `cf`, `size`, `material` | `FillBlock` |
| `ball` | `center`, `radius` (default 8), `material` | `FillBall` |
| `cylinder` | `cf`, `height` (default 8), `radius` (default 8), `material` | `FillCylinder`, axis is local Y |
| `wedge` | `cf`, `size`, `material` | `FillWedge` |
| `replace` | `min`, `max`, `from`, `to` | `ReplaceMaterial` in that box, resolution 4 |
| `clear` | `min?`, `max?` | With a box: fills it with Air. **Without: wipes all terrain** |

`cf` accepts any CFrame form, including `[x,y,z]`. `fillblock`, `fillball`, `fillcylinder` and `fillwedge` are accepted as op names too.

## Recipes

An island with a beach and a sea:

```call
terrain {"ops":[{"op":"block","cf":[0,-10,0],"size":[800,20,800],"material":"Water"},{"op":"ball","center":[0,-14,0],"radius":120,"material":"Sand"},{"op":"ball","center":[0,-10,0],"radius":100,"material":"Grass"},{"op":"ball","center":[20,20,0],"radius":40,"material":"Rock"}]}
```

A hill and a tunnel through it:

```call
terrain {"ops":[{"op":"ball","center":[100,0,0],"radius":50,"material":"Ground"},{"op":"cylinder","cf":{"p":[100,5,0],"r":[0,0,90]},"height":120,"radius":8,"material":"Air"}]}
```

Turn grass into snow in an area:

```call
terrain {"ops":[{"op":"replace","min":[-200,-50,-200],"max":[200,100,200],"from":"Grass","to":"Snow"}]}
```

Clear a box:

```call
terrain {"ops":[{"op":"clear","min":[-20,0,-20],"max":[20,30,20]}]}
```

Materials for terrain: Air, Water, Grass, LeafyGrass, Sand, Rock, Slate, Basalt, Ground, Mud, Snow, Ice, Glacier, Salt, Sandstone, Limestone, Concrete, Pavement, Asphalt, Cobblestone, Brick, WoodPlanks, CrackedLava.

## Procedural terrain

For noise-based shapes use `run`:

```call
run {"code":"local t = workspace.Terrain for x = -200, 200, 8 do for z = -200, 200, 8 do local h = math.noise(x/120, z/120) * 30 + 20 t:FillBlock(CFrame.new(x, h/2, z), Vector3.new(8, h, 8), Enum.Material.Grass) end end","timeout":120}
```

## Terrain settings

Water and grass settings are normal properties, in `Workspace/Terrain.Terrain.json` in the mirror: `WaterColor`, `WaterTransparency`, `WaterReflectance`, `WaterWaveSize`, `WaterWaveSpeed`, `Decoration`, `GrassLength`.

```call
set {"path":"Workspace/Terrain","props":{"WaterColor":"#1E6E8C","WaterWaveSize":0.2}}
```

The file also lists `CFrame` and `Size`, which mean nothing for Terrain.

## Reading voxels

There is no dedicated read tool. Use `run` with `ReadVoxels`:

```call
run {"code":"local r = Region3.new(Vector3.new(-16,-16,-16), Vector3.new(16,16,16)):ExpandToGrid(4) local m, o = workspace.Terrain:ReadVoxels(r, 4) return m.Size, m[1][1][1].Name, o[1][1][1]"}
```

A height test with a ray:

```call
run {"code":"local hit = workspace:Raycast(Vector3.new(0,500,0), Vector3.new(0,-1000,0)) return hit and hit.Position, hit and hit.Material.Name"}
```

## Placing things on terrain

```call
move {"paths":"Workspace/Hut","ground":true}
```

## Gotchas

- Voxels are 4 studs. Details smaller than that vanish.
- `clear` with no box has no safety check. It is one undo step, but confirm the intent first.
- Terrain cannot be exported to `.rbxm` or `.model.json` through these tools, and GeometryService CSG does not apply.
- `Clouds` lives under Terrain: see [lighting-atmosphere](lighting-atmosphere.md).
- Very large fills can run for a while. The tool waits up to 120 s, and `run` needs an explicit `timeout`.
