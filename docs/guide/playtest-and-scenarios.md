# Play-tests and scenarios

> Running the game, driving it by script with the T helpers, reading reports, and multiplayer tests.

## When to use

To prove that game code works. Test it yourself instead of asking the user to click through the game.

## The loop

1. `playtest_start` with `mode:"play"` (with a player) or `"run"` (server only, no player).
2. `playtest_scenario`: teleport, wait, check values, print.
3. `output_read` with `level:"error"`: script errors with stack traces.
4. `playtest_stop`. Everything that changed inside the test is thrown away.
5. Fix the code in edit mode, then go back to step 1.

```call
playtest_start {"mode":"play"}

playtest_status {}

output_read {"level":"error"}

playtest_stop {}
```

A test is a normal, visible Studio session. Unsaved edit-mode work stays in the edit DataModel and returns when the test stops, but no tool saves it to disk. Ask the user to save first if a crash would hurt.

Edit-mode tools keep working during a test, but what you change in `edit` does not reach the running test. Stop and start again.

If `playtest_start` says it cannot start, ask the user to press Play (F5) or Run (F8), and poll `playtest_status` until `running` is true. Every other tool then works the same way.

## Start and status

`playtest_start {mode, timeout?}` waits for the contexts to connect. Default timeout 60 s, at most 300. Result: `{started, mode, contexts:{edit,server,client}, note?}`. It is refused while another test runs.

`playtest_status {}` returns `{running, mode?, contexts, clients?, players?, lastResult?, lastError?, note?}`. It also sees tests a person started.

`playtest_stop {}` asks the server context to end the test, or falls back to a plugin-setting channel, then waits up to 20 s. It is a no-op when nothing runs.

## Scenarios

`playtest_scenario {source, args?, timeout?, context?, client?}`. Context `server` is the default, `client` works too, `edit` is refused. Default timeout 60 s, at most 600. After the timeout the code is cancelled.

```call
playtest_scenario {"source":"T.step('player exists', function() T.assert(T.player(), 'no player') end)","timeout":30}
```

In scope: `T`, `print`, `warn`, `args`, `plugin`, and all normal globals. A `return` value comes back as `returns`.

### A scenario is not one of the game's scripts

The scenario runs in the RoLink plugin, apart from the game's scripts. **`require` of a game ModuleScript gives the scenario its own, separate copy of that module.** Tables, flags, counters and connections inside it are not the game's: reading them shows the copy's state, and changing them does not reach the game. The report then carries a `warnings` entry naming the module.

Reach game state through what the game's scripts and the scenario both see:

| To | Use |
|---|---|
| Read state | Instances, attributes (`player:GetAttribute("Gold")`), `Value` objects the game keeps up to date |
| Change state | Set attributes or `Value` objects the game listens to, or move instances |
| Call game code | A `BindableEvent` / `BindableFunction` the game exposes, or fire the game's own remotes from a client scenario |

Pure helpers and constants from a module are fine to `require`.

```lua
-- the game keeps Gold as an attribute and listens to a BindableFunction "Debug/GiveGold"
T.step("debug gold", function()
  local player = T.player()
  game:GetService("ServerStorage").Debug.GiveGold:Invoke(player, 10)
  T.waitFor(function() return player:GetAttribute("Gold") == 10 end, 5, "gold to reach 10")
end)
```

### Example

```lua
T.step("spawns with zero gold", function()
  local player = T.player()
  T.waitFor(function() return player:GetAttribute("Gold") ~= nil end, 5, "Gold attribute")
  T.equal(player:GetAttribute("Gold"), 0)
end)

T.step("coin gives gold", function()
  T.teleport(workspace.Coin.Position + Vector3.new(0, 3, 0))
  T.waitFor(function() return T.player():GetAttribute("Gold") == 10 end, 5, "gold to reach 10")
  T.log("gold after coin:", T.player():GetAttribute("Gold"))
end)
```

## All T helpers

