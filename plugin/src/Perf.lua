-- Performance data: the Script Profiler during a play-test, and a snapshot of
-- memory, instance counts and heartbeat for any context.

local Perf = {}

local INTERNAL_SERVICES = {
	CoreGui = true, PluginGuiService = true, PluginDebugService = true, CorePackages = true,
	RobloxPluginGuiService = true, StudioService = true, PluginManagementService = true,
}

local DEFAULT_DURATION, MIN_DURATION, MAX_DURATION = 5, 0.01, 60
local DEFAULT_FREQUENCY, MIN_FREQUENCY, MAX_FREQUENCY = 1000, 1, 10000
local DEFAULT_TOP, MAX_TOP = 20, 200
local DATA_TIMEOUT = 15
local RAW_LIMIT = 20000
local DEFAULT_SAMPLE, MAX_SAMPLE = 0.5, 5
local TOP_CLASSES = 15

local function context()
	local rs = game:GetService("RunService")
	return rs:IsEdit() and "edit" or (rs:IsServer() and "server" or "client")
end

-- The docs describe the payload only as categories, call nodes and function
-- metadata, so anything else is flagged instead of guessed at.
function Perf.summarize(data, top)
	local functions = type(data) == "table" and data.Functions
	if type(functions) ~= "table" then
		return { unrecognised = true, functions = {} }
	end
	local list = {}
	for _, f in functions do
		table.insert(list, f)
	end
	table.sort(list, function(a, b)
		return (tonumber(a.TotalDuration) or 0) > (tonumber(b.TotalDuration) or 0)
	end)
	local out = {}
	for i = 1, math.min(top or DEFAULT_TOP, #list) do
		local f = list[i]
		table.insert(out, { name = f.Name, source = f.Source, line = f.Line, totalDuration = f.TotalDuration })
	end
	local categories = {}
	for _, c in (type(data.Categories) == "table" and data.Categories or {}) do
		table.insert(categories, c.Name)
	end
	return { functions = out, functionCount = #list, categories = categories }
end

local function decode(service, payload)
	local ok, data = pcall(function()
		return service:DeserializeJSON(payload)
	end)
	if ok then
		return data
	end
	return game:GetService("HttpService"):JSONDecode(payload)
end

function Perf.profile(args)
	local ctx = context()
	if ctx == "edit" then
		error("Script profiling needs a running play-test (server or client context); start one with playtest_start.", 0)
	end
	local frequency = tonumber(args.frequency)
	if frequency ~= nil and (frequency < MIN_FREQUENCY or frequency > MAX_FREQUENCY or frequency % 1 ~= 0) then
		error("frequency must be a whole number from 1 to 10000", 0)
	end
	frequency = frequency or DEFAULT_FREQUENCY
	local duration = math.clamp(tonumber(args.duration) or DEFAULT_DURATION, MIN_DURATION, MAX_DURATION)
	local top = math.clamp(math.floor(tonumber(args.top) or DEFAULT_TOP), 1, MAX_TOP)

	local ok, service = pcall(function()
		return game:GetService("ScriptProfilerService")
	end)
	if not ok then
		error("ScriptProfilerService is not available to this plugin: " .. tostring(service), 0)
	end

	local player = nil
	if ctx == "client" then
		player = game:GetService("Players").LocalPlayer
		if not player then
			error("the client context has no local player yet", 0)
		end
	end

	local payload
	local connection = service.OnNewData:Connect(function(from, json)
		if from == player then
			payload = json
		end
	end)
	local started = false
	local function cleanup()
		if started then
			pcall(function()
				if ctx == "server" then
					service:ServerStop()
				else
					service:ClientStop(player)
				end
			end)
		end
		connection:Disconnect()
	end

	local okStart, startErr = pcall(function()
		if ctx == "server" then
			service:ServerStart(frequency)
		else
			service:ClientStart(player, frequency)
		end
	end)
	if not okStart then
		cleanup()
		error("ScriptProfilerService could not start: " .. tostring(startErr), 0)
	end
	started = true

	task.wait(duration)

	local okRequest, requestErr = pcall(function()
		if ctx == "server" then
			service:ServerRequestData()
		else
			service:ClientRequestData(player)
		end
	end)
	if not okRequest then
		cleanup()
		error("ScriptProfilerService could not return data: " .. tostring(requestErr), 0)
	end

	local deadline = os.clock() + (tonumber(args.dataTimeout) or DATA_TIMEOUT)
	while payload == nil and os.clock() < deadline do
		task.wait(0.02)
	end
	cleanup()
	if payload == nil then
		error("the profiler returned no data in time; try a longer duration", 0)
	end

	local out = Perf.summarize(decode(service, payload), top)
	out.context = ctx
	out.duration = duration
	out.frequency = frequency
	out.note = "totalDuration is the profiler's raw value; the docs do not state its unit."
	if out.unrecognised then
		out.raw = string.sub(payload, 1, RAW_LIMIT)
	end
	return out
end

local function classCounts()
	local counts = {}
	for _, svc in game:GetChildren() do
		if not INTERNAL_SERVICES[svc.ClassName] then
			pcall(function()
				for _, d in svc:GetDescendants() do
					counts[d.ClassName] = (counts[d.ClassName] or 0) + 1
				end
			end)
		end
	end
	local list = {}
	for class, count in counts do
		table.insert(list, { class = class, count = count })
	end
	table.sort(list, function(a, b)
		return a.count > b.count
	end)
	return table.move(list, 1, math.min(TOP_CLASSES, #list), 1, {})
end

local function sampleHeartbeat(seconds)
	local total, longest, samples = 0, 0, 0
	local connection = game:GetService("RunService").Heartbeat:Connect(function(dt)
		total += dt
		longest = math.max(longest, dt)
		samples += 1
	end)
	task.wait(seconds)
	connection:Disconnect()
	if samples == 0 then
		return { samples = 0 }
	end
	local avg = total / samples
	return { samples = samples, avgDt = avg, maxDt = longest, fps = avg > 0 and 1 / avg or nil }
end

function Perf.stats(args)
	local errors = {}
	local function read(name, getter)
		local ok, value = pcall(getter)
		if ok then
			return value
		end
		errors[name] = tostring(value)
		return nil
	end
	local stats = read("Stats", function()
		return game:GetService("Stats")
	end)

	local out = { context = context() }
	if stats then
		out.memoryMb = read("memory", function()
			return stats:GetTotalMemoryUsageMb()
		end)
		out.instanceCount = read("instanceCount", function()
			return stats.InstanceCount
		end)
		out.primitives = read("primitives", function()
			return stats.PrimitivesCount
		end)
		out.movingPrimitives = read("movingPrimitives", function()
			return stats.MovingPrimitivesCount
		end)
		out.contacts = read("contacts", function()
			return stats.ContactsCount
		end)
		out.heartbeatTimeMs = read("heartbeatTime", function()
			return stats.HeartbeatTime * 1000
		end)
		out.physicsStepTimeMs = read("physicsStepTime", function()
			return stats.PhysicsStepTime * 1000
		end)
		out.dataReceiveKbps = read("dataReceiveKbps", function()
			return stats.DataReceiveKbps
		end)
		out.dataSendKbps = read("dataSendKbps", function()
			return stats.DataSendKbps
		end)
	end

	out.heartbeat = read("heartbeat", function()
		return sampleHeartbeat(math.clamp(tonumber(args.sample) or DEFAULT_SAMPLE, 0.01, MAX_SAMPLE))
	end)
	out.players = read("players", function()
		return #game:GetService("Players"):GetPlayers()
	end)
	out.classes = read("classes", classCounts)
	if next(errors) ~= nil then
		out.errors = errors
	end
	return out
end

return Perf
