# Lights, particles and effects

> PointLight, SpotLight, SurfaceLight, ParticleEmitter, Beam, Trail, Fire, Smoke, Sparkles, Highlight.

## When to use

Light sources and visual effects attached to parts. For sky, fog and post-processing see [lighting-atmosphere](lighting-atmosphere.md).

All of these are separate files inside a model: `<part>.<Class>.json`, and second of a class `<part>.<Class>~2.json`. On a loose part they go in `children`.

## Lights

Common: `Brightness`, `Color`, `Enabled`, `Shadows`.

| Class | Extra |
|---|---|
| `PointLight` | `Range` |
| `SpotLight` | `Range`, `Angle`, `Face` |
| `SurfaceLight` | `Range`, `Angle`, `Face` |

```json file=Workspace/Lamp.model/Bulb.PointLight.json
{"Brightness":2,"Range":24,"Color":"#FFE2B0","Shadows":true}
```

```json file=Workspace/Lamp.model/Bulb.SpotLight.json
{"Brightness":4,"Range":40,"Angle":60,"Face":"Bottom"}
```

A light needs a part or attachment as parent. A `Neon` bulb part plus a PointLight looks convincing. Keep shadow-casting lights few, see [perf](perf.md).

## ParticleEmitter

```json file=Workspace/Campfire.model/Logs.ParticleEmitter.json
{"Rate":40,"Lifetime":[0.6,1.2],"Speed":[3,6],"SpreadAngle":[15,15],"LightEmission":0.8,
 "Size":[[0,1.2],[1,0]],"Transparency":[[0,0.1],[1,1]],"Color":[[0,"#FFD060"],[1,"#FF3000"]],
 "Texture":"rbxasset://textures/particles/sparkles_main.dds"}
```

Key properties: `Rate`, `Lifetime` (NumberRange), `Speed` (NumberRange), `SpreadAngle` (Vector2), `Size`, `Transparency` and `Squash` (NumberSequence), `Color` (ColorSequence), `Acceleration`, `Drag`, `RotSpeed`, `Rotation`, `Orientation`, `EmissionDirection`, `LightEmission`, `LightInfluence`, `Brightness`, `ZOffset`, `LockedToPart`, `Enabled`, `Shape`, `TimeScale`, `Texture`.

`Rotation` of an emitter is not shown in mirror files. Particles do not simulate in edit mode, so check them in a test or with a burst from a scenario: `emitter:Emit(20)`.

## Beam

A Beam joins two Attachments. Attachments live in `model.json`, and **an Attachment's `CFrame` is relative to its parent part**, unlike part CFrames.

```json file=Workspace/Cable.model/model.json
{"children":[
  {"name":"PoleA","class":"Part","CFrame":{"p":[0,5,0]},"Size":[1,10,1],"children":[
    {"name":"Top","class":"Attachment","CFrame":{"p":[0,5,0]}}
  ]},
  {"name":"PoleB","class":"Part","CFrame":{"p":[20,5,0]},"Size":[1,10,1],"children":[
    {"name":"Top","class":"Attachment","CFrame":{"p":[0,5,0]}}
  ]}
]}
```

```json file=Workspace/Cable.model/PoleA.Beam.json
{"Attachment0":{"ref":"./PoleA/Top"},"Attachment1":{"ref":"./PoleB/Top"},"Width0":0.3,"Width1":0.3,"CurveSize0":4,"CurveSize1":-4,"Color":[[0,"#222222"],[1,"#222222"]]}
```

Also `Texture`, `TextureLength`, `TextureMode`, `TextureSpeed`, `Segments`, `FaceCamera`, `LightEmission`, `Transparency`, `ZOffset`, `Enabled`.

## Trail

Also two Attachments, on the same moving part. `Lifetime`, `MinLength`, `MaxLength`, `WidthScale`, `Color`, `Transparency`, `Texture`, `FaceCamera`, `Enabled`.

## Fire, Smoke, Sparkles

```json file=Workspace/Campfire.model/Logs.Fire.json
{"Heat":12,"Size":6,"Color":"#FF8800","SecondaryColor":"#FF2200"}
```

```json file=Workspace/Campfire.model/Logs.Smoke.json
{"Size":4,"Opacity":0.3,"RiseVelocity":3,"Color":"#555555"}
```

`Sparkles` has `SparkleColor`, `Enabled`, `TimeScale`.

## Highlight

An outline over a model or part. Parent it to the target, or set `Adornee`.

```json file=Workspace/Lamp.model/_model.Highlight.json
{"FillColor":"#FFFF00","FillTransparency":0.8,"OutlineColor":"#FFFFFF","DepthMode":"AlwaysOnTop"}
```

## Gotchas

- `inspect` and JSON `export` drop `Color` and `Size` on these classes. Mirror files keep them, and `get` reads them. See [build-spec](build-spec.md).
- Effects with custom textures need a real asset id.
- Many emitters or shadow lights are a frame-rate cost.
