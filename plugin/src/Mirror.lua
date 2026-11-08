-- Live mirror of the place: this side reads instance state and applies ops.
-- The server owns the file format. Identity is the session id from Paths.id;
-- nothing is written into the place (no marker attributes or tags).

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")

local Api = require(script.Parent.Api)
local Build = require(script.Parent.Build)
local Codec = require(script.Parent.Codec)
local Paths = require(script.Parent.Paths)
local Serialize = require(script.Parent.Serialize)

local Mirror = {}

local CHUNK_NODES = 400
local FRAME_BUDGET = 0.010
local FLUSH_DELAY = 0.25
local DELTA_NODES = 300

-- derived or carried elsewhere; never serialized
local SKIP = {
	BrickColor = true, Source = true,
	WorldPivot = true, WorldCFrame = true, WorldPosition = true, WorldOrientation = true, WorldAxis = true,
	WorldSecondaryAxis = true, LinkedSource = true, Pivot = true,
}

-- derived from CFrame on these classes only; a GUI's Position or an emitter's Rotation is real data
local PLACEMENT = { Position = true, Orientation = true, Rotation = true }

local sendEvent
local pluginRef
local loadApi
local active = false
local services = {} -- [service] = true
local walkStack = {}
local serviceConns = {}
local watchedTags = {}
local instConns = setmetatable({}, { __mode = "k" }) -- inst -> { connections }
local dirty = {} -- [inst] = true
local gone = {} -- [inst] = id
local flushScheduled = false

function Mirror.init(eventSender, plugin, apiLoader)
	sendEvent = eventSender
	pluginRef = plugin
	loadApi = apiLoader
end

local function excluded(inst)
	if inst.Archivable == false or inst.Name == "__RoLinkCSG" then
		return true -- not saved with the place, or Build's scratch folder
	end
	if inst:IsA("Camera") and inst.Parent == workspace then
		return true
	end
	if inst:IsA("Player") then
		return true
	end
	if inst:IsA("Model") and Players:GetPlayerFromCharacter(inst) then
		return true
	end
	return false
end

-- Inside a mirrored service and not below anything excluded.
local function mirrored(inst)
	local cur = inst
	while cur and cur ~= game do
		if services[cur] then
			return true
		end
		if excluded(cur) then
			return false
		end
		cur = cur.Parent
	end
	return false
end

-- Nearest Model or GUI at or above `inst`: what relative references are relative to.
local function refBase(inst)
	local cur = inst
	while cur and cur ~= game do
		if cur:IsA("Model") or cur:IsA("LayerCollector") then
			return cur
		end
		cur = cur.Parent
	end
	return nil
end

local function encodeRef(target, owner)
	local base = refBase(owner)
	if base then
		if target == base then
			return { ref = "." }
		end
		local rel = Paths.relative(target, base)
		if rel then
			return { ref = "./" .. rel }
		end
	end
	return { ref = Paths.of(target) }
end

local function encodeProps(inst)
	local props = {}
	local cls = inst.ClassName
	local derivedPlacement = inst:IsA("BasePart") or inst:IsA("Attachment")
	for prop, t in Api.props(cls) do
		if not SKIP[prop] and not (derivedPlacement and PLACEMENT[prop]) then
			local ok, v = pcall(function()
				return inst[prop]
			end)
			if ok then
				if t == "ref" then
					if v ~= nil then
						props[prop] = encodeRef(v, inst)
					end
				elseif v ~= nil and ((inst:IsA("BasePart") and (prop == "CFrame" or prop == "Size")) or not Serialize.isDefault(cls, prop, v)) then
					props[prop] = Codec.encode(v)
				end
			end
		end
	end
	if inst:IsA("Model") then
		props.Pivot = Codec.encode(inst:GetPivot())
	end
	if inst:IsA("MeshPart") then
		-- not script-writable, so not in the API table; shown read-only in the files
		local ok, id = pcall(function()
			return inst.MeshId
		end)
		if ok and id ~= "" then
			props.MeshId = id
		end
	end
	return props
end

