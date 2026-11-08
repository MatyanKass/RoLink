# Limits and known gaps

> An honest list of what RoLink cannot do, what is unverified, and known defects with workarounds.

## When to use

Before promising something, or when a workaround seems necessary.

## Verification status

The code is tested with automated mocks: a mock Studio plugin, a Lune harness simulating Roblox instances, fake Open Cloud, and fake dialogs. **Real Roblox Studio and the live Open Cloud API have not been verified end to end.** Treat a behaviour that depends on real Studio as likely, not proven, particularly:

- `playtest_start` and `multiplayer_test` through `StudioTestService`;
- `profile_scripts`;
- `generate_model`, which Roblox's docs do not confirm for plugins;
- mesh loading by id;
- CSG through `GeometryService`;
- publishing animations with a KeyframeSequence root;
- the screenshot crop on unusual layouts.

## What Roblox does not let a plugin do

| Action | Status |
|---|---|
| Publish or save the place from the plugin | Not available. A person saves a `.rbxl`, then `place_publish` uploads it |
| Inject real keyboard, mouse, touch or gamepad input | Not available |
| Hear audio, or see a running client from inside | Assert state instead. Screenshots show Studio's window |
| Read Studio's Script Analysis (lints, types) | Not available. `script_diagnostics` finds syntax errors only |
| Change device emulation | Not available |
| Drive the Studio debugger or MicroProfiler | Not available |
| Use the Animation Editor, Terrain Editor brushes, Material Generator UI | No API. Terrain's results can be reproduced with voxel calls |
| Write `MeshPart.MeshId` on an existing part | Not available. Create a new part |
| Undo during a play-test | Not available |
| Change experience settings | No tool here |

## What RoLink deliberately does not do

- Change experience privacy or make a game public.
- Drive a browser.
- Bypass the native dialog or type a confirmation phrase.
- Choose a license or check rights for you.

## Platform limits

- `screenshot` is Windows-only.
- `plugin/build.mjs --install` needs `LOCALAPPDATA`. Copy by hand elsewhere.
- Native dialog on Linux needs `zenity` or `kdialog`.

## Mirror gaps

| Gap | Workaround |
|---|---|
| `MaterialVariant` and other properties outside the class table do not appear | `get`, `set` |
| Script `Enabled`, `RunContext`, attributes and tags are not in files | `set` |
| Terrain voxels are not mirrored | `terrain` |
| Edits on disk while Studio is disconnected are lost | Stop editing until reconnected |
| Bulk deletes are refused | `delete` |
| Identity lasts only for this plugin session | Re-start after reloading |
| A mirror or sync stays with the Studio it started on, through reconnects. If that Studio closes, it does not move to another one, even for the same place | `mirror_stop` or `sync_stop`, then start again |

## Known defects

These are real behaviours in the current code. A later version may fix them, so test before relying on a workaround.

| Defect | Effect | Workaround |
|---|---|---|
| `export {keepPosition:false}` removes only `origin` | A root Part keeps its `cf` | Wrap in a Model, or `move` after import |

## Size limits at a glance

| Thing | Limit |
|---|---|
| Build | 50,000 instances per call |
| Result or event from Studio | 256 MB, 1000 chunks of at most about 700 KB |
| `run` output | 500 lines |
| Output ring | 3000 lines per context, 8000 characters per line |
| Scenario | 600 s, 300 report logs |
| `playtest_start` wait | 300 s |
| Multiplayer | 8 clients |
| Profile | 60 s |
| Mirror | 25 destroyed per batch by default, 100 cap, 100 per 60 s |
| Import preview | 50 MB, 1,000,000 triangles |
| Asset upload | 20 MB per file |
| Instance name | 100 characters from a file |
| Screenshot | 2560 px wide |
