-- Creator Store assets, handled conservatively: everything goes through a
-- quarantine (ServerStorage/RoLinkQuarantine) with scripts disabled, and the
-- server turns what is collected here into a report (server/src/toolbox.ts).

local InsertService = game:GetService("InsertService")
local MarketplaceService = game:GetService("MarketplaceService")
local Selection = game:GetService("Selection")
local ServerStorage = game:GetService("ServerStorage")

local Paths = require(script.Parent.Paths)

local Toolbox = {}

local QUARANTINE = "RoLinkQuarantine"
local ATTR_ASSET = "RoLinkAssetId"
local ATTR_WAS_ENABLED = "RoLinkWasEnabled"
local MAX_REF_LOOKUPS = 40
local MAX_NAME_CHARS = 50

local INVISIBLE = {
	{ 0x00AD, 0x00AD }, { 0x034F, 0x034F }, { 0x061C, 0x061C }, { 0x115F, 0x1160 }, { 0x17B4, 0x17B5 },
	{ 0x180B, 0x180F }, { 0x200B, 0x200F }, { 0x2028, 0x202F }, { 0x205F, 0x206F }, { 0x2800, 0x2800 },
	{ 0x3164, 0x3164 }, { 0xFE00, 0xFE0F }, { 0xFEFF, 0xFEFF }, { 0xFFA0, 0xFFA0 }, { 0xFFF0, 0xFFFF },
}

local function invisible(cp)
	if cp < 32 or (cp >= 127 and cp <= 159) then
		return true
	end
	for _, r in INVISIBLE do
		if cp >= r[1] and cp <= r[2] then
			return true
		end
	end
	return false
end

-- Asset names are third-party text: make them safe as one path segment.
function Toolbox.safeName(s)
	s = tostring(s or "")
	if not utf8.len(s) then
		s = string.gsub(s, "[\128-\255]", "")
	end
	local out, count = {}, 0
	for _, cp in utf8.codes(s) do
		if not invisible(cp) and count < MAX_NAME_CHARS then
			local ch = utf8.char(cp)
			if string.find(ch, "^[/#@%[%]%.\\]$") then
				ch = "_"
			end
			table.insert(out, ch)
			count += 1
		end
	end
	local name = table.concat(out)
	name = string.gsub(name, "%s+", " ")
	name = string.gsub(name, "^ +", "")
	name = string.gsub(name, " +$", "")
	return name ~= "" and name or "Asset"
end

local function productInfo(id)
	local ok, info = pcall(function()
		return MarketplaceService:GetProductInfoAsync(id)
	end)
	if ok and type(info) == "table" then
		return info
	end
	ok, info = pcall(function()
		return MarketplaceService:GetProductInfo(id)
	end)
	if ok and type(info) == "table" then
		return info
	end
	return nil
end

local function creatorOf(info)
	local c = info and info.Creator
	if type(c) ~= "table" then
		return nil
	end
	return { id = c.CreatorTargetId or c.Id, name = c.Name, type = c.CreatorType, verified = c.HasVerifiedBadge }
end

local function quarantineFolder()
	local q = ServerStorage:FindFirstChild(QUARANTINE)
	if not q then
		q = Instance.new("Folder")
		q.Name = QUARANTINE
		q.Parent = ServerStorage
	end
	return q
end

-- Works on the detached tree, so nothing has had a chance to run yet.
local function disableScripts(root)
	for _, d in root:GetDescendants() do
		if d:IsA("Script") or d:IsA("LocalScript") then
			d:SetAttribute(ATTR_WAS_ENABLED, d.Enabled)
			d.Enabled = false
		end
	end
end

local function relPath(inst, root)
	local parts = {}
	local cur = inst
	while cur and cur ~= root do
		table.insert(parts, 1, cur.Name)
		cur = cur.Parent
	end
	return table.concat(parts, "/")
end

local function assetIdIn(value)
	local s = tostring(value or "")
	return tonumber(string.match(s, "rbxassetid://(%d+)") or string.match(s, "[?&][iI][dD]=(%d+)") or string.match(s, "^(%d+)$"))
end

local REF_PROPS = { Sound = "SoundId", Animation = "AnimationId", Decal = "Texture", Texture = "Texture" }

local function collect(root, assetId, creator, loader)
	local out = {
		assetId = assetId,
		name = root.Name,
		creator = creator,
		path = Paths.of(root),
		loader = loader,
		counts = { instances = 0, parts = 0 },
		scripts = {},
		assetRefs = {},
		uncheckedRefs = 0,
	}
	local seen, lookups = {}, 0
	local descendants = root:GetDescendants()
	out.counts.instances = #descendants
	for _, d in descendants do
		if d:IsA("BasePart") then
			out.counts.parts += 1
		end
		local isRun = d:IsA("Script") or d:IsA("LocalScript")
		if isRun or d:IsA("ModuleScript") then
			local rc
			if d:IsA("Script") then
				local ok, v = pcall(function()
					return d.RunContext.Name
				end)
				rc = ok and v or nil
			end
			local was
			if isRun then
				was = d:GetAttribute(ATTR_WAS_ENABLED)
			end
			table.insert(out.scripts, {
				path = relPath(d, root),
				name = d.Name,
				class = d.ClassName,
				enabled = isRun and d.Enabled or nil,
				wasEnabled = was,
				runContext = rc,
				parentClass = d.Parent and d.Parent.ClassName or nil,
				source = d.Source,
			})
		end
		local prop = REF_PROPS[d.ClassName]
		if prop then
			local ok, value = pcall(function()
				return d[prop]
			end)
			local id = ok and assetIdIn(value) or nil
			if id and not seen[id] then
				seen[id] = true
				local ref = { kind = d.ClassName, id = id, path = relPath(d, root) }
				if lookups < MAX_REF_LOOKUPS then
					lookups += 1
					local c = creatorOf(productInfo(id))
					if c then
						ref.creatorId = c.id
						ref.creatorName = c.name
						ref.creatorType = c.type
					end
				else
					out.uncheckedRefs += 1
				end
				table.insert(out.assetRefs, ref)
			end
		end
	end
	local okBox, _, size = pcall(function()
		return root:GetBoundingBox()
	end)
	if okBox and size then
		out.sizeStuds = { size.X, size.Y, size.Z }
	end
	return out
