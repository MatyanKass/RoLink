-- Tests for the play-test modules: Output (ring buffer), Scenario (T helpers),
-- Playtest (start/stop/status against a fake StudioTestService).

local H = ...
local luau = require("@lune/luau")
local task = require("@lune/task")
local roblox = H.roblox
local Vector3, CFrame = roblox.Vector3, roblox.CFrame
local check = H.check

local function fakeGame(services)
	return {
		GetService = function(_, name)
			local s = services[name]
			if not s then
				error("no service " .. name)
			end
			return s
		end,
	}
end

local function fakeSignal()
	local handlers = {}
	return {
		Connect = function(_, fn)
			table.insert(handlers, fn)
			return { Disconnect = function() end }
		end,
		fire = function(_, ...)
			for _, fn in handlers do
				fn(...)
			end
		end,
	}
end

local function loadstringShim(src, chunk)
	local ok, f = pcall(luau.load, src, { debugName = chunk, environment = { Vector3 = Vector3, CFrame = CFrame, os = os } })
	if ok then
		return f
	end
	return nil, f
end

local Output = H.require("Output")

-------------------------------------------------------------------------------
H.section("Output ring buffer")

do
	local r = Output.new({ capacity = 100, base = 1000 })
	local a = r:add("output", "first")
	local b = r:add("warning", "second")
	check(a.seq == 1001 and b.seq == 1002, "sequence numbers increase from the base")
	local got = r:read({ since = a.seq })
	check(#got.entries == 1 and got.entries[1].text == "second", "since returns only newer entries")
	check(got.next == b.seq, "next cursor is the last seq")
	local empty = r:read({ since = got.next })
	check(#empty.entries == 0 and empty.next == b.seq, "polling at the cursor returns nothing new")
end

do
	local r = Output.new({ capacity = 3, base = 0 })
	for i = 1, 5 do
		r:add("output", "m" .. i)
	end
	local got = r:read({ since = 0 })
	check(#got.entries == 3 and got.entries[1].text == "m3", "ring keeps only the newest entries")
	check(got.entries[3].seq == 5, "seq keeps counting past capacity")
	check(got.missed == 2, "reports entries lost to eviction: " .. tostring(got.missed))
	check(r:read({ since = 3 }).missed == 0, "no gap when the cursor is inside the ring")
end

do
	local r = Output.new({ capacity = 100, base = 0 })
	r:add("output", "Hello World")
	r:add("error", "bad thing")
	r:add("warning", "careful")
	r:add("info", "note")
	local e = r:read({ level = "error" })
	check(#e.entries == 1 and e.entries[1].text == "bad thing", "level filter")
	local several = r:read({ level = { "error", "warning" } })
	check(#several.entries == 2, "several levels")
	local c = r:read({ contains = "hello" })
	check(#c.entries == 1 and c.entries[1].level == "output", "contains is case-insensitive")
	local special = r:read({ contains = "bad%" })
	check(#special.entries == 0, "contains is a plain substring, not a pattern")
	check(e.next == r:lastSeq(), "a filtered read still advances the cursor to the end")
end

do
	local r = Output.new({ capacity = 100, base = 0 })
	for i = 1, 10 do
		r:add("output", "m" .. i)
	end
	local first = r:read({ since = 0, limit = 4 })
	check(#first.entries == 4 and first.entries[1].text == "m1" and first.truncated == true, "since + limit is oldest-first")
	check(first.next == 4, "cursor stops at the last returned entry")
	local second = r:read({ since = first.next, limit = 100 })
	check(#second.entries == 6 and second.entries[1].text == "m5" and not second.truncated, "next read continues")
	local tail = r:read({ limit = 3 })
	check(#tail.entries == 3 and tail.entries[1].text == "m8" and tail.entries[3].text == "m10", "no since = newest entries, in order")
	check(#r:read({}).entries == 10, "default limit returns everything small")
	check(#r:read({ limit = 0 }).entries == 0 or #r:read({ limit = 0 }).entries == 1, "limit 0 does not error")
end

do
	local old = Output.new({ now = function()
		return 1800000000
	end })
	old:add("output", "x")
	local newer = Output.new({ now = function()
		return 1800000100
	end })
	local e = newer:add("output", "y")
	check(e.seq > old:lastSeq(), "a later plugin instance continues above earlier cursors")
	check(#newer:read({ since = old:lastSeq() }).entries == 1, "stale cursor from the previous test reads the new test")
	check(newer:read({ since = old:lastSeq() }).missed == 0, "a previous test's cursor is not a gap")
end

do
	local r = Output.new({ capacity = 10, base = 0, maxText = 8 })
	local e = r:add("output", string.rep("a", 50))
	check(#e.text <= 8 + 16 and string.find(e.text, "truncated", 1, true) ~= nil, "huge messages are cut: " .. e.text)
end

do -- stack traces: ScriptContext.Error and MessageOut in either order, one entry
	local r = Output.new({ capacity = 100, base = 0 })
	r:addMessage("error", "Script:3: boom")
	r:addError("Script:3: boom", "Script, line 3", "ServerScriptService.Script")
	local one = r:read({ level = "error" })
	check(#one.entries == 1, "MessageOut then Error merges")
	check(one.entries[1].stack == "Script, line 3" and one.entries[1].script == "ServerScriptService.Script", "stack attached")

	local r2 = Output.new({ capacity = 100, base = 0 })
	r2:addError("Script:9: late", "stack9", "S")
	r2:addMessage("error", "Script:9: late")
	local two = r2:read({ level = "error" })
	check(#two.entries == 1 and two.entries[1].stack == "stack9", "Error then MessageOut merges")

	local r3 = Output.new({ capacity = 100, base = 0 })
	r3:addMessage("error", "same")
	r3:addError("same", "s1", "S")
	r3:addMessage("error", "same")
	r3:addError("same", "s2", "S")
	local three = r3:read({ level = "error" })
	check(#three.entries == 2 and three.entries[1].stack == "s1" and three.entries[2].stack == "s2", "repeated errors stay separate")

	local r4 = Output.new({ capacity = 100, base = 0 })
	r4:addError("Error only", "s", "S")
	check(r4:read({ level = "error" }).entries[1].text == "Error only", "error event alone still recorded")
	check(string.find(r4:read({}).entries[1].stack, "s", 1, true) ~= nil, "with its stack")
end

do -- attach: backfills history and listens
	local r = Output.new({ capacity = 100, base = 0 })
	local out, err = fakeSignal(), fakeSignal()
	local log = {
		MessageOut = out,
		GetLogHistory = function()
			return { { message = "early", messageType = roblox.Enum.MessageType.MessageOutput, timestamp = 5 } }
		end,
	}
	r:attach(log, { Error = err })
	out:fire("live", roblox.Enum.MessageType.MessageWarning)
	err:fire("Script:1: x", "st", { GetFullName = function()
		return "SSS.Script"
	end })
	local all = r:read({ limit = 100 })
	check(#all.entries == 3 and all.entries[1].text == "early", "history backfilled before live messages")
	check(all.entries[2].level == "warning", "message types mapped")
	check(all.entries[3].level == "error" and all.entries[3].stack == "st" and all.entries[3].script == "SSS.Script", "script errors captured with stack")

	local r2 = Output.new({ capacity = 100, base = 0 })
	r2:attach({ MessageOut = fakeSignal(), GetLogHistory = function()
		error("not allowed")
	end }, { Error = fakeSignal() })
	check(#r2:read({}).entries == 0, "history failure is ignored")
end

-------------------------------------------------------------------------------
H.section("Scenario (T helpers)")

local function character(start)
	local char = { Name = "Char", pivot = start or CFrame.new() }
	function char:GetPivot()
		return self.pivot
	end
	function char:PivotTo(cf)
		self.pivot = cf
	end
	return char
end

local function newScenario(players, context)
	local serviceTable = { Players = players or { GetPlayers = function()
		return {}
	end } }
	local S = H.requireWith("Scenario", { game = fakeGame(serviceTable), loadstring = loadstringShim })
	local ring = Output.new({ capacity = 1000, base = 0 })
	return function(source, extra)
		local args = { source = source, timeout = 2 }
		for k, v in extra or {} do
			args[k] = v
		end
		return S.run(args, { output = ring, context = context or "server", quiet = true })
	end, ring, S
end

do
	local run = newScenario()
	local rep = run([[
		T.step("adds", function() T.equal(1 + 1, 2) end)
		T.step("truthy", function() T.assert(true, "never") end)
		return "done", 7
	]])
	check(rep.ok == true, "all-passing report ok: " .. tostring(rep.error))
	check(#rep.steps == 2 and rep.steps[1].name == "adds" and rep.steps[1].ok == true, "steps recorded in order")
	check(type(rep.steps[1].duration) == "number", "step duration")
	check(type(rep.duration) == "number" and rep.timedOut == false, "run duration, no timeout")
	check(rep.summary == "2/2 steps passed", "summary: " .. tostring(rep.summary))
	check(rep.returns[1] == "done" and rep.returns[2] == 7, "scenario returns")
	check(rep.context == "server", "context reported")
	check(H.serde.decode("json", H.serde.encode("json", rep)).ok == true, "report is JSON-encodable")
end

do -- a failing step must not stop the rest
	local run = newScenario()
	local rep = run([[
		local ok = T.step("bad", function() T.assert(false, "nope") end)
		T.step("after", function() T.set("ranAfter", true) end)
		return ok
	]])
	check(rep.ok == false, "report fails")
	check(#rep.steps == 2 and rep.steps[1].ok == false and rep.steps[2].ok == true, "later steps still run")
	check(string.find(rep.steps[1].message, "nope", 1, true) ~= nil, "failure message: " .. tostring(rep.steps[1].message))
	check(rep.summary == "1/2 steps passed", "partial summary")
	check(rep.returns[1] == false, "T.step returns false on failure")
	check(rep.error == nil, "a failed step is not a scenario error")
end

do
	local run = newScenario()
	local rep = run([[T.step("eq", function() T.equal(1, 2, "numbers") end)]])
	local m = rep.steps[1].message
	check(string.find(m, "numbers", 1, true) ~= nil and string.find(m, "1", 1, true) ~= nil and string.find(m, "2", 1, true) ~= nil, "T.equal shows both values: " .. m)
	check(type(rep.steps[1].traceback) == "string", "failure has a traceback")
	local rep2 = run([[T.step("deep", function() T.equal({ a = { 1, 2 } }, { a = { 1, 2 } }) end)]])
	check(rep2.steps[1].ok == true, "T.equal compares plain tables by value")
	local rep3 = run([[T.step("deep2", function() T.equal({ a = 1 }, { a = 2 }) end)]])
	check(rep3.steps[1].ok == false, "T.equal notices differing tables")
	local rep4 = run([[T.step("step returns", function() return 1 end) ; local a, b = T.step("v", function() return 42 end); return a, b]])
	check(rep4.returns[1] == true and rep4.returns[2] == 42, "T.step returns true and the value")
end

do -- errors outside steps keep the finished steps
	local run = newScenario()
	local rep = run([[
		T.step("ok", function() end)
		error("top level exploded")
	]])
	check(rep.ok == false and string.find(rep.error, "top level exploded", 1, true) ~= nil, "scenario error reported: " .. tostring(rep.error))
	check(#rep.steps == 1 and rep.steps[1].ok == true, "finished steps survive")
	check(type(rep.traceback) == "string", "scenario traceback")
end

do
	local run = newScenario()
	local rep = run("this is not lua (")
	check(rep.ok == false and string.find(rep.error, "compile error", 1, true) ~= nil, "compile errors come back as a report: " .. tostring(rep.error))
	check(#rep.steps == 0, "no steps ran")
	local empty = run("")
	check(empty.ok == true and #empty.steps == 0, "empty scenario is fine")
	local noSource = H.requireWith("Scenario", { game = fakeGame({}), loadstring = loadstringShim })
	check(not pcall(noSource.run, {}, { context = "server", quiet = true, output = Output.new({ base = 0 }) }), "missing source errors")
end

do -- timeout cancels the code
	local run, _, S = newScenario()
	local rep = run([[
		T.step("fast", function() end)
		T.step("slow", function()
			T.wait(0.4)
			T.set("shouldNotRun", true)
		end)
	]], { timeout = 0.15 })
	check(rep.timedOut == true and rep.ok == false, "timed out")
	check(#rep.steps == 2 and rep.steps[1].ok == true and rep.steps[2].ok == false, "unfinished step reported failed")
	check(string.find(rep.steps[2].message, "timed out", 1, true) ~= nil, "step message mentions timeout")
	check(string.find(rep.error, "timed out", 1, true) ~= nil, "report error mentions timeout")
	task.wait(0.5)
	check(S.vars.shouldNotRun == nil, "cancelled code does not continue")
end

do -- vars cross steps and scenarios
	local run = newScenario()
	run([[T.step("a", function() T.set("gold", 5) end)]])
	local rep = run([[
		T.step("b", function() T.equal(T.get("gold"), 5) end)
		T.set("other", T.get("gold") + 1)
		return T.get("other"), T.get("missing")
	]])
	check(rep.ok == true, "vars survive between scenarios")
	check(rep.returns[1] == 6 and rep.returns[2] == nil, "T.get")
end

do -- T.wait / T.waitFor
	local run = newScenario()
	local rep = run([[
		local t0 = os.clock()
		local dt = T.wait(0.02)
		T.assert(dt ~= nil and dt >= 0, "wait returns time")
		local n = 0
		local v = T.waitFor(function() n += 1; return n >= 3 and "ready" end, 1)
		T.equal(v, "ready")
		return n
	]])
	check(rep.ok == true, "waitFor resolves: " .. tostring(rep.error))
	check(rep.returns[1] >= 3, "predicate polled")

	local rep2 = run([[T.step("w", function() T.waitFor(function() return false end, 0.05, "door opens") end)]])
	check(rep2.steps[1].ok == false and string.find(rep2.steps[1].message, "door opens", 1, true) ~= nil, "waitFor timeout message: " .. rep2.steps[1].message)

	local rep3 = run([[
		local n = 0
		return T.waitFor(function()
			n += 1
			if n < 3 then error("not yet") end
			return n
		end, 1)
	]])
	check(rep3.ok == true and rep3.returns[1] == 3, "predicate errors are retried")

	local rep4 = run([[T.step("e", function() T.waitFor(function() error("always broken") end, 0.05) end)]])
	check(string.find(rep4.steps[1].message, "always broken", 1, true) ~= nil, "timeout keeps the last predicate error: " .. rep4.steps[1].message)
end

do -- T.player / T.character / T.teleport
	local char = character(CFrame.new(1, 2, 3) * CFrame.Angles(0, math.rad(90), 0))
	local plr = { Name = "Tester", Character = char }
	local players = { GetPlayers = function()
		return { plr }
	end }
	local run = newScenario(players)
	local rep = run([[
		T.equal(T.player().Name, "Tester")
		T.equal(T.character().Name, "Char")
		T.teleport(Vector3.new(10, 20, 30))
		return T.character():GetPivot()
	]])
	check(rep.ok == true, "player/character/teleport: " .. tostring(rep.error))
	H.near(char.pivot.Position, Vector3.new(10, 20, 30), "teleport to a Vector3 moves")
	H.near(char.pivot.LookVector, (CFrame.Angles(0, math.rad(90), 0)).LookVector, "teleport to a Vector3 keeps the facing")

	local target = CFrame.new(5, 6, 7) * CFrame.Angles(0, 1, 0)
	local S = H.requireWith("Scenario", { game = fakeGame({ Players = players }), loadstring = loadstringShim })
	local rep2 = S.run({ source = "T.teleport(args)", args = target, timeout = 1 }, { output = Output.new({ base = 0 }), context = "server", quiet = true })
	check(rep2.ok == true, "teleport cframe: " .. tostring(rep2.error))
	H.near(char.pivot, target, "teleport to a CFrame is exact")

	local rep3 = run([[T.step("bad", function() T.teleport("somewhere") end)]])
	check(rep3.steps[1].ok == false, "teleport rejects other types")

	local none = newScenario()
	local rep4 = none([[T.step("p", function() T.player(0.05) end)]])
	check(rep4.steps[1].ok == false and string.find(rep4.steps[1].message, "run", 1, true) ~= nil, "no player mentions Run mode: " .. rep4.steps[1].message)

	local late = { Name = "Late", Character = nil }
	local runLate = newScenario({ GetPlayers = function()
		return { late }
	end })
	task.delay(0.05, function()
		late.Character = character()
	end)
	local rep5 = runLate([[return T.character(1).Name]])
	check(rep5.ok == true and rep5.returns[1] == "Char", "character waits for spawn: " .. tostring(rep5.error))

	local lp = { Name = "Local", Character = character() }
	local runClient = newScenario({ LocalPlayer = lp, GetPlayers = function()
		return {}
	end }, "client")
	local rep6 = runClient([[return T.player().Name]])
	check(rep6.returns[1] == "Local", "client context uses LocalPlayer")
end

do -- logs and errors
	local run, ring = newScenario()
	local gameLine = ring:add("output", "before the run")
	local rep = run([[
		T.log("hello", 1, true)
		print("from print")
		warn("from warn")
		T.step("s", function()
			T.log("in step")
			print("printed in step")
		end)
	]])
	check(rep.ok == true, "logging run: " .. tostring(rep.error))
	check(#rep.steps[1].logs == 2 and rep.steps[1].logs[1] == "in step" and rep.steps[1].logs[2] == "printed in step", "step logs")
	local joined = table.concat(rep.logs, "\n")
	check(string.find(joined, "hello 1 true", 1, true) ~= nil, "T.log in report logs: " .. joined)
	check(string.find(joined, "[warn] from warn", 1, true) ~= nil, "warn tagged in report logs")
	check(string.find(joined, "before the run", 1, true) == nil, "only output from this run")
	check(gameLine.seq ~= nil, "ring in use")

	local run2, ring2 = newScenario()
	local rep2 = run2([[
		T.step("noisy", function()
			T.set("x", 1)
			args.ring:addError("Game.Script:1: gameplay broke", "Game.Script, line 1", "Game.Script")
			args.ring:add("output", "game print")
		end)
	]], { args = { ring = ring2 } })
	check(rep2.ok == true, "a game-script error does not fail a step")
	check(#rep2.errors == 1 and rep2.errors[1].stack == "Game.Script, line 1", "errors with stack traces: " .. #rep2.errors)
	check(rep2.errors[1].step == "noisy", "error attributed to its step")
	check(#rep2.steps[1].errors == 1, "error listed on the step")
	check(rep2.output.lastSeq == ring2:lastSeq(), "output cursor returned")
	local lines = table.concat(rep2.logs, "\n")
	check(string.find(lines, "game print", 1, true) ~= nil, "game prints appear in report logs: " .. lines)
end

do -- a chatty run keeps the newest lines and says how many it dropped
	local run = newScenario()
	local rep = run([[for i = 1, 350 do T.log("line", i) end]])
	check(#rep.logs == 300 and rep.logsDropped == 50, "report logs bounded: " .. #rep.logs)
	check(rep.logs[300] == "line 350" and rep.logs[1] == "line 51", "newest lines kept: " .. tostring(rep.logs[1]))
end

-------------------------------------------------------------------------------
H.section("Playtest start/stop/status")

local function fakeStudio(opts)
	opts = opts or {}
	local studio = { EditModeActive = opts.editActive ~= false, calls = {}, finish = nil }
	local function execute(self, kind, arg)
		table.insert(self.calls, { kind = kind, arg = arg })
		if opts.fail then
			error(opts.fail)
		end
		self.EditModeActive = false
		while self.finish == nil do
			task.wait(0.01)
		end
		self.EditModeActive = true
		local v = self.finish
		self.finish = nil
		return v
	end
	function studio:ExecutePlayModeAsync(arg)
		return execute(self, "play", arg)
	end
	function studio:ExecuteRunModeAsync(arg)
		return execute(self, "run", arg)
	end
	function studio:EndTest(v)
		self.ended = v
	end
	return studio
end

local function fakeRun(ctx, isRun)
	return {
		IsEdit = function()
			return ctx == "edit"
		end,
		IsServer = function()
			return ctx ~= "client"
		end,
		IsRunMode = function()
			return isRun == true
		end,
	}
end

local function fakePlugin()
	local store = {}
	return {
		store = store,
		GetSetting = function(_, k)
			return store[k]
		end,
		SetSetting = function(_, k, v)
			store[k] = v
		end,
	}
end

local function newPlaytest(ctx, studio, players, isRun, extra)
	local services = {
		StudioTestService = studio,
		RunService = fakeRun(ctx, isRun),
		Players = players or { GetPlayers = function()
			return {}
		end },
		LogService = { MessageOut = fakeSignal(), GetLogHistory = function()
			return {}
		end },
		ScriptContext = { Error = fakeSignal() },
	}
	local overrides = { game = fakeGame(services), loadstring = loadstringShim }
	for k, v in extra or {} do
		overrides[k] = v
	end
	local P = H.requireWith("Playtest", overrides)
	local pl = fakePlugin()
	P.init(pl, { noMonitor = true })
	return P, pl
end

do
	local studio = fakeStudio()
	local P = newPlaytest("edit", studio)
	local t0 = os.clock()
	local r = P.start({ mode = "play" })
	check(os.clock() - t0 < 1.5, "start does not block until the test ends")
	check(r.started == true and r.mode == "play", "start reports started")
	check(studio.calls[1].kind == "play", "ExecutePlayModeAsync called")
	local st = P.status({})
	check(st.running == true and st.editModeActive == false and st.mode == "play", "status while running")

	local ok, err = pcall(P.start, { mode = "play" })
	check(not ok and string.find(tostring(err), "already running", 1, true) ~= nil, "second start refused: " .. tostring(err))
	check(#studio.calls == 1, "second start did not call Studio")

	studio.finish = "bye"
	task.wait(0.05)
	local st2 = P.status({})
	check(st2.running == false and st2.editModeActive == true, "status after the test ended")
	check(st2.lastResult == "bye", "EndTest value kept: " .. tostring(st2.lastResult))
end

do
	local studio = fakeStudio()
	local P = newPlaytest("edit", studio)
	local r = P.start({ mode = "run" })
	check(r.mode == "run" and studio.calls[1].kind == "run", "run mode uses ExecuteRunModeAsync")
	studio.finish = "x"
	task.wait(0.05)
end

do -- a test the user started with the Play button
	local studio = fakeStudio({ editActive = false })
	local P = newPlaytest("edit", studio)
	local ok, err = pcall(P.start, { mode = "play" })
	check(not ok and string.find(tostring(err), "already running", 1, true) ~= nil, "user test blocks start: " .. tostring(err))
	check(#studio.calls == 0, "Studio not called")
	check(P.status({}).running == true, "user-started test counts as running")
end

do -- Studio refuses / API missing: actionable error
	local studio = fakeStudio({ fail = "Previous call to start play session has not been completed" })
	local P = newPlaytest("edit", studio)
	local ok, err = pcall(P.start, { mode = "play" })
	err = tostring(err)
	check(not ok, "start fails when Studio refuses")
	check(string.find(err, "press Play", 1, true) ~= nil and string.find(err, "playtest_status", 1, true) ~= nil, "error tells the agent what to do: " .. err)
	check(string.find(err, "Previous call", 1, true) ~= nil, "includes Studio's message")
	check(P.status({}).lastError ~= nil and P.status({}).running == false, "failure kept in status")

	local noApi = H.requireWith("Playtest", {
		game = fakeGame({ RunService = fakeRun("edit"), LogService = { MessageOut = fakeSignal() }, ScriptContext = { Error = fakeSignal() } }),
		loadstring = loadstringShim,
	})
	noApi.init(fakePlugin())
	local ok2, err2 = pcall(noApi.start, { mode = "play" })
	check(not ok2 and string.find(tostring(err2), "press Play", 1, true) ~= nil, "missing service is actionable: " .. tostring(err2))
end

do
	local P = newPlaytest("edit", fakeStudio())
	check(not pcall(P.start, { mode = "bogus" }), "bad mode refused")
	local studio = fakeStudio()
	local S = newPlaytest("server", studio)
	local ok, err = pcall(S.start, { mode = "play" })
	check(not ok and string.find(tostring(err), "edit", 1, true) ~= nil, "start only from edit context: " .. tostring(err))
end

do -- server context: info + EndTest
	local studio = fakeStudio({ editActive = false })
	local players = { GetPlayers = function()
		return { { Name = "A" }, { Name = "B" } }
	end }
	local P = newPlaytest("server", studio, players, true)
	local st = P.status({})
	check(st.context == "server" and st.isRunMode == true and #st.players == 2 and st.players[1] == "A", "server status")
	local r = P.endTest({})
	check(r.ending == true, "endTest acknowledges first")
	check(studio.ended == nil, "EndTest runs after the reply can be sent")
	task.wait(0.4)
	check(studio.ended ~= nil, "EndTest called: " .. tostring(studio.ended))

	local E = newPlaytest("edit", fakeStudio())
	local ok, err = pcall(E.endTest, {})
	check(not ok and string.find(tostring(err), "server", 1, true) ~= nil, "EndTest refused outside the server context: " .. tostring(err))
end

do -- fallback stop channel through plugin settings
	local editStudio = fakeStudio({ editActive = false })
	local E, edPl = newPlaytest("edit", editStudio)
	local r = E.requestStop({})
	check(r.requested == true and edPl.store.RoLinkStopRequest == true, "edit context raises the flag")

	local studio = fakeStudio({ editActive = false })
	local S, svPl = newPlaytest("server", studio)
	check(svPl.store.RoLinkStopRequest ~= true, "server clears a stale flag at startup")
	svPl.store.RoLinkStopRequest = true
	S.checkStopRequest()
	check(studio.ended ~= nil and svPl.store.RoLinkStopRequest == false, "server honours and clears the flag")
	studio.ended = nil
	S.checkStopRequest()
	check(studio.ended == nil, "flag is one-shot")
end

do -- scenario wrapper and output read are wired to the shared ring
	local players = { GetPlayers = function()
		return {}
	end }
	local P = newPlaytest("server", fakeStudio({ editActive = false }), players)
	local rep = P.scenario({ source = "T.step('a', function() end)", timeout = 1 })
	check(rep.ok == true and rep.context == "server", "scenario op")
	P.output():add("error", "something")
	local r = P.readOutput({ level = "error" })
	check(#r.entries == 1 and r.context == "server", "output op")
end

do -- Ops wiring
	local Ops = H.requireWith("Ops", { plugin = nil })
	for _, op in { "playtest_start", "playtest_status", "playtest_end", "playtest_request_stop", "playtest_scenario", "output_read" } do
		check(type(Ops[op]) == "function", "op registered: " .. op)
	end
	check(Ops.immediate.output_read and Ops.immediate.playtest_status and Ops.immediate.playtest_end, "observing ops bypass the worker queue")
	check(not Ops.immediate.playtest_scenario, "scenarios use the worker")
	check(not Ops.mutating.playtest_scenario, "scenarios are not undo steps")
end
