-- Tests for editor helpers (Editor), performance tools (Perf), multiplayer
-- tests (Playtest) and T.players (Scenario). Services the harness cannot
-- simulate are fakes passed through H.requireWith.

local H = ...
local roblox = H.roblox
local luau = require("@lune/luau")
local task = require("@lune/task")
local Instance, Vector3, CFrame = roblox.Instance, roblox.Vector3, roblox.CFrame
local check, near = H.check, H.near
local ws = H.workspace

-- a game whose listed services are fakes; the rest are the harness's real ones
local function fakeGame(services)
	return {
		GetService = function(_, name)
			local s = services[name]
			if s then
				return s
			end
			return H.game:GetService(name)
		end,
		GetChildren = function()
			return H.game:GetChildren()
		end,
	}
end

local function fakeRun(context)
	return {
		IsEdit = function()
			return context == "edit"
		end,
		IsServer = function()
			return context == "server" or context == "edit"
		end,
		Heartbeat = {
			Connect = function(_, fn)
				local alive = true
				task.spawn(function()
					for _ = 1, 4 do
						task.wait(0.01)
						if alive then
							fn(0.02)
						end
					end
				end)
				return {
					Disconnect = function()
						alive = false
					end,
				}
			end,
		},
	}
end

local function loadstringShim(src, chunk)
	local ok, f = pcall(luau.load, src, { debugName = chunk })
	if ok then
		return f
	end
	return nil, f
end

local function part(name, parent, x, sizeX)
	local p = Instance.new("Part")
	p.Name = name
	p.Size = Vector3.new(sizeX or 2, 2, 2)
	p.CFrame = CFrame.new(x, 5, 0)
	p.Parent = parent
	return p
end

local Editor = H.require("Editor")

-------------------------------------------------------------------------------
H.section("Editor: align and distribute")

