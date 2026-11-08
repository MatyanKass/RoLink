# Mirror format (precise notes)

Code: `server/src/mirrorname.ts` (names), `mirrorformat.ts` (layout, JSON, diff, `_info`,
AGENTS.md text), `mirror.ts` (session, safety), `plugin/src/Mirror.lua` (Studio side).

Tools: `mirror_start {dir, services?, deleteThreshold?}`, `mirror_stop`, `mirror_status`.

Default services: Workspace, ReplicatedStorage, ReplicatedFirst, ServerScriptService, ServerStorage,
StarterGui, StarterPack, StarterPlayer, Lighting, SoundService, Teams, Chat, TextChatService,
MaterialService. Other services are named at the end of `_tree.txt`.

`dir` must be new, empty or an earlier mirror (it holds `.rolink-mirror.json`). Files of an earlier run
move to `.rolink-trash/` (latest run only). Dot-prefixed entries are ignored by the watcher.

## Names

Token = encoded instance name, one path component.

- These are written `%XX` (uppercase hex): `< > : " / \ | ? * % ~ . +`, control chars, a leading or
  trailing space. Non-ASCII stays literal. Empty name: `%_`.
- Reserved tokens have their first character escaped (`%63on`, case-insensitive): CON PRN AUX NUL
  COM1-9 LPT1-9 server client init model gui _props _model _tree _errors agents.
- Siblings with the same token ignoring case: 2nd is `Tok~2`, 3rd `Tok~3`, in child order. Same-named
  siblings share one counter regardless of class. Applying the suffix never collides, as `~` is escaped.
- Decoding is lenient for hand-written files: a `%` not followed by two hex digits stays literal; a
  `~N` suffix is dropped. The file is rewritten under its canonical name after it is applied.
- Studio -> disk: a final file name failing `safeFileName` (sync.ts; includes longer than 200 chars)
  is not mirrored and is logged. Disk -> Studio: a name that is empty, over 100 chars or has control
  characters is rejected.

## Layout

| Instance | On disk |
|---|---|
| service | `<Service>/`, `_props.json` if it has fields |
| Folder | `Tok/`, `_props.json` if it has fields |
| Model | `Tok.model/model.json` |
| ScreenGui, SurfaceGui, BillboardGui | `Tok.gui/gui.json` (`class` key holds the exact class; default ScreenGui when creating) |
| Script / LocalScript / ModuleScript, no children | `Tok.server.luau` / `Tok.client.luau` / `Tok.luau` |
| script with children | `Tok.<Class>/init[.server\|.client].luau` plus the children |
| other instance with a script, Model or GUI somewhere below | `Tok.<Class>/_props.json` plus the children |
| any other instance | `Tok.<Class>.json`, descendants nested in `children` |

`.lua` is accepted when reading. Terrain appears as a normal JSON file of metadata; voxels are never read.

Excluded: CoreGui and non-listed services, `Workspace`'s Camera, Player objects, player characters,
`Archivable=false` instances, Build's `__RoLinkCSG` scratch folder.

### Inside `.model/` and `.gui/` (flat)

JSON tree: everything except scripts, Models/GUIs and the classes below.

Separate classes (`INTERACTIVE` in mirrorformat.ts): ProximityPrompt, ClickDetector, Sound, ParticleEmitter,
Beam, Trail, Fire, Smoke, Sparkles, Dialog, Highlight, Decal, Texture, SurfaceAppearance, PointLight,
SpotLight, SurfaceLight.

`<owner>` = tokens from the container down to the parent, joined by `+`, each token computed among all
children of its parent. Empty when the parent is the container.

| Child | File |
|---|---|
| script | `[<owner>.]Tok.server.luau` etc. |
| Model / GUI | `[<owner>.]Tok.model/`, `[<owner>.]Tok.gui/` |
| separate class | `<owner or _model>.<Class>[~N].json`; the instance name is the `name` key, omitted when it equals the class; `~N` counts same-class siblings of that owner |

