# Tools reference

> Every tool of both MCP servers: arguments, result and one example.

## When to use

You need the exact arguments or result of a tool. `?` marks an optional argument.

## Common arguments

Every `rolink` tool except `guide` also takes:

| Argument | Meaning |
|---|---|
| `place?` | Place name substring or exact id, when several Studios are open |
| `context?` | `edit` (default), `server`, `client`. Toolbox tools and `import_animation` are edit only. Playtest tools choose their own default |

Unknown arguments are dropped silently. A `path` may be any form in [overview](overview.md).

## rolink: reading

### `guide`

`topic?`, `section?`, `search?`. Returns text. See [overview](overview.md).

```call
guide {"topic":"gui","section":"UIListLayout"}
```

### `status`

No arguments. Text listing sessions and sync and mirror state.

```call
status {}
```

### `tree`

`path?` (string or array, default Workspace), `depth?` (2), `maxNodes?` (400), `classes?` (IsA filter, containers kept). Returns an outline with sizes, positions, part counts, script line counts and `#ids`.

```call
tree {"path":"ReplicatedStorage","depth":4}
```

### `inspect`

`path`, `depth?`, `maxNodes?` (1500), `source?`, `props?` (`changed` or `none`). Returns `{nodes:[...], truncated}` in build-spec form. Lossy for some classes, see [build-spec](build-spec.md).

```call
inspect {"path":"Workspace/Tower","depth":2}
```

### `get`

`path`, `props?` (names, any readable property), `source?` (default includes source). Returns `{path,id,class,props,attrs,tags,children}`. Unreadable values appear as `<unreadable>`.

```call
get {"path":"Workspace/Door","props":["Position","Anchored"]}
```

### `find`

`root?` (default Workspace, `game` for everything), `class?` (IsA), `exactClass?`, `name?` (substring, or `^` Lua pattern), `tag?`, `attr?`, `attrValue?`, `text?` (script source contains, case-sensitive), `near?`, `radius?`, `within?` `{min,max}`, `limit?` (100). Returns `{results:[{path,id,class,...}], total}`. `near` has a defect, see [limits-and-known-gaps](limits-and-known-gaps.md).

```call
find {"root":"game","class":"LuaSourceContainer","text":"DataStore"}
```

## rolink: writing

### `build`

`items`, `parent?`, `origin?`, `defaults?`, `replace?`, `select?`. See [build-spec](build-spec.md).

```call
build {"items":[{"name":"Box","size":[4,4,4],"at":[0,2,0]}]}
```

### `set`

`path?`, `props?`, `attrs?`, `tags?`, `untag?`, `name?`, `source?`, or `edits?` as an array of `{path, props?, attrs?, tags?, untag?, name?, source?, removeFalseAttrs?}`. Returns `{updated, warnings}`.

```call
set {"edits":[{"path":"Workspace/A","props":{"Color":"#FF0000"}},{"path":"Workspace/B","name":"Renamed"}]}
```

### `delete`

`paths`. Returns `{deleted}`. Services are refused.

```call
delete {"paths":"Workspace/Old"}
```

### `clone`

`path`, `parent?`, `count?`, `offset?`, `cframe?` (with count 1), `name?` (`%d` numbers copies). Returns `{created}`.

```call
clone {"path":"Workspace/Lamp","count":3,"offset":[8,0,0],"name":"Lamp%d"}
```

### `move`

`paths`, `to?`, `position?`, `by?`, `rotate?`, `orientation?`, `ground?`, `parent?`. Returns `{moved}`.

```call
move {"paths":"Workspace/Hut","position":[0,0,50],"ground":true}
```

### `run`

`code`, `args?`, `timeout?` (30 s). Text with `output:` and `returns:` or `ERROR:`. One undo step.

```call
run {"code":"return workspace.Gravity"}
```

### `selection`

`set?`. Returns `{selection:[...]}`.

```call
selection {"set":"Workspace/Tower"}
```

### `undo`

`steps?` (1), `redo?`. Returns `{ok}`.

```call
undo {"steps":2}
```

### `terrain`

`ops`. Returns `{ops:<count>}`. See [terrain](terrain.md).

```call
terrain {"ops":[{"op":"ball","center":[0,0,0],"radius":20,"material":"Rock"}]}
```

## rolink: view

### `screenshot`

`targets?`, `view?`, `views?`, `position?`, `lookAt?`, `cframe?`, `distance?`, `fov?`, `maxWidth?`, `restore?`, `hideSelection?`. Text plus JPEG images. See [editor-tools](editor-tools.md).

