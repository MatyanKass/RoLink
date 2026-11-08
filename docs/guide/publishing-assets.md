# Publishing assets

> Uploading sounds, images and animations with rolink-publish: phrases, placeholders, copyright, quota.

## When to use

A local sound, image or animation file needs a Roblox asset id. These tools belong to the separate `rolink-publish` server.

## Setup

Environment of `rolink-publish`:

| Variable | Purpose |
|---|---|
| `ROBLOX_PUBLISH_API_KEY` | Open Cloud key. Required to publish |
| `ROBLOX_CREATOR_USER_ID` or `ROBLOX_CREATOR_GROUP_ID` | Owner of uploads. The group wins if both are set |
| `ROBLOX_UNIVERSE_ID` | Experience that gets Use access to uploads |
| `AUDD_API_TOKEN` | Optional copyright check |
| `ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET` | Optional copyright check |
| `ROLINK_PORT` | RoLink's port, if not default |
| `ROLINK_PUBLISH_STATE_DIR` | Where the queue is stored |

Key permissions: `asset:read` and `asset:write` for uploads, `asset-permissions:write` for the experience grant. The key stays in this process.

## Responsibility

The user is responsible for holding the rights to everything published, including anything an agent chose. Roblox can remove assets and penalise the account. Say so when it matters.

## The two steps

**Step 1: prepare.** Validates the file and uploads nothing.

```call
prepare_asset {"path":"D:/audio/theme.mp3","kind":"audio","name":"Main Theme","target":{"path":"SoundService/Theme"}}
```

The result has `prepareId`, `summary`, `requiredPhrase`, `acceptedPhrases`, the copyright result, and file facts.

**Step 2: show the summary to the user and wait for them to type the phrase in chat.** Never type, guess or infer the phrase yourself, and do not treat earlier approval as the phrase.

**Step 3: publish**, passing exactly what the user typed.

```call
publish_asset {"prepareId":"11111111-1111-1111-1111-111111111111","confirmation":"I agree to publish sounds"}
```

Each `prepareId` works once, even if the upload fails. The file must not have changed since prepare.

For animations, `prepare_asset` with `kind:"animation"`, and then `publish_animation`.

## Phrases

| Asset | English | Russian |
|---|---|---|
| Sound | `I agree to publish sounds` | `Я согласен на публикацию звуков` |
| Image | `I agree to publish images` | `Я согласен на публикацию картинок` |
| Animation | `I agree to publish animations` | `Я согласен на публикацию анимаций` |
| Sound matching a known track | `I confirm publishing: <title>` | `Я подтверждаю публикацию: <title>` |

The phrase is a soft agreement and not a security boundary, because the server cannot tell who typed it. Honour it anyway.

## File limits

Checked locally before upload.

| Kind | Formats | Limits |
|---|---|---|
| Audio | `.mp3`, `.ogg`, `.wav`, `.flac` | 20 MB, 7 minutes |
| Image | `.png`, `.jpeg`, `.jpg`, `.bmp`, `.tga` | 20 MB, smaller than 8000x8000 |
| Animation | binary `.rbxm` | 20 MB |

`name` up to 50 characters, `description` up to 1000 and defaulting to the name. `path` must be absolute.

## Copyright check

Set AudD or ACRCloud keys to enable it, for audio only. Your audio is sent to that third party during `prepare_asset`.

| Outcome | Meaning |
|---|---|
| Did not run | No provider, a provider failed, or it is an image or animation |
| No match | Reported with a reminder that absence from a database proves nothing |
| Match | The summary warns about a strike risk, names the track, and the normal phrase stops working |

Files over a provider's sample limit (AudD 10 MB, ACRCloud about 5 MB) are checked from the start only.

## Placeholders

`target` applies the asset automatically once moderation approves it:

```json
{"path":"Workspace/Wall/Poster","class":"Decal"}
```

```json
{"path":"StarterGui/Menu/Logo","class":"ImageLabel","property":"Image"}
```

Defaults: `Sound.SoundId` for audio, `Decal.Texture` for images. Allowed pairs: Sound.SoundId, Decal.Texture, Texture.Texture, ImageLabel.Image, ImageButton.Image. `path` is slash-separated with an existing parent. Animations take no target.

After the upload is accepted the instance is created if missing, with an empty id and the attribute `RoLinkPendingAsset`. An existing instance keeps its id until the new one is approved. A background poller (every 15 s) then:

- on approval, sets `rbxassetid://<id>` and removes the attribute;
- on rejection, keeps the placeholder and records the reason;
- if Studio is closed, waits and retries, including after a server restart.

An entry stays tied to the place it started in.

## Status

```call
publish_status {}

publish_status {"prepareId":"11111111-1111-1111-1111-111111111111"}
```

Each entry: `prepareId, kind, name, status, assetId, contentId, reason, lastError, target, place, placeholder, universeId, grant, createdAt, updatedAt`.

`status`: uploading, processing, reviewing, approved, applied, rejected, failed.

## Experience access

An asset can be refused in an experience without permission. After an upload the server grants Use access to, in order: the `universeId` passed to `prepare_asset`, `ROBLOX_UNIVERSE_ID`, or the published experience open in Studio. The summary names it. `grant` in the status shows the outcome.

## Quota

```call
asset_quota {"assetType":"Audio","quotaType":"RateLimitUpload"}
```

Returns `{userId, quotas:[{quotaType,assetType,usage,capacity,remaining,period}], note}`. Roblox documents quotas per user, so a group creator needs `userId`. When an upload is over the allowance, the error shows Roblox's reason, and it may say to upload by hand.

## Gotchas

- `prepare_asset` needs the file on this PC. The upload is of the bytes hashed at prepare time.
- A failed upload spends its `prepareId`. Prepare again.
- The upload for animations has not been exercised against the live API.
- This server never drives a browser.
