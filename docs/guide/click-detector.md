# ClickDetector

> Mouse-clickable parts: exact files, events, and how to test them without a real mouse.

## When to use

The player clicks a part in the world. For walk-up key presses see [proximity-prompt](proximity-prompt.md).

## Where it goes

A child of a BasePart or Model.

```json file=Workspace/Panel.model/Button.ClickDetector.json
{"MaxActivationDistance":24}
```

On a model directly: `_model.ClickDetector.json`.

With build:

```call
build {"items":[{"name":"Button","size":[2,2,0.5],"at":[0,3,0],"color":"#CC3333","children":[{"class":"ClickDetector","MaxActivationDistance":24}]}]}
```

## Properties

`MaxActivationDistance` (default 32), `CursorIcon` (an image id).

## The script

```lua file=Workspace/Panel.model/Button.OnClick.server.luau
local button = script.Parent
local detector = button:WaitForChild("ClickDetector")

detector.MouseClick:Connect(function(player)
	button.Color = Color3.fromRGB(math.random(255), math.random(255), math.random(255))
	print(player.Name, "clicked")
end)
```

Events: `MouseClick(player)`, `RightMouseClick(player)`, `MouseHoverEnter(player)`, `MouseHoverLeave(player)`.

## Testing

Scripts have no method that fires a ClickDetector, and real mouse input cannot be injected. Keep the action in a function reachable another way. A BindableEvent next to the detector works:

```lua
local function press(player)
	-- the action
end

detector.MouseClick:Connect(press)
script.Parent:WaitForChild("Press").Event:Connect(press)
```

Then a server-context scenario can `workspace.Panel.Button.Press:Fire(T.player())`.

To test the real click, ask the user to click during a running test and read `output_read`.

## Gotchas

- A part behind another part cannot be clicked.
- Connect on the server unless the effect is purely local.
