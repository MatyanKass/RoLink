# Mirror reference

> Exact mirror file grammar: name encoding, layout rules, JSON keys, limits, safety refusals.

## When to use

You need the precise rule behind a file name or key, or `_errors.log` reports something unclear. For the everyday workflow see [mirror-basics](mirror-basics.md).

Code: `server/src/mirrorname.ts`, `mirrorformat.ts`, `mirror.ts`, `plugin/src/Mirror.lua`.

## Tools

| Tool | Notes |
|---|---|
| `mirror_start {dir, services?, deleteThreshold?}` | `deleteThreshold` default 25, capped at 100 |
| `mirror_status {}` | `active, dir, place, services, instances, files, deleteThreshold, batchesApplied, refusedDeletes, rejectedFiles, recentErrors, lastActivity` |
| `mirror_stop {}` | Files stay on disk but are no longer live |

Default services: Workspace, ReplicatedStorage, ReplicatedFirst, ServerScriptService, ServerStorage, StarterGui, StarterPack, StarterPlayer, Lighting, SoundService, Teams, Chat, TextChatService, MaterialService. Other services are named at the end of `_tree.txt`.

## Name encoding

A token is one instance name as it appears in a path component.

| Rule | Example |
|---|---|
| These characters become `%XX`, uppercase hex: `< > : " / \ | ? * % ~ . +` and control characters | `A.B` is `A%2EB` |
| Leading or trailing space becomes `%20` | |
| Empty name | `%_` |
| Reserved token: first character escaped, case-insensitive. Reserved: CON PRN AUX NUL COM1-9 LPT1-9 server client init model gui _props _model _tree _errors agents | `Server` is `%53erver` |
| Non-ASCII stays literal | `日本` |
| Encoded longer than 100 characters: start of the name, then `~h` and 12 hex digits of a hash | |
| Sibling with the same token ignoring case: `~2`, `~3` in child order, across classes | `Wall`, `Wall~2` |

Decoding hand-written files is lenient. A `%` not followed by two hex digits stays literal, and a `~N` suffix is dropped. The file is renamed to its canonical name after it is applied.

From Studio, a final file name that fails the safety check (over 200 characters, a path character, `..`, or ending in a dot or space) is not mirrored and is logged. From disk, an instance name that is empty, over 100 characters, or has control characters is rejected.

## Layout

| Instance | On disk |
|---|---|
| Service | `<Service>/`, plus `_props.json` if it has fields |
| Folder | `Tok/`, plus `_props.json` if it has fields |
| Model (exactly the class `Model`) | `Tok.model/model.json` |
| ScreenGui, SurfaceGui, BillboardGui | `Tok.gui/gui.json`, its `class` key holds the exact class. Default when creating: ScreenGui |
| Script, LocalScript, ModuleScript without children | `Tok.server.luau`, `Tok.client.luau`, `Tok.luau` |
| Script with children | `Tok.<Class>/init[.server\|.client].luau` plus the children |
| Other instance with a script, Model or GUI somewhere below | `Tok.<Class>/_props.json` plus the children |
| Any other instance | `Tok.<Class>.json`, descendants nested in `children` |

`.lua` is accepted when reading. Classes that inherit from Model but are not `Model`, such as Tool and Actor, use the generic rows.

A directory name with a capitalised last segment means a class: `Lamp.Part/`. A plain directory name means a Folder. The form on disk follows the instance: a `Lamp.Part/` whose scripts are gone is folded into `Lamp.Part.json`.

### Inside `.model/` and `.gui/`

JSON tree: everything except scripts, nested Models and GUIs, and these separate classes: ProximityPrompt, ClickDetector, Sound, ParticleEmitter, Beam, Trail, Fire, Smoke, Sparkles, Dialog, Highlight, Decal, Texture, SurfaceAppearance, PointLight, SpotLight, SurfaceLight.

`<owner>` is the tokens from the container down to the parent, joined with `+`, empty when the parent is the container. An owner label over 80 characters is replaced by an alias `~o<hash>`.

| Child | File |
|---|---|
| Script | `[<owner>.]Tok.server.luau` and so on |
| Model or GUI | `[<owner>.]Tok.model/`, `[<owner>.]Tok.gui/` |
| Separate class | `<owner or _model>.<Class>[~N].json`. The instance name is the `name` key, omitted when it equals the class. `~N` counts same-class siblings of that owner |

A new file for a class not in the separate list is created and then folded into the JSON tree, and the file goes away.

## JSON keys

| Key | Where | Meaning |
|---|---|---|
| `name` | `children` entries, separate-class files | Instance name |
| `class` | `children` entries, `gui.json` | Class. Must match an existing `model.json` |
| `attrs` | anywhere | Attributes, the complete set when present |
| `tags` | anywhere | Tags, the complete set when present |
| `children` | not in `_props.json` | Complete list when present, untouched when absent |
| `csg` | `children` entries, new loose files | Geometry recipe, used only at creation |
| `_info` | `model.json` | Read-only, regenerated |
| PascalCase | anywhere | A property |

