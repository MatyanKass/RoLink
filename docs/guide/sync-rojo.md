# File sync (Rojo-style projects)

> Live sync of a repository using *.project.json: file mapping, two-way scripts, models, limits.

## When to use

Code lives in a Git repository. For working on the whole place use [mirror-basics](mirror-basics.md). The two refuse to run over the same services.

## Start

```call
sync_start {"project":"D:/work/my-game"}

sync_status {}

sync_stop {}
```

`project` is a folder or a `*.project.json` path. In a folder, `rolink.project.json` is preferred, then `default.project.json`, then any `*.project.json`.

The start pushes everything and returns `{syncing, place, items, warnings, created, updated, removed, models, errors}`. Then every file save is pushed. Scripts edited in Studio are written back.

## Project file

```json
{
  "name": "my-game",
  "tree": {
    "$className": "DataModel",
    "ReplicatedStorage": {
      "Shared": {"$path": "src/shared"}
    },
    "ServerScriptService": {
      "Server": {"$path": "src/server"}
    },
    "StarterPlayer": {
      "StarterPlayerScripts": {
        "Client": {"$path": "src/client"}
      }
    },
    "Workspace": {
      "$properties": {"Gravity": 150}
    }
  }
}
```

Keys: `$path`, `$className`, `$properties`. A service mapped straight onto a directory makes the directory's files its children.

## File mapping

| File | Instance |
|---|---|
| `Foo.server.lua(u)` | Script |
| `Foo.client.lua(u)` | LocalScript |
| `Foo.lua(u)` | ModuleScript |
| `dir/` | Folder |
| `dir/init.server.luau`, `init.client.luau`, `init.luau` | The directory becomes that script, with the other files as children |
| `Foo.model.json` | A model: RoLink build spec, or Rojo's `{ClassName, Properties, Children}` |
| `Foo.rbxm` | Binary model, exact copy |
| `Foo.txt` | StringValue |
| `Foo.json` | ModuleScript returning the decoded table |
| `Foo.meta.json` | `{"properties":{...}}` applied to Foo |
| `init.meta.json` | `{"properties":{...},"className":"..."}` for the directory |

Files starting with a dot are skipped.

## Example model file

```json
{"class":"Model","children":[{"name":"Base","size":[8,1,8],"at":[0,0.5,0],"color":"#5A5F66"}]}
```

Models are rebuilt only when the file's content hash changes. It is stored in the attribute `RoLinkHash`.

## Ownership

Everything sync creates is tagged `RoLinkSync`. Only tagged instances are ever deleted by sync, so things built by hand are safe. An untagged instance in the way of a model file gives an error such as `exists and is not synced; not replacing`.

A script created by hand inside a synced folder gets a file automatically, about a second later.

## Two-way behaviour

| Change | Direction | Delay |
|---|---|---|
| File saved | To Studio | about 0.1 s |
| Script edited in Studio | To file | about 0.8 s |
| Script created in Studio under a synced root | New file | about 1 s |

Only script source flows back. Properties or models edited in Studio do not reach the files.

On reconnect the project is pushed again, so files win.

## Sensitive properties

As in the mirror, a project file cannot set `HttpEnabled`, `LoadStringEnabled` and the like. They are dropped with a warning naming them. The list is in [mirror-reference](mirror-reference.md).

## Saving existing models into the project

A relative `file` in `export` and `import` resolves against the project root:

```call
export {"path":"Workspace/Tower","file":"models/Tower.rbxm"}
```

## Differences from Rojo

- No Rojo server or plugin is used. This is RoLink's own implementation of the project format.
- Only the file types above are read. `.toml`, `.csv` and others are ignored.
- Terrain and other binary properties are out of scope.

## Gotchas

- Check `warnings` in the start result for `$path not found`.
- A file renamed on disk is a remove plus a create in Studio.
- A class change replaces the instance when it is synced, a script or a Folder. Otherwise it is an error.
- Saving many files at once is coalesced into one push, one undo step.
