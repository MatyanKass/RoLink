-- Loads the plugin modules under Lune with a fake `script` hierarchy and
-- shims for the few engine methods Lune doesn't implement.

local fs = require("@lune/fs")
local luau = require("@lune/luau")
local serde = require("@lune/serde")
local roblox = require("@lune/roblox")

local SRC = "../src/"

local game = roblox.Instance.new("DataModel")
local workspace = game:GetService("Workspace")

local PART_CLASSES = { "Part", "WedgePart", "CornerWedgePart", "MeshPart", "UnionOperation", "TrussPart", "SpawnLocation", "Seat" }

local function partPivot(self)
	return self.CFrame * self.PivotOffset
end

local function modelPivot(self)
	if self.PrimaryPart then
		return self.PrimaryPart.CFrame * self.PrimaryPart.PivotOffset
	end
	return self.WorldPivot
end

for _, cls in PART_CLASSES do
	roblox.implementMethod(cls, "GetPivot", partPivot)
	roblox.implementMethod(cls, "PivotTo", function(self, cf)
		self.CFrame = cf * self.PivotOffset:Inverse()
	end)
end

roblox.implementMethod("Model", "GetPivot", modelPivot)
roblox.implementMethod("Model", "PivotTo", function(self, target)
	local delta = target * modelPivot(self):Inverse()
	for _, d in self:GetDescendants() do
		if d:IsA("BasePart") then
			d.CFrame = delta * d.CFrame
		end
	end
	if not self.PrimaryPart then
		self.WorldPivot = target
	end
end)
roblox.implementMethod("Model", "GetBoundingBox", function(self)
	local lo, hi
	for _, d in self:GetDescendants() do
		if d:IsA("BasePart") then
			local h = d.Size / 2
			for _, sx in { -1, 1 } do
				for _, sy in { -1, 1 } do
					for _, sz in { -1, 1 } do
						local p = d.CFrame * roblox.Vector3.new(h.X * sx, h.Y * sy, h.Z * sz)
						lo = lo and lo:Min(p) or p
						hi = hi and hi:Max(p) or p
					end
				end
			end
		end
	end
	if not lo then
		return roblox.CFrame.new(), roblox.Vector3.zero
	end
	return roblox.CFrame.new((lo + hi) / 2), hi - lo
end)
roblox.implementMethod("Players", "GetPlayerFromCharacter", function()
	return nil
end)
roblox.implementMethod("HttpService", "JSONEncode", function(_, v)
	return serde.encode("json", v)
end)
roblox.implementMethod("HttpService", "JSONDecode", function(_, s)
	return serde.decode("json", s)
end)

local env = {}
for k, v in roblox do
	if type(k) == "string" and string.match(k, "^%u") then
		env[k] = v
	end
end
env.game = game
env.workspace = workspace
env.print = print
env.warn = print
env.typeof = typeof
env.task = require("@lune/task")

local cache = {}
local folder = { Name = "RoLink" }
local scripts = {}

local function load(name, overrides)
	if cache[name] and not overrides then
		return cache[name]
	end
	local src = fs.readFile(SRC .. name .. ".lua")
	local scriptObj = scripts[name]
	local modEnv = table.clone(env)
	for k, v in overrides or {} do
		modEnv[k] = v
	end
	modEnv.script = scriptObj
	modEnv.require = function(target)
		if type(target) == "table" and target.__module then
			return load(target.__module)
		end
		return require(target)
	end
	local fn = luau.load(src, { debugName = name, environment = modEnv })
	local result = fn()
	if not overrides then
		cache[name] = result
	end
	return result
end

setmetatable(folder, {
	__index = function(_, name)
		if not scripts[name] then
			scripts[name] = { __module = name, Name = name, Parent = folder }
		end
		return scripts[name]
	end,
})

local M = {}
M.game = game
M.workspace = workspace
M.roblox = roblox
M.serde = serde

function M.require(name)
	local _ = folder[name]
	return load(name)
end

-- Fresh (uncached) load with extra globals, e.g. a mocked `game`.
function M.requireWith(name, overrides)
	local _ = folder[name]
	return load(name, overrides)
end

function M.loadApi()
	local api = serde.decode("json", fs.readFile("api.json"))
	M.require("Api").load(api)
end

-- tiny assertion helpers
local failures = 0
local passes = 0
function M.check(cond, msg)
	if cond then
		passes += 1
	else
		failures += 1
		print("  FAIL: " .. msg)
	end
end

function M.near(a, b, msg, eps)
	eps = eps or 1e-3
	local ok
	if typeof(a) == "Vector3" then
		ok = (a - b).Magnitude < eps
	elseif typeof(a) == "CFrame" then
		ok = (a.Position - b.Position).Magnitude < eps
			and (a.LookVector - b.LookVector).Magnitude < eps
			and (a.UpVector - b.UpVector).Magnitude < eps
	else
		ok = math.abs(a - b) < eps
	end
	M.check(ok, msg .. " (got " .. tostring(a) .. ", want " .. tostring(b) .. ")")
end

function M.section(name)
	print("· " .. name)
end

function M.done()
	print(string.format("\n%d passed, %d failed", passes, failures))
	if failures > 0 then
		local process = require("@lune/process")
		process.exit(1)
	end
end

return M
