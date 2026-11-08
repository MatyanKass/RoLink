# Importing 3D models from your PC (`import_model`)

```json
{ "path": "C:/Models/chair.glb", "fitSize": 6, "position": [0, 0, 10] }
```

| arg | default | meaning |
|---|---|---|
| `path` | required | Local file: `.obj` (+ `.mtl` via `mtllib`), `.stl` (ascii/binary), `.gltf`, `.glb`; `.fbx` only in upload mode. Max 50 MB. |
| `parent` | `Workspace` | Instance path for the new Model |
| `name` | file name | Model name |
| `scale` | `1` | File units → studs |
| `fitSize` | – | Scale so the largest dimension equals this many studs (wins over `scale`) |
| `position` | `[0,0,0]` | World position of the model's **bottom-center** |
| `anchored` | `true` | Anchor all parts |
| `mode` | `auto` | `preview`, `upload`, or `auto` (upload if a key is configured, else preview) |
| `flipFaces` | `false` | Preview only: reverse winding if the model renders inside-out |

The import is one undo step (Ctrl+Z) and the new Model is selected.

## Preview mode (no account needed)

The server parses the file, centers it (x/z centered, bottom at y=0), applies the scale and
splits it into chunks of ≤18,000 triangles / ≤50,000 vertices (EditableMesh's limits are
20k triangles / 60k vertices per mesh). Each chunk goes to the plugin as its own bridge
command (~1 MB each); the plugin builds an `EditableMesh` per chunk
(`AddVertex` / `AddTriangle` / `AddNormal` + `SetFaceNormals` / `AddUV` + `SetFaceUVs`) and turns it into a
`MeshPart` with `AssetService:CreateMeshPartAsync(Content.fromObject(em))`.
Total limit: 1,000,000 triangles.

- Colors: OBJ `Kd`/`d` from the `.mtl`, glTF `baseColorFactor` (and alpha for BLEND materials) become
  `MeshPart.Color` / `Transparency`. **Textures are not applied in preview mode** (UVs are kept).
- Up axis: OBJ and glTF are taken as Y-up; STL is converted from Z-up.
- glTF: node transforms are baked in; only triangle primitives; Draco/meshopt-compressed files are not supported.
- OBJ n-gons are fan-triangulated (fine for convex faces).

> **Caveat: preview parts are NOT saved.** EditableMesh content lives only in the current Studio session;
> when the place is saved/published and reopened, those MeshParts come back without geometry.
> Preview Models are marked with the attribute `RoLinkPreviewImport = true`.
> Use upload mode for anything you want to keep.

## Upload mode (persistent)

Set these in the RoLink server's environment (e.g. the `env` block of your MCP config):

```
ROBLOX_API_KEY=<Open Cloud API key with asset:read and asset:write>
ROBLOX_CREATOR_USER_ID=<your user id>      # or ROBLOX_CREATOR_GROUP_ID=<group id>
```

The file is uploaded with `POST https://apis.roblox.com/assets/v1/assets`
(multipart: `request` = `{assetType:"Model", displayName, description, creationContext:{creator}}`,
`fileContent` = the file), the returned operation is polled at
`/assets/v1/operations/{id}` until done, and the plugin inserts the resulting asset with
`InsertService:LoadAsset` (fallback `game:GetObjects`), applies name/anchored/scale/position and
tags it with the attribute `RoLinkAssetId`. `.gltf` files are packed into a single `.glb` before upload.
Supported for upload: `.fbx`, `.glb`, `.gltf`, `.obj` (`.stl` → preview only).

The API key is only sent in the `x-api-key` header; it is never logged and is scrubbed from error messages.
New assets can take a while to pass moderation; if insertion fails right after upload, the error includes the asset id.
