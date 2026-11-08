# Lighting and atmosphere

> Time of day, ambient light, fog, Atmosphere, Sky, Clouds and post-processing effects, as exact files.

## When to use

Setting the overall look of the world. All of it shows immediately in edit mode.

## Lighting service

`Lighting/_props.json` lists every property of the service, because services have no default to compare with. Edit values in place:

```json file=Lighting/_props.json
{"ClockTime":18.5,"Brightness":2,"Ambient":"#303040","OutdoorAmbient":"#606070","GlobalShadows":true,"EnvironmentDiffuseScale":0.5,"EnvironmentSpecularScale":0.5}
```

Or use a tool:

```call
set {"path":"Lighting","props":{"ClockTime":6.5,"FogColor":"#AABBCC","FogEnd":800}}
```

| Property | Meaning |
|---|---|
| `ClockTime` | Hours as a number, 0 to 24 |
| `TimeOfDay` | The same as `"18:30:00"`. Set one, not both |
| `GeographicLatitude` | Sun path |
| `Brightness`, `ExposureCompensation` | Overall light |
| `Ambient`, `OutdoorAmbient` | Fill colour indoors and outdoors |
| `FogStart`, `FogEnd`, `FogColor` | Classic fog, ignored when an Atmosphere is present |
| `ShadowSoftness`, `GlobalShadows` | Shadows |
| `LightingStyle`, `PrioritizeLightingQuality` | Render style |

`Lighting.Technology` cannot be read or set by a plugin. The server's class table excludes it.

## Atmosphere

```json file=Lighting/Atmosphere.Atmosphere.json
{"Density":0.35,"Offset":0.2,"Color":"#C7D3E0","Decay":"#6A7A90","Glare":0.2,"Haze":1.5}
```

## Sky

```json file=Lighting/Sky.Sky.json
{"SkyboxBk":"rbxassetid://1","SkyboxDn":"rbxassetid://2","SkyboxFt":"rbxassetid://3","SkyboxLf":"rbxassetid://4","SkyboxRt":"rbxassetid://5","SkyboxUp":"rbxassetid://6","SunAngularSize":21,"MoonAngularSize":11,"StarCount":3000,"CelestialBodiesShown":true}
```

## Clouds

`Clouds` must be a child of Terrain. In the mirror it is nested in Terrain's own file under `children`. With tools:

```call
build {"parent":"Workspace/Terrain","items":[{"class":"Clouds","name":"Clouds","Cover":0.6,"Density":0.7,"Color":"#FFFFFF"}]}

get {"path":"Workspace/Terrain/Clouds"}

set {"path":"Workspace/Terrain/Clouds","props":{"Cover":0.3}}
```

## Post-processing

Children of `Lighting`, or of the Camera.

```json file=Lighting/Bloom.BloomEffect.json
{"Intensity":0.6,"Size":24,"Threshold":1.5}
```

```json file=Lighting/Grade.ColorCorrectionEffect.json
{"Brightness":0.02,"Contrast":0.1,"Saturation":0.15,"TintColor":"#FFF4E0"}
```

```json file=Lighting/Rays.SunRaysEffect.json
{"Intensity":0.1,"Spread":0.8}
```

```json file=Lighting/Focus.DepthOfFieldEffect.json
{"FarIntensity":0.2,"FocusDistance":50,"InFocusRadius":40,"NearIntensity":0}
```

```json file=Lighting/Soft.BlurEffect.json
{"Size":4}
```

## Day and night

Runtime code:

```lua file=ServerScriptService/DayNight.server.luau
local Lighting = game:GetService("Lighting")
local MINUTES_PER_DAY = 10

game:GetService("RunService").Heartbeat:Connect(function(dt)
	Lighting.ClockTime = (Lighting.ClockTime + dt * 24 / (MINUTES_PER_DAY * 60)) % 24
end)
```

## Looking at the result

```call
screenshot {"view":"bird"}
```

## Gotchas

- Set `Enabled` to false to compare an effect on and off.
- Colours in `_props.json` are `#RRGGBB`.
- `ClockTime` and `TimeOfDay` are the same state, so changing one rewrites the other in the file.
- A strong `Atmosphere.Density` can hide distant builds in screenshots.
