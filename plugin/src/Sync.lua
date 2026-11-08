-- File <-> Studio sync (the Rojo replacement).
--
-- The server owns the mapping from project files to instance paths and sends
-- items like { path = {"ReplicatedStorage","Shared","Items"}, class = "ModuleScript", source = "..." }.
-- Everything sync creates is tagged "RoLinkSync"; only tagged instances are
-- ever deleted by sync, so things built by hand in Studio are safe.
-- Script edits made in Studio flow back to the server as events.

local CollectionService = game:GetService("CollectionService")

local Build = require(script.Parent.Build)
local Codec = require(script.Parent.Codec)
local Util = require(script.Parent.Util)

local Sync = {}

local TAG = "RoLinkSync"
local sendEvent -- function(type, payload)
local roots = {} -- array of path arrays owned by the project
local applying = setmetatable({}, { __mode = "k" }) -- inst -> source we just wrote
local conns = {}
local watched = setmetatable({}, { __mode = "k" })
local pendingSend = setmetatable({}, { __mode = "k" })

function Sync.init(eventSender)
	sendEvent = eventSender
end

local function pathOf(inst)
	local out = {}
	local cur = inst
	while cur and cur ~= game do
		table.insert(out, 1, cur.Name)
		cur = cur.Parent
	end
	return out
end

local function resolve(path)
	local cur = game
	for i, name in path do
		local nxt = cur:FindFirstChild(name)
		if not nxt and i == 1 then
			local ok, svc = pcall(game.GetService, game, name)
			nxt = ok and svc or nil
		end
		if not nxt then
			return nil
		end
		cur = nxt
	end
	return cur
end

local function key(path)
	return table.concat(path, "\0")
end

local stats -- per-apply counters/errors, reset in Sync.apply

local function pushError(msg)
	if stats then
		table.insert(stats.errors, msg)
	end
end

local function setSource(inst, src)
	applying[inst] = src
	local ok, err = pcall(function()
		inst.Source = src
	end)
	if not ok then
		local okSes, errSes = pcall(function()
			local ScriptEditorService = game:GetService("ScriptEditorService")
			ScriptEditorService:UpdateSourceAsync(inst, function()
				return src
			end)
		end)
		if not okSes then
			applying[inst] = nil
			pushError(inst:GetFullName() .. ": could not set Source (" .. tostring(err) .. "; " .. tostring(errSes) .. ")")
		end
	end
end

local function underRoot(inst)
	local p = pathOf(inst)
	for _, r in roots do
		if #p > #r then
			local match = true
			for i = 1, #r do
				if p[i] ~= r[i] then
					match = false
					break
				end
			end
			if match then
				return true
			end
		end
	end
	return false
end

-- Studio -> files ------------------------------------------------------------

local function queueSourceSend(inst)
	if pendingSend[inst] then
		return
	end
	pendingSend[inst] = true
	task.delay(0.8, function()
		pendingSend[inst] = nil
		if not inst.Parent then
			return
		end
		local src = inst.Source
		if applying[inst] == src then
			return
		end
		applying[inst] = src
		sendEvent("source", { path = pathOf(inst), class = inst.ClassName, source = src })
	end)
end

local function watch(inst)
	if watched[inst] or not inst:IsA("LuaSourceContainer") then
		return
	end
	watched[inst] = true
	table.insert(conns, inst:GetPropertyChangedSignal("Source"):Connect(function()
		if applying[inst] ~= inst.Source then
			queueSourceSend(inst)
		end
	end))
end

local function onAdded(inst)
	if not inst:IsA("LuaSourceContainer") or CollectionService:HasTag(inst, TAG) then
		return
	end
	if not underRoot(inst) then
		return
	end
	-- a script created by hand inside a synced folder: give it a file
	task.delay(1, function()
		if not inst.Parent or CollectionService:HasTag(inst, TAG) or not underRoot(inst) then
			return
		end
		inst:AddTag(TAG)
		watch(inst)
		applying[inst] = inst.Source
		sendEvent("created", { path = pathOf(inst), class = inst.ClassName, source = inst.Source })
	end)
end

function Sync.stop()
	for _, c in conns do
		c:Disconnect()
	end
	conns = {}
	watched = setmetatable({}, { __mode = "k" })
	roots = {}
end

local function startWatching()
	for _, c in conns do
		c:Disconnect()
	end
	conns = {}
	watched = setmetatable({}, { __mode = "k" })
	for _, inst in CollectionService:GetTagged(TAG) do
		watch(inst)
	end
	local seenRoots = {}
	for _, r in roots do
		local inst = resolve(r)
		if inst and not seenRoots[inst] then
			seenRoots[inst] = true
			table.insert(conns, inst.DescendantAdded:Connect(onAdded))
		end
	end
end

-- files -> Studio ------------------------------------------------------------

local function replaceClass(old, className)
	local new = Instance.new(className)
	new.Name = old.Name
	for _, c in old:GetChildren() do
		c.Parent = new
	end
	new.Parent = old.Parent
	old:Destroy()
	return new
