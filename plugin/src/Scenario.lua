-- playtest_scenario: runs agent-written Luau in a running play-test with the
-- helper table `T`, and returns a structured report. A failing step never
-- kills the report; a timeout cancels the code (same pattern as Ops.run).

local Util = require(script.Parent.Util)

local Scenario = {}

-- T.set / T.get: live as long as this plugin instance, i.e. one play-test
-- context, across steps and scenarios.
Scenario.vars = {}

local MAX_REPORT_LOGS = 300
local MAX_STEP_LOGS = 200
local DEFAULT_PLAYER_WAIT = 10

local function joinArgs(...)
	local parts = {}
	for i = 1, select("#", ...) do
		parts[i] = tostring((select(i, ...)))
	end
	return table.concat(parts, " ")
end

local function deepEqual(a, b, depth)
	if a == b then
		return true
	end
	if type(a) ~= "table" or type(b) ~= "table" or (depth or 0) > 12 then
		return false
	end
	for k, v in a do
		if not deepEqual(v, b[k], (depth or 0) + 1) then
			return false
		end
	end
	for k in b do
		if a[k] == nil then
			return false
		end
	end
	return true
end

local function show(v, depth)
	if type(v) == "string" then
		return string.format("%q", v)
	end
	if type(v) == "table" and (depth or 0) < 3 then
		local parts = {}
		for k, val in v do
			if #parts >= 8 then
				table.insert(parts, "…")
				break
			end
			table.insert(parts, tostring(k) .. "=" .. show(val, (depth or 0) + 1))
		end
		return "{" .. table.concat(parts, ", ") .. "}"
	end
	return tostring(v)
end

local function compile(source)
	local wrapped = "return function(T, print, warn, args, plugin) " .. source .. "\nend"
	local okLs, f, err = pcall(loadstring, wrapped, "=scenario")
	if okLs and f then
		return f()
	end
	if okLs and err and not string.find(tostring(err), "loadstring", 1, true) then
		return nil, tostring(err)
	end
	-- loadstring unavailable: compile through a ModuleScript
	local ms = Instance.new("ModuleScript")
	ms.Name = "RoLinkScenario"
	ms.Source = wrapped
	local okReq, fn = pcall(require, ms)
	if not okReq then
		return nil, tostring(fn)
	end
	return fn
end

local function errorHandler(e)
	return { message = tostring(e), traceback = debug.traceback(nil, 2) }
end