```call
screenshot {"targets":"Workspace/Tower","view":"iso"}
```

### `camera`

`set?`. Returns `{cframe,focus,fov,viewport}`.

```call
camera {"set":{"position":[0,30,60],"lookAt":[0,0,0]}}
```

### `select_and_focus`

`paths`, `view?` (iso), `distance?`, `fov?`. Returns `{selection, focused, note?}`.

```call
select_and_focus {"paths":"Workspace/Door"}
```

## rolink: files

### `export`

`path`, `file`, `format?` (`json` or `rbxm`, from the extension), `keepPosition?` (true), `overwrite?`. Text with what was written.

```call
export {"path":"Workspace/Tower","file":"D:/work/Tower.model.json","format":"json"}
```

### `import`

`file`, `parent?`, `replace?`, `cframe?`. `.rbxm` returns `{created}`, JSON returns a build result.

```call
import {"file":"D:/work/Tower.model.json","parent":"Workspace","replace":true}
```

### `import_model`

`path`, `parent?`, `name?`, `scale?`, `fitSize?`, `position?`, `anchored?`, `mode?`, `flipFaces?`. See [meshes-and-import-model](meshes-and-import-model.md).

```call
import_model {"path":"C:/Models/tree.obj","mode":"preview","fitSize":12}
```

### `import_animation`

`path`, `rig?`, `name?`, `target?`, `fps?`, `animation?`, `boneMap?`, `scale?`, `facing?`, `loop?`, `priority?`, `replace?`, `preview?`, `previewSeconds?`. See [tween-animation-import](tween-animation-import.md).

```call
import_animation {"path":"C:/Anim/run.glb","name":"Run","loop":true}
```

## rolink: Creator Store

### `toolbox_search`

`query`, `kind?`, `limit?`. Returns `{notice, source, results}`. See [toolbox-quarantine](toolbox-quarantine.md).

```call
toolbox_search {"query":"street lamp"}
```

### `toolbox_insert`

`assetId`. Returns the scan report.

```call
toolbox_insert {"assetId":1234567}
```

### `toolbox_release`

`path`, `target`, `enableScripts?`, `acknowledgeFlags?`. Returns `{moved,enabled,disabled,unknownScripts}` or `{refused,reason}`.

```call
toolbox_release {"path":"ServerStorage/RoLinkQuarantine/Lamp_1234567","target":"Workspace"}
```

## rolink: sync and mirror

### `sync_start`

`project`. See [sync-rojo](sync-rojo.md).

```call
sync_start {"project":"D:/work/my-game/default.project.json"}
```

### `sync_stop`

No arguments.

```call
sync_stop {}
```

### `sync_status`

No arguments. `{project,root,place,items,warnings,recent}` or `{active:false}`.

```call
sync_status {}
```

### `mirror_start`

`dir`, `services?`, `deleteThreshold?`. Returns `{dir,place,services,instances,files}`. See [mirror-basics](mirror-basics.md).

```call
mirror_start {"dir":"D:/work/mirror","services":["Workspace","StarterGui"]}
```

### `mirror_stop`

No arguments.

```call
mirror_stop {}
```

### `mirror_status`

No arguments. See [mirror-reference](mirror-reference.md).

```call
mirror_status {}
```

## rolink: testing

See [playtest-and-scenarios](playtest-and-scenarios.md) and [output-and-debugging](output-and-debugging.md).

### `playtest_start`

`mode` (`play` or `run`), `timeout?` (60 s).

```call
playtest_start {"mode":"run"}
```

### `multiplayer_test`

`clients` (1 to 8), `timeout?` (120 s).

```call
multiplayer_test {"clients":3}
```

### `playtest_stop`

No arguments. `{stopped, running, note?}`.

```call
playtest_stop {}
```

### `playtest_status`

No arguments. `{running, mode?, contexts, clients?, players?, lastResult?, lastError?, note?}`.

```call
playtest_status {}
```

### `playtest_scenario`

`source`, `args?`, `timeout?` (60 s, at most 600), `client?`. Returns the report.

```call
playtest_scenario {"source":"T.step('ok', function() T.equal(1 + 1, 2) end)"}
```

### `output_read`

`since?`, `level?`, `limit?`, `contains?`, `client?`. Returns `{context, entries, next, lastSeq, oldestSeq, truncated, missed}`.

