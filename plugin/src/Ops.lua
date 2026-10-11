-- Command handlers. Each takes the decoded `args` table and returns a
-- JSON-friendly result (or errors with a readable message).

local ChangeHistoryService = game:GetService("ChangeHistoryService")
local CollectionService = game:GetService("CollectionService")
local Selection = game:GetService("Selection")

local Api = require(script.Parent.Api)
local Build = require(script.Parent.Build)
local Codec = require(script.Parent.Codec)
local Paths = require(script.Parent.Paths)
local Serialize = require(script.Parent.Serialize)
local Sync = require(script.Parent.Sync)
local Util = require(script.Parent.Util)
local View = require(script.Parent.View)

local Ops = {}
-- ops that change the place: wrapped in one undo step, rolled back on error
Ops.mutating = {
	build = true, set = true, delete = true, clone = true, move = true, run = true,
	terrain = true, import_rbxm = true, sync = true,
}

local pluginRef -- set by Main

function Ops.init(plugin)
	pluginRef = plugin
end

local function v3(v)
	return Codec.encode(v)
end

-- ------------------------------------------------------------------ reading

local function info(inst)
	local i = {}
	if inst:IsA("BasePart") then
		i.s = v3(inst.Size)
		i.p = v3(inst.Position)
	elseif inst:IsA("Model") then
		local ok, cf, size = pcall(function()
			return inst:GetBoundingBox()
		end)
		if ok then
			i.s = v3(size)
			i.p = v3(cf.Position)
		end
	elseif inst:IsA("LuaSourceContainer") then
		local ok, src = pcall(function()
			return inst.Source
		end)
		if ok then
			local _, n = string.gsub(src, "\n", "")
			i.lines = n + 1
		end
	end
	return i
end