| Helper | Behaviour |
|---|---|
| `T.player(timeout?)` | The test's player, `LocalPlayer` on the client, first player on the server. Waits, default 10 s. Errors in mode `run` |
| `T.players(minCount?, timeout?)` | Every player. With `minCount`, waits until that many joined, default 10 s, else errors |
| `T.character(timeout?)` | The player's character, waits for it to spawn with a root part |
| `T.teleport(target)` | Moves the character. A `CFrame` sets everything, a `Vector3` keeps facing. Zeroes velocity. Returns the character |
| `T.wait(seconds?)` | `task.wait` |
| `T.waitFor(predicate, timeout?, label?)` | Polls each frame until truthy, and returns that value. Default 5 s. A predicate that errors counts as not ready, and the last error is included in the timeout message |
| `T.assert(cond, message?)` | Fails the current step when `cond` is falsy. Returns `cond` |
| `T.equal(actual, expected, message?)` | Fails with both values when they differ. Plain tables compare by value, to 12 levels |
| `T.step(name, fn)` | Runs a named step. Returns `true, ...results`, or `false, message`. Later steps still run |
| `T.log(...)` | Prints to Output and records the line on the current step |
| `T.set(key, value)`, `T.get(key)` | Variables for this play-test context, across steps and scenarios. They do not cross between server and client |

`T.players` is the helper for several players, and is missing from older descriptions.

## The report

| Field | Meaning |
|---|---|
| `ok` | All steps passed, no error outside a step, no timeout |
| `summary` | For example `3/4 steps passed` |
| `context`, `duration`, `timedOut` | |
| `error`, `traceback` | A failure outside any step, or a compile error |
| `returns` | Return values |
| `steps[]` | `name`, `ok`, `duration`, `message`, `traceback`, `logs`, `errors` (with `seq`, `text`, `stack`, `script`) |
| `logs` | All Output lines during the run, also from the game's own scripts. The last 300 |
| `logsDropped` | How many lines were cut |
| `errors` | Error lines with `stack`, `script`, `step` |
| `output` | `{from, lastSeq}`, for continuing with `output_read` |
| `warnings` | Present when the scenario did something that does not do what it looks like, such as requiring a game ModuleScript |

A game script's error does not fail a step. Look at `errors`, or assert on it.

## Client and server

Use `context:"client"` for anything only the client sees: `PlayerGui`, `LocalPlayer`, camera.

```call
playtest_scenario {"context":"client","source":"T.step('hud', function() T.assert(T.player().PlayerGui:WaitForChild('Hud', 5), 'no Hud') end)"}
```

`run {"context":"server","code":"..."}` runs one-off Luau inside a test as well.

A client can press a real ProximityPrompt with `prompt:InputHoldBegin()` and `prompt:InputHoldEnd()`, after moving the character into range. Called on the server, these do nothing.

Roblox refuses HTTP on a play-test client, so the client context talks to RoLink through the server context over a RemoteEvent named `__RoLinkClientRelay` in `ReplicatedStorage`. It exists only inside tests, and game code can see it. If the client never connects, look in Output for a warning starting with `[RoLink]`.

## Several players

```call
multiplayer_test {"clients":2}
```

One server and 1 to 8 client windows on this PC. Default timeout 120 s. `playtest_status` shows mode `multiplayer` and `clients`.

To pick a window, pass `context:"client"` and `client` (join order, from 1) to `playtest_scenario`, `output_read` or `profile_scripts`.

```lua
T.step("both joined", function()
  local list = T.players(2, 30)
  T.equal(#list, 2)
end)
```

```call
playtest_scenario {"context":"client","client":2,"source":"T.step('second window', function() T.log(T.player().Name) end)"}
```

`T.set` and `T.get` are per context, so use attributes to share state between windows.

## What cannot be simulated

Real keyboard, mouse, touch or gamepad input cannot be injected. Move the character with `T.teleport`, or `humanoid:MoveTo` from a server or client scenario. Fire remotes, or invoke bindables the game exposes. Calling into a game module through `require` reaches the scenario's own copy, not the game (see above). See [limits-and-known-gaps](limits-and-known-gaps.md).

## Gotchas

- A scenario blocks other queued commands for that context, except `output_read`, `playtest_status`, `perf_stats` and `profile_scripts`.
- `T.waitFor` swallows errors in the predicate, so a typo looks like a timeout. Read the `last error` part of the message.
- A scenario may be cut off when the test ends. The error says the play-test ended, so check `output_read`.
- A slow or unfocused Studio (around 10 fps) runs scenarios slowly. A context busy with a scenario is not dropped for polling late, but the scenario's own `timeout` and the `T.waitFor` timeouts still count wall time: give them room.
- `screenshot` during a test: use `context:"client"` for what the player sees. The edit view is hidden while a test runs, and the server view only shows when the user switches Studio to it; a capture of a context that is not on screen fails with a message instead of returning a wrong image. See [editor-tools](editor-tools.md).
- Mode `run` has no players or client context.
- Output from `print` in a scenario also appears in Studio's Output window.