A new file for a class not in that list is created and then folded into the JSON tree (the file goes away).

## JSON

Reserved keys: `name` `class` `attrs` `tags` `children` `csg` `_info`. Everything else must be PascalCase
and is a property; `Parent` `Name` `Source` `ClassName` and `__proto__` are rejected.

- Loose `Tok.<Class>.json`: name and class come from the file name.
- `model.json`, `gui.json`, `_props.json`: name comes from the directory.
- `children` entries require `name` and `class`.
- Coverage is generic: every property in the API dump table (`Api.props`) with a codec type is read and
  written; every creatable class works through `Instance.new`.
- Reading: only non-default values are written (default = a fresh instance with builder defaults:
  parts Anchored, smooth top/bottom). BaseParts always carry `CFrame` and `Size`. Skipped as derived:
  Position, Orientation, Rotation, BrickColor (on parts), World* axes, WorldPivot, Source.
- Writing: a property absent from a file is not changed. `attrs` / `tags` when present are the full set;
  `children` when present is the full list (absent: untouched).
- `Pivot` (Model): world frame, applied through PivotTo before the other properties of the same edit.
- `_info` (model.json): read-only, regenerated: `partCount`, `size`, `joints` (cap 200), `attached` (cap 200),
  `neighbours` (other top-level Workspace objects whose box touches, cap 16 from at most 5000 objects),
  `touching` (part pairs, models up to 150 parts, cap 30), `*Truncated` flags. Neighbours are refreshed
  when the model itself is re-rendered, not when the neighbour moves.

Value forms are those of `plugin/src/Codec.lua` (head comment). References: `{"ref":"./Door/Hinge"}` is
relative to the nearest Model/GUI at or above the instance, `{"ref":"."}` is that container itself,
`{"ref":"Workspace/A[2]"}` is absolute, `null` clears. Resolved after all ops of the batch.

### Child identity in JSON lists

Matched in order: same name + class + identical content; same name + class; same class + `CFrame` + `Size`
+ all else (a rename). The rest are created or destroyed.

### Unions and meshes

`{"name":"A","class":"UnionOperation","csg":{"op":"union|subtract|intersect|negate","parts":[{...},{...}]}}`.
Parts are `{class?,CFrame,Size,Color?,Material?,Shape?}` in world coordinates; the first part is the base
(negate takes one and yields a NegateOperation via `Plugin:Negate`). The other ops go through `Build`
(GeometryService, then the BasePart API). `csg` only applies at creation; on an existing name it is rejected.
A Union without `csg` is rejected. A new MeshPart needs `MeshId` (loaded with `CreateMeshPartAsync`).
Existing Unions and MeshParts keep geometry; other properties edit normally.

## Behaviour

- Debounce: disk 250 ms minimum after the last event (the watcher waits 100 ms for writes to settle);
  Studio about 0.25 s, then a render. A new folder waits until its files have been seen.
- Each disk batch is one `mirror_apply` = one undo step. Ops run in order: moves, creates, sets, destroys;
  references last.
- Echo control is by content: a watcher event whose hash equals the last known content is ignored; a Studio
  delta equal to the shadow changes nothing.
- Writes: temp file in `.rolink-tmp/`, then rename. Paths are checked against the root; links are never
  followed and a link in the tree is logged.
- Identity: `Paths.id` (session only); no markers are stored in the place. File/directory rename or move: same
  content (file), or the same relative file set (directory), in one batch. A file renamed and edited at once is
  a delete plus a create.
- Rejected edits go to `_errors.log` (last 500 lines); unparsable files are left in place until fixed.
- Refused, nothing applied, files restored from Studio, reported in `_errors.log` and `mirror_status.refusedDeletes`:
  batch destroying more than `deleteThreshold` (default 25) instances, a service directory removed, the root removed.
- `sync_start` and `mirror_start` refuse each other when their services overlap.
- Reconnect: Studio is re-dumped and the files reconciled to it; edits made on disk while disconnected are lost.
