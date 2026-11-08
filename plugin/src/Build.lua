-- Build-spec JSON -> instances. See docs/BUILD_FORMAT.md for the full format.
--
-- Coordinates are local: a node's `at`/`rot` (or `cf`/`origin`) place it in its
-- parent node's frame; Models and Parts open a new frame for their children.
-- The whole subtree is assembled detached and parented at the end.

local AssetService = game:GetService("AssetService")

local Api = require(script.Parent.Api)
local Codec = require(script.Parent.Codec)
local Paths = require(script.Parent.Paths)
local Serialize = require(script.Parent.Serialize)

local Build = {}

local MAX_NODES = 50000

-- Lowercase keys with special meaning; anything else starting with an
-- uppercase letter is treated as a property.
local RESERVED = {
	class = true, name = true, at = true, rot = true, cf = true, origin = true, size = true,
	color = true, material = true, shape = true, transparency = true, props = true, attrs = true,
	tags = true, children = true, ["repeat"] = true, mirror = true, csg = true, span = true,
	thickness = true, mesh = true, asset = true, primary = true, scale = true, weld = true,
	source = true, more = true, lines = true, opaque = true, id = true, comment = true,
}

local SHAPES = {
	block = Enum.PartType.Block,
	ball = Enum.PartType.Ball,
	sphere = Enum.PartType.Ball,
	cylinder = Enum.PartType.Cylinder,
}

local function warn_(ctx, path, msg)
	if #ctx.warnings < 200 then
		table.insert(ctx.warnings, path .. ": " .. msg)
	end
end

local function classOf(n)
	if n.class then
		return n.class
	end
	local shape = type(n.shape) == "string" and string.lower(n.shape) or nil
	if shape == "wedge" then
		return "WedgePart"
	elseif shape == "cornerwedge" then
		return "CornerWedgePart"
	end
	if n.mesh then
		return "MeshPart"
	end
	if n.asset then
		return "Model"
	end
	if n.size or n.span or n.shape or n.csg or n.color or n.material then
		return "Part"
	end
	if n.children then
		return "Model"
	end
	return "Part"
end

local function localCF(n)
	if n.cf then
		return Codec.cframe(n.cf)
	end
	if n.origin then
		return Codec.cframe(n.origin)
	end
	local cf = CFrame.identity
	if n.at then
		cf = CFrame.new(Codec.vector3(n.at))
	end
	if n.rot then
		local r = Codec.vector3(n.rot)
		cf *= CFrame.fromOrientation(math.rad(r.X), math.rad(r.Y), math.rad(r.Z))
	end
	return cf
end

-- Reflect `cf` across the planes given by sign vector `s` in the `base` frame.
local function reflect(cf, base, s)
	local l = base:Inverse() * cf
	local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = l:GetComponents()
	local sx, sy, sz = s.X, s.Y, s.Z
	local m = CFrame.new(
		x * sx, y * sy, z * sz,
		r00 * sx * sx, r01 * sx * sy, r02 * sx * sz,
		r10 * sy * sx, r11 * sy * sy, r12 * sy * sz,
		r20 * sz * sx, r21 * sz * sy, r22 * sz * sz
	)
	return base * m
end

local function finalCF(cf, mirrors)
	for i = #mirrors, 1, -1 do
		cf = reflect(cf, mirrors[i].base, mirrors[i].s)
	end
	return cf
end

local MIRROR_AXES = { x = Vector3.new(-1, 1, 1), y = Vector3.new(1, -1, 1), z = Vector3.new(1, 1, -1) }

