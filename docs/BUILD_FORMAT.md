> To look at and edit the place, prefer the file mirror (`mirror_start {dir}`, then your normal file tools; see `AGENTS.md` in that folder).

# RoLink build format

The `build` tool takes an array of **nodes**. `inspect` and `export` return the same format, so anything in Studio can be read, edited and rebuilt.

## Node

```json
{
  "class": "Model",              // default: Part if it has size/shape/color…, Model if it only has children
  "name": "Generator",
  "at": [0, 0, 0],               // position in the PARENT node's frame (studs)
  "rot": [0, 90, 0],             // orientation in degrees (Roblox Orientation, Y-X-Z order)
  "children": [ … ]
}
```

| key | meaning |
|---|---|
| `class` | any creatable Roblox class |
| `name` | instance name; `%d` is replaced by the repeat index |
| `at`, `rot` | local position / orientation; alternatively `cf` = `{"p":[x,y,z],"r":[rx,ry,rz]}` or `{"p":…,"lookAt":[…]}`. Models may use `origin` (same thing) |
| `size` | `[x,y,z]` for parts |
| `color` | `"#RRGGBB"`, `[r,g,b]` 0-255, or a BrickColor name |
| `material` | `"Concrete"`, `"Metal"`, `"DiamondPlate"`, `"SmoothPlastic"`, `"Neon"`, `"Glass"`, `"Wood"`, `"WoodPlanks"`, `"Brick"`, `"CorrodedMetal"`, `"Foil"`, `"Slate"`, `"Granite"`, `"Marble"`, `"Pebble"`, `"Fabric"`… |
| `shape` | `"Block"`, `"Cylinder"` (axis = local X), `"Ball"`, `"Wedge"` (→ WedgePart), `"CornerWedge"` |
| `transparency` | 0..1 |
| `props` | `{ "Reflectance": 0.1, "CastShadow": false }` — or put PascalCase keys directly on the node |
| `attrs` | attributes: numbers/strings/bools as-is, typed values wrapped: `{"Glow": {"Color3": "#ffaa00"}}` |
| `tags` | CollectionService tags |
| `children` | child nodes |
| `primary` | (Model) name/path of the PrimaryPart, e.g. `"Base"` |
| `weld` | (Model) `true` → WeldConstraints from every part to the PrimaryPart |
| `scale` | (Model) `Model:ScaleTo` factor after building |
| `source` | Script/LocalScript/ModuleScript source |
| `mesh` | MeshPart asset id (`"rbxassetid://123"` or `123`) |
| `asset` | insert a Creator Store / owned asset by id at this node's placement |

### Frames (the important part)

* Top-level nodes are placed relative to the build call's `origin` (default: world origin).
* A **Model** (or any node with `at`/`rot`) opens a frame: its children's `at`/`rot` are relative to it.
  Build a model around its own origin (e.g. bottom-centre at `[0,0,0]`), then move the whole thing by changing only the model's `at`/`rot` — or the build `origin`.
* A **Part's** children are relative to the part (handy for details glued to a surface).
* An **Attachment's** `at`/`rot` is its CFrame relative to the parent part (as in Roblox).
* Model pivot = its frame, so `move`/`PivotTo` works intuitively afterwards.

### Repeat, mirror, span

```json
{"name": "Rail%d", "size": [0.3, 3, 0.3], "at": [-10, 1.5, 4], "repeat": {"count": 11, "step": [2, 0, 0]}}
{"name": "Column%d", "size": [1, 8, 1], "at": [6, 4, 0], "repeat": {"count": 8, "rotStep": [0, 45, 0]}}
{"name": "Leg", "size": [1, 4, 1], "at": [3, 2, 2], "mirror": ["x", "z"]}
{"name": "Pipe", "shape": "Cylinder", "span": [[0, 5, 0], [0, 5, 20]], "thickness": 1.2}
{"name": "Beam", "span": [[0, 10, 0], [12, 14, 0]], "thickness": [0.6, 1]}
```

* `repeat.step` translates each copy; `rotStep` rotates copies **around the parent frame's origin** (circular arrays). Both combine (spirals).
* `mirror` adds reflected copies across the parent frame's x/y/z planes (`["x","z"]` → 4 copies). Correct for symmetric shapes; wedges keep their shape (they are not mirrored themselves).
* `span` makes a part run from point A to point B (both in the parent frame): length = distance, `thickness` = diameter or `[width, height]`. Cylinders are oriented automatically. Perfect for pipes, cables, beams, rails, struts.

### CSG (holes, cut-outs, rounded shapes)

```json
{"name": "Wall", "size": [12, 10, 1], "at": [0, 5, 0], "material": "Brick",
 "csg": {"op": "subtract", "with": [
   {"size": [4, 7, 2], "at": [-3, -1.5, 0]},
   {"shape": "Cylinder", "size": [2, 3, 3], "at": [3.5, 1, 0], "rot": [0, 90, 0]}
 ]}}
```

`op`: `subtract` | `union` | `intersect`. The `with` parts are positioned **relative to the base part**. The result is a UnionOperation keeping the node's name. Keep CSG for real cut-outs; use plain parts for everything else (cheaper, editable).

