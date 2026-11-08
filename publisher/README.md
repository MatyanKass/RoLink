# rolink-publish

A separate MCP server that publishes sounds, images and places to Roblox from your own account through Open Cloud. It connects to a running RoLink server over `/rpc` to create placeholders. Confirmations for live changes are native windows opened by this process.

Your API key stays in this process. It is sent only to `apis.roblox.com` in the `x-api-key` header, is scrubbed from logs and results, and is never passed to RoLink or the Studio plugin.

## Your responsibility

**You are responsible for holding the rights to everything published through this tool, including anything an agent picked for you.** Roblox can remove assets and penalise your account, and copyright holders can file strikes. An automatic copyright check that finds nothing does not mean a sound is free of copyright.

## Setup

```
cd publisher
npm install
npm run build
```

Register it in your MCP client, for example in Claude Code:

```
claude mcp add rolink-publish \
  -e ROBLOX_PUBLISH_API_KEY=your-key \
  -e ROBLOX_CREATOR_USER_ID=your-user-id \
  -- node /absolute/path/to/RoLink/publisher/dist/index.js
```

Or in a JSON config:

```json
{
  "mcpServers": {
    "rolink-publish": {
      "command": "node",
      "args": ["/absolute/path/to/RoLink/publisher/dist/index.js"],
      "env": { "ROBLOX_PUBLISH_API_KEY": "your-key", "ROBLOX_CREATOR_USER_ID": "your-user-id" }
    }
  }
}
```

| Variable | Purpose |
| --- | --- |
| `ROBLOX_PUBLISH_API_KEY` | Open Cloud key. Required to publish. |
| `ROBLOX_CREATOR_USER_ID` or `ROBLOX_CREATOR_GROUP_ID` | Who owns uploaded assets. If both are set, the group is used. |
| `AUDD_API_TOKEN` | Optional: copyright check through AudD. |
| `ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET` | Optional: copyright check through ACRCloud. |
| `ROBLOX_UNIVERSE_ID` | Optional: experience that gets Use access to uploads (see below). |
| `ROLINK_PORT` | RoLink's port, if not the default 34872. |
| `ROLINK_PUBLISH_STATE_DIR` | Overrides where the queue is stored. |

The queue lives in `%APPDATA%\RoLink\publisher` on Windows, `~/Library/Application Support/RoLink/publisher` on macOS, and `$XDG_CONFIG_HOME/rolink/publisher` (or `~/.config/rolink/publisher`) on Linux.

### Minimum key permissions