local function buildT(ctx)
	local T = {}

	function T.wait(seconds)
		return task.wait(seconds)
	end

	function T.waitFor(predicate, timeout, label)
		timeout = timeout or 5
		local deadline = os.clock() + timeout
		local lastErr
		while true do
			local ok, value = pcall(predicate)
			if ok and value then
				return value
			end
			if not ok then
				lastErr = tostring(value)
			end
			if os.clock() >= deadline then
				error(
					string.format("T.waitFor timed out after %gs%s%s", timeout, label and (": " .. tostring(label)) or "", lastErr and (" (last error: " .. lastErr .. ")") or ""),
					0
				)
			end
			task.wait()
		end
	end

	function T.assert(cond, message)
		if not cond then
			error(message ~= nil and tostring(message) or "assertion failed", 2)
		end
		return cond
	end

	function T.equal(actual, expected, message)
		if not deepEqual(actual, expected) then
			error(string.format("%sexpected %s, got %s", message and (tostring(message) .. ": ") or "", show(expected), show(actual)), 2)
		end
		return actual
	end

	function T.set(key, value)
		Scenario.vars[key] = value
		return value
	end

	function T.get(key)
		return Scenario.vars[key]
	end

	function T.log(...)
		ctx.emit("output", print, ...)
	end

	function T.player(timeout)
		timeout = timeout or DEFAULT_PLAYER_WAIT
		local Players = game:GetService("Players")
		local deadline = os.clock() + timeout
		while true do
			local p
			if ctx.context == "client" then
				p = Players.LocalPlayer
			else
				p = Players:GetPlayers()[1]
			end
			if p then
				return p
			end
			if os.clock() >= deadline then
				error(string.format('no player within %gs: a test in mode "run" has no players, use mode "play"', timeout), 0)
			end
			task.wait(0.03)
		end
	end

	-- every player in the test; with minCount, waits until that many have joined
	function T.players(minCount, timeout)
		local Players = game:GetService("Players")
		if minCount == nil then
			return Players:GetPlayers()
		end
		timeout = timeout or DEFAULT_PLAYER_WAIT
		local deadline = os.clock() + timeout
		while true do
			local list = Players:GetPlayers()
			if #list >= minCount then
				return list
			end
			if os.clock() >= deadline then
				error(string.format("only %d of %d players joined within %gs", #list, minCount, timeout), 0)
			end
			task.wait(0.03)
		end
	end

	function T.character(timeout)
		timeout = timeout or DEFAULT_PLAYER_WAIT
		local player = T.player(timeout)
		return T.waitFor(function()
			local char = player.Character
			if not char then
				return false
			end
			local ok, root = pcall(function()
				return char.PrimaryPart or char:FindFirstChild("HumanoidRootPart")
			end)
			return (not ok or root) and char
		end, timeout, "the character to spawn")
	end

	function T.teleport(target)
		local kind = typeof(target)
		local char = T.character()
		local cf
		if kind == "CFrame" then
			cf = target
		elseif kind == "Vector3" then
			local pivot = char:GetPivot()
			cf = CFrame.new(target) * (pivot - pivot.Position)
		else
			error("T.teleport expects a CFrame or Vector3, got " .. kind, 2)
		end
		char:PivotTo(cf)
		pcall(function()
			local root = char.PrimaryPart or char:FindFirstChild("HumanoidRootPart")
			root.AssemblyLinearVelocity = Vector3.zero
			root.AssemblyAngularVelocity = Vector3.zero
		end)
		return char
	end

	function T.step(name, fn)
		local rec = { name = tostring(name), ok = false, inProgress = true, logs = {}, errors = {}, from = ctx.ring:lastSeq(), started = os.clock() }
		table.insert(ctx.report.steps, rec)
		local prev = ctx.current
		ctx.current = rec
		local out = table.pack(xpcall(fn, errorHandler))
		ctx.current = prev
		rec.duration = os.clock() - rec.started
		rec.inProgress = nil
		rec.to = ctx.ring:lastSeq()
		if out[1] then
			rec.ok = true
			return true, table.unpack(out, 2, out.n)
		end
		rec.message = out[2].message
		rec.traceback = out[2].traceback
		return false, out[2].message
	end

	return T
end

local function formatLine(e)
	local prefix = ""
	if e.level == "warning" then
		prefix = "[warn] "
	elseif e.level == "error" then
		prefix = "[error] "
	elseif e.level == "info" then
		prefix = "[info] "
	end
	return prefix .. e.text
end

local function finishReport(report, ring, startSeq, startClock)
	-- MessageOut / ScriptContext.Error fire deferred: let them arrive
	task.wait()
	task.wait()
	ring:clearEchoes()

	local lines = {}
	local errors = {}
	local passed = 0
	local entries = ring:read({ since = startSeq, limit = 2000 }).entries
	for _, e in entries do
		table.insert(lines, formatLine(e))
		if e.level == "error" then
			table.insert(errors, e)
		end
	end
	if #lines > MAX_REPORT_LOGS then
		report.logsDropped = #lines - MAX_REPORT_LOGS
		lines = table.move(lines, #lines - MAX_REPORT_LOGS + 1, #lines, 1, {})
	end
	report.logs = lines

	for _, step in report.steps do
		if step.inProgress then
			step.ok = false
			step.message = report.timedOut and "timed out while running this step" or "did not finish"
			step.duration = os.clock() - step.started
			step.inProgress = nil
		end
		if step.ok then
			passed += 1
		end
		for _, e in errors do
			if e.seq > step.from and (step.to == nil or e.seq <= step.to) then
				table.insert(step.errors, { seq = e.seq, text = e.text, stack = e.stack, script = e.script })
				e.step = e.step or step.name
			end
		end
		step.from, step.to, step.started = nil, nil, nil
	end
	report.errors = errors

	report.summary = string.format("%d/%d steps passed", passed, #report.steps)
	report.ok = passed == #report.steps and report.error == nil and not report.timedOut
	report.duration = os.clock() - startClock
	report.output = { from = startSeq, lastSeq = ring:lastSeq() }
	return report
end

function Scenario.run(args, deps)
	if type(args.source) ~= "string" then
		error("playtest_scenario needs `source` (Luau code)", 0)
	end
	local ring = deps.output
	local timeout = math.clamp(tonumber(args.timeout) or 60, 0.05, 600)
	local startSeq = ring:lastSeq()
	local startClock = os.clock()
	local report = { ok = false, summary = "", context = deps.context, timedOut = false, steps = {}, logs = {}, errors = {} }

	local fn, compileErr = compile(args.source)
	if not fn then
		report.error = "compile error: " .. tostring(compileErr)
		return finishReport(report, ring, startSeq, startClock)
	end

	local ctx = { context = deps.context, ring = ring, report = report }

	-- own lines go into the ring directly (so they survive even if MessageOut
	-- filters them) and the real print output is deduplicated as an echo
	function ctx.emit(level, realFn, ...)
		local text = joinArgs(...)
		ring:add(level, text)
		if ctx.current and #ctx.current.logs < MAX_STEP_LOGS then
			table.insert(ctx.current.logs, text)
		end
		if not deps.quiet and realFn then
			ring:expectEcho(level, text)
			realFn(text)
		end
	end

	local T = buildT(ctx)

	local results = nil
	local thread = task.spawn(function()
		results = table.pack(xpcall(function()
			return fn(T, function(...)
				ctx.emit("output", print, ...)
			end, function(...)
				ctx.emit("warning", warn, ...)
			end, args.args, deps.plugin)
		end, errorHandler))
	end)

	local deadline = os.clock() + timeout
	while results == nil and os.clock() < deadline do
		task.wait()
	end
	if results == nil then
		pcall(task.cancel, thread)
		report.timedOut = true
		report.error = string.format("scenario timed out after %gs (code cancelled)", timeout)
		return finishReport(report, ring, startSeq, startClock)
	end

	if results[1] then
		local returns = {}
		for i = 2, results.n do
			returns[i - 1] = Util.deepEncode(results[i])
		end
		report.returns = returns
	else
		report.error = results[2].message
		report.traceback = results[2].traceback
	end
	return finishReport(report, ring, startSeq, startClock)
end

return Scenario
