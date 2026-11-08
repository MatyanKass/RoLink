# Performance

> Snapshots with perf_stats and Script Profiler runs with profile_scripts, and how to act on them.

## When to use

The game feels slow, or you want a baseline before and after a change.

## perf_stats

```call
perf_stats {}

perf_stats {"context":"server","sample":2}

perf_stats {"context":"client"}
```

`sample` is seconds of heartbeat sampling, default 0.5, at most 5. Works in any context.

Result: `context, memoryMb, instanceCount, primitives, movingPrimitives, contacts, heartbeatTimeMs, physicsStepTimeMs, dataReceiveKbps, dataSendKbps, heartbeat:{samples,avgDt,maxDt,fps}, players, classes:[{class,count}] (top 15), errors?`.

Anything Studio refuses to read is listed under `errors`, the rest still arrives. In edit mode, heartbeat and physics numbers say little.

## profile_scripts

Runs in a play-test only.

```call
profile_scripts {"duration":10,"top":30}

profile_scripts {"context":"client","client":1,"duration":5}
```

| Argument | Default | Limits |
|---|---|---|
| `duration` | 5 s | 0.01 to 60 |
| `frequency` | 1000 samples/s | 1 to 10000, whole number |
| `top` | 20 | 1 to 200 |

Result: `{functions:[{name,source,line,totalDuration}], functionCount, categories, context, duration, frequency, note}`. The docs do not state a unit for `totalDuration`, so compare values with each other only. If the payload format is unknown, you get `unrecognised:true` and a `raw` excerpt.

It runs alongside a scenario. Start the profile, then drive load from `playtest_scenario` in the same turn, or have the game generate load by itself.

## A method

1. Baseline `perf_stats` during a test.
2. Look at `classes` for unexpected counts, and `movingPrimitives` for unanchored clutter.
3. `profile_scripts` while the slow thing happens.
4. Read the top functions with `script_outline`, then the code.
5. Change one thing and measure again.

## What usually costs the most

| Symptom | Likely cause | Fix |
|---|---|---|
| Low FPS, many `primitives` | Too many parts | Merge detail, use MeshParts, enable `StreamingEnabled` |
| High `physicsStepTimeMs` | Unanchored parts, complex collisions | Anchor scenery, `CanCollide` false on decoration, simpler `CollisionFidelity` |
| Heartbeat spikes | Heavy per-frame scripts | Run less often, cache lookups |
| Memory grows steadily | Connections or tables never released | Disconnect, clear on removal |
| Light-related stutter | Many shadow-casting lights | `Shadows` false on minor lights |
| High data rates | Remotes fired every frame | Throttle, use `UnreliableRemoteEvent` |

`find` helps locate candidates:

```call
find {"class":"BasePart","root":"Workspace","limit":200}
```

## Gotchas

- Studio's numbers run with Studio's overhead, so they are for comparing, not absolute values.
- The MicroProfiler has no API. See [limits-and-known-gaps](limits-and-known-gaps.md).
- The profiler is refused in edit mode, since game scripts do not run there.