Create the key at [Creator Dashboard > Open Cloud > API Keys](https://create.roblox.com/dashboard/credentials), and give it only what you use:

| You want | Add to the key |
| --- | --- |
| Sounds and images | **assets**: Read and Write (`asset:read`, `asset:write`) |
| `place_save` / `place_publish` | **universe-places**: Write (`universe-places:write`), **only for the one experience** you want to publish. Leave it out if you do not want this. |
| Experience access after upload | **asset-permissions**: Write (`asset-permissions:write`). Without it uploads still work, and `publish_status` reports the failed grant. |
| `asset_quota` | **assets**: Read (`asset:read`) |
| `server_restart` | **universe**: Write (`universe:write`), only for that experience |
| `datastore_list` | `universe-datastores.control:list` for the list of stores, `universe-datastores.objects:list` for keys |
| `datastore_get` | `universe-datastores.objects:read` |
| `datastore_set` | `universe-datastores.objects:read` and `universe-datastores.objects:update` (the entry is read first) |
| `datastore_delete` | `universe-datastores.objects:read` and `universe-datastores.objects:delete` |

If a permission is missing, the tool's error names it.

A leaked key with place permission can overwrite that experience, so keep it out of keys that do not need it. A key made under your personal account cannot manage group assets.

Be careful which experiences you select for **assets** Write as well. Roblox's current [place publishing guide](https://create.roblox.com/docs/cloud/guides/usage-place-publishing) documents publishing a place through the Assets API using that permission on the selected game. This server does not use that route, but a leaked key could.

`place_save` and `place_publish` call `POST /universes/v1/{universeId}/places/{placeId}/versions` with `versionType`, which is still in the [API reference](https://create.roblox.com/docs/cloud/reference/features/places.md).

## Tools

| Tool | What it does |
| --- | --- |
| `prepare_asset {path, kind, name, description?, target?}` | Validates the file, computes SHA-256, runs the copyright check, returns a `prepareId`, a summary and the exact phrase. Uploads nothing. |
| `publish_asset {prepareId, confirmation}` | Uploads if the phrase matches and the file has not changed. Each `prepareId` works once. |
| `publish_animation {prepareId, confirmation}` | Same as `publish_asset`, for a `kind: "animation"` prepare of a binary `.rbxm`. |
| `publish_status {prepareId?}` | Lists the queue: moderation state, placeholder state, experience access, rejection reason. |
| `asset_quota {userId?, assetType?, quotaType?}` | Reads usage, capacity and remaining count from Roblox. Roblox documents this per user. |
| `place_save {universeId, placeId, file}` | Uploads a new Saved version. Players do not get it. No confirmation. |
| `place_publish {universeId, placeId, file}` | Uploads and publishes after a Yes in the native dialog. |
| `server_restart {universeId}` | Restarts servers on an older place version, after a Yes in the native dialog. |
| `datastore_list {universeId, store?, scope?, prefix?, limit?, pageToken?}` | Lists data stores, or the keys in one. No confirmation. |
| `datastore_get {universeId, store, key, scope?}` | Reads one entry. No confirmation. |
| `datastore_set {universeId, store, key, value, scope?, users?, attributes?, create?}` | Writes one entry after a Yes in the native dialog showing the current and new value. |
| `datastore_delete {universeId, store, key, scope?}` | Deletes one entry after a Yes in the native dialog. There is no bulk delete tool. |

There is deliberately **no tool that changes experience privacy or makes a game public**.

### Experience access

Roblox can refuse to play an asset in an experience that has no permission to use it. After an upload is accepted, this server grants the experience **Use** access through the asset-permissions API. The experience is, in order: `universeId` passed to `prepare_asset`, `ROBLOX_UNIVERSE_ID`, or the published experience open in Studio. The summary names it before you agree. A rejected asset is not granted; a rate-limited grant is retried in the background.

### Data stores

Open Cloud's v2 update has no partial update and clears fields left out of the request. `datastore_set` guards against that by reading the entry first and sending its `users` and `attributes` again unless you pass your own; `value` is always the whole new value. It refuses if the entry changed while the dialog was open, and a key containing `@` is refused for writes because it addresses a revision.

### Confirmation phrases

| Asset | Phrase |
| --- | --- |
| Sound | `Я согласен на публикацию звуков` or `I agree to publish sounds` |
| Image | `Я согласен на публикацию картинок` or `I agree to publish images` |
| Animation | `Я согласен на публикацию анимаций` or `I agree to publish animations` |
| Sound matching a known track | `Я подтверждаю публикацию: <title>` or `I confirm publishing: <title>` |

**The phrase is a soft agreement, not a security boundary.** Tool descriptions tell the agent to show you the summary and wait for you to type it, but the server cannot tell who typed the text: an agent could type the phrase itself. It stops mistakes and makes the decision explicit, nothing more.

### The native dialog

**The native dialog is the only real gate.** `place_publish`, `server_restart`, `datastore_set` and `datastore_delete` open a modal window on this computer and act only on an explicit Yes. No is the default button; closing the window, the 120-second timeout or any error all count as No. It does not need Studio, and it does not go through RoLink's `/rpc` or the plugin, so a fake plugin session or code running in Studio cannot answer it.

| System | Dialog |
| --- | --- |
| Windows | Windows Forms window through `powershell.exe`, always on top |
| macOS | `osascript` |
| Linux | `zenity`, or `kdialog` if zenity is missing. With neither, these tools refuse with an error; they never proceed without asking. |

Names and values from the game are untrusted, so they reach the dialog as data, never as part of a command, and control, bidirectional and zero-width characters are removed and lengths capped in what you see. Read the target in the window before clicking Yes. Only one dialog can be open at a time. `place_save` has no dialog: it does not reach players.

**The remaining limit:** an agent with full shell access to your user account can still read the API key and call Roblox directly, or script a click on the window, because it runs as you. The dialog stops a confined agent, not your own account. The key's scopes are the last line: give it only the permissions and experiences you need.

A failed upload still spends its `prepareId`, because the outcome of a failed request can be unclear. Call `prepare_asset` again to retry.

### Copyright check

Set AudD or ACRCloud keys to enable it. With a provider configured, your audio is sent to that third party during `prepare_asset`. If several are configured they run in order and the first match wins.

- No provider configured, or images: the summary says the check **did not run**.
- Provider failed: the summary says the check did not run, with the reason.
- No match: reported as no match, with a reminder that this does not mean there is no copyright.
- Match: the summary warns that the sound is copyrighted and may lead to a strike, names the track and artist, and the normal phrase stops working. Only the phrase naming the title publishes it.

Files larger than a provider's sample limit (AudD 10 MB, ACRCloud 5 MB) are checked from the start only, and the summary says so.

### Placeholders while moderation runs

Pass `target` to `prepare_asset` to have the asset applied automatically:

```json
{ "path": "Workspace/Music/Theme" }
{ "path": "Workspace/Wall/Poster", "class": "Decal" }
{ "path": "StarterGui/Menu/Logo", "class": "ImageLabel", "property": "Image" }
```

Defaults are `Sound.SoundId` for audio and `Decal.Texture` for images. The parent must already exist.

Right after the upload is accepted, the instance is created if missing, with an empty id and the attribute `RoLinkPendingAsset`. An instance that already exists keeps its current id until the new one is approved. A background poller then:

- on approval, sets `rbxassetid://<id>` and removes the attribute;
- on rejection, keeps the placeholder and records the reason (see `publish_status`);
- if Studio is closed, waits and retries when it connects, including after this server restarts.

An entry stays tied to the place it started in, so a different open place is never modified.

### Limits

Checked locally before anything is uploaded, from the [Assets usage guide](https://create.roblox.com/docs/cloud/guides/usage-assets#supported-asset-types-and-limits):

| | Formats | Limits |
| --- | --- | --- |
| Audio | `.mp3` `.ogg` `.wav` `.flac` | 20 MB, 7 minutes; the upload allowance depends on the account (see below) |
| Image | `.png` `.jpeg` `.bmp` `.tga` | 20 MB, smaller than 8000x8000 |

Names are limited to 50 characters and descriptions to 1000. The audio upload allowance depends on the Roblox account, and Roblox's own documentation gives conflicting numbers, so this server does not check or state one: when an upload is over the allowance, the error Roblox returns is what you see. When Roblox refuses for quota or rate-limit reasons, the error shows Roblox's reason and says you may need to upload the file yourself in Creator Hub or the Studio Asset Manager. This server never drives a browser.

## Getting a place file

A Studio plugin cannot write a `.rbxl`: `PluginManager:ExportPlace` writes `.obj` geometry, and `SerializationService` serialises instances rather than a whole place. So you need to save the file yourself first, then pass its path as `file`:

1. In Studio choose **File > Save to File As** and save a `.rbxl` or `.rbxlx`.
2. Call `place_save` or `place_publish` with that path.

Save again before each upload, since the file is what gets sent, not the open session.

Roblox's place publishing guide says this API does not update `EditableImage`, `EditableMesh`, `PartOperation`, `SurfaceAppearance` or `BaseWrap` instances. If your place uses them, publish from Studio after changing them.

## Development

```
npm run typecheck
npm test
```

Tests use a fake Open Cloud and a real local HTTP stand-in for RoLink's `/rpc`; nothing talks to Roblox, and no real dialog is opened.