local function treeNode(inst, depth, maxDepth, budget, filter)
	budget.n += 1
	local node = { n = inst.Name, c = inst.ClassName, id = Paths.id(inst) }
	for k, v in info(inst) do
		node[k] = v
	end
	local kids = inst:GetChildren()
	node.k = #kids
	if inst:IsA("Model") or inst:IsA("Folder") then
		local parts = 0
		for _, d in inst:GetDescendants() do
			if d:IsA("BasePart") then
				parts += 1
			end
		end
		node.parts = parts
	end
	if #kids == 0 or depth >= maxDepth or budget.n >= budget.max then
		return node
	end
	-- collapse runs of identical siblings (same name + class) into one entry
	local groups, order = {}, {}
	for _, c in kids do
		if not filter or filter(c) then
			local key = c.Name .. "\0" .. c.ClassName
			if not groups[key] then
				groups[key] = {}
				table.insert(order, key)
			end
			table.insert(groups[key], c)
		end
	end
	node.ch = {}
	for _, key in order do
		local g = groups[key]
		if budget.n >= budget.max then
			node.cut = true
			break
		end
		if #g >= 3 then
			budget.n += 1
			local first = g[1]
			local e = { n = first.Name, c = first.ClassName, x = #g, id = Paths.id(first) }
			for k, v in info(first) do
				e[k] = v
			end
			table.insert(node.ch, e)
		else
			for _, c in g do
				if budget.n >= budget.max then
					node.cut = true
					break
				end
				table.insert(node.ch, treeNode(c, depth + 1, maxDepth, budget, filter))
			end
		end
	end
	return node
end

function Ops.tree(args)
	local roots
	if args.path then
		roots = Paths.resolveMany(args.path)
	else
		roots = { workspace }
	end
	local filter
	if args.classes then
		filter = function(inst)
			for _, c in args.classes do
				if inst:IsA(c) then
					return true
				end
			end
			-- keep containers so filtered items deeper down stay reachable
			return inst:IsA("Folder") or inst:IsA("Model")
		end
	end
	local budget = { n = 0, max = args.maxNodes or 400 }
	local out = {}
	for _, r in roots do
		local node = treeNode(r, 0, args.depth or 2, budget, filter)
		node.path = Paths.of(r)
		table.insert(out, node)
	end
	return { roots = out, nodes = budget.n }
end

function Ops.inspect(args)
	local list = Paths.resolveMany(args.path or args.paths or "@selection")
	local out = {}
	local truncated = false
	for _, inst in list do
		local node, count, cut = Serialize.node(inst, {
			depth = args.depth,
			maxNodes = args.maxNodes or 1500,
			source = args.source,
			props = args.props,
		})
		node.path = Paths.of(inst)
		node.id = Paths.id(inst)
		if inst:IsA("PVInstance") then
			local b = Build.bounds({ inst })
			if b then
				node.bounds = { center = v3(b.center), size = v3(b.size) }
			end
		end
		node.instances = count
		truncated = truncated or cut
		table.insert(out, node)
	end
	return { nodes = out, truncated = truncated }
end

-- All property values of one instance (not only changed ones).
function Ops.get(args)
	local inst = Paths.one(args.path)
	local props = {}
	local names = args.props
	if not names then
		names = {}
		for p in Api.props(inst.ClassName) do
			table.insert(names, p)
		end
		if inst:IsA("BasePart") then
			table.insert(names, "Position")
			table.insert(names, "Orientation")
		end
		table.sort(names)
	end
	for _, p in names do
		local ok, v = pcall(function()
			return inst[p]
		end)
		if ok then
			props[p] = Codec.encode(v)
		else
			props[p] = "<unreadable>"
		end
	end
	if inst:IsA("LuaSourceContainer") and args.source ~= false then
		local ok, src = pcall(function()
			return inst.Source
		end)
		if ok then
			props.Source = src
		end
	end
	local attrs = {}
	for k, v in inst:GetAttributes() do
		attrs[k] = Codec.encodeAttr(v)
	end
	return {
		path = Paths.of(inst),
		id = Paths.id(inst),
		class = inst.ClassName,
		props = props,
		attrs = attrs,
		tags = inst:GetTags(),
		children = #inst:GetChildren(),
	}
end

function Ops.find(args)
	local roots = args.root and Paths.resolveMany(args.root) or { workspace }
	local limit = args.limit or 100
	local nameQ = args.name and string.lower(args.name)
	local namePattern = nameQ and string.sub(nameQ, 1, 1) == "^"
	local textQ = args.text
	local near = args.near and Codec.vector3(args.near.point or args.near[1] or args.near)
	local radius = args.near and tonumber(args.near.radius or args.radius) or nil
	local wmin = args.within and Codec.vector3(args.within.min or args.within[1])
	local wmax = args.within and Codec.vector3(args.within.max or args.within[2])
	local results = {}
	local total = 0

	local function position(inst)
		if inst:IsA("BasePart") then
			return inst.Position
		elseif inst:IsA("Model") then
			local ok, p = pcall(function()
				return inst:GetPivot().Position
			end)
			return ok and p or nil
		end
		return nil
	end

	local function matches(inst)
		if args.class and not inst:IsA(args.class) then
			return false
		end
		if args.exactClass and inst.ClassName ~= args.exactClass then
			return false
		end
		if nameQ then
			local n = string.lower(inst.Name)
			if namePattern then
				local ok, hit = pcall(string.find, n, nameQ)
				if not (ok and hit) then
					return false
				end
			elseif not string.find(n, nameQ, 1, true) then
				return false
			end
		end
		if args.tag and not CollectionService:HasTag(inst, args.tag) then
			return false
		end
		if args.attr then
			local v = inst:GetAttribute(args.attr)
			if v == nil then
				return false
			end
			if args.attrValue ~= nil and Codec.encodeAttr(v) ~= args.attrValue then
				return false
			end
		end
		if textQ then
			if not inst:IsA("LuaSourceContainer") then
				return false
			end
			local ok, src = pcall(function()
				return inst.Source
			end)
			if not ok or not string.find(src, textQ, 1, true) then
				return false
			end
		end
		if near or wmin then
			local p = position(inst)
			if not p then
				return false
			end
			if near and radius and (p - near).Magnitude > radius then
				return false
			end
			if wmin and wmax then
				local lo, hi = wmin:Min(wmax), wmin:Max(wmax)
				if p.X < lo.X or p.Y < lo.Y or p.Z < lo.Z or p.X > hi.X or p.Y > hi.Y or p.Z > hi.Z then
					return false
				end
			end
		end
		return true
	end

	for _, r in roots do
		for _, d in r:GetDescendants() do
			if matches(d) then
				total += 1
				if #results < limit then
					local e = Paths.ref(d)
					for k, v in info(d) do
						e[k] = v
					end
					if textQ then
						-- show matching lines
						local lines = {}
						local ln = 0
						for line in string.gmatch(d.Source .. "\n", "([^\n]*)\n") do
							ln += 1
							if string.find(line, textQ, 1, true) then
								table.insert(lines, ln .. ": " .. string.sub(line, 1, 200))
								if #lines >= 5 then
									break
								end
							end
						end
						e.matches = lines
					end
					table.insert(results, e)
				end
			end
		end
	end
	return { results = results, total = total }
end

function Ops.bounds(args)
	local list = Paths.resolveMany(args.path or args.paths or "@selection")
	local b = Build.bounds(list)
	if not b then
		return { empty = true }
	end
	return { center = v3(b.center), size = v3(b.size), min = v3(b.min), max = v3(b.max) }
end

function Ops.selection(args)
	if args.set then
		Selection:Set(Paths.resolveMany(args.set))
	end
	local out = {}
	for _, s in Selection:Get() do
		local e = Paths.ref(s)
		for k, v in info(s) do
			e[k] = v
		end
		table.insert(out, e)
	end
	return { selection = out }
end

-- ------------------------------------------------------------------ writing

local function createdRefs(list)
	local out = {}
	for _, inst in list do
		local e = Paths.ref(inst)
		if inst:IsA("Model") or inst:IsA("BasePart") then
			for k, v in info(inst) do
				e[k] = v
			end
		end
		table.insert(out, e)
	end
	return out
end

function Ops.build(args)
	local parent = args.parent and Paths.one(args.parent) or workspace
	local res = Build.run(parent, args.items or args.item, {
		origin = args.origin,
		defaults = args.defaults,
		replace = args.replace,
	})
	if args.select ~= false and #res.created > 0 then
		Selection:Set(res.created)
	end
	local b = Build.bounds(res.created)
	return {
		created = createdRefs(res.created),
		warnings = res.warnings,
		instances = res.count,
		parts = res.parts,
		csg = res.csg,
		bounds = b and { center = v3(b.center), size = v3(b.size) } or nil,
	}
end

function Ops.set(args)
	local edits = args.edits
	if not edits then
		edits = { { path = args.path or args.paths, props = args.props, attrs = args.attrs, tags = args.tags, untag = args.untag, name = args.name, source = args.source } }
	end
	local warnings = {}
	local updated = 0
	for _, e in edits do
		for _, inst in Paths.resolveMany(e.path) do
			local where = Paths.of(inst)
			if e.name then
				inst.Name = e.name
			end
			for prop, val in e.props or {} do
				if type(val) == "table" and val.ref ~= nil then
					local target = Paths.resolve(val.ref, inst) or Paths.resolve(val.ref)
					if not target then
						table.insert(warnings, where .. ": ref not found " .. tostring(val.ref))
					else
						local ok, err = pcall(function()
							inst[prop] = target
						end)
						if not ok then
							table.insert(warnings, where .. ": " .. tostring(err))
						end
					end
				else
					local okRead, cur = pcall(function()
						return inst[prop]
					end)
					if not okRead then
						local hint = Api.suggest(inst.ClassName, prop)
						table.insert(warnings, string.format("%s: %s has no property '%s'%s", where, inst.ClassName, prop, #hint > 0 and (" (did you mean " .. table.concat(hint, ", ", 1, math.min(#hint, 4)) .. "?)") or ""))
					else
						local ok, err = pcall(function()
							inst[prop] = Codec.decode(Api.propType(inst.ClassName, prop), val, cur)
						end)
						if not ok then
							table.insert(warnings, where .. "." .. prop .. ": " .. tostring(err))
						end
					end
				end
			end
			for k, v in e.attrs or {} do
				if v == false and e.removeFalseAttrs then
					inst:SetAttribute(k, nil)
				else
					local ok, err = pcall(function()
						inst:SetAttribute(k, Codec.decodeAttr(v))
					end)
					if not ok then
						table.insert(warnings, where .. " attr " .. k .. ": " .. tostring(err))
					end
				end
			end
			for _, t in e.tags or {} do
				inst:AddTag(t)
			end
			for _, t in e.untag or {} do
				inst:RemoveTag(t)
			end
			if e.source ~= nil and inst:IsA("LuaSourceContainer") then
				inst.Source = e.source
			end
			updated += 1
		end
	end
	return { updated = updated, warnings = warnings }
end

function Ops.delete(args)
	local list = Paths.resolveMany(args.path or args.paths)
	local names = {}
	for _, inst in list do
		if inst.Parent == game or inst == workspace or inst == game then
			error("refusing to delete a service: " .. inst.Name, 0)
		end
		table.insert(names, Paths.of(inst))
	end
	for _, inst in list do
		inst:Destroy()
	end
	return { deleted = names }
end

function Ops.clone(args)
	local src = Paths.one(args.path)
	local parent = args.parent and Paths.one(args.parent) or src.Parent
	local count = math.max(1, args.count or 1)
	local offset = args.offset and Codec.vector3(args.offset) or nil
	local created = {}
	for i = 1, count do
		local c = src:Clone()
		if args.name then
			c.Name = string.gsub(args.name, "%%d", tostring(i))
		end
		if c:IsA("PVInstance") then
			if args.cframe and count == 1 then
				c:PivotTo(Codec.cframe(args.cframe))
			elseif offset then
				c:PivotTo(src:GetPivot() + offset * i)
			end
		end
		c.Parent = parent
		table.insert(created, c)
	end
	Selection:Set(created)
	return { created = createdRefs(created) }
end

local function groundUnder(inst, pivot)
	local params = RaycastParams.new()
	params.FilterType = Enum.RaycastFilterType.Exclude
	params.FilterDescendantsInstances = { inst }
	local b = Build.bounds({ inst })
	local origin = (b and b.center or pivot.Position) + Vector3.new(0, 5000, 0)
	local hit = workspace:Raycast(origin, Vector3.new(0, -20000, 0), params)
	if not hit then
		return nil
	end
	local bottom = b and b.min.Y or pivot.Position.Y
	return hit.Position.Y - bottom
end

function Ops.move(args)
	local list = Paths.resolveMany(args.path or args.paths)
	local out = {}
	local newParent = args.parent and Paths.one(args.parent)
	for _, inst in list do
		if inst:IsA("PVInstance") then
			local pivot = inst:GetPivot()
			if args.to then
				pivot = Codec.cframe(args.to)
			end
			if args.position then
				pivot = pivot.Rotation + Codec.vector3(args.position)
			end
			if args.by then
				pivot += Codec.vector3(args.by)
			end
			if args.rotate then
				local r = Codec.vector3(args.rotate)
				pivot *= CFrame.fromOrientation(math.rad(r.X), math.rad(r.Y), math.rad(r.Z))
			end
			if args.orientation then
				local r = Codec.vector3(args.orientation)
				pivot = CFrame.new(pivot.Position) * CFrame.fromOrientation(math.rad(r.X), math.rad(r.Y), math.rad(r.Z))
			end
			inst:PivotTo(pivot)
			if args.ground then
				local dy = groundUnder(inst, pivot)
				if dy then
					inst:PivotTo(inst:GetPivot() + Vector3.new(0, dy, 0))
				end
			end
		end
		if newParent then
			inst.Parent = newParent
		end
		local e = Paths.ref(inst)
		for k, v in info(inst) do
			e[k] = v
		end
		table.insert(out, e)
	end
	return { moved = out }
end

function Ops.terrain(args)
	local t = workspace.Terrain
	local done = 0
	for i, op in args.ops or { args } do
		local kind = string.lower(op.op or "")
		local mat = op.material and Codec.decode("Enum:Material", op.material) or Enum.Material.Grass
		if kind == "block" or kind == "fillblock" then
			t:FillBlock(Codec.cframe(op.cf or op.at or { 0, 0, 0 }), Codec.vector3(op.size), mat)
		elseif kind == "ball" or kind == "fillball" then
			t:FillBall(Codec.vector3(op.center or op.at), tonumber(op.radius) or 8, mat)
		elseif kind == "cylinder" or kind == "fillcylinder" then
			t:FillCylinder(Codec.cframe(op.cf or op.at), tonumber(op.height) or 8, tonumber(op.radius) or 8, mat)
		elseif kind == "wedge" or kind == "fillwedge" then
			t:FillWedge(Codec.cframe(op.cf or op.at), Codec.vector3(op.size), mat)
		elseif kind == "replace" then
			local lo, hi = Codec.vector3(op.min), Codec.vector3(op.max)
			local region = Region3.new(lo:Min(hi), lo:Max(hi)):ExpandToGrid(4)
			t:ReplaceMaterial(region, 4, Codec.decode("Enum:Material", op.from), Codec.decode("Enum:Material", op.to))
		elseif kind == "clear" then
			if op.min and op.max then
				local lo, hi = Codec.vector3(op.min), Codec.vector3(op.max)
				local size = hi - lo
				t:FillBlock(CFrame.new((lo + hi) / 2), Vector3.new(math.abs(size.X), math.abs(size.Y), math.abs(size.Z)), Enum.Material.Air)
			else
				t:Clear()
			end
		else
			error("terrain op " .. i .. ": unknown op '" .. tostring(op.op) .. "' (block, ball, cylinder, wedge, replace, clear)", 0)
		end
		done += 1
	end
	return { ops = done }
end

-- ------------------------------------------------------------------ code

function Ops.run(args)
	local output = {}
	local function capture(prefix)
		return function(...)
			local parts = {}
			for i = 1, select("#", ...) do
				parts[i] = tostring((select(i, ...)))
			end
			local line = prefix .. table.concat(parts, " ")
			if #output < 500 then
				table.insert(output, line)
			end
		end
	end
	local env = {
		print = capture(""),
		warn = capture("[warn] "),
		args = args.args,
		plugin = pluginRef,
	}
	local fn
	local okLs, f, compileErr = pcall(loadstring, args.code)
	if okLs and f then
		setfenv(f, setmetatable(env, { __index = getfenv(1) }))
		fn = function()
			return f()
		end
	elseif okLs and compileErr then
		error("compile error: " .. tostring(compileErr), 0)
	else
		-- loadstring unavailable: compile through a ModuleScript
		local ms = Instance.new("ModuleScript")
		ms.Name = "RoLinkRun"
		ms.Source = "return function(print, warn, args, plugin)\n" .. args.code .. "\nend"
		local okReq, wrapper = pcall(require, ms)
		if not okReq then
			error("compile error: " .. tostring(wrapper), 0)
		end
		fn = function()
			return wrapper(env.print, env.warn, env.args, env.plugin)
		end
	end
	local results = table.pack(xpcall(fn, function(e)
		return tostring(e) .. "\n" .. debug.traceback(nil, 2)
	end))
	if not results[1] then
		return { ok = false, error = results[2], output = output }
	end
	local returns = {}
	for i = 2, results.n do
		returns[i - 1] = Util.deepEncode(results[i])
	end
	return { ok = true, returns = returns, output = output }
end

-- ------------------------------------------------------------------ history

function Ops.undo(args)
	for _ = 1, args.steps or 1 do
		ChangeHistoryService:Undo()
	end
	return { ok = true }
end

function Ops.redo(args)
	for _ = 1, args.steps or 1 do
		ChangeHistoryService:Redo()
	end
	return { ok = true }
end

-- ------------------------------------------------------------------ view

function Ops.shot_prepare(args)
	return View.prepare(args)
end

function Ops.shot_finish(args)
	return View.finish(args)
end

function Ops.camera(args)
	if args.set then
		View.frame(args.set)
	end
	local cam = workspace.CurrentCamera
	return { cframe = Codec.encode(cam.CFrame), focus = Codec.encode(cam.Focus.Position), fov = cam.FieldOfView, viewport = v3(cam.ViewportSize) }
end

-- ------------------------------------------------------------------ binary

function Ops.export_rbxm(args)
	local list = Paths.resolveMany(args.path or args.paths)
	local SerializationService = game:GetService("SerializationService")
	local buf = SerializationService:SerializeInstancesAsync(list)
	return { data = Util.base64Encode(buf), bytes = buffer.len(buf) }
end

function Ops.import_rbxm(args)
	local parent = args.parent and Paths.one(args.parent) or workspace
	local SerializationService = game:GetService("SerializationService")
	local list = SerializationService:DeserializeInstancesAsync(Util.base64Decode(args.data))
	for _, inst in list do
		if args.replace then
			for _, old in parent:GetChildren() do
				if old.Name == inst.Name then
					old:Destroy()
				end
			end
		end
		if args.cframe and inst:IsA("PVInstance") then
			inst:PivotTo(Codec.cframe(args.cframe))
		end
		inst.Parent = parent
	end
	Selection:Set(list)
	return { created = createdRefs(list) }
end

-- ------------------------------------------------------------------ sync

function Ops.sync(args)
	return Sync.apply(args)
end

-- ------------------------------------------------------------------ dispatch

function Ops.ping()
	return { pong = true }
end

function Ops.dispatch(op, args)
	local fn = Ops[op]
	if type(fn) ~= "function" or op == "dispatch" or op == "init" then
		error("unknown op '" .. tostring(op) .. "'", 0)
	end
	args = args or {}
	if not Ops.mutating[op] then
		return fn(args)
	end
	local rec = ChangeHistoryService:TryBeginRecording("RoLink: " .. op)
	local ok, res = xpcall(fn, function(e)
		return tostring(e)
	end, args)
	if rec then
		ChangeHistoryService:FinishRecording(rec, ok and Enum.FinishRecordingOperation.Commit or Enum.FinishRecordingOperation.Cancel)
	end
	if not ok then
		error(res, 0)
	end
	return res
end

return Ops