do
	local folder = Instance.new("Folder")
	folder.Name = "Al"
	folder.Parent = ws
	local a = part("A", folder, 0, 2)
	local b = part("B", folder, 10, 4)
	local c = part("C", folder, -5, 2)
	local paths = { "Workspace/Al/A", "Workspace/Al/B", "Workspace/Al/C" }

	local r = Editor.align({ paths = paths, axis = "x", to = "max" })
	check(#r.moved == 3, "align reports every target")
	near(a.CFrame.Position.X + 1, 12, "A's right edge reaches the union's")
	near(b.CFrame.Position.X + 2, 12, "B stays at the far edge")
	near(c.CFrame.Position.X + 1, 12, "C's right edge too")
	near(a.CFrame.Position.Y, 5, "the other axes do not move")

	a.CFrame = CFrame.new(0, 5, 0)
	b.CFrame = CFrame.new(10, 5, 0)
	Editor.align({ paths = { "Workspace/Al/A", "Workspace/Al/B" }, axis = "x", to = "center", relativeTo = "first" })
	near(a.CFrame.Position.X, 0, "the first target does not move")
	near(b.CFrame.Position.X, 0, "the next is centred on the first")

	Editor.align({ paths = { "Workspace/Al/A" }, axis = "z", to = "min", value = -7 })
	near(a.CFrame.Position.Z - 1, -7, "an explicit value sets the edge")

	check(not pcall(Editor.align, { paths = paths, axis = "w", to = "max" }), "bad axis refused")
	check(not pcall(Editor.align, { paths = paths, axis = "x", to = "middle" }), "bad to refused")

	local notes = Instance.new("Folder")
	notes.Name = "N"
	notes.Parent = folder
	local okFolder, errFolder = pcall(Editor.align, { paths = { "Workspace/Al/N" }, axis = "x", to = "min" })
	check(not okFolder and string.find(tostring(errFolder), "cannot", 1, true) ~= nil, "a folder cannot be moved as a whole: " .. tostring(errFolder))
	folder:Destroy()
end

do
	local folder = Instance.new("Folder")
	folder.Name = "Di"
	folder.Parent = ws
	local p1 = part("P1", folder, 0, 2)
	local p2 = part("P2", folder, 3, 2)
	local p3 = part("P3", folder, 9, 2)
	local p4 = part("P4", folder, 20, 2)
	local paths = { "Workspace/Di/P3", "Workspace/Di/P1", "Workspace/Di/P4", "Workspace/Di/P2" }

	local r = Editor.distribute({ paths = paths, axis = "x" })
	near(r.gap, 14 / 3, "the gap is reported")
	near(p1.CFrame.Position.X, 0, "the first stays")
	near(p4.CFrame.Position.X, 20, "the last stays")
	near(p2.CFrame.Position.X, 0 + 2 + 14 / 3, "second is one gap further")
	near(p3.CFrame.Position.X, 0 + 4 + 28 / 3, "third is two gaps further")

	Editor.distribute({ paths = paths, axis = "x", spacing = 1 })
	near(p1.CFrame.Position.X, 0, "spacing starts from the first")
	near(p2.CFrame.Position.X, 3, "edge-to-edge gap of 1")
	near(p3.CFrame.Position.X, 6, "next gap")
	near(p4.CFrame.Position.X, 9, "the last moves when spacing is given")

	check(not pcall(Editor.distribute, { paths = { "Workspace/Di/P1", "Workspace/Di/P2" }, axis = "x" }), "two targets need a spacing")
	Editor.distribute({ paths = { "Workspace/Di/P1", "Workspace/Di/P2" }, axis = "x", spacing = 4 })
	near(p2.CFrame.Position.X, 6, "two targets work with a spacing")
	folder:Destroy()
end

-------------------------------------------------------------------------------
H.section("Editor: weld_model")

do
	local m = Instance.new("Model")
	m.Name = "Wm"
	m.Parent = ws
	local main = part("Main", m, 0, 8)
	local b = part("B", m, 10, 2)
	local c = part("C", m, -10, 2)

	local r = Editor.weld_model({ path = "Workspace/Wm" })
	check(r.created == 2 and r.root == "Main", "welds the others to the largest part")
	local welds = {}
	for _, d in m:GetDescendants() do
		if d:IsA("WeldConstraint") then
			table.insert(welds, d)
		end
	end
	check(#welds == 2, "two WeldConstraints exist")
	check(welds[1].Part0 == main and (welds[1].Part1 == b or welds[1].Part1 == c), "root is Part0")
	check(welds[1].Name == "RoLinkWeld", "named so they can be found again")

	local again = Editor.weld_model({ path = "Workspace/Wm" })
	check(again.created == 0 and again.skipped == 2, "running it twice adds nothing")

	main.Anchored, b.Anchored = true, true
	local un = Editor.weld_model({ path = "Workspace/Wm", unanchor = true, root = "B" })
	check(un.root == "B" and main.Anchored == false and b.Anchored == false, "unanchor and an explicit root")

	check(not pcall(Editor.weld_model, { path = "Workspace/Wm", root = "Nope" }), "unknown root refused")
	local empty = Instance.new("Folder")
	empty.Name = "E"
	empty.Parent = ws
	check(not pcall(Editor.weld_model, { path = "Workspace/E" }), "nothing to weld is refused")
	empty:Destroy()
	m:Destroy()
end

-------------------------------------------------------------------------------
H.section("Editor: collision groups")

do
	local registered = { Default = true }
	local calls = {}
	local physics = {}
	function physics:IsCollisionGroupRegistered(name)
		return registered[name] == true
	end
	function physics:RegisterCollisionGroup(name)
		registered[name] = true
	end
	function physics:CollisionGroupSetCollidable(a, b, on)
		if a == "Bad" then
			error("server only")
		end
		table.insert(calls, { a, b, on })
	end
	function physics:GetRegisteredCollisionGroups()
		local out = {}
		for name in registered do
			table.insert(out, { name = name, mask = 1 })
		end
		return out
	end
	function physics:CollisionGroupsAreCollidable()
		return false
	end
	function physics:GetMaxCollisionGroups()
		return 32
	end
	local E = H.requireWith("Editor", { game = fakeGame({ PhysicsService = physics }) })

	local folder = Instance.new("Model")
	folder.Name = "Cg"
	folder.Parent = ws
	local p = part("P", folder, 0, 2)

	local r = E.set_collision_groups({
		register = { "Players", "Doors" },
		rules = { { a = "Players", b = "Doors", collide = false } },
		assign = { { paths = "Workspace/Cg", group = "Doors" } },
	})
	check(registered.Players and registered.Doors, "groups registered")
	check(#calls == 1 and calls[1][1] == "Players" and calls[1][3] == false, "collision rule applied")
	check(p.CollisionGroup == "Doors", "descendant parts assigned: " .. tostring(p.CollisionGroup))
	check(r.assigned == 1, "assignment count")
	check(#r.groups >= 3, "registered groups returned")

	local okUnknown, errUnknown = pcall(E.set_collision_groups, { assign = { { paths = "Workspace/Cg", group = "Ghosts" } } })
	check(not okUnknown and string.find(tostring(errUnknown), "Ghosts", 1, true) ~= nil, "assigning an unregistered group is refused")
	check(p.CollisionGroup == "Doors", "the refused assignment changed nothing")

	local w = E.set_collision_groups({ rules = { { a = "Bad", b = "Doors", collide = false } } })
	check(#w.warnings == 1 and string.find(w.warnings[1], "server only", 1, true) ~= nil, "a refused rule is reported as a warning")
	folder:Destroy()
end

-------------------------------------------------------------------------------
H.section("Editor: select_and_focus")

do
	local View = H.require("View")
	local framed
	local saved = View.frame
	View.frame = function(a)
		framed = a
	end
	local selected
	local E = H.requireWith("Editor", { game = fakeGame({ Selection = { Set = function(_, list)
		selected = list
	end } }) })
	local p = part("Focus", ws, 0, 2)
	local r = E.select_and_focus({ paths = "Workspace/Focus", distance = 0.5 })
	check(#selected == 1 and selected[1] == p, "selects the target")
	check(framed.targets == "Workspace/Focus" and framed.view == "iso" and framed.distance == 0.5, "frames the camera on it")
	check(#r.selection == 1 and r.focused == true, "reports what happened")

	View.frame = function()
		error("targets have no spatial bounds", 0)
	end
	local r2 = E.select_and_focus({ paths = "Workspace/Focus" })
	check(r2.focused == false and r2.note ~= nil, "selection still works when there is nothing to frame")
	View.frame = saved
	p:Destroy()
end

-------------------------------------------------------------------------------
H.section("Editor: script_search")

do
	local folder = Instance.new("Folder")
	folder.Name = "Code"
	folder.Parent = ws
	local function script(name, src)
		local s = Instance.new("Script")
		s.Name = name
		s.Source = src
		s.Parent = folder
		return s
	end
	script("A", "local Coin = 1\nprint('coin')\nprint('no')")
	script("B", "-- nothing here")
	script("C", "local coins = 2")

	local r = Editor.script_search({ query = "coin", root = "Workspace/Code" })
	check(r.total == 3 and r.scripts == 2, "case-insensitive by default: " .. r.total)
	local first = r.matches[1]
	check(first.path == "Workspace/Code/A" and first.line == 1 and string.find(first.text, "Coin", 1, true) ~= nil, "path, line and text")

	local cs = Editor.script_search({ query = "coin", root = "Workspace/Code", caseSensitive = true })
	check(cs.total == 2, "caseSensitive narrows it: " .. cs.total)
	local plain = Editor.script_search({ query = "coin.", root = "Workspace/Code" })
	check(plain.total == 0, "the query is plain text by default")
	local pat = Editor.script_search({ query = "^local %a+ = %d", root = "Workspace/Code", pattern = true })
	check(pat.total == 2, "pattern mode: " .. pat.total)
	check(not pcall(Editor.script_search, { query = "[", root = "Workspace/Code", pattern = true }), "a broken pattern is refused")
	check(not pcall(Editor.script_search, { query = "", root = "Workspace/Code" }), "empty query refused")

	local cut = Editor.script_search({ query = "coin", root = "Workspace/Code", limit = 1 })
	check(#cut.matches == 1 and cut.truncated == true and cut.total == 3, "limit truncates but still counts")

	local whole = Editor.script_search({ query = "nothing here" })
	check(whole.total == 1, "defaults to the whole place: " .. whole.total)
	folder:Destroy()
end

-------------------------------------------------------------------------------
H.section("Editor: script_diagnostics")

do
	local E = H.requireWith("Editor", { loadstring = loadstringShim })
	local folder = Instance.new("Folder")
	folder.Name = "Diag"
	folder.Parent = ws
	local function script(name, src)
		local s = Instance.new("ModuleScript")
		s.Name = name
		s.Source = src
		s.Parent = folder
	end
	script("Good", "return 1")
	script("Bad", "local a = 1\nlocal b = = 2\n")
	script("Sneaky", "_G.RoLinkDiagRan = true")

	local r = E.script_diagnostics({ path = "Workspace/Diag" })
	check(r.checked == 3 and r.withErrors == 1, "counts: " .. r.checked .. "/" .. r.withErrors)
	check(r.diagnostics[1].path == "Workspace/Diag/Bad", "names the broken script")
	check(r.diagnostics[1].line == 2, "gives the line: " .. tostring(r.diagnostics[1].line))
	check(type(r.diagnostics[1].message) == "string" and #r.diagnostics[1].message > 0, "gives the message")
	check(r.available == true and string.find(r.note, "Script Analysis", 1, true) ~= nil, "says this is a syntax check only")
	check(_G.RoLinkDiagRan == nil, "the checked code is never executed")

	local whole = E.script_diagnostics({})
	check(whole.checked >= 3, "defaults to the whole place")

	local none = H.requireWith("Editor", {})
	local nr = none.script_diagnostics({ path = "Workspace/Diag" })
	check(nr.available == false and nr.checked == 0 and string.find(nr.note, "loadstring", 1, true) ~= nil, "without loadstring it says it could not check")

	local off = H.requireWith("Editor", {
		loadstring = function()
			return nil, "loadstring() is not available"
		end,
	})
	check(off.script_diagnostics({ path = "Workspace/Diag" }).available == false, "a disabled loadstring is not reported as a syntax error")
	folder:Destroy()
end

-------------------------------------------------------------------------------
H.section("Editor: generate_model")

do
	local got = {}
	local answer
	local gen = {}
	function gen:GenerateModelAsync(inputs, schema, options)
		got = { inputs = inputs, schema = schema, options = options }
		return answer()
	end
	local Content = { fromAssetId = function(id)
		return "content:" .. id
	end }
	local E = H.requireWith("Editor", { game = fakeGame({ GenerationService = gen, Selection = { Set = function() end } }), Content = Content })
	local function model()
		local m = Instance.new("Model")
		m.Name = "Generated"
		return m
	end
	answer = function()
		return model(), { UUID = "u-1" }
	end

	local r = E.generate_model({ prompt = "a red car", name = "Car", size = { 8, 4, 16 }, maxTriangles = 500, textures = false })
	check(got.inputs.TextPrompt == "a red car", "prompt sent")
	check(got.inputs.Size == Vector3.new(8, 4, 16) and got.inputs.MaxTriangles == 500 and got.inputs.GenerateTextures == false, "options sent")
	check(got.schema.SchemaDefinition.Groups[1] == "Car", "default schema is one group named after the model")
	check(ws:FindFirstChild("Car") ~= nil, "model placed under the default parent")
	check(r.uuid == "u-1" and r.created[1].path == "Workspace/Car", "reports the model and uuid")
	ws:FindFirstChild("Car"):Destroy()

	E.generate_model({ prompt = "car", name = "C2", predefined = "Car5" })
	check(got.schema.PredefinedSchema == "Car5" and got.schema.SchemaDefinition == nil, "predefined schema")
	ws:FindFirstChild("C2"):Destroy()

	E.generate_model({ prompt = "x", name = "C3", parts = { "Body", "Wheel" } })
	check(#got.schema.SchemaDefinition.Groups == 2, "explicit part groups")
	ws:FindFirstChild("C3"):Destroy()

	E.generate_model({ image = 123, name = "C4" })
	check(got.inputs.Image == "content:123" and got.inputs.TextPrompt == nil, "image input")
	ws:FindFirstChild("C4"):Destroy()

	check(not pcall(E.generate_model, { name = "N" }), "needs a prompt or an image")
	check(not pcall(E.generate_model, { prompt = "x", parts = { "a" }, predefined = "Car5" }), "parts and predefined are exclusive")
	check(not pcall(E.generate_model, { prompt = "x", predefined = "Boat" }), "unknown predefined schema refused")

	answer = function()
		error("capability DynamicGeneration is not granted")
	end
	local okFail, errFail = pcall(E.generate_model, { prompt = "x", name = "F" })
	check(not okFail and string.find(tostring(errFail), "DynamicGeneration", 1, true) ~= nil and string.find(tostring(errFail), "plugin", 1, true) ~= nil, "failure explains the capability: " .. tostring(errFail))

	answer = function()
		return nil
	end
	check(not pcall(E.generate_model, { prompt = "x", name = "F" }), "no model returned is an error")
end

-------------------------------------------------------------------------------
H.section("Perf: profile_scripts")

do
	local Perf = H.require("Perf")
	local top = Perf.summarize({
		Categories = { { Name = "Heartbeat" } },
		Functions = {
			{ Name = "slow", Source = "S", Line = 4, TotalDuration = 900 },
			{ Name = "fast", Source = "S", Line = 9, TotalDuration = 10 },
			{ Name = "mid", Source = "S", Line = 2, TotalDuration = 50 },
		},
	}, 2)
	check(#top.functions == 2 and top.functions[1].name == "slow" and top.functions[2].name == "mid", "top functions by duration")
	check(top.functionCount == 3 and top.categories[1] == "Heartbeat", "counts and categories")
	check(Perf.summarize({ Other = 1 }, 5).unrecognised == true, "an unknown shape is flagged rather than faked")

	local signal
	local started, stopped, requested
	local profiler = {}
	profiler.OnNewData = {
		Connect = function(_, fn)
			signal = fn
			return {
				Disconnect = function()
					signal = nil
				end,
			}
		end,
	}
	function profiler:ServerStart(freq)
		started = { "server", freq }
	end
	function profiler:ServerStop()
		stopped = "server"
	end
	function profiler:ServerRequestData()
		requested = "server"
		task.delay(0.02, function()
			if signal then
				signal(nil, "JSON")
			end
		end)
	end
	function profiler:ClientStart(player, freq)
		started = { "client", freq, player }
	end
	function profiler:ClientStop(player)
		stopped = { "client", player }
	end
	function profiler:ClientRequestData(player)
		requested = player
		task.delay(0.02, function()
			if signal then
				signal(player, "JSON")
			end
		end)
	end
	function profiler:DeserializeJSON(s)
		check(s == "JSON", "DeserializeJSON gets the string from OnNewData")
		return { Functions = { { Name = "work", TotalDuration = 5 } } }
	end

	local function perf(context, extra)
		local services = { RunService = fakeRun(context), ScriptProfilerService = profiler }
		for k, v in extra or {} do
			services[k] = v
		end
		return H.requireWith("Perf", { game = fakeGame(services) })
	end

	local P = perf("server")
	local r = P.profile({ duration = 0.05, frequency = 500 })
	check(started[1] == "server" and started[2] == 500, "starts on the server with the frequency")
	check(requested == "server" and stopped == "server", "requests the data then stops")
	check(r.functions[1].name == "work" and r.context == "server", "returns the summary")
	check(signal == nil, "the signal is disconnected")

	local local_player = { Name = "Tester" }
	local C = perf("client", { Players = { LocalPlayer = local_player } })
	local rc = C.profile({ duration = 0.02 })
	check(started[1] == "client" and started[3] == local_player and rc.functions[1].name == "work", "client context uses the local player")

	local okEdit, errEdit = pcall(perf("edit").profile, { duration = 0.02 })
	check(not okEdit and string.find(tostring(errEdit), "play-test", 1, true) ~= nil, "edit context is refused: " .. tostring(errEdit))
	check(not pcall(P.profile, { duration = 0.02, frequency = 20000 }), "frequency out of range refused")

	local realStart = profiler.ServerStart
	profiler.ServerStart = function()
		error("not allowed")
	end
	local okNo, errNo = pcall(P.profile, { duration = 0.02 })
	check(not okNo and string.find(tostring(errNo), "not allowed", 1, true) ~= nil, "a refused start is reported")
	profiler.ServerStart = realStart

	local realReq = profiler.ServerRequestData
	profiler.ServerRequestData = function() end
	local T = perf("server")
	local okTo, errTo = pcall(T.profile, { duration = 0.02, dataTimeout = 0.05 })
	check(not okTo and string.find(tostring(errTo), "data", 1, true) ~= nil, "no data in time is an error")
	check(stopped == "server" and signal == nil, "cleans up after a timeout")
	profiler.ServerRequestData = realReq
end

-------------------------------------------------------------------------------
H.section("Perf: perf_stats")

do
	local stats = { InstanceCount = 1200, PrimitivesCount = 300, MovingPrimitivesCount = 5, ContactsCount = 2, HeartbeatTime = 0.004, PhysicsStepTime = 0.002 }
	function stats:GetTotalMemoryUsageMb()
		return 512.5
	end
	local P = H.requireWith("Perf", { game = fakeGame({ Stats = stats, RunService = fakeRun("edit"), Players = { GetPlayers = function()
		return { 1, 2 }
	end } }) })
	local r = P.stats({ sample = 0.03 })
	check(r.memoryMb == 512.5 and r.instanceCount == 1200, "memory and instance count")
	check(r.primitives == 300 and r.movingPrimitives == 5 and r.contacts == 2, "physics counts")
	near(r.heartbeatTimeMs, 4, "heartbeat time in milliseconds")
	check(r.heartbeat.samples >= 1 and r.heartbeat.avgDt > 0, "heartbeat is sampled")
	check(r.players == 2, "player count")
	check(type(r.classes) == "table", "instance counts by class")

	local broken = {}
	setmetatable(broken, { __index = function(_, k)
		error("no member " .. k)
	end })
	local P2 = H.requireWith("Perf", { game = fakeGame({ Stats = broken, RunService = fakeRun("edit") }) })
	local r2 = P2.stats({ sample = 0.01 })
	check(r2.memoryMb == nil and r2.errors ~= nil, "unavailable stats are reported, not fatal")
end

-------------------------------------------------------------------------------
H.section("Playtest: multiplayer")

do
	local function signal()
		return { Connect = function()
			return { Disconnect = function() end }
		end }
	end
	local studio = { calls = {}, editActive = true, fail = nil }
	local svc = { EditModeActive = true }
	function svc:ExecuteMultiplayerTestAsync(n, args)
		table.insert(studio.calls, { n = n, args = args })
		if studio.fail then
			error(studio.fail)
		end
		self.EditModeActive = false
		while not studio.finish do
			task.wait(0.005)
		end
		self.EditModeActive = true
		return studio.finish
	end
	local plugin = {}
	function plugin:GetSetting() end
	function plugin:SetSetting() end
	local function new()
		local P = H.requireWith("Playtest", {
			game = fakeGame({ RunService = fakeRun("edit"), StudioTestService = svc, LogService = { MessageOut = signal() }, ScriptContext = { Error = signal() } }),
			loadstring = loadstringShim,
		})
		P.init(plugin, { noMonitor = true })
		return P
	end

	local P = new()
	local r = P.start({ mode = "multiplayer", clients = 3 })
	check(r.mode == "multiplayer" and r.clients == 3, "start reports the clients")
	check(studio.calls[1].n == 3, "ExecuteMultiplayerTestAsync gets the count")
	check(studio.calls[1].args.rolink == true, "args identify RoLink")
	local st = P.status({})
	check(st.running and st.mode == "multiplayer", "status says multiplayer")

	check(not pcall(P.start, { mode = "multiplayer", clients = 2 }), "refused while one runs")
	studio.finish = "done"
	task.wait(0.05)
	check(P.status({}).running == false, "ended")
	check(P.status({}).mode == nil, "the mode is cleared so a later user-started test is not called multiplayer")

	studio.finish = nil
	local P2 = new()
	for _, bad in { 0, 9, 1.5, "x" } do
		check(not pcall(P2.start, { mode = "multiplayer", clients = bad }), "clients must be 1..8: " .. tostring(bad))
	end
	check(not pcall(P2.start, { mode = "multiplayer" }), "clients is required")

	studio.fail = "Studio said no"
	local okF, errF = pcall(P2.start, { mode = "multiplayer", clients = 2 })
	check(not okF and string.find(tostring(errF), "Studio said no", 1, true) ~= nil and string.find(tostring(errF), "Clients and Servers", 1, true) ~= nil, "a refusal says what to press: " .. tostring(errF))
	studio.fail = nil
end

-------------------------------------------------------------------------------
H.section("Scenario: T.players")

do
	local list = { { Name = "A" } }
	local players = {}
	function players:GetPlayers()
		return list
	end
	local Output = H.require("Output")
	local function run(source, timeout)
		local S = H.requireWith("Scenario", {
			game = fakeGame({ Players = players }),
			loadstring = function(src, chunk)
				local ok, f = pcall(luau.load, src, { debugName = chunk, environment = { task = task, pairs = pairs } })
				if ok then
					return f
				end
				return nil, f
			end,
		})
		return S.run({ source = source, timeout = timeout or 5 }, { output = Output.new({ base = 0 }), context = "server", quiet = true })
	end

	local r = run("return #T.players()")
	check(r.ok and r.returns[1] == 1, "T.players returns everyone: " .. tostring(r.error))

	task.delay(0.05, function()
		list = { { Name = "A" }, { Name = "B" } }
	end)
	local waited = run("return #T.players(2, 2)")
	check(waited.ok and waited.returns[1] == 2, "T.players(n) waits for n players: " .. tostring(waited.error))

	local short = run("T.players(5, 0.05)")
	check(not short.ok and string.find(tostring(short.error), "5", 1, true) ~= nil, "a shortfall fails the scenario: " .. tostring(short.error))
end