local function encodeNode(inst)
	local parent = inst.Parent
	local node = {
		i = Paths.id(inst),
		p = services[inst] and 0 or (parent and Paths.id(parent) or 0),
		c = inst.ClassName,
		n = inst.Name,
		props = encodeProps(inst),
	}
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
	if inst:IsA("LuaSourceContainer") then
		local ok, src = pcall(function()
			return inst.Source
		end)
		if ok then
			node.src = src
		end
	end
	return node
end

-- Studio -> server --------------------------------------------------------

local function flush()
	flushScheduled = false
	if not active then
		return
	end
	local upserts, removed = {}, {}
	local t0 = os.clock()
	local function send()
		if #upserts > 0 or #removed > 0 then
			if sendEvent then
				sendEvent("mirror_delta", { upserts = upserts, removed = removed })
			end
			upserts, removed = {}, {}
		end
	end
	local batch = dirty
	local leaving = gone
	dirty, gone = {}, {}
	for inst, id in leaving do
		-- a reparent inside the mirror looks like remove + add: only a real exit is a removal
		if inst.Parent == nil or not mirrored(inst) then
			table.insert(removed, id)
			batch[inst] = nil
			local conns = instConns[inst]
			if conns then
				for _, c in conns do
					c:Disconnect()
				end
				instConns[inst] = nil
			end
		else
			batch[inst] = true
		end
	end
	-- parents first: a large batch is cut into several deltas, and a child needs its parent to exist
	local ordered = {}
	for inst in batch do
		if inst.Parent and mirrored(inst) then
			local depth, cur = 0, inst
			while cur and cur ~= game do
				depth += 1
				cur = cur.Parent
			end
			table.insert(ordered, { inst = inst, depth = depth })
		end
		if os.clock() - t0 > FRAME_BUDGET then
			task.wait()
			t0 = os.clock()
		end
	end
	table.sort(ordered, function(a, b)
		return a.depth < b.depth
	end)
	for _, entry in ordered do
		local inst = entry.inst
		if inst.Parent and mirrored(inst) then
			local ok, node = pcall(encodeNode, inst)
			if ok then
				table.insert(upserts, node)
			end
			if #upserts >= DELTA_NODES then
				send()
			end
			if os.clock() - t0 > FRAME_BUDGET then
				task.wait()
				t0 = os.clock()
			end
		end
	end
	send()
end

local function markDirty(inst)
	if not active then
		return
	end
	dirty[inst] = true
	if not flushScheduled then
		flushScheduled = true
		task.delay(FLUSH_DELAY, flush)
	end
end

-- Connections per tag rather than per instance, so the cost does not grow with the place.
local function onTagChanged(inst)
	if active and mirrored(inst) then
		markDirty(inst)
	end
end

local function watchTag(tag)
	if watchedTags[tag] then
		return
	end
	watchedTags[tag] = true
	table.insert(serviceConns, CollectionService:GetInstanceAddedSignal(tag):Connect(onTagChanged))
	table.insert(serviceConns, CollectionService:GetInstanceRemovedSignal(tag):Connect(onTagChanged))
end

local function watchInst(inst)
	if instConns[inst] then
		return
	end
	local function changed()
		markDirty(inst)
	end
	instConns[inst] = { inst.Changed:Connect(changed), inst.AttributeChanged:Connect(changed) }
end

local function onAdded(inst)
	if not active or not mirrored(inst) then
		return
	end
	watchInst(inst)
	gone[inst] = nil
	markDirty(inst)
end

local function onRemoving(inst)
	if not active then
		return
	end
	gone[inst] = Paths.id(inst)
	if not flushScheduled then
		flushScheduled = true
		task.delay(FLUSH_DELAY, flush)
	end
end

local function disconnectAll()
	for _, c in serviceConns do
		c:Disconnect()
	end
	serviceConns = {}
	watchedTags = {}
	for inst, conns in instConns do
		for _, c in conns do
			c:Disconnect()
		end
		instConns[inst] = nil
	end
	dirty, gone = {}, {}
end