end

local function loadAsset(id)
	local ok, res = pcall(function()
		return InsertService:LoadAsset(id)
	end)
	if ok and res then
		return res, "LoadAsset"
	end
	-- LoadAsset only serves assets the experience's creator may use. GetObjects
	-- is deprecated but still available to plugins for assets LoadAsset refuses.
	local okObj, objs = pcall(function()
		return game:GetObjects("rbxassetid://" .. tostring(id))
	end)
	if okObj and type(objs) == "table" and #objs > 0 then
		local m = Instance.new("Model")
		for _, o in objs do
			o.Parent = m
		end
		return m, "GetObjects"
	end
	error(string.format("could not load asset %d: %s (the asset may be private or not usable by this creator)", id, tostring(res)), 0)
end

function Toolbox.insert(args)
	local id = tonumber(args.assetId)
	if not id or id <= 0 or id ~= math.floor(id) then
		error("assetId must be a positive whole number", 0)
	end
	local q = quarantineFolder()
	for _, c in q:GetChildren() do
		if c:GetAttribute(ATTR_ASSET) == id then
			local out = collect(c, id, creatorOf(productInfo(id)), nil)
			out.existing = true
			return out
		end
	end
	local info = productInfo(id)
	local container, loader = loadAsset(id)
	disableScripts(container)
	local base = Toolbox.safeName(info and info.Name)
	container.Name = string.format("%s_%d", base, id)
	container:SetAttribute(ATTR_ASSET, id)
	container.Parent = q
	return collect(container, id, creatorOf(info), loader)
end

function Toolbox.release(args)
	local q = ServerStorage:FindFirstChild(QUARANTINE)
	if not q then
		error("nothing is quarantined", 0)
	end
	local inst = Paths.one(args.path)
	if inst.Parent ~= q then
		error("toolbox_release only moves direct children of ServerStorage/" .. QUARANTINE, 0)
	end
	local target = Paths.one(args.target)
	if target == q or target:IsDescendantOf(q) then
		error("target must be outside the quarantine", 0)
	end

	local children = inst:GetChildren()
	local moved
	if #children == 1 then
		moved = children[1]
		moved.Parent = target
		inst:Destroy()
	else
		moved = inst
		moved.Name = string.gsub(moved.Name, "_%d+$", "")
		moved.Parent = target
	end
	moved:SetAttribute(ATTR_ASSET, nil)

	local enable = args.enableScripts == true
	local enabled, disabled, unknown = 0, 0, 0
	local function apply(d)
		if d:IsA("Script") or d:IsA("LocalScript") then
			local was = d:GetAttribute(ATTR_WAS_ENABLED)
			if was == nil then
				unknown += 1 -- appeared after the scan: never reviewed
			end
			d.Enabled = enable and was == true
			if d.Enabled then
				enabled += 1
			else
				disabled += 1
			end
			d:SetAttribute(ATTR_WAS_ENABLED, nil)
		end
	end
	apply(moved)
	for _, d in moved:GetDescendants() do
		apply(d)
	end
	Selection:Set({ moved })
	return { moved = Paths.ref(moved), enabled = enabled, disabled = disabled, unknownScripts = unknown }
end

local PAGE_SIZE = 21
local SEARCHERS = { model = { "GetFreeModelsAsync", "GetFreeModels" }, decal = { "GetFreeDecalsAsync", "GetFreeDecals" } }

-- Key-less search through InsertService; the server prefers Open Cloud.
function Toolbox.search(args)
	local kind = args.kind or "model"
	local methods = SEARCHERS[kind]
	if not methods then
		error("Studio can only list free models and decals; searching '" .. tostring(kind) .. "' needs the Open Cloud key", 0)
	end
	local limit = math.clamp(tonumber(args.limit) or 20, 1, 100)
	local results = {}
	for page = 0, math.ceil(limit / PAGE_SIZE) - 1 do
		local ok, res = pcall(function()
			return InsertService[methods[1]](InsertService, args.query, page)
		end)
		if not ok then
			ok, res = pcall(function()
				return InsertService[methods[2]](InsertService, args.query, page)
			end)
		end
		if not ok then
			error("search failed: " .. tostring(res), 0)
		end
		local list = res and res[1] and res[1].Results
		if not list or #list == 0 then
			break
		end
		for _, r in list do
			if #results < limit then
				table.insert(results, { id = r.AssetId, name = r.Name, creator = r.CreatorName })
			end
		end
		if #list < PAGE_SIZE then
			break
		end
	end
	return { results = results }
end

return Toolbox
