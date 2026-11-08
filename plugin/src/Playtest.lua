-- Play-test control. The edit DataModel starts a test (ExecutePlayModeAsync /
-- ExecuteRunModeAsync yield until it ends, so they run on their own thread);
-- only the server DataModel may end it (EndTest).

local Output = require(script.Parent.Output)
local Scenario = require(script.Parent.Scenario)

local Playtest = {}

local STOP_SETTING = "RoLinkStopRequest"
local END_VALUE = "rolink:stopped"
local START_GRACE = 2 -- seconds to catch an immediate refusal from Studio

local pluginRef
local ring
local state = { starting = false, mode = nil, lastResult = nil, lastError = nil }

local function context()
	local rs = game:GetService("RunService")
	return rs:IsEdit() and "edit" or (rs:IsServer() and "server" or "client")
end

local function studioTest()
	local ok, svc = pcall(function()
		return game:GetService("StudioTestService")
	end)
	return ok and svc or nil
end

local function editModeActive(svc)
	if not svc then
		return nil
	end
	local ok, active = pcall(function()
		return svc.EditModeActive
	end)
	if ok then
		return active
	end
	return nil
end

local function askUser(mode, why)
	return string.format(
		'Could not start a play-test from the plugin: %s. Ask the user to press %s in Studio, then call playtest_status until running is true.',
		tostring(why),
		mode == "run" and "Run (F8)" or "Play (F5)"
	)
end

function Playtest.output()
	if not ring then
		ring = Output.new()
	end
	return ring
end

local function callEndTest()
	local svc = studioTest()
	if not svc then
		error("StudioTestService is not available", 0)
	end
	svc:EndTest(END_VALUE)
end

function Playtest.checkStopRequest()
	if not pluginRef or pluginRef:GetSetting(STOP_SETTING) ~= true then
		return false
	end
	pluginRef:SetSetting(STOP_SETTING, false)
	pcall(callEndTest)
	return true
end

function Playtest.init(plugin, opts)
	pluginRef = plugin
	pcall(function()
		Playtest.output():attach(game:GetService("LogService"), game:GetService("ScriptContext"))
	end)
	if context() == "server" then
		pcall(function()
			plugin:SetSetting(STOP_SETTING, false)
		end)
		if not (opts and opts.noMonitor) then
			-- a second stop channel for when this DataModel can't reach the bridge
			task.spawn(function()
				while pluginRef == plugin do
					task.wait(1)
					Playtest.checkStopRequest()
				end
			end)
		end
	end
end

function Playtest.start(args)
	local mode = args.mode
	if mode ~= "play" and mode ~= "run" then
		error('mode must be "play" or "run"', 0)
	end
	if context() ~= "edit" then
		error("a play-test can only be started from the edit context", 0)
	end
	local svc = studioTest()
	if not svc then
		error(askUser(mode, "StudioTestService is not available in this Studio version"), 0)
	end
	if state.starting or editModeActive(svc) == false then
		error("A play-test is already running; stop it first with playtest_stop (or ask the user to press Stop).", 0)
	end

	state.starting = true
	state.mode = mode
	state.lastResult = nil
	state.lastError = nil
	local finished = false
	local failure = nil
	task.spawn(function()
		local ok, res = pcall(function()
			local arg = { rolink = true, mode = mode }
			if mode == "run" then
				return svc:ExecuteRunModeAsync(arg)
			end
			return svc:ExecutePlayModeAsync(arg)
		end)
		state.starting = false
		finished = true
		if ok then
			state.lastResult = (type(res) == "string" or type(res) == "number" or type(res) == "boolean") and res or (res ~= nil and tostring(res) or nil)
		else
			failure = tostring(res)
			state.lastError = failure
		end
	end)

	local deadline = os.clock() + START_GRACE
	while not finished and os.clock() < deadline and editModeActive(svc) ~= false do
		task.wait(0.02)
	end
	if failure then
		error(askUser(mode, failure), 0)
	end
	return { started = true, mode = mode, state = editModeActive(svc) == false and "running" or "starting" }
end

function Playtest.status()
	local ctx = context()
	local svc = studioTest()
	local active = editModeActive(svc)
	local info = { context = ctx, editModeActive = active, mode = state.mode, lastResult = state.lastResult, lastError = state.lastError }
	if ctx == "edit" then
		info.running = state.starting or active == false
	else
		info.running = true
		local rs = game:GetService("RunService")
		local okMode, isRun = pcall(function()
			return rs:IsRunMode()
		end)
		info.isRunMode = okMode and isRun == true
		info.mode = info.isRunMode and "run" or "play"
		local names = {}
		pcall(function()
			for _, p in game:GetService("Players"):GetPlayers() do
				table.insert(names, p.Name)
			end
		end)
		info.players = names
	end
	return info
end

function Playtest.endTest()
	if context() ~= "server" then
		error("EndTest only works from a play-test's server context", 0)
	end
	-- answer first: EndTest tears this DataModel down
	task.delay(0.2, function()
		pcall(callEndTest)
	end)
	return { ending = true }
end

function Playtest.requestStop()
	if context() ~= "edit" or not pluginRef then
		error("the stop request is only available from the edit context", 0)
	end
	pluginRef:SetSetting(STOP_SETTING, true)
	return { requested = true }
end

function Playtest.scenario(args)
	return Scenario.run(args, { output = Playtest.output(), context = context(), plugin = pluginRef })
end

function Playtest.readOutput(args)
	local r = Playtest.output():read(args)
	r.context = context()
	return r
end

return Playtest
