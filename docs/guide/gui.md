# GUI

> Screen, surface and billboard GUIs: files, UDim2, every common class, layouts, edit-mode preview.

## When to use

Any 2D interface. The mirror's `Name.gui/gui.json` is the best route, because one file holds the whole tree.

## How a GUI lives in files

```text
StarterGui/Hud.gui/
  gui.json              the ScreenGui and every descendant except scripts
  Open.client.luau      LocalScript directly in the ScreenGui
  Panel.Buy.client.luau LocalScript inside the Frame named Panel
```

`Panel+Inner.Buy.client.luau` is a script inside `Panel/Inner`. Sounds and other separate classes are their own files, for example `Panel.Sound.json`. See [mirror-reference](mirror-reference.md).

## First GUI

```json file=StarterGui/Hud.gui/gui.json
{
  "class": "ScreenGui",
  "ResetOnSpawn": false,
  "ZIndexBehavior": "Sibling",
  "children": [
    {"name":"Panel","class":"Frame","AnchorPoint":[0.5,0],"Position":[0.5,0,0,20],"Size":[0,300,0,120],"BackgroundColor3":"#202028","children":[
      {"name":"Corner","class":"UICorner","CornerRadius":[0,12]},
      {"name":"Title","class":"TextLabel","Size":[1,0,1,0],"BackgroundTransparency":1,"Text":"Hello","TextColor3":"#FFFFFF","TextSize":28,
       "FontFace":{"family":"GothamSSm","weight":"Bold","style":"Normal"}}
    ]}
  ]
}
```

Save it and look:

```call
screenshot {"view":"current"}
```

## How it shows in edit mode

Contents of `StarterGui` draw over the viewport in edit mode as long as `StarterGui.ShowDevelopmentGui` is true and the GUI's `Enabled` is true. So `screenshot {"view":"current"}` shows it without a test.

LocalScripts do not run in edit mode. Anything built or changed by code only appears in a test. In a test, players get a copy under `PlayerGui`, and the copy in `StarterGui` is a template.

The viewport's aspect ratio differs from players' screens. Prefer scale-based sizes with constraints for anything that spans the screen.

## UDim2

A size or position is `[xScale, xOffset, yScale, yOffset]`. Scale is a fraction of the parent, offset is pixels, and the final value is their sum.

| Value | Meaning |
|---|---|
| `[1,0,1,0]` | Fill the parent |
| `[0,300,0,120]` | Fixed 300x120 px |
| `[0.5,0,0.5,0]` as Position with AnchorPoint `[0.5,0.5]` | Centred |
| `[1,-20,0,20]` as Position with AnchorPoint `[1,0]` | Top right, 20 px in |
| `[1,-40,0,50]` as Size | Parent width minus 40 px, 50 px tall |

`AnchorPoint` is `[x,y]`, from 0 to 1, the point of the element that `Position` refers to.

## Common properties (every GuiObject)

`Size`, `Position`, `AnchorPoint`, `Rotation`, `Visible`, `ZIndex`, `LayoutOrder`, `BackgroundColor3`, `BackgroundTransparency`, `BorderSizePixel`, `BorderColor3`, `BorderMode`, `ClipsDescendants`, `AutomaticSize`, `SizeConstraint`, `Active`, `Selectable`, `Interactable`.

Remember: `Position` and `Rotation` are write-only through files. See "Reading a GUI back".

## Containers

| Class | Key properties |
|---|---|
| `ScreenGui` | `Enabled`, `ResetOnSpawn`, `DisplayOrder`, `IgnoreGuiInset`, `ScreenInsets`, `ZIndexBehavior`, `ClipToDeviceSafeArea` |
| `SurfaceGui` | `Adornee`, `Face`, `SizingMode`, `CanvasSize`, `PixelsPerStud`, `AlwaysOnTop`, `Brightness`, `LightInfluence`, `MaxDistance` |
| `BillboardGui` | `Adornee`, `Size`, `StudsOffset`, `ExtentsOffset`, `AlwaysOnTop`, `MaxDistance`, `LightInfluence` |

Keep `ResetOnSpawn` false unless the GUI should reset on each respawn.

## Elements

