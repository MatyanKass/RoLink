-- Editor actions a person does by hand in Studio: arrange, weld, collision
-- groups, focus the camera, search and check scripts, generate models.

local Build = require(script.Parent.Build)
local Codec = require(script.Parent.Codec)
local Paths = require(script.Parent.Paths)
local View = require(script.Parent.View)

local Editor = {}

local AXES = { x = "X", y = "Y", z = "Z" }
local UNIT = { X = Vector3.new(1, 0, 0), Y = Vector3.new(0, 1, 0), Z = Vector3.new(0, 0, 1) }
local INTERNAL_SERVICES = {
	CoreGui = true, PluginGuiService = true, PluginDebugService = true, CorePackages = true,
	RobloxPluginGuiService = true, StudioService = true, PluginManagementService = true,
}
local PREDEFINED_SCHEMAS = { Car5 = true, Body1 = true }
local MAX_LINE = 200
local DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT = 200, 2000

local function axisOf(args)
	local axis = AXES[string.lower(tostring(args.axis))]
	if not axis then
		error('axis must be "x", "y" or "z", got ' .. tostring(args.axis), 0)
	end
	return axis
end

local function spatial(spec)
	if spec == nil then
		error("paths is required", 0)
	end
	local items = {}
	for _, inst in Paths.resolveMany(spec) do
		if not inst:IsA("PVInstance") then
			error(string.format("cannot move %s: a %s has no position of its own", Paths.of(inst), inst.ClassName), 0)
		end
		local b = Build.bounds({ inst })
		if not b then
			error("cannot move " .. Paths.of(inst) .. ": it has no parts", 0)
		end
		table.insert(items, { inst = inst, min = b.min, max = b.max, center = b.center, size = b.size })
	end
	if #items == 0 then
		error("nothing selected / no target given", 0)
	end
	return items
end

local function shift(item, axis, delta)
	item.inst:PivotTo(item.inst:GetPivot() + UNIT[axis] * delta)
end

function Editor.align(args)
	local axis = axisOf(args)
	local to = args.to
	if to ~= "min" and to ~= "center" and to ~= "max" then
		error('to must be "min", "center" or "max", got ' .. tostring(to), 0)
	end
	if args.relativeTo ~= nil and args.relativeTo ~= "all" and args.relativeTo ~= "first" then
		error('relativeTo must be "all" or "first", got ' .. tostring(args.relativeTo), 0)
	end
	local items = spatial(args.paths or args.path)
	local goal
	if type(args.value) == "number" then
		goal = args.value
	elseif args.relativeTo == "first" then
		goal = items[1][to][axis]
	else
		local lo, hi = math.huge, -math.huge
		for _, item in items do
			lo = math.min(lo, item.min[axis])
			hi = math.max(hi, item.max[axis])
		end
		goal = (to == "min" and lo) or (to == "max" and hi) or (lo + hi) / 2
	end
	local moved = {}
	for _, item in items do
		shift(item, axis, goal - item[to][axis])
		table.insert(moved, Paths.ref(item.inst))
	end
	return { moved = moved, axis = axis, value = goal }
end