-- Expand `repeat` and `mirror` into concrete variants.
local function variants(n)
	local out = {}
	local rep = n["repeat"]
	local count = rep and math.max(1, math.floor(tonumber(rep.count) or 1)) or 1
	local mirrorSets = { false }
	if n.mirror then
		local axes = type(n.mirror) == "table" and n.mirror or { n.mirror }
		local list = {}
		for _, a in axes do
			local s = MIRROR_AXES[string.lower(tostring(a))]
			if not s then
				error("mirror axis must be x, y or z", 0)
			end
			table.insert(list, s)
		end
		-- every combination of the requested axes (x, z -> x, z, xz)
		for mask = 1, (2 ^ #list) - 1 do
			local s = Vector3.one
			for bit = 1, #list do
				if bit32.btest(mask, 2 ^ (bit - 1)) then
					s *= list[bit]
				end
			end
			table.insert(mirrorSets, s)
		end
	end
	for i = 1, count do
		local xf = CFrame.identity
		if rep then
			local k = i - 1
			if rep.step then
				xf = CFrame.new(Codec.vector3(rep.step) * k)
			end
			if rep.rotStep then
				local r = Codec.vector3(rep.rotStep) * k
				xf *= CFrame.fromOrientation(math.rad(r.X), math.rad(r.Y), math.rad(r.Z))
			end
		end
		for _, m in mirrorSets do
			table.insert(out, { xf = xf, mirror = m or nil, index = i })
		end
	end
	return out
end

local function nameFor(n, cls, index)
	local name = n.name or cls
	if string.find(name, "%d", 1, true) then
		name = string.gsub(name, "%%d", tostring(index))
	end
	return name
end

local function setProp(ctx, inst, prop, value, where)
	local cls = inst.ClassName
	local t = Api.propType(cls, prop)
	if type(value) == "table" and value.ref ~= nil then
		table.insert(ctx.refs, { inst = inst, prop = prop, ref = value.ref, root = ctx.root, where = where })
		return
	end
	local current
	local readable, cur = pcall(function()
		return inst[prop]
	end)
	if not readable then
		local hint = Api.suggest(cls, prop)
		warn_(ctx, where, string.format("%s has no property '%s'%s", cls, prop, #hint > 0 and (" (did you mean " .. table.concat(hint, ", ", 1, math.min(#hint, 4)) .. "?)") or ""))
		return
	end
	current = cur
	local ok, decoded = pcall(Codec.decode, t, value, current)
	if not ok then
		warn_(ctx, where, prop .. ": " .. tostring(decoded))
		return
	end
	local setOk, err = pcall(function()
		inst[prop] = decoded
	end)
	if not setOk then
		warn_(ctx, where, "can't set " .. prop .. ": " .. tostring(err))
	end
end

local function applyAttrs(ctx, inst, attrs, where)
	for k, v in attrs do
		local ok, err = pcall(function()
			inst:SetAttribute(k, Codec.decodeAttr(v))
		end)
		if not ok then
			warn_(ctx, where, "attribute " .. k .. ": " .. tostring(err))
		end
	end
end

local function spanPlacement(n, frame)
	local a = frame * Codec.vector3(n.span[1])
	local b = frame * Codec.vector3(n.span[2])
	local len = (b - a).Magnitude
	if len < 1e-4 then
		error("span endpoints are identical", 0)
	end
	local w, h
	if type(n.thickness) == "table" then
		w, h = tonumber(n.thickness[1]) or 1, tonumber(n.thickness[2]) or 1
	else
		w = tonumber(n.thickness) or 1
		h = w
	end
	local mid = (a + b) / 2
	local up = math.abs((b - a).Unit:Dot(Vector3.yAxis)) > 0.99 and Vector3.xAxis or Vector3.yAxis
	local cf = CFrame.lookAt(mid, b, up)
	return cf, len, w, h
end

local function makeInstance(ctx, n, cls, where)
	if n.asset then
		local id = tostring(n.asset)
		if not string.find(id, "://", 1, true) then
			id = "rbxassetid://" .. id
		end
		local objs = game:GetObjects(id)
		if #objs == 1 then
			return objs[1]
		end
		local m = Instance.new("Model")
		for _, o in objs do
			o.Parent = m
		end
		return m
	end
	if n.mesh then
		local id = tostring(n.mesh)
		if not string.find(id, "://", 1, true) then
			id = "rbxassetid://" .. id
		end
		local ok, mp = pcall(function()
			return AssetService:CreateMeshPartAsync(id)
		end)
		if ok and mp then
			return mp
		end
		warn_(ctx, where, "mesh " .. id .. " failed to load (" .. tostring(mp) .. "), using a Part")
		return Instance.new("Part")
	end
	local ok, inst = pcall(Instance.new, cls)
	if not ok then
		error(where .. ": can't create class '" .. tostring(cls) .. "'", 0)
	end
	return inst
end

local function doCsg(ctx, base, n, baseCF, mirrors, where)
	local spec = n.csg
	local op = string.lower(spec.op or "subtract")
	local tools = {}
	local temp = Instance.new("Folder")
	temp.Name = "__RoLinkCSG"
	temp.Parent = workspace
	base.Parent = temp
	for i, wn in spec.with or {} do
		local cls = classOf(wn)
		local p = makeInstance(ctx, wn, cls, where .. "/csg[" .. i .. "]")
		Serialize.applyBuilderDefaults(p)
		if wn.shape and p:IsA("Part") then
			local s = SHAPES[string.lower(wn.shape)]
			if s then
				p.Shape = s
			end
		end
		if wn.size then
			p.Size = Codec.vector3(wn.size)
		end
		if wn.span then
			local cf, len, w, h = spanPlacement(wn, baseCF)
			p.Size = (p:IsA("Part") and p.Shape == Enum.PartType.Cylinder) and Vector3.new(len, w, w) or Vector3.new(w, h, len)
			if p:IsA("Part") and p.Shape == Enum.PartType.Cylinder then
				cf *= CFrame.Angles(0, math.pi / 2, 0)
			end
			p.CFrame = finalCF(cf, mirrors)
		else
			p.CFrame = finalCF(baseCF * localCF(wn), mirrors)
		end
		p.Parent = temp
		table.insert(tools, p)
	end
	local options = {
		CollisionFidelity = Enum.CollisionFidelity.PreciseConvexDecomposition,
		RenderFidelity = Enum.RenderFidelity.Precise,
		SplitApart = false,
	}
	local ok, res = pcall(function()
		local GeometryService = game:GetService("GeometryService")
		if op == "union" then
			return GeometryService:UnionAsync(base, tools, options)
		elseif op == "intersect" then
			return GeometryService:IntersectAsync(base, tools, options)
		end
		return GeometryService:SubtractAsync(base, tools, options)
	end)
	local result
	if ok and res and res[1] then
		result = res[1]
	else
		-- older API on BasePart
		local ok2, r2 = pcall(function()
			if op == "union" then
				return base:UnionAsync(tools)
			elseif op == "intersect" then
				return base:IntersectAsync(tools)
			end
			return base:SubtractAsync(tools)
		end)
		if not ok2 then
			temp:Destroy()
			error(where .. ": CSG " .. op .. " failed: " .. tostring(ok and "no result" or res) .. " / " .. tostring(r2), 0)
		end
		result = r2
	end
	result.Name = base.Name
	result.Anchored = base.Anchored
	for k, v in base:GetAttributes() do
		result:SetAttribute(k, v)
	end
	for _, tag in base:GetTags() do
		result:AddTag(tag)
	end
	result.Parent = nil
	temp:Destroy()
	ctx.csg += 1
	return result
end

local buildNode

local function buildVariant(ctx, n, v, parent, frame, mirrors, where, isTop)
	ctx.count += 1
	if ctx.count > MAX_NODES then
		error("build too large (> " .. MAX_NODES .. " instances); split it into several calls", 0)
	end
	local cls = classOf(n)
	local inst = makeInstance(ctx, n, cls, where)
	inst.Name = nameFor(n, inst.ClassName, v.index)
	where = where .. "/" .. inst.Name

	if v.mirror then
		mirrors = table.clone(mirrors)
		table.insert(mirrors, { base = frame, s = v.mirror })
	end
	local placed = frame * v.xf * localCF(n)

	if isTop then
		ctx.root = inst
	end

	local isPart = inst:IsA("BasePart")
	if isPart then
		Serialize.applyBuilderDefaults(inst)
		for prop, val in ctx.defaults do
			setProp(ctx, inst, prop, val, where)
		end
	end

	-- shorthands
	if n.shape and inst:IsA("Part") then
		local s = SHAPES[string.lower(n.shape)]
		if s then
			inst.Shape = s
		end
	end
	if n.color ~= nil then
		setProp(ctx, inst, "Color", n.color, where)
	end
	if n.material ~= nil then
		setProp(ctx, inst, "Material", n.material, where)
	end
	if n.transparency ~= nil then
		setProp(ctx, inst, "Transparency", n.transparency, where)
	end

	-- generic properties
	if n.props then
		for k, val in n.props do
			setProp(ctx, inst, k, val, where)
		end
	end
	for k, val in n do
		if type(k) == "string" and not RESERVED[k] and string.match(k, "^%u") then
			setProp(ctx, inst, k, val, where)
		end
	end

	if n.size ~= nil and isPart then
		local ok, err = pcall(function()
			inst.Size = Codec.vector3(n.size)
		end)
		if not ok then
			warn_(ctx, where, "size: " .. tostring(err))
		end
	end

	if n.size ~= nil and inst:IsA("GuiObject") then
		setProp(ctx, inst, "Size", n.size, where)
	end

	-- placement
	local childFrame = placed
	if n.span and isPart then
		local cf, len, w, h = spanPlacement(n, frame * v.xf)
		local cyl = inst:IsA("Part") and inst.Shape == Enum.PartType.Cylinder
		inst.Size = cyl and Vector3.new(len, w, w) or Vector3.new(w, h, len)
		if cyl then
			cf *= CFrame.Angles(0, math.pi / 2, 0)
		end
		inst.CFrame = finalCF(cf, mirrors)
		childFrame = cf
	elseif isPart then
		inst.CFrame = finalCF(placed, mirrors)
	elseif inst:IsA("Attachment") or inst:IsA("Bone") then
		inst.CFrame = localCF(n)
		childFrame = frame
	elseif inst:IsA("PVInstance") and n.asset then
		inst:PivotTo(finalCF(placed, mirrors))
	end

	if n.attrs then
		applyAttrs(ctx, inst, n.attrs, where)
	end
	if n.tags then
		for _, tag in n.tags do
			inst:AddTag(tag)
		end
	end
	if n.source ~= nil and inst:IsA("LuaSourceContainer") then
		inst.Source = n.source
	end

	if n.csg and isPart then
		local base = inst
		inst = doCsg(ctx, base, n, childFrame, mirrors, where)
		if ctx.root == base then
			ctx.root = inst
		end
	end

	if n.children then
		for _, c in n.children do
			buildNode(ctx, c, inst, childFrame, mirrors, where, false)
		end
	end

	if inst:IsA("Model") and not n.asset then
		if n.primary then
			local pp = Paths.resolve(n.primary, inst)
			if pp and pp:IsA("BasePart") then
				inst.PrimaryPart = pp
			else
				warn_(ctx, where, "primary '" .. tostring(n.primary) .. "' is not a part inside the model")
			end
		end
		local pivot = finalCF(placed, mirrors)
		if inst.PrimaryPart then
			inst.PrimaryPart.PivotOffset = inst.PrimaryPart.CFrame:Inverse() * pivot
		else
			inst.WorldPivot = pivot
		end
		if n.weld then
			local anchor = inst.PrimaryPart or inst:FindFirstChildWhichIsA("BasePart", true)
			if anchor then
				for _, d in inst:GetDescendants() do
					if d:IsA("BasePart") and d ~= anchor then
						local w = Instance.new("WeldConstraint")
						w.Part0 = anchor
						w.Part1 = d
						w.Parent = d
					end
				end
			end
		end
		if n.scale and tonumber(n.scale) and tonumber(n.scale) ~= 1 then
			inst:ScaleTo(tonumber(n.scale))
		end
	end

	inst.Parent = parent
	if isPart then
		ctx.parts += 1
	end
	return inst
end

function buildNode(ctx, n, parent, frame, mirrors, where, isTop)
	if type(n) ~= "table" then
		error(where .. ": node must be an object", 0)
	end
	local out = {}
	for _, v in variants(n) do
		table.insert(out, buildVariant(ctx, n, v, parent, frame, mirrors, where, isTop))
	end
	return out
end

local function resolveRefs(ctx)
	for _, r in ctx.refs do
		local ref = r.ref
		local target
		if ref == "." then
			target = r.root
		elseif type(ref) == "string" and string.sub(ref, 1, 2) == "./" then
			target = r.root and Paths.resolve(string.sub(ref, 3), r.root)
		else
			target = (r.root and Paths.resolve(ref, r.root)) or Paths.resolve(ref)
		end
		if not target then
			warn_(ctx, r.where, r.prop .. ": ref '" .. tostring(ref) .. "' not found")
		else
			local ok, err = pcall(function()
				r.inst[r.prop] = target
			end)
			if not ok then
				warn_(ctx, r.where, "can't set " .. r.prop .. ": " .. tostring(err))
			end
		end
	end
end

--[[
	Build.run(parent, items, opts)
	  items   array of nodes (or one node)
	  opts.origin    CFrame (wire format) for the top-level frame
	  opts.defaults  { [Prop] = value } applied to every new BasePart
	  opts.replace   destroy existing same-named children of `parent` first
	returns { created = {inst...}, warnings = {...}, parts = n, count = n, csg = n }
]]
function Build.run(parent, items, opts)
	opts = opts or {}
	if type(items) == "table" and (items.class or items.name or items.children or items.size) then
		items = { items }
	end
	local defaults = {}
	for k, v in opts.defaults or {} do
		local key = k
		if key == "color" then
			key = "Color"
		elseif key == "material" then
			key = "Material"
		elseif key == "anchored" then
			key = "Anchored"
		end
		defaults[key] = v
	end
	local frame = opts.origin and Codec.cframe(opts.origin) or CFrame.identity
	local created = {}
	local ctx = { warnings = {}, refs = {}, defaults = defaults, count = 0, parts = 0, csg = 0 }

	for i, n in items do
		local where = "[" .. i .. "]"
		local built = buildNode(ctx, n, nil, frame, {}, where, true)
		for _, inst in built do
			if opts.replace then
				for _, old in parent:GetChildren() do
					if old.Name == inst.Name and old ~= inst then
						old:Destroy()
					end
				end
			end
			inst.Parent = parent
			table.insert(created, inst)
		end
	end
	resolveRefs(ctx)
	return {
		created = created,
		warnings = ctx.warnings,
		parts = ctx.parts,
		count = ctx.count,
		csg = ctx.csg,
	}
end

-- Combined world bounding box of instances (Models, Parts). nil if nothing spatial.
function Build.bounds(list)
	local minV, maxV
	local function add(cf, size)
		local h = size / 2
		for _, sx in { -1, 1 } do
			for _, sy in { -1, 1 } do
				for _, sz in { -1, 1 } do
					local p = cf * Vector3.new(h.X * sx, h.Y * sy, h.Z * sz)
					minV = minV and minV:Min(p) or p
					maxV = maxV and maxV:Max(p) or p
				end
			end
		end
	end
	for _, inst in list do
		if inst:IsA("Model") or inst:IsA("WorldModel") then
			local ok, cf, size = pcall(function()
				return inst:GetBoundingBox()
			end)
			if ok and size.Magnitude > 0 then
				add(cf, size)
			end
		elseif inst:IsA("BasePart") then
			add(inst.CFrame, inst.Size)
		elseif inst:IsA("Folder") then
			local parts = {}
			for _, d in inst:GetDescendants() do
				if d:IsA("BasePart") then
					table.insert(parts, d)
				end
			end
			if #parts > 0 then
				local b = Build.bounds(parts)
				if b then
					add(CFrame.new(b.center), b.size)
				end
			end
		end
	end
	if not minV then
		return nil
	end
	return { center = (minV + maxV) / 2, size = maxV - minV, min = minV, max = maxV }
end

return Build
