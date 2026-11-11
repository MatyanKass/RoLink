# Plugin internals

> How the bridge, sessions, contexts, command queue, undo, ids and the class table actually work.

## When to use

You need to reason about timing, undo, concurrency, a timeout, or why a command went to a given Studio.

## Transport

A Studio plugin cannot accept connections, so it long-polls the server. Code: `server/src/bridge.ts`, `plugin/src/Main.server.lua`.

| Route | Direction | Purpose |
|---|---|---|
| `POST /plugin/hello` | plugin to server | Registers a session, returns its id |
| `GET /plugin/poll?s=<id>` | plugin to server | Held open up to 15 s, returns queued commands |
| `POST /plugin/result` | plugin to server | Answer to a command, sent in chunks |
| `POST /plugin/event` | plugin to server | Unsolicited events: `mirror_delta`, `source`, `created` |
| `POST /plugin/bye` | plugin to server | Clean disconnect |
| `GET /plugin/api` | plugin to server | The compact class and property table |
| `GET /health` | anyone local | `{rolink, version, sessions}` without session ids |
| `POST /rpc` | other local processes | Runs a tool. Needs the `x-rolink-token` header |

Every request must carry `Host: 127.0.0.1:<port>` or `localhost:<port>`, and must not carry an `Origin` header. That blocks requests from web pages.

| Limit | Value |
|---|---|
| Poll hold | 15 s |
| Session expiry with no poll | 45 s, not while a command is still running in it |
| Default command timeout | 60 s (long operations set their own, see below) |
| Result and large event chunk | about 700 KB, split on UTF-8 boundaries, smaller if JSON re-encoding would pass 960 KB |
| Chunks per result | 1000 |
| Reassembled result | 256 MB |
| Request body | 64 MB |

Command timeouts set by tools: `build` and `import` 180 s, `terrain` 120 s, `run` its `timeout` + 15 s, `playtest_scenario` its `timeout` + 15 s, `export` and `import` of `.rbxm` 120 s, `mesh_build` 300 s, `generate_model` 300 s, `toolbox_insert` 180 s, `perf_stats` 15 s, `script_search` 60 s, `script_diagnostics` 120 s.

A timeout on the server side does not cancel the work in Studio. The plugin may still finish it.

## Sessions and contexts

Each DataModel running the plugin is one session with a context:

| Context | DataModel |
|---|---|
| `edit` | The place you edit |
| `server` | The server side of a running play-test |
| `client` | One client of a running play-test |

`Bridge.pick(context, place)` chooses the newest non-duplicate session of that context. `place` matches a substring of the name, case-insensitive, or the exact place id. A running mirror or sync does not pick again: it is bound to the place id and to its session's line of reconnects through `replaces`, so another Studio cannot receive its commands.

The tool argument `client` (a join-order number) exists only on `playtest_scenario`, `output_read` and `profile_scripts`. Other tools with `context: "client"` go to the newest client.

**Reconnect.** After a failed poll or an HTTP 410 the plugin says `hello` again with `replaces: <old id>`, backing off 1, 2, 4, then 5 s. A reloaded plugin (reinstalled, or Studio reloading plugins) remembers its edit DataModel's last session id too: a random key in a non-archivable `CoreGui.RoLinkIdentity` folder points to it in the plugin's settings, so the reload is the same Studio coming back. A new window or a reopened place gets a new key. On a new edit session the server re-sends the whole sync project and re-dumps the mirror; the mirror then keeps and applies disk edits Studio did not also change, and keeps the disk copy of a real conflict in `.rolink-conflicts/` (see [mirror-basics](mirror-basics.md)).

**Duplicates.** A second live edit session with the same non-zero `placeId` is a duplicate. It gets no commands and its events are ignored, because `/plugin/hello` has no credential. It takes over when the first session closes. Unpublished places all have id 0, so they are never duplicates.

## Command execution

The plugin runs commands from one poll this way:

| Kind | Ops | How |
|---|---|---|
| Queued (default) | Everything else | One worker, strictly in order |
| Immediate | `ping`, `output_read`, `playtest_status`, `playtest_end`, `playtest_request_stop` | Own thread, skips the queue |
| Concurrent | `perf_stats`, `profile_scripts` | Own thread, so a scenario can generate the load being measured |

A long `playtest_scenario` therefore blocks other queued commands for that context, but not `output_read` or `playtest_status`.

