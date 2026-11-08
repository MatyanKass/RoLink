# Materials, textures and decals

> Part materials, material variants, Decal, Texture and SurfaceAppearance, with exact files.

## When to use

Changing how surfaces look.

## Material and colour

`Material` is an enum, `Color` a Color3.

Values: Plastic, SmoothPlastic, Neon, Wood, WoodPlanks, Marble, Basalt, Slate, CrackedLava, Concrete, Limestone, Granite, Pavement, Brick, Pebble, Cobblestone, Rock, Sandstone, CorrodedMetal, DiamondPlate, Foil, Metal, Grass, LeafyGrass, Sand, Fabric, Snow, Mud, Ground, Asphalt, Salt, Ice, Glacier, Glass, ForceField, Air, Water, Cardboard, Carpet, CeramicTiles, ClayRoofTiles, RoofShingles, Leather, Plaster, Rubber.

```call
set {"path":["Workspace/Wall","Workspace/Floor"],"props":{"Material":"Concrete","Color":"#8C8F94"}}
```

Glass with `Transparency` around 0.5 looks like glass. `Neon` glows and is best used sparingly.

## Decal

An image on one face of a part.

On a part in a model: `Tower.model/Door.Decal.json`. A second decal on the same part is `Door.Decal~2.json`.

```json file=Workspace/Tower.model/Door.Decal.json
{"Texture":"rbxassetid://123","Face":"Front"}
```

On a loose part, inside `children` of `Name.Part.json`:

```json file=Workspace/Sign.Part.json
{"CFrame":{"p":[0,4,0]},"Size":[6,4,0.2],"children":[
  {"name":"Poster","class":"Decal","Texture":"rbxassetid://123","Face":"Front"}
]}
```

Properties: `Texture`, `Face` (Front, Back, Left, Right, Top, Bottom), `Color3`, `Transparency`, `ZIndex`, `UVOffset`, `UVScale`.

## Texture

A tiling image on a face.

```json file=Workspace/Tower.model/Floor.Texture.json
{"Texture":"rbxassetid://123","Face":"Top","StudsPerTileU":4,"StudsPerTileV":4}
```

Properties as Decal, plus `StudsPerTileU`, `StudsPerTileV`, `OffsetStudsU`, `OffsetStudsV`.

## SurfaceAppearance

PBR maps on a MeshPart.

```json file=Workspace/Statue.model/Body.SurfaceAppearance.json
{"ColorMap":"rbxassetid://1","NormalMap":"rbxassetid://2","RoughnessMap":"rbxassetid://3","MetalnessMap":"rbxassetid://4","AlphaMode":"Overlay"}
```

## MaterialVariant

Custom materials live in `MaterialService`, and are ordinary mirror files:

```json file=MaterialService/MossyBrick.MaterialVariant.json
{"BaseMaterial":"Brick","ColorMap":"rbxassetid://1","NormalMap":"rbxassetid://2","StudsPerTile":8}
```

Apply one with the part's `MaterialVariant` string. This property is not shown in mirror files, so use `set` and `get`:

```call
set {"path":"Workspace/Wall","props":{"Material":"Brick","MaterialVariant":"MossyBrick"}}
```

## Getting an image id

An image file must be uploaded first. See [publishing-assets](publishing-assets.md). With a `target`, RoLink makes a placeholder Decal or Texture and fills in the id after moderation. To find existing images: `toolbox_search {"query":"brick","kind":"decal"}`, see [toolbox-quarantine](toolbox-quarantine.md).

## Gotchas

- An id from `toolbox_search` or an upload may fail to display if the experience has no permission to use it.
- `rbxassetid://123` is the standard form. A bare number works in JSON too, and comes back in the `rbxassetid://` form.
- `Decal.Color3` is named differently from `BasePart.Color`.
- Open Cloud place publishing does not update `SurfaceAppearance`, per Roblox's guide.
- `SurfaceAppearance` map properties are PluginSecurity. A plugin can set them, a game script cannot.