| Class | Key properties |
|---|---|
| `Frame` | Common only |
| `ScrollingFrame` | `CanvasSize`, `AutomaticCanvasSize`, `ScrollBarThickness`, `ScrollingDirection`, `ScrollBarImageColor3`, `ElasticBehavior` |
| `CanvasGroup` | `GroupColor3`, `GroupTransparency` |
| `ViewportFrame` | `CurrentCamera`, `Ambient`, `LightColor`, `LightDirection`, `ImageColor3` |
| `VideoFrame` | `Video`, `Looped`, `Playing`, `Volume` |
| `TextLabel` | `Text`, `TextColor3`, `TextSize`, `FontFace`, `TextScaled`, `TextWrapped`, `RichText`, `TextXAlignment`, `TextYAlignment`, `TextTruncate`, `TextStrokeColor3`, `TextStrokeTransparency`, `TextTransparency`, `LineHeight`, `MaxVisibleGraphemes` |
| `TextButton` | As TextLabel, plus `AutoButtonColor`, `Modal` |
| `TextBox` | As TextLabel, plus `PlaceholderText`, `PlaceholderColor3`, `ClearTextOnFocus`, `MultiLine`, `TextEditable` |
| `ImageLabel` | `Image`, `ImageColor3`, `ImageTransparency`, `ScaleType`, `SliceCenter`, `SliceScale`, `TileSize`, `ImageRectOffset`, `ImageRectSize`, `ResampleMode` |
| `ImageButton` | As ImageLabel, plus `HoverImage`, `PressedImage`, `AutoButtonColor` |

`ScaleType` is one of Stretch, Slice, Tile, Fit, Crop. `Image` needs a real asset: see [publishing-assets](publishing-assets.md).

## Modifiers (children of an element)

| Class | Key properties |
|---|---|
| `UICorner` | `CornerRadius` as UDim, `[0,12]` |
| `UIStroke` | `Color`, `Thickness`, `Transparency`, `ApplyStrokeMode` (Contextual, Border), `LineJoinMode` |
| `UIGradient` | `Color`, `Transparency`, `Rotation`, `Offset`, `Type` (Linear, Radial, Conical, Elliptical) |
| `UIPadding` | `PaddingTop`, `PaddingBottom`, `PaddingLeft`, `PaddingRight`, as UDim |
| `UIScale` | `Scale` |
| `UIAspectRatioConstraint` | `AspectRatio`, `AspectType`, `DominantAxis` |
| `UISizeConstraint` | `MinSize`, `MaxSize` as Vector2 |
| `UITextSizeConstraint` | `MinTextSize`, `MaxTextSize` |
| `UIFlexItem` | `FlexMode`, `GrowRatio`, `ShrinkRatio`, `ItemLineAlignment` |

## Layouts

A layout is a child of the container and arranges its siblings. It overrides their `Position`.

### UIListLayout

`FillDirection` (Horizontal, Vertical), `Padding` as UDim, `SortOrder` (LayoutOrder, Name), `HorizontalAlignment`, `VerticalAlignment`, `Wraps`, `HorizontalFlex`, `VerticalFlex`. Use `SortOrder: "LayoutOrder"` and give children `LayoutOrder`.

```json file=StarterGui/Menu.gui/gui.json
{"class":"ScreenGui","children":[
  {"name":"List","class":"Frame","Size":[0,220,0,300],"Position":[0,20,0,20],"BackgroundColor3":"#1B1B22","children":[
    {"name":"Layout","class":"UIListLayout","Padding":[0,8],"SortOrder":"LayoutOrder","HorizontalAlignment":"Center"},
    {"name":"Pad","class":"UIPadding","PaddingTop":[0,10]},
    {"name":"Play","class":"TextButton","LayoutOrder":1,"Size":[1,-20,0,44],"Text":"Play","TextSize":20},
    {"name":"Quit","class":"TextButton","LayoutOrder":2,"Size":[1,-20,0,44],"Text":"Quit","TextSize":20}
  ]}
]}
```

### UIGridLayout

`CellSize` and `CellPadding` as UDim2, `FillDirection`, `FillDirectionMaxCells`, `StartCorner`, `SortOrder`.

