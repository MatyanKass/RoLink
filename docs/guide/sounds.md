# Sounds

> Sound instances, placement, effects, autoplay, uploading audio, and checking playback.

## When to use

Music, ambience and sound effects.

## Placement decides how it plays

| Parent | Result |
|---|---|
| A BasePart or Attachment | 3D, fades with distance |
| `SoundService`, `Workspace` or a GUI | 2D, heard everywhere |

## Files

3D on a part of a model:

```json file=Workspace/Radio.model/Box.Sound.json
{"name":"Music","SoundId":"rbxassetid://123","Volume":0.6,"Looped":true,"Playing":true,"RollOffMaxDistance":60,"RollOffMode":"InverseTapered"}
```

2D in SoundService:

```json file=SoundService/Theme.Sound.json
{"SoundId":"rbxassetid://123","Volume":0.4,"Looped":true}
```

With build:

```call
build {"parent":"SoundService","items":[{"class":"Sound","name":"Click","SoundId":"rbxassetid://123","Volume":0.5}]}
```

## Properties

`SoundId`, `Volume` (0 to 10), `PlaybackSpeed`, `Looped`, `Playing`, `PlayOnRemove`, `RollOffMinDistance`, `RollOffMaxDistance`, `RollOffMode` (Inverse, Linear, LinearSquare, InverseTapered), `SoundGroup` (a reference), `PlaybackRegion`, `PlaybackRegionsEnabled`, `LoopRegion`, `TimePosition`.

`SoundService` properties live in `SoundService/_props.json`: `AmbientReverb`, `DistanceFactor`, `DopplerScale`, `RolloffScale`.

## Groups and effects

A `SoundGroup` has `Volume`. Effects are children of a Sound or SoundGroup, and live in its `children` list:

```json file=SoundService/Sfx.SoundGroup.json
{"Volume":0.8,"children":[
  {"name":"Echo","class":"EchoSoundEffect","Delay":0.3,"Feedback":0.4,"WetLevel":-6,"DryLevel":0}
]}
```

Effect classes: ReverbSoundEffect, EchoSoundEffect, EqualizerSoundEffect, ChorusSoundEffect, CompressorSoundEffect, DistortionSoundEffect, FlangeSoundEffect, PitchShiftSoundEffect, TremoloSoundEffect.

## Getting a sound id

- Find one with `toolbox_search {"query":"door creak","kind":"audio"}`. Audio search needs `ROBLOX_API_KEY`. Treat third-party rights carefully.
- Upload your own: [publishing-assets](publishing-assets.md). Pass a `target` to have a placeholder Sound created and filled after moderation.

## Playing from a script

```lua
local sound = workspace.Radio.Box.Music
if not sound.IsLoaded then
	sound.Loaded:Wait()
end
sound:Play()
```

`Play`, `Stop`, `Pause`, `Resume`. In edit mode sounds do not play.

## Testing

Sound output cannot be heard by an agent. Assert the state instead:

```lua
T.step("music plays", function()
  local s = workspace.Radio.Box.Music
  T.waitFor(function() return s.IsLoaded end, 10, "sound to load")
  T.assert(s.IsPlaying, "not playing")
end)
```

A sound that fails to load puts an error in Output. Check `output_read {"contains":"sound"}`.

## Gotchas

- An audio id can be refused at runtime if the experience has no permission for it. `rolink-publish` grants Use access after an upload, see [publishing-assets](publishing-assets.md).
- Setting `Playing` in a file has no effect until the game runs.
- `Volume` above 1 is amplification, which is rarely wanted.
