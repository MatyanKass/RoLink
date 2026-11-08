# Troubleshooting

> Symptom, cause and fix for connection, mirror, build, test, screenshot and publishing problems.

## When to use

Something did not work. Search this topic for the error text.

## Connection

| Symptom | Cause | Fix |
|---|---|---|
| `Roblox Studio is not connected` | No place open, plugin not installed or off | Open a place. Check the RoLink toolbar button, press **Connect** |
| Panel says `Waiting for RoLink server on port 34872` | Server not running, or different port | Start the MCP client. Check `ROLINK_PORT` and the plugin's `RoLinkPort` |
| `No edit session for place "X"` | `place` does not match | Call `status` for the names |
| `port 34872 is busy and not a RoLink server` | Another program has the port | Set `ROLINK_PORT` on server and plugin |
| `DUPLICATE of a live session` in `status` | Place open twice, or a program posing as Studio | Close the extra one. If you did not open it twice, investigate |
| `rejected our token` | Port owned by another user's server | Stop that process |
| `Studio did not answer "op" within Ns` | Studio busy or stalled | Wait. The work may still finish, so check before retrying |
| `Studio session closed` during a command | Studio closed or reloaded | Reconnect and check state |
| HTTP prompt keeps blocking | Permission denied earlier | Allow it in Studio's Plugin Management, then reopen the place |
| Writing scripts fails | Script injection permission denied | Allow it in Plugin Management |
| `could not load class table` in the panel | API dump unavailable | Give the server internet once, then reconnect |

## Mirror

| Symptom | Cause | Fix |
|---|---|---|
| `is not empty and is not a RoLink mirror` | Wrong `dir` | Use a new or empty folder |
| An edit does not show up | Rejected | Read `_errors.log` |
| `Position` key vanished on a part | Expected: placement is in `CFrame` | [mirror-basics](mirror-basics.md) |
| `mirror_start refused: the Roblox API dump` | No cached dump and the download failed | Check the network and try again |
| `batch would destroy N instances` | Delete guard | Use the `delete` tool |
| `the service directory ... was removed` | A service folder deleted | Restored automatically, nothing applied |
| `unknown key "x"` | Lowercase property | Properties are PascalCase |
| `"children" is not allowed in _props.json` | Children in a folder's props | Create files instead |
| `every child needs "name" and "class"` | Incomplete entry | Add both |
| `"X" already exists; "csg" only applies...` | `csg` on an existing name | Remove the key or use a new name |
| `owner "X" not found in the model` | Sub-file for a missing part | Add the part first, or fix the name |
| `UnionOperation needs a "csg" recipe` | Hand-written union | Add `csg` |
| `cannot create class 'X'` | Not creatable or misspelled | Check the class name |
| A second instance appeared | A folder made for an existing loose instance | Delete the extra. See [mirror-basics](mirror-basics.md) |
| Disk edits lost | Studio reconnected | Studio wins on reconnect |
| `mirror and sync cannot run on the same content` | Overlapping services | Stop one |
| `a mirror is already running` | One at a time | `mirror_stop` |

## Build and set

| Symptom | Cause | Fix |
|---|---|---|
| Warning `has no property 'x' (did you mean ...)` | Misspelled property | Use the suggestion |
| Warning `bad Material value` | Wrong enum name | The message lists options |
| Part at the origin | `CFrame` used as a key on a build node | Use `at`, `rot` or `cf` |
| Object falls in a test | `Anchored` false | Check parts |
| Object frozen in a test | `Anchored` true | Unanchor the moving parts |
| `not found: <path>` | Wrong path | Check with `tree`. Names are case-sensitive |
| `refusing to delete a service` | Target is a service | Delete its children |
| `not undoable` in a result | Recording refused, usually in a test | Expected in tests |
| Reference not applied | Path wrong for the route | See [property-types](property-types.md) |
| Grey faces inside a hole | Tool colours | See [unions-csg](unions-csg.md) |

## Run and scenarios

| Symptom | Cause | Fix |
|---|---|---|
| `compile error: ...` | Luau syntax | Fix the code |
| `run timed out` | Exceeded `timeout` | Raise `timeout` or fix the loop. The changes were rolled back |
| `A play-test is already running` | One at a time | `playtest_stop` |
| `Could not start a play-test` | Studio refused | Ask the user to press Play, then poll `playtest_status` |
| `did not connect within` | Plugin not loading in tests | Check `RoLinkPlayConnect`, check Studio |
| `no player within` | Mode `run` | Use mode `play` |
| `There is no client N` | Fewer clients joined | `playtest_status` |
| `No client context is connected` | Mode `run` or still joining | Use `play`, or wait |
| Code change has no effect in a test | Edited while running | Stop and restart |
| `T.waitFor timed out ... (last error: ...)` | Bug in the predicate | Read the last error |

## Screenshot

| Symptom | Cause | Fix |
|---|---|---|
| `Screenshots are only supported on Windows` | Other OS | Use `get` and `find` to reason about layout |
| `Studio window not found` | Studio not visible | Bring it up |
| `viewport markers not found` | Something covers a corner of the viewport | The whole window is returned. Close overlays |
| Empty or black picture | Window covered, or a GPU capture limit | Keep Studio visible and uncovered |
| `targets have no spatial bounds` | Target has no parts | Choose a part or model |

## Import

| Symptom | Cause | Fix |
|---|---|---|
| `.fbx can only be imported via upload mode` | No key | Set the key, or convert to `.glb` |
| Parts lost after reopening | Preview mode | Use upload |
| Inside-out model | Winding | `flipFaces:true` |
| `Draco/meshopt-compressed files are not supported` | Compressed glTF | Export without compression |
| `uploaded but could not be inserted` | In moderation | Retry later with the asset id in the message |

## Publishing

| Symptom | Cause | Fix |
|---|---|---|
| `Confirmation phrase does not match` | Wrong text | Show the summary, wait for the user |
| `prepareId was already used` | One use only | Prepare again |
| `The file changed` | Edited after prepare | Prepare again |
| `Not confirmed: the dialog...` | User said No, or it timed out | Respect it, ask if they want to retry |
| `no confirmation dialog is available` | Linux without zenity or kdialog | Install one |
| Refused with a permission name | Key scope | Add that permission |
| Asset silent or invisible in the game | No experience access, or moderation | `publish_status`, check `grant` |
| Placeholder never filled | Studio closed or wrong place | It retries, and stays tied to its original place |

## When nothing here helps

1. `status`, `mirror_status`, `sync_status`.
2. The plugin panel's log.
3. The MCP server's stderr, where every line starts with `[rolink]`.
4. Search this guide: `guide({search:"<error text>"})`.
