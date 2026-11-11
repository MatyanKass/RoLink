# Mirror basics

> Work on the whole place through ordinary files: layout, everyday edits, and how to check they landed.

## When to use

For nearly all looking and editing. The mirror turns the place into a folder of files you read and edit with normal file tools. For exact grammar see [mirror-reference](mirror-reference.md).

Use a tool instead for: bulk deletes, terrain voxels and a script's `Enabled` flag.

## Start and stop

```call
mirror_start {"dir":"D:/work/my-place-mirror"}

mirror_status {}

mirror_stop {}
```

`dir` must be new, empty, or an earlier mirror. Dot-entries such as `.git`, `.gitignore` or `.vscode` do not count, so a fresh git repository is fine. A folder with other content is refused.

Starting on an earlier mirror moves only the files that mirror wrote (listed in `.rolink-mirror.json`) to `.rolink-trash/run-<time>/` and writes a fresh copy from Studio. The last three runs are kept there. Nothing else moves: dot-entries, a `README.md`, your own notes, anything the mirror did not write stays where it is.

### Your own files in the mirror folder

The mirror only ever moves, rewrites or deletes files it wrote itself, on start, on reconnect and when an instance leaves the place.

- At the top level and in dot-folders: ignored entirely.
- Inside a service folder (for example `Workspace/notes.md`): left as they are and listed in `mirror_status` under `foreignFiles`. They are not applied to Studio at start. If you edit one later, it is read like any new file: a mirror file name creates an instance, any other name is logged in `_errors.log` as not a mirror file.
- One sitting exactly where the mirror wants to write an instance's file: kept, listed under `blockedFiles`, and the mirror's own file for that instance is written only after you move or delete yours.

Only one mirror runs at a time. A mirror and `sync_start` refuse to run over the same services.

## What the folder looks like

```text
AGENTS.md                         explains the format, generated
_tree.txt                         compact outline of the place, generated
_errors.log                       rejected edits with reasons, generated
Workspace/
  _props.json                     properties of the service
  Baseplate.Part.json             a loose part
  Map/                            a Folder
  Tower.model/
    model.json                    the model, its parts and their properties
    Open.server.luau              a Script directly in the model
    Door.Open.server.luau         a Script inside part "Door"
    Door.ProximityPrompt.json     a prompt on part "Door"
ReplicatedStorage/
  Util.luau                       a ModuleScript
  Remotes/Buy.RemoteEvent.json    a RemoteEvent
ServerScriptService/Main.server.luau
StarterGui/Hud.gui/gui.json       a ScreenGui and everything inside it
```

Never edit `AGENTS.md`, `_tree.txt` or `_errors.log`. They are regenerated.

## The working loop

1. Edit, create, rename or delete files.
2. Wait about a second.
3. Read `_errors.log`, and re-read the file you changed. The server rewrites it in canonical form.
4. Look at the result with `screenshot`, or test it.

Each batch of file changes that land together is one undo step in Studio.

## Everyday edits

### Change a property

Edit the value and save. Only keys present in the file are applied, so to change one thing you may also write a file holding just that key:

```json file=Workspace/Baseplate.Part.json
{"Color":"#3A7D44","Material":"Grass"}
```

A key you remove from a file is left alone in Studio. It does not reset to the default.

### Add a part to a model

Append an entry to `children` in `model.json`. CFrames are world coordinates.

```json file=Workspace/Tower.model/model.json
{
  "children": [
    {"name":"Roof","class":"Part","CFrame":{"p":[0,20,0]},"Size":[12,1,12],"Color":"#884422","Material":"WoodPlanks"}
  ]
}
```

That example replaces the whole list. **When `children` is present it is the complete list, and anything missing from it is destroyed.** Normally you edit the existing file and keep its entries.

### Move or rotate a whole model

Change `Pivot`, which is in the world frame:

```json file=Workspace/Tower.model/model.json
{"Pivot":{"p":[40,0,10],"r":[0,90,0]}}
```