```call
output_read {"level":"error","limit":20}
```

### `profile_scripts`

`duration?`, `frequency?`, `top?`, `client?`. See [perf](perf.md).

```call
profile_scripts {"duration":5}
```

### `perf_stats`

`sample?`. See [perf](perf.md).

```call
perf_stats {"sample":1}
```

## rolink: editor actions

See [editor-tools](editor-tools.md).

### `align`

`paths`, `axis`, `to`, `relativeTo?`, `value?`.

```call
align {"paths":"@selection","axis":"y","to":"min"}
```

### `distribute`

`paths`, `axis`, `spacing?`.

```call
distribute {"paths":"@selection","axis":"x","spacing":2}
```

### `weld_model`

`path`, `root?`, `unanchor?`. See [welds-constraints](welds-constraints.md).

```call
weld_model {"path":"Workspace/Cart","root":"Base"}
```

### `set_collision_groups`

`register?`, `rules?`, `assign?`.

```call
set_collision_groups {"register":["Props"],"rules":[{"a":"Props","b":"Props","collide":false}]}
```

### `script_outline`

`path`. Returns `{path,class,lines,functions,locals,services,requires}`.

```call
script_outline {"path":"ServerScriptService/Main"}
```

### `script_search`

`query`, `root?`, `pattern?`, `caseSensitive?`, `limit?`.

```call
script_search {"query":"PlayerAdded","root":"ServerScriptService"}
```

### `script_diagnostics`

`path?` (string or array, default every script). Returns `{available,checked,withErrors,diagnostics,note}`.

```call
script_diagnostics {"path":"ServerScriptService"}
```

### `generate_model`

`prompt?`, `image?`, `name?`, `parent?`, `at?`, `size?`, `maxTriangles?`, `textures?`, `parts?`, `predefined?`.

```call
generate_model {"prompt":"a stone well"}
```

## rolink-publish

These tools have no `place` or `context` arguments, and results come as an optional summary followed by JSON. See [publishing-assets](publishing-assets.md) and [publishing-places-datastores](publishing-places-datastores.md).

### `prepare_asset`

`path`, `kind` (`audio`, `image`, `animation`), `name`, `universeId?`, `description?`, `target?` `{path, property?, class?, place?}`. Uploads nothing.

```call
prepare_asset {"path":"D:/art/logo.png","kind":"image","name":"Logo","target":{"path":"StarterGui/Menu/Logo","class":"ImageLabel","property":"Image"}}
```

### `publish_asset`

`prepareId`, `confirmation` (exactly what the user typed).

```call
publish_asset {"prepareId":"11111111-1111-1111-1111-111111111111","confirmation":"I agree to publish images"}
```

### `publish_animation`

`prepareId`, `confirmation`.

```call
publish_animation {"prepareId":"22222222-2222-2222-2222-222222222222","confirmation":"I agree to publish animations"}
```

### `publish_status`

`prepareId?`. Returns `{queue:[...]}`.

```call
publish_status {}
```

### `asset_quota`

`userId?`, `assetType?`, `quotaType?`.

```call
asset_quota {"assetType":"Audio"}
```

### `place_save`

`universeId`, `placeId`, `file`. No dialog.

```call
place_save {"universeId":1000,"placeId":2000,"file":"D:/work/game.rbxl"}
```

### `place_publish`

`universeId`, `placeId`, `file`. Native dialog.

```call
place_publish {"universeId":1000,"placeId":2000,"file":"D:/work/game.rbxlx"}
```

### `server_restart`

`universeId`. Native dialog.

```call
server_restart {"universeId":1000}
```

### `datastore_list`

`universeId`, `store?`, `scope?`, `prefix?`, `limit?`, `pageToken?`.

```call
datastore_list {"universeId":1000,"store":"PlayerData"}
```

### `datastore_get`

`universeId`, `store`, `key`, `scope?`.

```call
datastore_get {"universeId":1000,"store":"PlayerData","key":"user_1"}
```

### `datastore_set`

`universeId`, `store`, `key`, `value`, `scope?`, `users?`, `attributes?`, `create?`. Native dialog.

```call
datastore_set {"universeId":1000,"store":"PlayerData","key":"user_1","value":{"coins":5}}
```

### `datastore_delete`

`universeId`, `store`, `key`, `scope?`. Native dialog.

```call
datastore_delete {"universeId":1000,"store":"PlayerData","key":"user_1"}
```
