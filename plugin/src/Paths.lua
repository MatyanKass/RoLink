-- Instance addressing.
--
--   "Workspace/Map/Tower"        slash-separated names from the DataModel root
--   "Workspace/Wall[2]"          2nd child named "Wall" (1-based, children order)
--   "#42"                        session id handed out in earlier results
--   "@selection"                 everything currently selected in Studio
--
-- A path without "/" may use "." as separator ("Workspace.Map.Tower") when no
-- child literally carries the dotted name.

local Selection = game:GetService("Selection")

local Paths = {}

-- Strong references: Luau may collect the wrapper of an instance that is still
-- alive, which would expire a "#42" from a weak table. Destroying clears an entry,
-- and the oldest ids go first past the limit.
local maxIds = 200000
local idOf, byId, destroyConn = {}, {}, {}
local nextId, oldest, count = 0, 1, 0

local function forget(id)
	local inst = byId[id]
	if not inst then
		return
	end
	byId[id] = nil
	idOf[inst] = nil
	count -= 1
	local conn = destroyConn[id]
	if conn then
		destroyConn[id] = nil
		conn:Disconnect()
	end
end

function Paths.id(inst)
	local id = idOf[inst]
	if not id then
		nextId += 1
		id = nextId
		idOf[inst] = id
		byId[id] = inst
		count += 1
		local ok, conn = pcall(function()
			return inst.Destroying:Once(function()
				-- deferred: Destroying fires before DescendantRemoving, whose handlers still need this id
				task.defer(forget, id)
			end)
		end)
		if ok then
			destroyConn[id] = conn
		end
		while count > maxIds and oldest < nextId do
			forget(oldest)
			oldest += 1
		end
	end
	return id
end

-- for the tests
function Paths._setLimit(n)
	maxIds = n
end

local function sameNameIndex(inst)
	local parent = inst.Parent
	if not parent then
		return 1, 1
	end
	local idx, count = 1, 0
	for _, sib in parent:GetChildren() do
		if sib.Name == inst.Name then
			count += 1
			if sib == inst then
				idx = count
			end
		end
	end
	return idx, count
end

local function segmentOf(inst)
	local idx, count = sameNameIndex(inst)
	if count > 1 then
		return inst.Name .. "[" .. idx .. "]"
	end
	return inst.Name
end

-- Path from the DataModel root ("Workspace/Map/Tower"). Instances outside the
-- DataModel get a "(detached)/" prefix.
function Paths.of(inst)
	local parts = {}
	local cur = inst
	while cur and cur ~= game do
		table.insert(parts, 1, segmentOf(cur))
		cur = cur.Parent
	end
	if cur ~= game then
		table.insert(parts, 1, "(detached)")
	end
	return table.concat(parts, "/")
end

-- Path of `inst` relative to `root` (root itself = ""), or nil if not inside.
function Paths.relative(inst, root)
	local parts = {}
	local cur = inst
	while cur and cur ~= root do
		table.insert(parts, 1, segmentOf(cur))
		cur = cur.Parent
	end
	if cur ~= root then
		return nil
	end
	return table.concat(parts, "/")
end

local function childBySegment(parent, seg)
	local name, n = string.match(seg, "^(.-)%[(%d+)%]$")
	if name and n then
		n = tonumber(n)
		local count = 0
		for _, c in parent:GetChildren() do
			if c.Name == name then
				count += 1
				if count == n then
					return c
				end
			end
		end
		-- a literal name like "Slot[2]" still wins if it exists
		return parent:FindFirstChild(seg)
	end
	local c = parent:FindFirstChild(seg)
	if c then
		return c
	end
	if parent == game then
		local ok, svc = pcall(game.GetService, game, seg)
		if ok and svc then
			return svc
		end
		if string.lower(seg) == "workspace" then
			return workspace
		end
	end
	return nil
end

local function walk(root, segs)
	local cur = root
	for _, seg in segs do
		if seg ~= "" then
			cur = childBySegment(cur, seg)
			if not cur then
				return nil
			end
		end
	end
	return cur
end

local function split(path, sep)
	local out = {}
	for seg in string.gmatch(path, "[^" .. sep .. "]+") do
		table.insert(out, seg)
	end
	return out
end

-- Resolve one path to one instance (nil if missing). `base` makes the path
-- relative (used for refs inside a build spec).
function Paths.resolve(path, base)
	if typeof(path) == "Instance" then
		return path
	end
	if type(path) == "number" then
		return byId[path]
	end
	if type(path) ~= "string" then
		return nil
	end
	path = string.gsub(path, "^%s+", "")
	path = string.gsub(path, "%s+$", "")
	local id = string.match(path, "^#(%d+)$")
	if id then
		return byId[tonumber(id)]
	end
	if path == "" or path == "game" then
		return base or game
	end
	path = string.gsub(path, "^game[/%.]", "")
	local root = base or game

	if string.find(path, "/", 1, true) then
		return walk(root, split(path, "/"))
	end
	-- a single segment, or a dotted path
	local direct = childBySegment(root, path)
	if direct then
		return direct
	end
	if string.find(path, ".", 1, true) then
		return walk(root, split(path, "%."))
	end
	return nil
end

-- Resolve a path or list of paths to a list of instances. "@selection" expands.
-- Throws with a readable message for anything missing.
function Paths.resolveMany(spec)
	local list = type(spec) == "table" and spec or { spec }
	local out = {}
	for _, p in list do
		if p == "@selection" then
			for _, s in Selection:Get() do
				table.insert(out, s)
			end
		else
			local inst = Paths.resolve(p)
			if not inst then
				error("not found: " .. tostring(p), 0)
			end
			table.insert(out, inst)
		end
	end
	return out
end

function Paths.one(spec)
	local list = Paths.resolveMany(spec)
	if #list == 0 then
		error("nothing selected / no target given", 0)
	end
	return list[1]
end

-- Short description used in many results.
function Paths.ref(inst)
	return { path = Paths.of(inst), id = Paths.id(inst), class = inst.ClassName }
end

return Paths
