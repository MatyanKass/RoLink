-- Regression tests for the second plugin audit: replace semantics, mirror apply
-- robustness, per-item sync errors, id handling on removal.

local H = ...
local roblox = H.roblox
local Instance = roblox.Instance
local check = H.check
local ws = H.workspace

local Paths = H.require("Paths")
local Build = H.require("Build")

H.section("Build: replace does not replace its own variants")
do
	local holder = Instance.new("Folder")
	holder.Name = "ReplaceHolder"
	holder.Parent = ws
	local old = Instance.new("Part")
	old.Name = "Post"
	old.Parent = holder
	local res = Build.run(holder, { { name = "Post", size = { 1, 4, 1 }, ["repeat"] = { count = 3, step = { 5, 0, 0 } } } }, { replace = true })
	local posts = 0
	for _, c in holder:GetChildren() do
		if c.Name == "Post" then
			posts += 1
		end
	end
	check(#res.created == 3, "three variants built")
	check(posts == 3, "all three variants survive replace, got " .. posts)
	check(old.Parent == nil, "the pre-existing child was replaced")
	holder:Destroy()
end

H.section("Mirror.apply: a move to a missing parent keeps the instance")
do
	local Mirror = H.require("Mirror")
	local holder = Instance.new("Folder")
	holder.Name = "MoveHolder"
	holder.Parent = ws
	local part = Instance.new("Part")
	part.Name = "Stay"
	part.Parent = holder
	local res = Mirror.apply({ ops = { { op = "set", id = Paths.id(part), parent = 987654321 } } })
	check(part.Parent == holder, "instance not detached by a move to an unknown parent")
	check(#res.errors == 1 and string.find(res.errors[1].message, "no longer exists", 1, true) ~= nil, "the failed move is reported")

	-- a delete that the engine refuses is an error, not the end of the batch
	local locked = { Name = "Locked" }
	function locked:Destroy()
		error("The Parent property of Locked is locked", 0)
	end
	local lockedId = Paths.id(locked)
	local res2 = Mirror.apply({ ops = {
		{ op = "destroy", id = lockedId },
		{ op = "set", id = Paths.id(part), name = "Renamed" },
	} })
	check(part.Name == "Renamed", "ops after a refused delete still run")
	check(#res2.errors == 1 and string.find(res2.errors[1].message, "could not delete", 1, true) ~= nil, "the refused delete is reported")
	holder:Destroy()
end

H.section("Paths.peek does not hand out ids")
do
	local p = Instance.new("Part")
	check(Paths.peek(p) == nil, "no id before one is asked for")
	local id = Paths.id(p)
	check(Paths.peek(p) == id, "peek returns the existing id")
	p:Destroy()
end

H.section("Sync: one bad file does not abort the sync")
do
	-- Lune routes CollectionService:HasTag to Instance:HasTag on the service itself
	local tags = {
		HasTag = function(_, inst, tag)
			return inst:HasTag(tag)
		end,
		GetTagged = function()
			return {}
		end,
	}
	local fakeGame = {}
	function fakeGame:GetService(name)
		return name == "CollectionService" and tags or H.game:GetService(name)
	end
	function fakeGame:FindFirstChild(name)
		return H.game:FindFirstChild(name)
	end
	local Sync = H.requireWith("Sync", { game = fakeGame })
	local holder = Instance.new("Folder")
	holder.Name = "SyncHolder"
	holder.Parent = ws
	local stats = Sync.apply({ action = "patch", upsert = {
		{ path = { "Workspace", "SyncHolder", "Bad" }, class = "NotAClass" },
		{ path = { "Workspace", "SyncHolder", "Good" }, class = "Folder" },
	} })
	check(holder:FindFirstChild("Good") ~= nil, "the good item is applied")
	check(holder:FindFirstChild("Bad") == nil, "the bad item is not")
	check(#stats.errors == 1 and string.find(stats.errors[1], "SyncHolder/Bad", 1, true) ~= nil, "the bad item is reported: " .. table.concat(stats.errors, ";"))
	holder:Destroy()
end
