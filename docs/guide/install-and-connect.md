# Install and connect

> Build the plugin and servers, register them in an MCP client, and get Studio connected.

## When to use

`status` says no Studio is connected, or RoLink is not set up yet.

## Requirements

- Node.js 20 or newer.
- Roblox Studio. Windows is the most complete platform: `screenshot` is Windows-only, and `plugin/build.mjs --install` needs `LOCALAPPDATA`.
- Internet access on the first server start, to download the Roblox API dump (see below).

## Build

From the repository root:

```bash
cd server
npm install
npm run build
cd ..
node plugin/build.mjs --install
```

`npm run build` compiles the server and copies `docs/` into `server/dist/docs`, which is where the `guide` tool reads from.

`node plugin/build.mjs` writes `plugin/dist/RoLink.rbxmx`. With `--install` it also copies that file to `%LOCALAPPDATA%\Roblox\Plugins`. On macOS, skip `--install` and copy the file to `~/Documents/Roblox/Plugins` yourself. Restart Studio or reopen the place after installing.

Optional publisher:

```bash
cd publisher
npm install
npm run build
```

## Register the MCP servers

Use absolute paths. Claude Code:

```bash
claude mcp add rolink -- node /absolute/path/to/RoLink/server/dist/index.js
```

Any client with a JSON config (Claude Desktop, Cursor and others):

```json
{
  "mcpServers": {
    "rolink": {
      "command": "node",
      "args": ["/absolute/path/to/RoLink/server/dist/index.js"]
    }
  }
}
```

RoLink is a local stdio server. A client that only accepts remote HTTP MCP servers needs a stdio-to-HTTP bridge, which this project does not provide.

### Environment of the `rolink` server

| Variable | Purpose |
|---|---|
| `ROLINK_PORT` | Bridge port, default `34872` |
| `ROBLOX_API_KEY` | Open Cloud key. Needed for `import_model` upload mode (`asset:read`, `asset:write`) and for full `toolbox_search` (`creator-store-product:read`) |
| `ROBLOX_CREATOR_USER_ID` or `ROBLOX_CREATOR_GROUP_ID` | Owner of models uploaded by `import_model` |

The publisher's variables are in [publishing-assets](publishing-assets.md).

## Connect Studio

1. Open a place in Studio.
2. The plugin connects by itself. The first time, Studio may ask to allow HTTP access to `127.0.0.1` and script injection for this plugin. Allow both. Without script injection, writing script `Source` fails.
3. The toolbar has a **RoLink** button that opens a panel with status, a **Connect**/**Disconnect** button and a command log.
4. Call `status`:

```call
status {}
```

A healthy result looks like this:

```text
RoLink bridge on port 34872.
• MyPlace [edit] placeId=0 plugin v0.1.0 (last poll 3s ago)
Sync: off
Mirror: off
```

**Disconnect** is remembered (`RoLinkAutoConnect`). After using it, the plugin stays off until you press **Connect**.

## The API dump

The server downloads `API-Dump.json` from the public Roblox client tracker on GitHub and caches it in `server/cache/` for 7 days. If a download fails it uses the cached copy. The plugin fetches a compact class table from the server when it connects.

With neither a download nor a cache, the plugin logs `warning: could not load class table from server` and keeps working in a degraded way: mirror files carry almost no properties, and `inspect` shows no generic properties. Restore internet access, restart the server, then reconnect the plugin.

## Several clients at once

The first `rolink` process takes the port and owns the bridge. Later processes detect it and forward each tool call to the owner over `POST /rpc`, using a token stored in `rolink-<port>.token` in the user's temp folder. If the owner exits, the next call takes the port over.

`npm run serve` in `server/` runs a bridge-only process with no stdio MCP, so the bridge outlives any one client.

## Changing the port

Set `ROLINK_PORT` for the server. The plugin reads its own stored setting `RoLinkPort` and has no UI for it. While still connected on the old port you can write the setting, and it takes effect when the plugin reloads:

```call
run {"code":"plugin:SetSetting('RoLinkPort', 35000)"}
```

Then set `ROLINK_PORT=35000` for every server, including `rolink-publish`, and reopen the place.

## Several Studios

Each open place is its own session. Commands go to the most recently connected edit session unless you pass `place` (a substring of the place name, or the exact place id). A second session for the same published place is held back as a duplicate and receives no commands. See [security-and-trust](security-and-trust.md).

```call
tree {"place":"Lobby","path":"Workspace"}
```

## Gotchas

- The plugin talks to `127.0.0.1` only. A server on another machine cannot be used.
- Play-test DataModels connect too, unless the plugin setting `RoLinkPlayConnect` is `false`.
- If port 34872 is held by something that is not RoLink, the server logs a message and every tool call fails. Set `ROLINK_PORT`.
- More in [troubleshooting](troubleshooting.md).