### References

Any property that takes an Instance: `{"ref": "./Base"}` (relative to the top-level built node), `{"ref": "."}` (that node itself) or an absolute path `{"ref": "Workspace/Map/Door"}`. Resolved after everything is built:

```json
{"class": "WeldConstraint", "Part0": {"ref": "./Base"}, "Part1": {"ref": "./Arm"}}
{"class": "Beam", "Attachment0": {"ref": "./PoleA/Top"}, "Attachment1": {"ref": "./PoleB/Top"}}
```

### Value formats (props / set)

| type | JSON |
|---|---|
| Vector3 / Vector2 | `[x,y,z]` / `[x,y]` |
| Color3 | `"#RRGGBB"` |
| CFrame | `{"p":[x,y,z],"r":[rx,ry,rz]}` |
| Enum | `"Neon"` (name; case-insensitive) |
| UDim2 / UDim | `[xs,xo,ys,yo]` / `[s,o]` |
| NumberSequence | `[[t,v],[t,v,env]]`, a number, or `[from,to]` |
| ColorSequence | `[[t,"#hex"],…]` or `["#from","#to"]` |
| NumberRange | `[min,max]` |
| Font | `{"family":"GothamSSm","weight":"Bold"}` |
| PhysicalProperties | `[density, friction, elasticity, fw, ew]` or `false` |

Unknown property names and bad values do not abort the build: they come back in `warnings` with "did you mean" hints. Read them and fix.

## Build options

`build {items, parent?, origin?, defaults?, replace?, select?}`

* `defaults` — applied to every new part, e.g. `{"material": "SmoothPlastic"}`. Parts are always Anchored with smooth surfaces unless you say otherwise.
* `replace: true` — first destroys same-named children of `parent`. Use it to iterate on a model: rebuild, screenshot, adjust, rebuild.
* The whole call is one undo step; if anything throws, nothing is left behind.

## Quality checklist

1. **Look before building**: `tree`, `find`, `screenshot` the area. Match the existing style (materials, palette, scale).
2. **Plan dimensions in studs**, from player scale: character ≈ 5 tall, door 4×7, ceiling 10–14, stairs 1 rise / 1.5 run, walkway ≥ 6, railing 3. Snap to 0.25/0.5.
3. **One Model per object**, named, with a sensible origin (bottom-centre) and `primary`. Group sub-assemblies into child Models (`Body`, `Roof`, `Pipes`).
4. **Silhouette first, then detail**: big blocks → secondary forms (bevels via thin trim parts, wedges, cylinders) → small greebles (bolts, vents, panels, cables via `span`).
5. **Materials & colour**: 2–3 main colours plus one accent; real materials (Metal, DiamondPlate, Concrete, CorrodedMetal) over flat Plastic; `Neon` only for glowing bits, sparingly. Add PointLight/SurfaceLight for lamps.
6. **No z-fighting**: coplanar overlapping faces flicker — offset decals/panels by 0.01–0.05 or make them slightly thinner/smaller.
7. **Verify**: `screenshot` with `views: ["iso","front","top"]` on the model; check proportions and gaps, fix with `set`/`replace`.
8. **Save it**: `export` to `models/<Name>.model.json` (or `.rbxm` for meshes/unions) inside the synced project so it's under git.

## Example — small power generator

```json
[{"class": "Model", "name": "SmallGenerator", "primary": "Skid", "children": [
  {"name": "Skid", "size": [8, 0.6, 5], "at": [0, 0.3, 0], "color": "#2E3238", "material": "DiamondPlate", "children": [
    {"class": "Attachment", "name": "OutPlus", "at": [3.5, 1.2, 0.6]},
    {"class": "Attachment", "name": "OutMinus", "at": [3.5, 1.2, -0.6]}]},
  {"name": "Housing", "size": [5.5, 3.6, 4], "at": [-0.8, 2.4, 0], "color": "#D9A21B", "material": "Metal", "children": [
    {"name": "Vent%d", "size": [0.08, 0.25, 3], "at": [2.76, -0.8, 0], "color": "#1E1F22", "repeat": {"count": 6, "step": [0, 0.4, 0]}},
    {"name": "Panel", "size": [0.1, 1.6, 1.8], "at": [-2.76, 0.4, 0], "color": "#24272B", "material": "SmoothPlastic", "children": [
      {"class": "SurfaceLight", "Face": "Left", "Brightness": 0.6, "Range": 6, "Color": "#9DF29D"}]},
    {"name": "Lamp", "shape": "Ball", "size": [0.5, 0.5, 0.5], "at": [-2.8, 1.4, 1.2], "color": "#5DFF6A", "material": "Neon"}]},
  {"name": "Exhaust", "shape": "Cylinder", "span": [[1.2, 4.2, -1], [1.2, 6.2, -1]], "thickness": 0.6, "color": "#3B3F45", "material": "CorrodedMetal"},
  {"name": "Foot", "size": [0.8, 0.4, 0.8], "at": [3.4, 0.2, 2.0], "color": "#1B1D20", "mirror": ["x", "z"]}
]}]
```
