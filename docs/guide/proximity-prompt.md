# ProximityPrompt

> Press-to-interact prompts on parts: exact files, server script, testing.

## When to use

The player walks up to something and presses a key, such as opening a door or buying an item. For mouse clicks see [click-detector](click-detector.md).

## Where it goes

A child of a BasePart or Attachment. On a part in a model it is its own file:

```json file=Workspace/House.model/Door.ProximityPrompt.json
{"ActionText":"Open","ObjectText":"Door","HoldDuration":0.5,"MaxActivationDistance":10,"KeyboardKeyCode":"E"}
```

The instance name is the `name` key, and without one it is `ProximityPrompt`. A second prompt on the same part is `Door.ProximityPrompt~2.json`. On the model itself use `_model.ProximityPrompt.json`.

With build:

```call
build {"items":[{"name":"Chest","size":[4,3,3],"at":[0,1.5,0],"children":[{"class":"ProximityPrompt","ActionText":"Open","HoldDuration":1}]}]}
```

## Properties

`ActionText`, `ObjectText`, `HoldDuration` (seconds, 0 is instant), `MaxActivationDistance`, `KeyboardKeyCode`, `GamepadKeyCode`, `RequiresLineOfSight`, `Enabled`, `Exclusivity` (OnePerButton, OneGlobally, AlwaysShow), `ClickablePrompt`, `Style` (Default, Custom), `UIOffset`, `MaxIndicatorDistance`.

## The script

Put a Script on the same part. It runs on the server:

```lua file=Workspace/House.model/Door.Open.server.luau
local door = script.Parent
local prompt = door:WaitForChild("ProximityPrompt")

prompt.Triggered:Connect(function(player)
	door.CanCollide = false
	door.Transparency = 0.7
	prompt.Enabled = false
	task.delay(3, function()
		door.CanCollide = true
		door.Transparency = 0
		prompt.Enabled = true
	end)
end)
```

Events: `Triggered(player)`, `TriggerEnded(player)`, `PromptButtonHoldBegan(player)`, `PromptButtonHoldEnded(player)`. `PromptShown` and `PromptHidden` fire on the client.

## Testing

Key presses cannot be injected. Two workable approaches, both in [playtest-and-scenarios](playtest-and-scenarios.md):

1. In a `client` context, `ProximityPrompt:InputHoldBegin()` and `InputHoldEnd()` drive the prompt the way custom prompt UI does. This has not been verified in real Studio by this project.

```lua
T.step("door opens", function()
  local door = workspace.House.Door
  T.teleport(door.Position + Vector3.new(0, 0, 6))
  T.wait(0.5)
  local prompt = door.ProximityPrompt
  prompt:InputHoldBegin()
  T.wait(prompt.HoldDuration + 0.1)
  prompt:InputHoldEnd()
  T.waitFor(function() return door.Transparency > 0 end, 3, "door to open")
end)
```

2. Move the handler into a ModuleScript and call that from a server-context scenario.

## Gotchas

- On a loose part that holds no scripts, the prompt is nested in `children` of `Name.Part.json`.
- A prompt under a part that is not in `Workspace` does nothing.
- `RequiresLineOfSight` true means a wall in the way hides the prompt.