`Pivot` is applied first, then other properties of the same edit, so a part `CFrame` in the same edit is absolute and wins.

### Add a script

Create the file, and the instance appears:

```lua file=ServerScriptService/Greeter.server.luau
game:GetService("Players").PlayerAdded:Connect(function(player)
	print("hello", player.Name)
end)
```

Suffixes: `.server.luau` is a Script, `.client.luau` a LocalScript, plain `.luau` a ModuleScript. See [scripts](scripts.md).

### Add a loose instance

Create `Name.ClassName.json`. It works for any creatable class:

```json file=ReplicatedStorage/Remotes/Buy.RemoteEvent.json
{}
```

```json file=Workspace/Spawn.SpawnLocation.json
{"CFrame":{"p":[0,1,0]},"Size":[12,1,12],"Neutral":true}
```

### Add a Folder

Make a directory with a plain name.

### Add a model or GUI

Make `Name.model/` with `model.json`, or `Name.gui/` with `gui.json`. Write the files in the same step as the directory. See [models-and-parts](models-and-parts.md) and [gui](gui.md).

### Rename or move

Rename or move the file or directory. Identity is kept, so scripts, welds and references stay intact. A file renamed and edited in the same batch counts as a delete plus a create.

Inside a `children` list, renaming an entry's `name` is a rename as well.

### Delete

Delete the file or directory, or remove the entry from `children`. A batch that would destroy more than 25 instances is refused and the files come back. Use the `delete` tool for bulk deletes.

## How Studio changes come back

Changes made in Studio, by a person or by another tool, reach the files about a quarter of a second later. If you saved a file after the last write RoLink made to it, your edit wins and is applied.

## When Studio does not take an edit

If an edit cannot be applied (Studio reconnecting, closed, or busy), your files stay exactly as you wrote them. Nothing is reloaded over them.

- `mirror_status` lists them under `unappliedEdits`, and every tool result carries `WARNING (mirror): ... NOT in Studio yet` until they land.
- When Studio answers again, the place is reloaded and your edits are applied on top. The next tool result says they reached Studio.
- If Studio changed the same file meanwhile, that is a conflict: Studio's version is written to the file, and yours is kept in `.rolink-conflicts/<time>/<path>`. `mirror_status.conflicts` and a one-time warning name both. Re-apply what you still need.
- If Studio removed or renamed the instance whose file you edited, your edited copy is kept in `.rolink-conflicts/` the same way.
- If Studio refuses the same edit three times while connected, the file is left as you wrote it, listed under `rejectedFiles`, and not retried until you change it.

A mirror stays with the Studio it was started on. If that Studio is gone for good (closed, or a different place opened), the warning says so: copy what you still need from the unapplied files, then `mirror_stop` and `mirror_start` on the open Studio. `mirror_stop` names the edits that never reached Studio.

## Gotchas

**On parts and attachments, placement lives in `CFrame`.** `Position`, `Rotation` and `Orientation` are not written for them, since they are derived from it. On every other class they are ordinary properties: `GuiObject.Position`, `ParticleEmitter.Rotation` and `AlignPosition.Position` appear in the files and can be edited.

**A new directory adopts the instance it names.** `Lamp.Part/` next to `Lamp.Part.json` is the same part, and so is a plain `StarterPlayerScripts/` for the existing service child. Put a script in it, and the single file folds into a `Name.Class/` directory with `_props.json`. A plain name never adopts a script, a Model or a GUI: `Util/` next to `Util.luau` is a new Folder.

**Not everything is in the files.** Terrain voxels, `Archivable=false` instances, players and characters, and script properties other than source are absent. See [mirror-reference](mirror-reference.md).

**Studio wins only real conflicts.** After a reconnect, a file only Studio changed is rewritten, a file only you changed keeps your version and is applied, and a file both changed is a conflict (see above).

**Names are case-insensitive on disk.** `wall` and `Wall` under one parent get the suffix `~2`.