function Editor.distribute(args)
	local axis = axisOf(args)
	local items = spatial(args.paths or args.path)
	local spacing = tonumber(args.spacing)
	if #items < 2 or (spacing == nil and #items < 3) then
		error("distribute needs at least 3 targets, or 2 with a spacing", 0)
	end
	table.sort(items, function(a, b)
		return a.center[axis] < b.center[axis]
	end)
	local first, last = items[1], items[#items]
	local gap = spacing
	if gap == nil then
		local total = 0
		for _, item in items do
			total += item.size[axis]
		end
		gap = (last.max[axis] - first.min[axis] - total) / (#items - 1)
	end
	local cursor = first.max[axis]
	local stop = spacing == nil and #items - 1 or #items
	local moved = { Paths.ref(first.inst) }
	for i = 2, stop do
		local item = items[i]
		shift(item, axis, cursor + gap - item.min[axis])
		cursor += gap + item.size[axis]
		table.insert(moved, Paths.ref(item.inst))
	end
	return { moved = moved, axis = axis, gap = gap }
end

local function basePartsOf(inst)
	local parts = inst:IsA("BasePart") and { inst } or {}
	for _, d in inst:GetDescendants() do
		if d:IsA("BasePart") then
			table.insert(parts, d)
		end
	end
	return parts
end

local function volume(p)
	return p.Size.X * p.Size.Y * p.Size.Z
end

local function pairKey(a, b)
	return Paths.id(a) .. ":" .. Paths.id(b)
end

function Editor.weld_model(args)
	local inst = Paths.one(args.path)
	local parts = basePartsOf(inst)
	if #parts < 2 then
		error(Paths.of(inst) .. " has fewer than two parts: nothing to weld", 0)
	end
	local root
	if args.root then
		root = Paths.resolve(args.root, inst)
		if not root or not table.find(parts, root) then
			error("root is not a part of " .. Paths.of(inst) .. ": " .. tostring(args.root), 0)
		end
	elseif inst:IsA("Model") and inst.PrimaryPart then
		root = inst.PrimaryPart
	else
		root = parts[1]
		for _, p in parts do
			if volume(p) > volume(root) then
				root = p
			end
		end
	end

	local welded = {}
	for _, d in inst:GetDescendants() do
		if d:IsA("WeldConstraint") and d.Part0 and d.Part1 then
			welded[pairKey(d.Part0, d.Part1)] = true
			welded[pairKey(d.Part1, d.Part0)] = true
		end
	end

	local created, skipped = 0, 0
	for _, p in parts do
		if p ~= root then
			if welded[pairKey(root, p)] then
				skipped += 1
			else
				local w = Instance.new("WeldConstraint")
				w.Name = "RoLinkWeld"
				w.Part0 = root
				w.Part1 = p
				w.Parent = p
				created += 1
			end
		end
	end
	if args.unanchor then
		for _, p in parts do
			p.Anchored = false
		end
	end
	return { root = root.Name, created = created, skipped = skipped, parts = #parts }
end

function Editor.set_collision_groups(args)
	local physics = game:GetService("PhysicsService")
	local warnings = {}

	-- resolve every assignment first, so a bad one leaves nothing half-applied
	local assignments = {}
	local registered = {}
	for _, name in args.register or {} do
		registered[name] = true
	end
	for _, a in args.assign or {} do
		local group = a.group
		if type(group) ~= "string" or group == "" then
			error("assign needs a group", 0)
		end
		if group ~= "Default" and not registered[group] and not physics:IsCollisionGroupRegistered(group) then
			error('collision group "' .. group .. '" is not registered: add it to register first', 0)
		end
		local targets = {}
		for _, inst in Paths.resolveMany(a.paths or a.path) do
			for _, p in a.descendants == false and { inst } or basePartsOf(inst) do
				if p:IsA("BasePart") then
					table.insert(targets, p)
				end
			end
		end
		table.insert(assignments, { group = group, parts = targets })
	end

	for _, name in args.register or {} do
		if not physics:IsCollisionGroupRegistered(name) then
			local ok, err = pcall(function()
				physics:RegisterCollisionGroup(name)
			end)
			if not ok then
				table.insert(warnings, "register " .. name .. ": " .. tostring(err))
			end
		end
	end
	for _, rule in args.rules or {} do
		local ok, err = pcall(function()
			physics:CollisionGroupSetCollidable(rule.a, rule.b, rule.collide == true)
		end)
		if not ok then
			table.insert(warnings, string.format("rule %s/%s: %s", tostring(rule.a), tostring(rule.b), tostring(err)))
		end
	end

	local assigned = 0
	for _, a in assignments do
		for _, p in a.parts do
			p.CollisionGroup = a.group
			assigned += 1
		end
	end

	local ok, groups = pcall(function()
		return physics:GetRegisteredCollisionGroups()
	end)
	return {
		assigned = assigned,
		warnings = warnings,
		groups = ok and groups or {},
		note = "Registering groups and collision rules may not be part of the undo step; part assignments are.",
	}
end

function Editor.select_and_focus(args)
	local spec = args.paths or args.path
	local list = Paths.resolveMany(spec)
	game:GetService("Selection"):Set(list)
	local refs = {}
	for _, inst in list do
		table.insert(refs, Paths.ref(inst))
	end
	local ok, err = pcall(View.frame, { targets = spec, view = args.view or "iso", distance = args.distance, fov = args.fov })
	if not ok then
		return { selection = refs, focused = false, note = "selected, but the camera was not moved: " .. tostring(err) }
	end
	return { selection = refs, focused = true }
end

local function scriptsIn(root, out)
	if root:IsA("LuaSourceContainer") then
		table.insert(out, root)
	end
	for _, d in root:GetDescendants() do
		if d:IsA("LuaSourceContainer") then
			table.insert(out, d)
		end
	end
end

local function scriptsUnder(spec)
	local out = {}
	for _, root in Paths.resolveMany(spec or "game") do
		if root.ClassName == "DataModel" then
			-- the whole place, minus Studio's own UI and internals
			for _, svc in root:GetChildren() do
				if not INTERNAL_SERVICES[svc.ClassName] then
					pcall(scriptsIn, svc, out)
				end
			end
		else
			scriptsIn(root, out)
		end
	end
	return out
end

local function sourceOf(script_)
	local ok, src = pcall(function()
		return script_.Source
	end)
	return ok and src or nil
end

function Editor.script_search(args)
	local query = args.query
	if type(query) ~= "string" or query == "" then
		error("query is required", 0)
	end
	local isPattern = args.pattern == true
	local caseSensitive = isPattern or args.caseSensitive == true
	local needle = caseSensitive and query or string.lower(query)
	local limit = math.clamp(math.floor(tonumber(args.limit) or DEFAULT_SEARCH_LIMIT), 1, MAX_SEARCH_LIMIT)
	local matches, total, scripts = {}, 0, 0

	if isPattern then
		local ok, err = pcall(string.find, "", needle)
		if not ok then
			error("bad pattern: " .. tostring(err), 0)
		end
	end

	for _, script_ in scriptsUnder(args.root) do
		local src = sourceOf(script_)
		if src then
			local hits, ln = 0, 0
			for line in string.gmatch(src .. "\n", "([^\n]*)\n") do
				ln += 1
				local hay = caseSensitive and line or string.lower(line)
				local ok, found = pcall(string.find, hay, needle, 1, not isPattern)
				if not ok then
					error("bad pattern: " .. tostring(found), 0)
				end
				if found then
					hits += 1
					total += 1
					if #matches < limit then
						table.insert(matches, { path = Paths.of(script_), line = ln, text = string.sub(line, 1, MAX_LINE) })
					end
				end
			end
			if hits > 0 then
				scripts += 1
			end
		end
	end
	return { matches = matches, total = total, scripts = scripts, truncated = total > #matches }
end

local CHECK_NOTE = "Syntax check through loadstring only: Studio's Script Analysis results (types, lints) cannot be read from a plugin. The code is compiled, never run."

local function compile(src)
	if type(loadstring) ~= "function" then
		return "unavailable", "loadstring is not available in this Studio"
	end
	local ok, f, err = pcall(loadstring, src, "=script")
	if not ok then
		return "unavailable", tostring(f)
	end
	if f then
		return "ok"
	end
	if string.find(tostring(err), "loadstring() is not available", 1, true) then
		return "unavailable", tostring(err)
	end
	return "error", tostring(err)
end

function Editor.script_diagnostics(args)
	local diagnostics, checked = {}, 0
	for _, script_ in scriptsUnder(args.paths or args.path) do
		local src = sourceOf(script_)
		if src then
			local status, err = compile(src)
			if status == "unavailable" then
				return { available = false, checked = 0, withErrors = 0, diagnostics = {}, note = "Could not check syntax: " .. err .. ". Studio's Script Analysis results cannot be read from a plugin either (loadstring was the only route)." }
			end
			checked += 1
			if status == "error" then
				local line, message = string.match(err, ":(%d+): (.+)")
				table.insert(diagnostics, { path = Paths.of(script_), line = tonumber(line), message = message or err })
			end
		end
	end
	return { available = true, checked = checked, withErrors = #diagnostics, diagnostics = diagnostics, note = CHECK_NOTE }
end

function Editor.generate_model(args)
	local prompt, image = args.prompt, args.image
	if (type(prompt) ~= "string" or prompt == "") and image == nil then
		error("generate_model needs a prompt or an image", 0)
	end
	if args.parts and args.predefined then
		error("pass either parts or predefined, not both", 0)
	end
	if args.predefined and not PREDEFINED_SCHEMAS[args.predefined] then
		error("predefined must be Car5 or Body1, got " .. tostring(args.predefined), 0)
	end
	local name = args.name or "GeneratedModel"
	local parent = args.parent and Paths.one(args.parent) or workspace

	local inputs = {}
	if type(prompt) == "string" and prompt ~= "" then
		inputs.TextPrompt = prompt
	end
	if image ~= nil then
		inputs.Image = Content.fromAssetId(image)
	end
	if args.size then
		inputs.Size = Codec.vector3(args.size)
	end
	if args.maxTriangles then
		inputs.MaxTriangles = args.maxTriangles
	end
	if args.textures ~= nil then
		inputs.GenerateTextures = args.textures == true
	end
	local schema
	if args.predefined then
		schema = { PredefinedSchema = args.predefined }
	else
		schema = { SchemaDefinition = { Groups = args.parts or { name } } }
	end

	local ok, model, meta = pcall(function()
		return game:GetService("GenerationService"):GenerateModelAsync(inputs, schema)
	end)
	if not ok then
		error(
			"GenerationService:GenerateModelAsync failed: "
				.. tostring(model)
				.. ". Roblox's docs do not say whether a plugin holds the DynamicGeneration capability this needs; if this keeps failing, generation is not available from a plugin here.",
			0
		)
	end
	if typeof(model) ~= "Instance" then
		error("GenerationService returned no model", 0)
	end

	model.Name = name
	if args.at then
		model:PivotTo(CFrame.new(Codec.vector3(args.at)))
	end
	model.Parent = parent
	game:GetService("Selection"):Set({ model })
	return { created = { Paths.ref(model) }, uuid = meta and meta.UUID or nil }
end

return Editor
