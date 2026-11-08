# Events, remotes and bindables

> RemoteEvent, RemoteFunction, UnreliableRemoteEvent and Bindables: exact files, patterns and tests.

## When to use

Scripts need to talk: client to server (remotes), or server to server and client to client (bindables).

## Create

Any of these is an empty JSON file. Parent folders are plain directories.

```json file=ReplicatedStorage/Remotes/Buy.RemoteEvent.json
{}
```

```json file=ReplicatedStorage/Remotes/GetPrice.RemoteFunction.json
{}
```

```json file=ReplicatedStorage/Remotes/Aim.UnreliableRemoteEvent.json
{}
```

```json file=ServerStorage/Signals/MatchEnded.BindableEvent.json
{}
```

```json file=ServerStorage/Signals/Query.BindableFunction.json
{}
```

With tools:

```call
build {"parent":"ReplicatedStorage","items":[{"class":"Folder","name":"Remotes","children":[{"class":"RemoteEvent","name":"Buy"}]}]}
```

Remotes must be in a place both sides see, normally `ReplicatedStorage`.

## RemoteEvent pattern

Server:

```lua file=ServerScriptService/Shop.server.luau
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local buy = ReplicatedStorage:WaitForChild("Remotes"):WaitForChild("Buy")

local PRICES = { Sword = 50 }

buy.OnServerEvent:Connect(function(player, item)
	local price = PRICES[item]
	if type(item) ~= "string" or not price then
		return
	end
	local coins = player:GetAttribute("Coins") or 0
	if coins < price then
		return
	end
	player:SetAttribute("Coins", coins - price)
end)
```

Client:

```lua file=StarterGui/Menu.gui/List+Play.Buy.client.luau
local remote = game:GetService("ReplicatedStorage"):WaitForChild("Remotes"):WaitForChild("Buy")

script.Parent.Activated:Connect(function()
	remote:FireServer("Sword")
end)
```

**Never trust what a client sends.** The server re-checks the type, the price and the balance. The first argument of `OnServerEvent` is the real sender and cannot be forged.

## API summary

| Class | Sender | Receiver |
|---|---|---|
| RemoteEvent | `FireServer(...)` | `OnServerEvent(player, ...)` |
| RemoteEvent | `FireClient(player, ...)`, `FireAllClients(...)` | `OnClientEvent(...)` |
| UnreliableRemoteEvent | Same as RemoteEvent | Same, delivery not guaranteed. For frequent, disposable updates |
| RemoteFunction | `InvokeServer(...)` returns | `OnServerInvoke = function(player, ...)` |
| BindableEvent | `Fire(...)` | `Event` |
| BindableFunction | `Invoke(...)` returns | `OnInvoke = function(...)` |

Avoid `InvokeClient` from the server, since a client that never answers stalls the server thread.

## Testing

A scenario in the `client` context can fire a remote, and one in the `server` context can check the result.

```call
playtest_start {"mode":"play"}
```

```lua
-- context "client"
T.step("buying sends the event", function()
  game.ReplicatedStorage.Remotes.Buy:FireServer("Sword")
end)
```

```lua
-- context "server"
T.step("coins were spent", function()
  local p = T.player()
  T.waitFor(function() return p:GetAttribute("Coins") == 50 end, 3, "coins to drop")
end)
```

`T.set` and `T.get` do not cross between contexts. Use attributes or Value objects for that. See [playtest-and-scenarios](playtest-and-scenarios.md).

## Gotchas

- Scripts cannot find a remote that is created after they call `FindFirstChild`. Use `WaitForChild`.
- Tables sent through a remote are copied. Metatables and functions are lost, and mixed keys are not allowed.
- A `script_search` for `OnServerEvent` is a quick way to audit every entry point. See [editor-tools](editor-tools.md).
