# Meshes and import_model

> MeshParts by asset id, and importing OBJ, glTF, GLB, STL and FBX files from this PC.

## When to use

You have a 3D file on disk, or an existing mesh asset id.

## Import a file

```call
import_model {"path":"C:/Models/chair.glb","fitSize":6,"position":[0,0,10]}
```

| Argument | Default | Meaning |
|---|---|---|
| `path` | required | Absolute path. Up to 50 MB |
| `parent` | `Workspace` | Parent of the new Model |
| `name` | file name | Model name |
| `scale` | 1 | File units to studs |
| `fitSize` | | Scale so the largest dimension is this many studs. Wins over `scale` |
| `position` | `[0,0,0]` | World position of the bottom centre |
| `anchored` | true | Anchor all parts |
| `mode` | `auto` | `preview`, `upload`, `auto` (upload if a key is configured) |
| `flipFaces` | false | Preview only, reverses winding if it looks inside-out |

## Preview versus upload

| | `preview` | `upload` |
|---|---|---|
| Needs | Nothing | `ROBLOX_API_KEY` (`asset:read`, `asset:write`), `ROBLOX_CREATOR_USER_ID` or `ROBLOX_CREATOR_GROUP_ID` on the server |
| Formats | `.obj`, `.stl`, `.gltf`, `.glb` | `.fbx`, `.gltf`, `.glb`, `.obj` |
| Colours | Material colours only, no textures | Keeps textures |
| Saved with the place | **No** | Yes |
| Marker | Attribute `RoLinkPreviewImport` on the Model | Attribute `RoLinkAssetId` |

**Preview parts are not saved.** The geometry lives only in this Studio session. Reopening the place leaves MeshParts without geometry. Use upload for anything to keep. Upload is a publish to Roblox under the configured account, so the user is responsible for rights to the model, and moderation applies.

Preview result: `{mode, created, meshParts, persisted:false, parts, triangles, vertices, size, scale, note}`. Upload result: `{mode, assetId, created, persisted:true}`.

## Preview limits

18,000 triangles and 50,000 vertices per chunk, one MeshPart per chunk. 1,000,000 triangles per model. Draco or meshopt compression is not supported. OBJ and glTF are taken as Y-up, STL is converted from Z-up. OBJ n-gons are fan-triangulated. Files referenced by the model (`.mtl`, `.bin`, images) must be relative and inside the model's own folder, 200 MB in total. Anything else is refused.

## Upload notes

A `.gltf` is packed into one `.glb` first. The tool polls the upload for up to 180 s. If the asset is still in moderation when inserted, the error says so and includes the asset id. `.stl` is preview only.

## MeshPart by id

Build:

```call
build {"items":[{"name":"Rock","mesh":"rbxassetid://123456","size":[4,3,4],"at":[0,1.5,0]}]}
```

Mirror, creating a new part:

```json file=Workspace/Rock.MeshPart.json
{"MeshId":"rbxassetid://123456","CFrame":{"p":[0,1.5,0]},"Size":[4,3,4]}
```

## Texture and appearance

`TextureID` on a MeshPart is a normal property. For PBR use a `SurfaceAppearance` child. See [materials-textures-decals](materials-textures-decals.md).

## Generate a model

```call
generate_model {"prompt":"a small wooden barrel","at":[0,0,0],"size":[4,5,4]}
```

Uses `GenerationService:GenerateModelAsync`. Roblox's docs do not confirm a plugin can call it. If Studio refuses, the error says so. See [editor-tools](editor-tools.md).

## Gotchas

- `MeshId` cannot be changed on an existing MeshPart, by file or by `set`. Create a new one.
- `MeshId` is not in mirror files, so read it with `get {"path":"...","props":["MeshId"]}` or `inspect`.
- A copied `children` entry for a MeshPart has no `MeshId`, and makes an empty part.
- With `build`, a mesh that cannot load gives a plain Part and a warning. The mirror route reports an error instead. Mesh loading by id passes a plain string to an API documented as taking a `Content` value, and this has not been verified in real Studio. If it fails, use `run` with `Content.fromUri`, or insert the asset.
- `.fbx` has no preview route. Convert it or use upload.
