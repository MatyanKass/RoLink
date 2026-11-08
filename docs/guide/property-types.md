# Property types

> JSON encoding of every Roblox value type, for reading and writing, in all tools and mirror files.

## When to use

You are writing a property value in a mirror file, a `build` node, `set`, or `playtest` args, or reading one back. Code: `plugin/src/Codec.lua`.

## Table of types

"Written as" is what RoLink produces. "Also accepted" works when you write.

| Type | Written as | Also accepted |
|---|---|---|
| bool | `true` | `"true"`, `1` |
| number | `12.5`, rounded to 4 decimals | numeric string |
| string | `"text"` | |
| ContentId (`Image`, `SoundId`, `Texture`...) | `"rbxassetid://123"` | the number `123` |
| Vector3 | `[x,y,z]` | one number for all axes, `{"x":1,"y":2,"z":3}` |
| Vector2 | `[x,y]` | `{"x":1,"y":2}` |
| Vector3int16, Vector2int16 | `[x,y,z]`, `[x,y]` | |
| Color3 | `"#RRGGBB"` | `"#RGB"`, `[r,g,b]` with 0-255, an exact BrickColor name |
| BrickColor | `"Bright red"` | a number, `"#RRGGBB"` (nearest) |
| CFrame | `{"p":[x,y,z],"r":[rx,ry,rz]}` (`r` omitted when zero) | see below |
| Enum | `"Neon"` | any case, `"Enum.Material.Neon"`, the numeric value |
| UDim | `[scale,offset]` | a number, meaning offset |
| UDim2 | `[xScale,xOffset,yScale,yOffset]` | nothing shorter |
| NumberRange | `[min,max]` | one number |
| NumberSequence | `[[t,v],[t,v,envelope]]` | one number, `[from,to]` |
| ColorSequence | `[[t,"#hex"],...]` | `"#hex"`, `["#from","#to"]` |
| Rect | `[minX,minY,maxX,maxY]` | |
| Font | `{"family":"GothamSSm","weight":"Bold","style":"Normal"}` | a font asset URL, a font name, an Enum.Font name |
| PhysicalProperties | `[density,friction,elasticity,frictionWeight,elasticityWeight]` | `false` or `"default"` clears, a material name, three numbers (weights default to 1) |
| Faces | `["Top","Front"]` | one name as a string |
| Axes | `["X","Y"]` | one name as a string |
| Instance reference | `{"ref":"Workspace/Path"}` | see below |

## CFrame

`r` is `Orientation`: degrees, applied in Y, X, Z order. All of these work:

```json
{"p":[0,5,0]}
```

```json
{"p":[0,5,0],"r":[0,90,0]}
```

```json
{"p":[0,5,0],"lookAt":[10,5,0]}
```

```json
[0,5,0]
```

```json
[0,5,0, 1,0,0, 0,1,0, 0,0,1]
```

`pos`, `position` and `at` are accepted in place of `p`. `rot` and `orientation` are accepted in place of `r`.

## UDim2 in one line

`[0.5,-150,0,20]` is X at 50% minus 150 px, Y at 0% plus 20 px. Details in [gui](gui.md).

## Sequences

Keypoint times run from 0 to 1 and must include both 0 and 1, a Roblox rule. A bad sequence is reported as an error or warning.

```json
{"Transparency":[[0,0],[0.7,0.2],[1,1]],"Color":[[0,"#FFAA00"],[1,"#FF2200"]],"Size":[[0,1],[1,3,0.5]]}
```

## Fonts

A bare `family` expands to `rbxasset://fonts/families/<family>.json`. Common families: `GothamSSm`, `SourceSansPro`, `Roboto`, `RobotoMono`, `Arial`. Weights: Thin, ExtraLight, Light, Regular, Medium, SemiBold, Bold, ExtraBold, Heavy. Styles: Normal, Italic. The property is `FontFace`.

## Instance references

The meaning of a reference differs by route, so check this before using one.

| Route | `{"ref":"."}` | `{"ref":"./A/B"}` | `{"ref":"A/B"}` | Clear |
|---|---|---|---|---|
| Mirror file | Nearest Model or GUI | Relative to it | Absolute | `null` |
| `build` node | Top-level built node | Relative to it | Relative to it, then absolute | leave out |
| `set` | Nearest Model or GUI | Relative to it | Relative to the instance, then absolute | `null` or `{"ref":false}` |

`#42` works as an absolute target in all three. In `build` and in the mirror, references resolve after everything in the call exists.

## Attributes

Numbers, strings and booleans are written as they are. Other types are wrapped with the type name:

```json
{"attrs":{"Health":100,"Label":"Boss","Active":true,"Tint":{"Color3":"#FF8800"},"Home":{"Vector3":[1,2,3]},"Range":{"NumberRange":[1,5]}}}
```

Wrappable types: Vector3, Vector2, Color3, CFrame, UDim, UDim2, NumberRange, NumberSequence, ColorSequence, Rect, BrickColor, Font. A bare three-number array also becomes a Vector3. Instance references cannot be attributes. See [attributes-tags](attributes-tags.md).

## Return values of `run` and scenarios

Luau return values are encoded with the same rules. Tables go at most 6 levels deep and 500 keys wide. Functions, threads and signals are shown as `<function>` and so on. Cycles become `<cycle>`.

## Gotchas

- Infinity is written as `1e300` and `-1e300`, NaN as `0`.
- Numbers come back rounded to 4 decimals, so compare with a tolerance.
- JSON `null` has no effect in `build`, because a Lua table cannot hold it. In `set` and the mirror, `null` clears an instance reference.
- A value of the wrong shape never aborts a call. It appears in `warnings` or `_errors.log`, often with "did you mean".
- Unknown property types fall back to the type of the current value.