local function start(args)
	if not Api.loaded() and loadApi then
		loadApi()
	end
	if not Api.loaded() then
		error("the class table has not loaded from the RoLink server yet, so instances cannot be read; try again in a moment", 0)
	end
	disconnectAll()
	active = true
	services = {}
	walkStack = {}
	local list = {}
	local wanted = {}
	for _, name in args.services or {} do
		wanted[name] = true
		local ok, svc = pcall(game.GetService, game, name)
		if ok and svc then
			services[svc] = true
			table.insert(walkStack, svc)
			table.insert(list, name)
			-- connected before the walk, so anything that changes during it is delivered afterwards
			table.insert(serviceConns, svc.DescendantAdded:Connect(onAdded))
			table.insert(serviceConns, svc.DescendantRemoving:Connect(onRemoving))
		end
	end
	for _, tag in CollectionService:GetAllTags() do
		watchTag(tag)
	end
	table.insert(serviceConns, CollectionService.TagAdded:Connect(watchTag))
	local others = {}
	for _, c in game:GetChildren() do
		local okName, n = pcall(function()
			return c.ClassName
		end)
		if okName and not wanted[n] and not services[c] then
			table.insert(others, n)
		end
	end
	table.sort(others)
	return { services = list, others = others }
end

-- One chunk of the dump. Yields between frames so Studio stays responsive.
local function nextChunk()
	local nodes = {}
	local t0 = os.clock()
	while #nodes < CHUNK_NODES and #walkStack > 0 do
		local inst = table.remove(walkStack)
		if services[inst] or (inst.Parent and not excluded(inst)) then
			local ok, node = pcall(encodeNode, inst)
			if ok then
				table.insert(nodes, node)
			end
			watchInst(inst)
			local kids = inst:GetChildren()
			for i = #kids, 1, -1 do
				table.insert(walkStack, kids[i])
			end
		end
		if os.clock() - t0 > FRAME_BUDGET then
			task.wait()
			t0 = os.clock()
		end
	end
	return { nodes = nodes, done = #walkStack == 0 }
end

function Mirror.control(args)
	if args.action == "start" then
		return start(args)
	elseif args.action == "next" then
		return nextChunk()
	elseif args.action == "stop" then
		active = false
		disconnectAll()
		return { stopped = true }
	end
	error("unknown mirror action " .. tostring(args.action), 0)
end

-- server -> Studio --------------------------------------------------------

local function setSource(inst, src)
	local ok, err = pcall(function()
		inst.Source = src
	end)
	if not ok then
		local okSes, errSes = pcall(function()
			game:GetService("ScriptEditorService"):UpdateSourceAsync(inst, function()
				return src
			end)
		end)
		if not okSes then
			error("could not set Source (" .. tostring(err) .. "; " .. tostring(errSes) .. ")", 0)
		end
	end
end

local function resolveRef(owner, ref)
	if ref == "." then
		return refBase(owner)
	end
	if type(ref) == "string" and string.sub(ref, 1, 2) == "./" then
		local base = refBase(owner)
		return base and Paths.resolve(string.sub(ref, 3), base)
	end
	return Paths.resolve(ref)
end

local function applyOne(ctx, inst, prop, v)
	local where = inst:GetFullName() .. "." .. tostring(prop)
	local readable, cur = pcall(function()
		return inst[prop]
	end)
	if not readable and not Api.propType(inst.ClassName, prop) then
		local hint = Api.suggest(inst.ClassName, prop)
		table.insert(ctx.errors, { where = where, message = "unknown property" .. (#hint > 0 and (" (did you mean " .. table.concat(hint, ", ") .. "?)") or "") })
		return
	end
	local ok, err = pcall(function()
		inst[prop] = Codec.decode(Api.propType(inst.ClassName, prop), v, cur)
	end)
	if not ok then
		table.insert(ctx.errors, { where = where, message = tostring(err) })
	end
end

local function applyProps(ctx, inst, props)
	if not props then
		return
	end
	if props.Pivot ~= nil then
		-- first: explicit CFrames in the same edit are absolute and win
		local ok, err = pcall(function()
			inst:PivotTo(Codec.cframe(props.Pivot))
		end)
		if not ok then
			table.insert(ctx.errors, { where = inst:GetFullName() .. ".Pivot", message = tostring(err) })
		end
	end
	for prop, v in props do
		if prop ~= "Pivot" then
			if type(v) == "table" and v.ref ~= nil then
				table.insert(ctx.refs, { inst = inst, prop = prop, ref = v.ref })
			else
				applyOne(ctx, inst, prop, v)
			end
		end
	end
end

local function applyAttrs(ctx, inst, attrs, remove)
	for k, v in attrs or {} do
		local ok, err = pcall(function()
			inst:SetAttribute(k, Codec.decodeAttr(v))
		end)
		if not ok then
			table.insert(ctx.errors, { where = inst:GetFullName() .. "@" .. tostring(k), message = tostring(err) })
		end
	end
	for _, k in remove or {} do
		pcall(function()
			inst:SetAttribute(k, nil)
		end)
	end
end

local function setTags(inst, tags)
	if not tags then
		return
	end
	local want = {}
	for _, t in tags do
		want[t] = true
		if not inst:HasTag(t) then
			inst:AddTag(t)
		end
	end
	for _, t in inst:GetTags() do
		if not want[t] then
			inst:RemoveTag(t)
		end
	end
end

local function byId(ctx, id)
	if type(id) == "number" and id < 0 then
		return ctx.tmp[id]
	end
	return Paths.resolve(id)
end

local function worldNode(part, baseCF, name)
	local n = { class = part.class or "Part", name = name or part.name or "Part", size = part.Size }
	local cf = Codec.cframe(part.CFrame or {})
	n.cf = baseCF and (baseCF:Inverse() * cf) or cf
	n.color = part.Color
	n.material = part.Material
	n.shape = part.Shape and string.lower(tostring(part.Shape)) or nil
	return n
end

-- A union is built by Build (GeometryService, falling back to the BasePart API).
local function makeCsg(ctx, op, parent)
	local parts = op.csg.parts
	if op.csg.op == "negate" then
		if not pluginRef then
			error("negate needs the plugin object", 0)
		end
		local built = Build.run(parent, { worldNode(parts[1], nil, op.name) }, {})
		local res = pluginRef:Negate(built.created)
		res[1].Name = op.name
		return res[1]
	end
	local baseCF = Codec.cframe(parts[1].CFrame or {})
	local spec = worldNode(parts[1], nil, op.name)
	local with = {}
	for i = 2, #parts do
		table.insert(with, worldNode(parts[i], baseCF))
	end
	spec.csg = { op = op.csg.op, with = with }
	local built = Build.run(parent, { spec }, {})
	for _, w in built.warnings do
		table.insert(ctx.errors, { where = tostring(op.name), message = w })
	end
	return built.created[1]
end

-- Geometry cannot be made by assigning properties: Unions need csg, MeshParts need a mesh load.
local function makeInstance(ctx, op, parent)
	if op.csg then
		return makeCsg(ctx, op, parent), true
	end
	if op.class == "UnionOperation" or op.class == "NegateOperation" or op.class == "IntersectOperation" then
		error(op.class .. ' needs a "csg" recipe; see AGENTS.md', 0)
	end
	if op.class == "MeshPart" and op.props and op.props.MeshId then
		local mp = Build.meshPart(op.props.MeshId)
		op.props = table.clone(op.props)
		op.props.MeshId = nil
		return mp, false
	end
	return Instance.new(op.class), false
end

local function doCreate(ctx, op)
	local parent = byId(ctx, op.parent)
	if not parent then
		table.insert(ctx.errors, { where = tostring(op.name), message = "parent was not created" })
		return
	end
	local ok, inst, parented = pcall(makeInstance, ctx, op, parent)
	if not ok or not inst then
		local why = ok and "the operation produced nothing" or tostring(inst)
		if string.find(why, "not a valid", 1, true) or string.find(why, "Unable to create", 1, true) then
			why = "cannot create class '" .. tostring(op.class) .. "'"
		end
		table.insert(ctx.errors, { where = tostring(op.name), message = why })
		return
	end
	if not parented then
		Serialize.applyBuilderDefaults(inst)
	end
	inst.Name = op.name
	if op.source ~= nil and inst:IsA("LuaSourceContainer") then
		local okS, err = pcall(setSource, inst, op.source)
		if not okS then
			table.insert(ctx.errors, { where = tostring(op.name), message = tostring(err) })
		end
	end
	applyProps(ctx, inst, op.props)
	applyAttrs(ctx, inst, op.attrs)
	setTags(inst, op.tags)
	local okP, err = pcall(function()
		inst.Parent = parent
	end)
	if not okP then
		inst:Destroy()
		table.insert(ctx.errors, { where = tostring(op.name), message = tostring(err) })
		return
	end
	ctx.tmp[op.t] = inst
	table.insert(ctx.created, op.t)
end

local function doSet(ctx, op)
	local inst = byId(ctx, op.id)
	if not inst then
		table.insert(ctx.errors, { where = "#" .. tostring(op.id), message = "instance no longer exists" })
		return
	end
	if op.name ~= nil then
		local ok, err = pcall(function()
			inst.Name = op.name
		end)
		if not ok then
			table.insert(ctx.errors, { where = inst:GetFullName(), message = tostring(err) })
		end
	end
	if op.parent ~= nil then
		local p = byId(ctx, op.parent)
		local ok, err = pcall(function()
			inst.Parent = p
		end)
		if not (ok and p) then
			table.insert(ctx.errors, { where = inst:GetFullName(), message = "could not move: " .. tostring(err) })
		end
	end
	if op.source ~= nil then
		local ok, err = pcall(setSource, inst, op.source)
		if not ok then
			table.insert(ctx.errors, { where = inst:GetFullName(), message = tostring(err) })
		end
	end
	applyProps(ctx, inst, op.props)
	applyAttrs(ctx, inst, op.attrs, op.attrsRemove)
	setTags(inst, op.tags)
	table.insert(ctx.touched, inst)
end

--[[
	args.ops, executed in order; returns the true state of everything touched:
	  { op="create", t=<negative temp id>, parent=id|t, class, name, props?, attrs?, tags?, source? }
	  { op="set", id=id|t, name?, parent?, source?, props?, attrs?, attrsRemove?, tags? }
	  { op="destroy", id=id }
	Instance references are resolved after every op, so they can point at anything in the batch.
]]
function Mirror.apply(args)
	local ctx = { tmp = {}, created = {}, touched = {}, errors = {}, refs = {} }
	for _, op in args.ops or {} do
		if op.op == "create" then
			doCreate(ctx, op)
		elseif op.op == "set" then
			doSet(ctx, op)
		elseif op.op == "destroy" then
			local inst = Paths.resolve(op.id)
			if inst then
				inst:Destroy()
			end
		end
	end
	for _, r in ctx.refs do
		local where = r.inst:GetFullName() .. "." .. tostring(r.prop)
		if r.ref == false then
			pcall(function()
				r.inst[r.prop] = nil
			end)
		else
			local target = resolveRef(r.inst, r.ref)
			if not target then
				table.insert(ctx.errors, { where = where, message = "reference not found: " .. tostring(r.ref) })
			else
				local ok, err = pcall(function()
					r.inst[r.prop] = target
				end)
				if not ok then
					table.insert(ctx.errors, { where = where, message = tostring(err) })
				end
			end
		end
	end
	local created = {}
	for _, t in ctx.created do
		table.insert(created, { t = t, node = encodeNode(ctx.tmp[t]) })
	end
	local nodes = {}
	for _, inst in ctx.touched do
		if inst.Parent then
			table.insert(nodes, encodeNode(inst))
		end
	end
	return { created = created, nodes = nodes, errors = ctx.errors }
end

-- exposed for the tests
Mirror._encodeNode = encodeNode

return Mirror