end

local function applyProps(inst, props)
	if not props then
		return
	end
	local Api = require(script.Parent.Api)
	for prop, v in props do
		local okRead, cur = pcall(function()
			return inst[prop]
		end)
		if okRead then
			local okSet, err = pcall(function()
				inst[prop] = Codec.decode(Api.propType(inst.ClassName, prop), v, cur)
			end)
			if not okSet then
				pushError(inst:GetFullName() .. "." .. tostring(prop) .. ": " .. tostring(err))
			end
		else
			pushError(inst:GetFullName() .. ": unknown property " .. tostring(prop))
		end
	end
end

local function applyItem(item)
	local path = item.path
	if #path == 1 then
		-- a service: only properties
		local svc = resolve(path)
		if svc then
			applyProps(svc, item.props)
		end
		return
	end
	local parentPath = table.move(path, 1, #path - 1, 1, {})
	local parent = resolve(parentPath)
	if not parent then
		table.insert(stats.errors, "parent missing for " .. table.concat(path, "/"))
		return
	end
	local name = path[#path]
	local inst = parent:FindFirstChild(name)

	if item.spec then
		-- model file: rebuild when content changed
		if inst and inst:GetAttribute("RoLinkHash") == item.hash then
			return
		end
		if inst and (CollectionService:HasTag(inst, TAG) or item.adopt) then
			inst:Destroy()
		elseif inst then
			table.insert(stats.errors, table.concat(path, "/") .. " exists and is not synced; not replacing")
			return
		end
		local spec = table.clone(item.spec)
		spec.name = name
		local res = Build.run(parent, { spec }, { origin = item.origin })
		for _, w in res.warnings do
			table.insert(stats.errors, w)
		end
		for _, c in res.created do
			c:AddTag(TAG)
			c:SetAttribute("RoLinkHash", item.hash)
		end
		stats.models += 1
		return
	end

	if item.rbxm then
		if inst and inst:GetAttribute("RoLinkHash") == item.hash then
			return
		end
		if inst and CollectionService:HasTag(inst, TAG) then
			inst:Destroy()
		elseif inst then
			table.insert(stats.errors, table.concat(path, "/") .. " exists and is not synced; not replacing")
			return
		end
		local SerializationService = game:GetService("SerializationService")
		local list = SerializationService:DeserializeInstancesAsync(Util.base64Decode(item.rbxm))
		local root = list[1]
		if #list ~= 1 then
			root = Instance.new("Model")
			for _, x in list do
				x.Parent = root
			end
		end
		root.Name = name
		root:AddTag(TAG)
		root:SetAttribute("RoLinkHash", item.hash)
		root.Parent = parent
		stats.models += 1
		return
	end

	if inst and inst.ClassName ~= item.class then
		if CollectionService:HasTag(inst, TAG) or inst:IsA("LuaSourceContainer") or inst:IsA("Folder") then
			inst = replaceClass(inst, item.class)
		else
			table.insert(stats.errors, table.concat(path, "/") .. " is a " .. inst.ClassName .. ", file wants " .. item.class)
			return
		end
	end
	if not inst then
		inst = Instance.new(item.class)
		inst.Name = name
		if item.source ~= nil and inst:IsA("LuaSourceContainer") then
			setSource(inst, item.source)
		end
		applyProps(inst, item.props)
		inst.Parent = parent
		stats.created += 1
	else
		if item.source ~= nil and inst:IsA("LuaSourceContainer") and inst.Source ~= item.source then
			setSource(inst, item.source)
			stats.updated += 1
		end
		applyProps(inst, item.props)
	end
	if not CollectionService:HasTag(inst, TAG) then
		inst:AddTag(TAG)
	end
	watch(inst)
end

--[[
	args.action = "full"  : items = complete snapshot, roots = owned paths
	args.action = "patch" : upsert = items, remove = paths
	args.action = "stop"
]]
function Sync.apply(args)
	stats = { created = 0, updated = 0, removed = 0, models = 0, errors = {} }
	if args.action == "stop" then
		Sync.stop()
		return stats
	end
	if args.action == "full" then
		roots = args.roots or {}
		local keep = {}
		for _, item in args.items do
			keep[key(item.path)] = true
		end
		for _, item in args.items do
			applyItem(item)
		end
		-- remove synced instances whose file is gone
		for _, inst in CollectionService:GetTagged(TAG) do
			if inst.Parent and underRoot(inst) and not keep[key(pathOf(inst))] then
				-- only if no synced ancestor is also being removed (Destroy covers it)
				inst:Destroy()
				stats.removed += 1
			end
		end
		startWatching()
		return stats
	end
	for _, item in args.upsert or {} do
		applyItem(item)
	end
	for _, p in args.remove or {} do
		local inst = resolve(p)
		if inst and CollectionService:HasTag(inst, TAG) then
			inst:Destroy()
			stats.removed += 1
		end
	end
	return stats
end

return Sync