Rejected keys: `Parent`, `Name`, `Source`, `ClassName`, `__proto__`, any lowercase key not listed above, nesting over 100 levels.

Rejected as sensitive, because a file must not be able to change what code may run: `AllowThirdPartySales`, `LoadStringEnabled`, `HttpEnabled`, `FilteringEnabled`, `SandboxedInstanceMode`, `Capabilities`, `Sandboxed`, `ScriptsDisabled`, `LinkedSource`, `BanningEnabled`, `HttpProxyEnabled`, `HttpProxyURL`, `AllowInsertFreeModels`, `AllowInsertFreeAssets`.

Value forms are in [property-types](property-types.md).

### What is written

Only values that differ from a fresh instance with builder defaults (parts Anchored, smooth top and bottom). Exceptions:

- BaseParts always carry `CFrame` and `Size`.
- Models and everything inheriting from Model always carry `Pivot`, including `Workspace/_props.json`.
- Non-creatable classes, meaning services, have no fresh instance to compare with, so their `_props.json` lists every property.
- References are always written when set.

Never written, on any class: `Position`, `Orientation`, `Rotation`, `BrickColor`, `Source`, `WorldPivot`, `WorldCFrame`, `WorldPosition`, `WorldOrientation`, `WorldAxis`, `WorldSecondaryAxis`, `LinkedSource`. Also anything outside the class table, such as `MeshId` and `MaterialVariant`. See [plugin-internals](plugin-internals.md).

Scripts are source only. Their attributes, tags, `Enabled` and `RunContext` have no place in the files.

Excluded instances: non-listed services, Workspace's Camera, Player objects, characters of players, anything with `Archivable=false`, Build's `__RoLinkCSG` scratch folder, and children of Terrain.

### References

`{"ref":"./Door/Hinge"}` is relative to the nearest Model or GUI at or above the instance, `{"ref":"."}` is that container, `{"ref":"Workspace/A[2]"}` is absolute, `null` clears.

Workspace inherits from Model, so a loose instance under Workspace has refs relative to Workspace. Outside a Model or GUI, refs are absolute. All refs resolve after all ops of the batch, so they may point at something created in the same batch.

### Child identity in `children`

Matched in order: same name and class with identical content; same name and class; same class with same `CFrame`, `Size` and all else (a rename). The rest are created or destroyed. Order in the list has no meaning.

## `_info` in model.json

`partCount`, `size`, `joints` (cap 200), `attached` (cap 200), `neighbours` (other top-level Workspace objects whose bounding box touches, cap 16 from at most 5000 objects), `touching` (part pairs, models of up to 150 parts, cap 30), and `*Truncated` flags. Neighbours refresh when the model itself is re-rendered, not when the neighbour moves.

## Timing

| Stage | Time |
|---|---|
| Watcher waits for a write to settle | 100 ms |
| Disk batch debounce | at least 250 ms after the last event |
| A new folder | Waits until its files have been seen, up to 20 deferrals |
| Studio to disk flush | about 0.25 s, then a render debounced by 200 ms |
| Plugin dump | 400 nodes per chunk, about 10 ms of work per frame |

## Order of operations in a batch

One `mirror_apply`, one undo step: moves, creates, sets, destroys, then references. Each op has its own error handling, so one rejected property does not stop the rest of the batch.

## Refusals

Nothing is applied, and files are restored from Studio. Reported in `_errors.log` and `mirror_status.refusedDeletes`:

- a batch destroying more than `deleteThreshold` instances, counted with descendants;
- more than 100 instances destroyed within 60 s across batches;
- a service directory removed;
- the mirror root removed.

## Rejected files

An unparsable file or bad name is logged as `REJECTED <file>: <reason>` and left in place until you change it. `_errors.log` keeps the last 500 lines.

Studio-side failures for one property are logged as `REJECTED <full name>.<prop>: <reason>`.

## Reading and writing safety

Writes go to `.rolink-tmp/`, then rename. Symlinks are never followed. Dot-prefixed entries are ignored by the watcher. Text from the place written to `_tree.txt`, `_errors.log` and `_info` is cleaned of control and invisible characters.

## Gotchas

- A new MeshPart needs `MeshId` in the creating file. Setting `MeshId` on an existing MeshPart fails, since Studio does not let plugins write it.
- `csg` on an existing name is rejected. Use a new name.
- A `UnionOperation` entry without `csg` is rejected at creation. See [unions-csg](unions-csg.md).
- Attribute and tag lists are replaced whole, so copy the existing ones when adding.
