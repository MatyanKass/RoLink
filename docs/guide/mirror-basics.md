# Mirror basics

> Work on the whole place through ordinary files: layout, everyday edits, and how to check they landed.

## When to use

For nearly all looking and editing. The mirror turns the place into a folder of files you read and edit with normal file tools. For exact grammar see [mirror-reference](mirror-reference.md).

Use a tool instead for: bulk deletes, terrain voxels, a script's `Enabled` flag, the first script in `StarterPlayerScripts`, and reading `Position` or `Rotation`.

## Start and stop

```call
mirror_start {"dir":"D:/work/my-place-mirror"}

mirror_status {}

mirror_stop {}
```

`dir` must be new, empty, or an earlier mirror. A folder with other content is refused. Starting on an earlier mirror moves its old files to `.rolink-trash/` and writes a fresh copy from Studio.

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

## Gotchas

**`Position`, `Rotation` and `Orientation` never appear in mirror files, on any class.** This includes `GuiObject.Position`, `GuiObject.Rotation`, `UIGradient.Rotation`, `ParticleEmitter.Rotation` and `AlignPosition.Position`. You may set them in a file. They apply, and then the key vanishes when the file is rewritten. To read them:

```call
get {"path":"StarterGui/Hud/Panel","props":["Position","Rotation"]}
```

**A folder for a new instance cannot adopt an existing one.** `Lamp.Part/` next to an existing `Lamp.Part.json` makes a second part. To add a script to an existing loose part or to `StarterPlayerScripts` while it has none, use `build` with `parent`. After that the directory exists and you can use files:

```call
build {"parent":"StarterPlayer/StarterPlayerScripts","items":[{"class":"LocalScript","name":"Hud","source":"print('hi')"}]}
```

`StarterPlayerScripts` and `StarterCharacterScripts` are not creatable, so a hand-made directory for them ends in `_errors.log`.

**Not everything is in the files.** Terrain voxels, the children of Terrain such as `Clouds`, `Archivable=false` instances, players and characters, and script properties other than source are absent. See [mirror-reference](mirror-reference.md).

**Reconnecting overwrites disk.** If Studio disconnects, disk edits made meanwhile are lost when it comes back, because Studio is the source of truth.

**Names are case-insensitive on disk.** `wall` and `Wall` under one parent get the suffix `~2`.

**Do not copy an entry to duplicate it blindly.** Copies lose `Position` and, for MeshParts, `MeshId`, since the files do not hold them.