## Undo

`Ops.dispatch` wraps these ops in one `ChangeHistoryService` recording named `RoLink: <op>`:

`build`, `set`, `delete`, `clone`, `move`, `run`, `terrain`, `import_rbxm`, `sync`, `mesh_build`, `insert_asset`, `mirror_apply`, `toolbox_insert`, `toolbox_release`, `animation_build`, `align`, `distribute`, `weld_model`, `set_collision_groups`, `generate_model`.

If the handler raises an error, the recording is cancelled and its changes roll back. Tools that report problems as `warnings` have not raised an error, so whatever succeeded stays.

If Studio refuses to record, as during a play-test, the operation still runs and its result carries `warning: "not undoable"`. The `undo` tool itself fails during a play-test.

`set_collision_groups` says so in its own result: registering groups and collision rules may not be undoable, while part assignments are.

Not recorded at all: `camera`, `selection`, `select_and_focus`, the screenshot camera moves, and `import_animation`'s preview.

## Addressing and ids

`plugin/src/Paths.lua`. Ids are small integers handed out per plugin run and held by strong references. An id is cleared when its instance is destroyed, and past 200,000 ids the oldest go first. They are never stored in the place. The mirror uses them as identity.

Resolution order for a segment: child by name, or `Name[n]`, then for the DataModel `GetService(segment)`. The word `workspace` matches case-insensitively at the root.

## The class table

The server compacts the API dump into `{classes:{Name:{super,props:{Prop:type}}}}`. A property is included when all of these hold (`server/src/apidump.ts`):

- it is not ReadOnly, NotScriptable, Deprecated or Hidden;
- it can load from a file, and can also save, unless it is a canonical twin such as `Size` or `Color`;
- read and write security are both `None` or `PluginSecurity`;
- its type is one the codec supports.

Excluded by name: `Parent`, `Name`, `Archivable`, `SourceAssetId`, `Capabilities`, `Sandboxed`.

Consequences you will notice:

| Property | Not in the table because | How to reach it |
|---|---|---|
| `MeshPart.MeshId` | Write security is not plugin-level | Reads with `get` and is shown in mirror files; set only when creating the part |
| `BaseScript.Enabled` | Cannot load from a file | `set` and `get` still work, `BaseScript.Disabled` is the saved form |
| `BasePart.MaterialVariant` | Cannot load from a file | `set` and `get` still work |
| `ImageLabel.ImageContent` and other `Content` type twins | Unsupported type | Use the `ContentId` twin, `Image` |

`set` and `build` also accept a property outside the table if the instance can read it, and then infer the type from the current value.

## Files in plugin/src

| File | Role |
|---|---|
| `Main.server.lua` | Connection loop, worker, UI |
| `Ops.lua` | Command handlers and dispatch |
| `Build.lua` | Build spec to instances, bounds |
| `Serialize.lua` | Instances to build spec (`inspect`, `export`) |
| `Codec.lua` | JSON and Roblox values |
| `Paths.lua` | Addressing and ids |
| `Api.lua` | Class table, "did you mean" hints |
| `Mirror.lua` | Reads instance state, applies mirror ops |
| `Sync.lua` | Applies project files, sends script edits back |
| `View.lua` | Camera framing, screenshot markers |
| `Playtest.lua`, `Scenario.lua`, `Output.lua` | Play-test control, `T` helpers, Output ring |
| `Editor.lua`, `Perf.lua` | Editor actions, profiling |
| `Toolbox.lua`, `MeshImport.lua`, `Animation.lua` | Creator Store, 3D import, animation build |

## Plugin settings

| Setting | Default | Effect |
|---|---|---|
| `RoLinkPort` | 34872 | Bridge port |
| `RoLinkAutoConnect` | on | Set by the Connect and Disconnect button |
| `RoLinkPlayConnect` | on | Whether play-test DataModels connect |
| `RoLinkStopRequest` | off | Internal channel for `playtest_stop` |

## Gotchas

- `run` exposes the real `plugin` object to your code, including `plugin:SetSetting`.
- Attributes and tags RoLink may leave in a place: tag `RoLinkSync`, attributes `RoLinkHash`, `RoLinkPendingAsset`, `RoLinkPreviewImport`, `RoLinkAssetId`, `RoLinkWasEnabled`. Weld instances from `weld_model` are named `RoLinkWeld`.
- The mirror leaves no markers in the place.