```json file=StarterGui/Bag.gui/gui.json
{"class":"ScreenGui","children":[
  {"name":"Grid","class":"ScrollingFrame","Size":[0,340,0,260],"AutomaticCanvasSize":"Y","CanvasSize":[0,0,0,0],"children":[
    {"name":"Layout","class":"UIGridLayout","CellSize":[0,64,0,64],"CellPadding":[0,6,0,6],"SortOrder":"LayoutOrder"}
  ]}
]}
```

### UITableLayout and UIPageLayout

`UITableLayout`: `MajorAxis`, `Padding` as UDim2, `FillEmptySpaceColumns`, `FillEmptySpaceRows`. `UIPageLayout`: `Animated`, `Circular`, `EasingStyle`, `EasingDirection`, `TweenTime`, `Padding` as UDim, `ScrollWheelInputEnabled`, `TouchInputEnabled`, `GamepadInputEnabled`.

## Surface and billboard GUIs

On a part of a model, the directory carries the owner in its name:

```json file=Workspace/Shop.model/Sign.Label.gui/gui.json
{"class":"SurfaceGui","Face":"Front","PixelsPerStud":50,"SizingMode":"PixelsPerStud","children":[
  {"name":"Text","class":"TextLabel","Size":[1,0,1,0],"BackgroundTransparency":1,"Text":"SHOP","TextScaled":true}
]}
```

A SurfaceGui or BillboardGui inside a part works without `Adornee`. One in `StarterGui` needs `Adornee` set by a script or a reference.

```json file=Workspace/Npc.model/Head.Tag.gui/gui.json
{"class":"BillboardGui","Size":[0,200,0,50],"StudsOffset":[0,3,0],"AlwaysOnTop":true,"children":[
  {"name":"Name","class":"TextLabel","Size":[1,0,1,0],"BackgroundTransparency":1,"Text":"Merchant","TextColor3":"#FFFFFF","TextScaled":true}
]}
```

## Buttons that do something

Write the GUI, a `RemoteEvent`, a LocalScript, and a server Script. The remote pattern is in [events-remotes-bindables](events-remotes-bindables.md).

```lua file=StarterGui/Menu.gui/List+Play.Click.client.luau
local button = script.Parent
local remote = game:GetService("ReplicatedStorage"):WaitForChild("Remotes"):WaitForChild("Play")

button.Activated:Connect(function()
	remote:FireServer()
end)
```

## With the build tool

See [build-spec](build-spec.md). `size` means `Size`. `color`, `at` and `transparency` do not apply to GUI objects.

## Reading a GUI back

| Property | `gui.json` | `inspect` / JSON `export` | `get` |
|---|---|---|---|
| `Size` | yes | yes | yes |
| `Position`, `Rotation` | yes | yes | yes |
| Everything else | yes | yes | yes |

To check layout, take a screenshot, or:

```call
get {"path":"StarterGui/Hud/Panel","props":["Position","Size","AbsolutePosition","AbsoluteSize"]}
```

When rewriting a whole `gui.json`, an entry without `Position` keeps its current position.

## Testing

Real clicks cannot be injected. In a client-context scenario you can read `PlayerGui` and fire the remote yourself, or call a module the button also uses. See [playtest-and-scenarios](playtest-and-scenarios.md).

```lua
T.step("menu exists", function()
  local gui = T.player().PlayerGui:WaitForChild("Menu", 5)
  T.assert(gui, "Menu was copied to PlayerGui")
  T.assert(gui.List.Play.Visible, "Play is visible")
end)
```

## Gotchas

- `gui.json` `class` must be ScreenGui, SurfaceGui or BillboardGui, and without it a new one is a ScreenGui.
- A GuiObject outside a ScreenGui, SurfaceGui or BillboardGui does not draw.
- `Color3` properties have the suffix: `BackgroundColor3`, `TextColor3`, `ImageColor3`. `UIStroke.Color` is the exception, and `UIGradient.Color` is a ColorSequence.
- `TextScaled` overrides `TextSize`.
- Set `ZIndexBehavior` to `Sibling` so draw order follows the tree.
- `children` is the complete list when present: removing an entry destroys it.
- Text in a GUI is shown to players, so keep it free of anything copied blindly from third-party assets.
