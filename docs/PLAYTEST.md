# Testing by script in a play-test

You can test the game yourself, the same way you test code on a normal computer:
run it, make it do something, read what happened, fix, run again. Prefer this to
asking the user to click through the game.

## The loop

1. `playtest_start {mode:"play"}`. A normal, visible Studio test starts
   (`"run"` = no player, server only). Refused while another test is running.
2. `playtest_scenario {source}`: teleport the player, wait, check values, print.
3. `output_read {level:"error"}`: script errors with stack traces. Poll with
   `since` = the `next` you got last time for new lines only.
4. `playtest_stop`. Everything that changed inside the test is thrown away.
5. Fix the code (edit scripts or save synced files), then go back to step 1.

Edit-mode tools still work during a test, but what you edit in `edit` does not
reach the running test: stop and start again to test the change.

If `playtest_start` says it cannot start the test, ask the user to press Play
(F5) or Run (F8) and call `playtest_status` until `running` is true; all the
other tools then work the same way.

## Several players

`multiplayer_test {clients}` starts one server and 1 to 8 client windows on this
PC. Everything above works the same way: `playtest_status` shows mode
`multiplayer` and the number of clients, `playtest_scenario` runs on the server
by default, and `playtest_stop` ends it. To work with one window, pass
`context: "client"` and `client: 2`, numbered in the order they joined, to
`playtest_scenario` or `output_read`. On the server, `T.players(2)` waits for two
players to join and returns them.

## Performance

`profile_scripts {duration}` runs the Script Profiler during a test and returns
the functions that took the most time. It runs alongside a scenario, so start the
profile first and drive the load from the scenario. `perf_stats` returns memory,
counts and heartbeat for any context at any time.

## Example

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

## `T` helpers

| Helper | What it does |
| --- | --- |
| `T.player(timeout?)` | The test's player (`LocalPlayer` on the client); waits for one to join. Errors in mode `run`, which has no players. |
| `T.players(minCount?, timeout?)` | Every player in the test. With `minCount`, waits until that many have joined (default 10 s), and errors if they do not. |
| `T.character(timeout?)` | The player's character; waits for it to spawn. |
| `T.teleport(cframeOrVector)` | Moves the character. A `Vector3` keeps its facing. |
| `T.wait(seconds?)` | `task.wait`. |
| `T.waitFor(predicate, timeout?, label?)` | Polls until the predicate returns a truthy value and returns it (default 5 s). A predicate that errors counts as not ready yet. |
| `T.assert(cond, msg)` | Fails the current step if `cond` is falsy. |
| `T.equal(actual, expected, msg?)` | Fails with both values if different. Plain tables are compared by value. |
| `T.step(name, fn)` | Runs a named step. Returns `true, ...results`, or `false, message` when it failed; later steps still run. |
| `T.log(...)` | Prints to Output and records the line on the step. |
| `T.set(key, value)` / `T.get(key)` | Variables shared across steps and scenarios of this play-test context. |

`print` and `warn` work as usual. Also in scope: `args` (the `args` tool input)
and `plugin`. `return` values come back in the report as `returns`.

## The report

`ok`, `summary`, `context`, `duration`, `timedOut`, `error`/`traceback` (a failure
outside any step), `returns`, `steps[]` (`name`, `ok`, `message`, `traceback`,
`duration`, `logs`, `errors`), `logs` (all Output lines during the run, also from
the game's own scripts), `errors` (error lines with `stack`, `script`, `step`) and
`output.lastSeq` for continuing with `output_read`.

A scenario is cancelled when `timeout` (default 60 s) passes, so a stuck wait
cannot hang you. A game script's error does not fail a step by itself: look at
`errors`, or assert on it.
