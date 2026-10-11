-- Instance -> build-spec JSON (the same format Build.lua accepts), so anything
-- read from Studio can be edited and rebuilt, or saved to a file.
--
-- Placement is relative: a Model's children are expressed in the Model's pivot
-- frame, a Part's children in the Part's frame. Only properties that differ
-- from a freshly built instance are emitted.

local HttpService = game:GetService("HttpService")

local Api = require(script.Parent.Api)
local Codec = require(script.Parent.Codec)
local Paths = require(script.Parent.Paths)

local Serialize = {}

-- Properties the node format carries in dedicated fields.
local HANDLED = {
	CFrame = true, Size = true, Color = true, BrickColor = true, Material = true,
	WorldPivot = true, PrimaryPart = true, Source = true, MeshId = true,
	Position = true, Orientation = true, Rotation = true,
}

-- Defaults the builder applies to every new BasePart; serialization treats them
-- as "default" so they are not repeated on every node.
function Serialize.applyBuilderDefaults(inst)
	if inst:IsA("BasePart") then
		inst.Anchored = true
		inst.TopSurface = Enum.SurfaceType.Smooth
		inst.BottomSurface = Enum.SurfaceType.Smooth
	end
end

local defaultInst = {}
local defaultEnc = {}

local function enc(v)
	local e = Codec.encode(v)
	if type(e) == "table" then
		return HttpService:JSONEncode(e)
	end
	return e
end

local function defaultOf(className, prop)
	local perClass = defaultEnc[className]
	if not perClass then
		perClass = {}
		defaultEnc[className] = perClass
		local ok, inst = pcall(Instance.new, className)
		if ok and inst then
			Serialize.applyBuilderDefaults(inst)
			defaultInst[className] = inst
		end
	end
	local cached = perClass[prop]
	if cached ~= nil then
		return cached
	end
	local inst = defaultInst[className]
	local value = "\0nodefault"
	if inst then
		local ok, v = pcall(function()
			return inst[prop]
		end)
		if ok then
			value = enc(v)
			if value == nil then
				value = "\0nil"
			end
		end
	end
	perClass[prop] = value
	return value
end

local function isScript(inst)
	return inst:IsA("LuaSourceContainer")
end

local function countLines(src)
	local _, n = string.gsub(src, "\n", "")
	return n + 1
end

local function refValue(target, root)
	if target == root then
		return { ref = "." }
	end
	local rel = Paths.relative(target, root)
	if rel then
		return { ref = "./" .. rel }
	end
	return { ref = Paths.of(target) }
end

local function placement(node, localCf)
	local p = localCf.Position
	node.at = { Codec.round(p.X), Codec.round(p.Y), Codec.round(p.Z) }
	local r = Codec.orientation(localCf)
	if r[1] ~= 0 or r[2] ~= 0 or r[3] ~= 0 then
		node.rot = r
	end
end

--[[
	opts:
	  depth      max depth (default unlimited)
	  maxNodes   stop after this many nodes (default 3000)
	  source     include script Source (default false: only line counts)
	  props      "changed" (default) | "none"
]]
function Serialize.node(root, opts)
	opts = opts or {}
	local maxDepth = opts.depth or math.huge
	local budget = opts.maxNodes or 3000
	local count = 0
	local truncated = false

	local function visit(inst, parentFrame, depth, isRoot)
		count += 1
		local cls = inst.ClassName
		local node = { class = cls, name = inst.Name }
		local frame = parentFrame

		if inst:IsA("BasePart") then
			local cf = inst.CFrame
			if isRoot then
				node.cf = Codec.encode(cf)
			else
				placement(node, parentFrame:Inverse() * cf)
			end
			frame = cf
			node.size = Codec.encode(inst.Size)
			local col = Codec.hex(inst.Color)
			if col ~= defaultOf(cls, "Color") then
				node.color = col
			end
			if inst.Material.Name ~= defaultOf(cls, "Material") then
				node.material = inst.Material.Name
			end
			if inst:IsA("MeshPart") and inst.MeshId ~= "" then
				node.mesh = inst.MeshId
			end
			if inst:IsA("PartOperation") then
				node.opaque = true -- CSG geometry can't be rebuilt from JSON; use .rbxm export
			end
		elseif inst:IsA("Model") then
			local pivot = inst:GetPivot()
			if isRoot then
				node.origin = Codec.encode(pivot)
			else
				placement(node, parentFrame:Inverse() * pivot)
			end
			frame = pivot
			if inst.PrimaryPart then
				node.primary = Paths.relative(inst.PrimaryPart, inst)
			end
		elseif inst:IsA("Attachment") then
			placement(node, inst.CFrame)
		end

		if isScript(inst) then
			local ok, src = pcall(function()
				return inst.Source
			end)
			if ok then
				if opts.source then
					node.source = src
				else
					node.lines = countLines(src)
				end
			end
		end

		if opts.props ~= "none" then
			local props = {}
			local any = false
			for prop, t in Api.props(cls) do
				if not HANDLED[prop] and not (inst:IsA("Attachment") and (prop == "CFrame" or prop == "Position" or prop == "Orientation")) then
					local ok, v = pcall(function()
						return inst[prop]
					end)
					if ok then
						if t == "ref" then
							if v ~= nil then
								props[prop] = refValue(v, root)
								any = true
							end
						else
							local e = enc(v)
							local d = defaultOf(cls, prop)
							if e ~= d and not (e == nil and d == "\0nil") then
								props[prop] = Codec.encode(v)
								any = true
							end
						end
					end
				end
			end
			if any then
				node.props = props
			end
		end

		local attrs = inst:GetAttributes()
		if next(attrs) then
			local out = {}
			for k, v in attrs do
				out[k] = Codec.encodeAttr(v)
			end
			node.attrs = out
		end
		local tags = inst:GetTags()
		if #tags > 0 then
			node.tags = tags
		end

		local kids = inst:GetChildren()
		if #kids > 0 then
			if depth >= maxDepth or count >= budget then
				node.more = #kids
				truncated = true
			else
				node.children = {}
				for i, c in kids do
					if count >= budget then
						node.more = #kids - i + 1
						truncated = true
						break
					end
					table.insert(node.children, visit(c, frame, depth + 1, false))
				end
			end
		end
		return node
	end

	local node = visit(root, CFrame.identity, 0, true)
	return node, count, truncated
end

return Serialize
