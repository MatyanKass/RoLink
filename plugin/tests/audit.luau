-- Regression tests for audited plugin bugs. Lune has no instance events, so
-- fake signals are attached with roblox.implementProperty and fired by hand.

local H = ...
local roblox = H.roblox
local luau = require("@lune/luau")
local task = require("@lune/task")
local Instance, Vector3, CFrame, Color3, UDim2 = roblox.Instance, roblox.Vector3, roblox.CFrame, roblox.Color3, roblox.UDim2
local check = H.check
local ws = H.workspace
local game = H.game

local Paths = H.require("Paths")
local Build = H.require("Build")
local Serialize = H.require("Serialize")

local function signal()
	local s = { conns = {} }
	function s:Connect(fn)
		local c = { fn = fn }
		function c:Disconnect()
			local i = table.find(s.conns, c)
			if i then
				table.remove(s.conns, i)
			end
		end
		table.insert(s.conns, c)
		return c
	end
	function s:Once(fn)
		local c
		c = s:Connect(function(...)
			c:Disconnect()
			fn(...)
		end)
		return c
	end
	function s:Fire(...)
		for _, c in table.clone(s.conns) do
			c.fn(...)
		end
	end
	return s
end

local function folder(name)
	local f = Instance.new("Folder")
	f.Name = name
	f.Parent = ws
	return f
end

local added, removing = signal(), signal()
for _, cls in { "Workspace", "ServerStorage", "TestService", "Part", "Model", "Folder", "Frame", "Terrain", "Clouds", "MeshPart" } do
	local changed = signal()
	roblox.implementProperty(cls, "Changed", function()
		return changed
	end)
	roblox.implementProperty(cls, "AttributeChanged", function()
		return changed
	end)
end
for _, cls in { "Workspace", "ServerStorage", "TestService" } do
	roblox.implementProperty(cls, "DescendantAdded", function()
		return added
	end)
	roblox.implementProperty(cls, "DescendantRemoving", function()
		return removing
	end)
end

local tagAddedSignals, tagRemovedSignals, tagAdded = {}, {}, signal()
local allTags = {}
roblox.implementMethod("CollectionService", "GetAllTags", function()
	return allTags
end)
roblox.implementMethod("CollectionService", "GetInstanceAddedSignal", function(_, t)
	tagAddedSignals[t] = tagAddedSignals[t] or signal()
	return tagAddedSignals[t]
end)
roblox.implementMethod("CollectionService", "GetInstanceRemovedSignal", function(_, t)
	tagRemovedSignals[t] = tagRemovedSignals[t] or signal()
	return tagRemovedSignals[t]
end)
roblox.implementProperty("CollectionService", "TagAdded", function()
	return tagAdded
end)

local meshCalls, meshFails = {}, false
roblox.implementMethod("AssetService", "CreateMeshPartAsync", function(_, content, options)
	table.insert(meshCalls, { content = content, options = options })
	if meshFails or typeof(content) ~= "Content" then
		error("Unable to cast value to Content")
	end
	return Instance.new("MeshPart")
end)

local function freshMirror()
	local sent = {}
	local Mirror = H.requireWith("Mirror", {})
	Mirror.init(function(kind, payload)
		table.insert(sent, { kind = kind, payload = payload })
	end, nil)
	return Mirror, sent
end

-------------------------------------------------------------------------------
H.section("Mirror: deltas go out parents first")
do
	local Mirror, sent = freshMirror()
	local holder = folder("BigDelta")
	local model = Instance.new("Model")
	model.Name = "Big"
	local kids = {}
	for i = 1, 350 do
		local p = Instance.new("Part")
		p.Name = "P" .. i
		p.Parent = model
		table.insert(kids, p)
	end
	model.PrimaryPart = kids[1] -- Lune has no WorldPivot for a model without one
	model.Parent = holder
	Mirror.control({ action = "start", services = { "Workspace" } })
	for _, p in kids do
		added:Fire(p)
	end
	added:Fire(model)
	task.wait(0.5)
	Mirror.control({ action = "stop" })
	local order, n = {}, 0
	for _, e in sent do
		check(e.kind == "mirror_delta", "delta event")
		for _, u in e.payload.upserts do
			n += 1
			order[u.i] = n
		end
	end
	check(n == 351, "every instance sent, got " .. n)
	check(#sent >= 2, "split into several deltas, got " .. #sent)
	local mid = order[Paths.id(model)]
	local bad = 0
	for _, p in kids do
		if not mid or order[Paths.id(p)] < mid then
			bad += 1
		end
	end
	check(bad == 0, "the model precedes all children, " .. bad .. " came first")
	holder:Destroy()
end

-------------------------------------------------------------------------------
H.section("Mirror: placement properties are skipped only where derived")
do
	local Mirror = H.requireWith("Mirror", {})
	local f = Instance.new("Frame")
	f.Position = UDim2.new(0.5, 10, 0, 20)
	f.Rotation = 15
	local fn = Mirror._encodeNode(f).props
	check(fn.Position ~= nil and fn.Position[2] == 10, "GUI Position kept")
	check(fn.Rotation == 15, "GUI Rotation kept")

	local pe = Instance.new("ParticleEmitter")
	pe.Rotation = roblox.NumberRange.new(10, 20)
	pe.Orientation = roblox.Enum.ParticleOrientation.VelocityParallel
	local pn = Mirror._encodeNode(pe).props
	check(pn.Rotation ~= nil, "emitter Rotation kept")
	check(pn.Orientation ~= nil, "emitter Orientation kept")

	local ap = Instance.new("AlignPosition")
	ap.Position = Vector3.new(1, 2, 3)
	check(Mirror._encodeNode(ap).props.Position ~= nil, "constraint Position kept")

	local part = Instance.new("Part")
	part.Position = Vector3.new(4, 5, 6)
	part.Orientation = Vector3.new(0, 45, 0)
	local n = Mirror._encodeNode(part).props
	check(n.Position == nil and n.Orientation == nil and n.Rotation == nil, "part placement stays in CFrame")
	local att = Instance.new("Attachment")
	att.Position = Vector3.new(1, 0, 0)
	local an = Mirror._encodeNode(att).props
	check(an.Position == nil and an.Orientation == nil, "attachment placement stays in CFrame")
end

-------------------------------------------------------------------------------
H.section("Serialize: dedicated fields apply only where the format has them")
do
	local holder = folder("SerialHold")
	local gui = Instance.new("ScreenGui")
	gui.Name = "Gui"
	local fr = Instance.new("Frame")
	fr.Name = "F"
	fr.Size = UDim2.new(0, 120, 0, 30)
	fr.Position = UDim2.new(0.25, 1, 0.5, 2)
	fr.Rotation = 7
	fr.Parent = gui
	gui.Parent = holder
	local node = Serialize.node(gui, {})
	local f = node.children[1]
	check(f.props and f.props.Size ~= nil, "GUI Size exported")
	check(f.props and f.props.Position ~= nil, "GUI Position exported")
	check(f.props and f.props.Rotation == 7, "GUI Rotation exported")

	local part = Instance.new("Part")
	part.Name = "Lamp"
	part.Parent = holder
	local light = Instance.new("PointLight")
	light.Name = "L"
	light.Color = Color3.fromRGB(255, 0, 0)
	light.Parent = part
	local sm = Instance.new("SpecialMesh")
	sm.Name = "M"
	sm.MeshId = "rbxassetid://77"
	sm.Parent = part
	local pn = Serialize.node(part, {})
	local byName = {}
	for _, c in pn.children do
		byName[c.name] = c
	end
	check(byName.L.props and byName.L.props.Color == "#FF0000", "light Color exported")
	check(byName.M.props and byName.M.props.MeshId == "rbxassetid://77", "SpecialMesh MeshId exported")
	check(pn.props == nil or (pn.props.Size == nil and pn.props.Color == nil and pn.props.CFrame == nil and pn.props.Position == nil), "a part's own fields are not repeated in props")

	local json = H.serde.decode("json", H.serde.encode("json", node))
	json.name = "Gui2"
	local res = Build.run(holder, { json }, {})
	check(#res.warnings == 0, "rebuild clean: " .. table.concat(res.warnings, ";"))
	local f2 = holder:FindFirstChild("Gui2"):FindFirstChild("F")
	check(f2.Size == fr.Size and f2.Position == fr.Position and f2.Rotation == 7, "GUI layout survives an export and rebuild")
	holder:Destroy()
end

-------------------------------------------------------------------------------
H.section("MeshPart creation")
do
	local holder = folder("MeshHold")
	local r = Build.run(holder, { { name = "Rock", mesh = 123 } }, {})
	local call = meshCalls[#meshCalls]
	check(call ~= nil and typeof(call.content) == "Content", "Build passes a Content, got " .. typeof(call and call.content))
	check(call ~= nil and typeof(call.content) == "Content" and call.content.Uri == "rbxassetid://123", "numeric id becomes an asset uri")
	check(#r.warnings == 0 and r.created[1] and r.created[1]:IsA("MeshPart"), "MeshPart created: " .. table.concat(r.warnings, ";"))

	meshFails = true
	local bad = Build.run(holder, { { name = "Broken", mesh = "rbxassetid://9", children = { { class = "Attachment", name = "A" } } } }, {})
	meshFails = false
	check(holder:FindFirstChild("Broken") == nil, "no plain Part stands in for a failed mesh")
	check(#bad.created == 0, "nothing reported as created")
	check(#bad.warnings == 1 and string.find(bad.warnings[1], "rbxassetid://9", 1, true) ~= nil, "failure warned once: " .. table.concat(bad.warnings, ";"))

	local Mirror = H.requireWith("Mirror", {})
	local res = Mirror.apply({ ops = { { op = "create", t = -1, parent = Paths.id(holder), class = "MeshPart", name = "FromFile", props = { MeshId = "rbxassetid://44", Size = { 1, 2, 3 } } } } })
	local c2 = meshCalls[#meshCalls]
	check(typeof(c2.content) == "Content" and c2.content.Uri == "rbxassetid://44", "Mirror passes a Content")
	check(#res.errors == 0, "no errors: " .. (res.errors[1] and res.errors[1].message or ""))
	local mp = holder:FindFirstChild("FromFile")
	check(mp ~= nil and mp.Size == Vector3.new(1, 2, 3), "other props applied")

	meshFails = true
	local res2 = Mirror.apply({ ops = { { op = "create", t = -1, parent = Paths.id(holder), class = "MeshPart", name = "Fails", props = { MeshId = "rbxassetid://45" } } } })
	meshFails = false
	check(holder:FindFirstChild("Fails") == nil and #res2.errors == 1, "a failed mesh is reported by the mirror")

	local shown = Instance.new("MeshPart")
	shown.MeshId = "rbxassetid://44"
	check(Mirror._encodeNode(shown).props.MeshId == "rbxassetid://44", "MeshId is shown in the mirror")
	holder:Destroy()
end

-------------------------------------------------------------------------------
H.section("Ops.find near")
do
	local Ops = H.require("Ops")
	local holder = folder("NearHold")
	local a = Instance.new("Part")
	a.Name = "NearA"
	a.Position = Vector3.new(100, 0, 0)
	a.Parent = holder
	local b = Instance.new("Part")
	b.Name = "NearB"
	b.Position = Vector3.new(500, 0, 0)
	b.Parent = holder
	local function names(args)
		args.root = "Workspace/NearHold"
		args.class = "BasePart"
		local ok, r = pcall(Ops.find, args)
		if not ok then
			return "error: " .. tostring(r)
		end
		local out = {}
		for _, x in r.results do
			table.insert(out, string.match(x.path, "[^/]+$"))
		end
		table.sort(out)
		return table.concat(out, ",")
	end
	local got = names({ near = { 100, 0, 0 }, radius = 10 })
	check(got == "NearA", "near [x,y,z] with radius: " .. got)
	got = names({ near = { point = { 500, 0, 0 }, radius = 10 } })
	check(got == "NearB", "near {point,radius}: " .. got)
	got = names({ near = { { 100, 0, 0 } }, radius = 10 })
	check(got == "NearA", "near [[x,y,z]]: " .. got)
	holder:Destroy()
end

-------------------------------------------------------------------------------
H.section("Ops.set references")
do
	local Ops = H.require("Ops")
	local holder = folder("RefHold")
	local m = Instance.new("Model")
	m.Name = "M"
	m.Parent = holder
	local a = Instance.new("Part")
	a.Name = "A"
	a.Parent = m
	local b = Instance.new("Part")
	b.Name = "B"
	b.Parent = m
	local w = Instance.new("WeldConstraint")
	w.Name = "W"
	w.Part0 = a
	w.Part1 = b
	w.Parent = a

	-- Lune cannot assign nil to a reference property, so clearing is checked on a stand-in
	do
		local stand = { ClassName = "WeldConstraint", Part0 = a, Part1 = b }
		local savedMany, savedOf = Paths.resolveMany, Paths.of
		Paths.resolveMany = function()
			return { stand }
		end
		Paths.of = function()
			return "stand"
		end
		local r1 = Ops.set({ path = "x", props = { Part0 = { ref = false } } })
		local r2 = Ops.set({ path = "x", props = { Part1 = {} } })
		Paths.resolveMany, Paths.of = savedMany, savedOf
		check(#r1.warnings == 0 and stand.Part0 == nil, "{ref=false} clears: " .. table.concat(r1.warnings, ";"))
		check(#r2.warnings == 0 and stand.Part1 == nil, "an empty value (ref:null after JSON) clears a reference: " .. table.concat(r2.warnings, ";"))
	end

	local r

	r = Ops.set({ path = "Workspace/RefHold/M/A/W", props = { Part0 = { ref = "./B" } } })
	check(#r.warnings == 0 and w.Part0 == b, "./ is relative to the enclosing model: " .. table.concat(r.warnings, ";"))
	r = Ops.set({ path = "Workspace/RefHold/M", props = { PrimaryPart = { ref = "./A" } } })
	check(#r.warnings == 0 and m.PrimaryPart == a, "./ on the model itself: " .. table.concat(r.warnings, ";"))
	r = Ops.set({ path = "Workspace/RefHold/M/A/W", props = { Part1 = { ref = "Workspace/RefHold/M/A" } } })
	check(#r.warnings == 0 and w.Part1 == a, "absolute path still works")
	r = Ops.set({ path = "Workspace/RefHold/M/A/W", props = { Part1 = { ref = "./Missing" } } })
	check(#r.warnings == 1 and w.Part1 == a, "a missing target warns and changes nothing")
	r = Ops.set({ path = "Workspace/RefHold/M", props = { Name2 = {} } })
	check(#r.warnings == 1, "an unknown property still warns")
	holder:Destroy()
end

-------------------------------------------------------------------------------
H.section("Mirror: Terrain children are walked")
do
	local Mirror = H.requireWith("Mirror", {})
	Mirror.init(function() end, nil)
	local svc = game:GetService("TestService")
	local terrain = Instance.new("Terrain")
	terrain.Name = "Terrain"
	terrain.Parent = svc
	local clouds = Instance.new("Clouds")
	clouds.Name = "Clouds"
	clouds.Parent = terrain
	Mirror.control({ action = "start", services = { "TestService" } })
	local seen = {}
	for _ = 1, 20 do
		local r = Mirror.control({ action = "next" })
		for _, n in r.nodes do
			seen[n.c] = n
		end
		if r.done then
			break
		end
	end
	Mirror.control({ action = "stop" })
	check(seen.Terrain ~= nil, "Terrain listed")
	check(seen.Clouds ~= nil and seen.Clouds.p == Paths.id(terrain), "Clouds listed under Terrain")
	terrain:Destroy()
end

-------------------------------------------------------------------------------
H.section("Mirror: tag changes")
do
	local Mirror, sent = freshMirror()
	local holder = folder("TagHold")
	local p = Instance.new("Part")
	p.Name = "Tagged"
	p.Parent = holder
	allTags = { "Existing" }
	Mirror.control({ action = "start", services = { "Workspace" } })
	check(tagAddedSignals.Existing ~= nil and #tagAddedSignals.Existing.conns == 1, "existing tag watched once")
	p:AddTag("Existing")
	tagAddedSignals.Existing:Fire(p)
	task.wait(0.35)
	local tags
	for _, e in sent do
		for _, u in e.payload.upserts do
			if u.i == Paths.id(p) then
				tags = u.tags
			end
		end
	end
	check(tags ~= nil and tags[1] == "Existing", "an added tag reaches the server")

	tagAdded:Fire("Brand")
	tagAdded:Fire("Brand")
	check(tagAddedSignals.Brand ~= nil and #tagAddedSignals.Brand.conns == 1, "a new tag is watched once")
	check(tagRemovedSignals.Brand ~= nil and #tagRemovedSignals.Brand.conns == 1, "its removal is watched")

	table.clear(sent)
	p:RemoveTag("Existing")
	tagRemovedSignals.Existing:Fire(p)
	task.wait(0.35)
	local count, stillTagged = 0, false
	for _, e in sent do
		for _, u in e.payload.upserts do
			if u.i == Paths.id(p) then
				count += 1
				stillTagged = u.tags ~= nil
			end
		end
	end
	check(count == 1 and not stillTagged, "a removed tag reaches the server")

	local outside = Instance.new("Part")
	table.clear(sent)
	tagAddedSignals.Existing:Fire(outside)
	task.wait(0.35)
	check(#sent == 0, "instances outside the mirror are ignored")

	Mirror.control({ action = "stop" })
	check(#tagAddedSignals.Existing.conns == 0 and #tagAddedSignals.Brand.conns == 0, "tag connections released on stop")
	allTags = {}
	holder:Destroy()
end

-------------------------------------------------------------------------------
H.section("Mirror: start needs the class table")
do
	local Api = H.require("Api")
	local Mirror = H.requireWith("Mirror", {})
	local loads = 0
	Mirror.init(function() end, nil, function()
		loads += 1
	end)
	local real = Api.loaded
	Api.loaded = function()
		return false
	end
	local ok, err = pcall(Mirror.control, { action = "start", services = { "Workspace" } })
	Api.loaded = real
	check(not ok and string.find(tostring(err), "class table", 1, true) ~= nil, "refused without it: " .. tostring(err))
	check(loads == 1, "tried to load it first, calls: " .. loads)
end

-------------------------------------------------------------------------------
H.section("Ops.run falls back when loadstring is disabled")
do
	local Ops = H.requireWith("Ops", {
		loadstring = function()
			return nil, "loadstring() is not available"
		end,
		require = function(target)
			return luau.load(target.Source, { debugName = "module" })()
		end,
	})
	local ok, r = pcall(Ops.run, { code = "return 1 + 1" })
	check(ok and r.ok == true and r.returns[1] == 2, "ran through a ModuleScript: " .. tostring(ok and r.error or r))
	local badOk, bad = pcall(Ops.run, { code = "return (" })
	check(not badOk and string.find(tostring(bad), "compile error", 1, true) ~= nil, "a real compile error is still reported: " .. tostring(bad))

	local Strict = H.requireWith("Ops", {
		loadstring = function()
			return nil, "syntax error near x"
		end,
	})
	local okS, errS = pcall(Strict.run, { code = "x" })
	check(not okS and string.find(tostring(errS), "syntax error", 1, true) ~= nil, "loadstring's own compile error surfaces: " .. tostring(errS))
end

-------------------------------------------------------------------------------
H.section("Build.run wraps a single node of any shape")
do
	local holder = folder("WrapHold")
	local r = Build.run(holder, { color = "#FF0000" }, {})
	check(#r.created == 1 and r.created[1]:IsA("Part") and r.created[1].Color == Color3.fromRGB(255, 0, 0), "a node with only color")
	r = Build.run(holder, { material = "Wood", at = { 1, 2, 3 } }, {})
	check(#r.created == 1 and r.created[1].Material == roblox.Enum.Material.Wood, "a node with material and at")
	r = Build.run(holder, { mesh = 5 }, {})
	check(#r.created == 1 and r.created[1]:IsA("MeshPart"), "a node with only mesh")
	r = Build.run(holder, {}, {})
	check(#r.created == 0, "an empty array builds nothing")
	r = Build.run(holder, { { name = "One" }, { name = "Two" } }, {})
	check(#r.created == 2, "arrays are unchanged")
	holder:Destroy()
end

-------------------------------------------------------------------------------
H.section("Paths: ids are strong, cleared on destroy, bounded")
do
	local P = H.requireWith("Paths", {})
	local holder = folder("IdHold")
	do
		local p = Instance.new("Part")
		p.Name = "Keep"
		p.Parent = holder
		_G.__keepId = P.id(p)
	end
	-- Lune cannot force a collection: allocate until the collector has run several times
	local before = collectgarbage("count")
	local cycles, peak = 0, before
	for _ = 1, 40000000 do
		local _t = { 1, 2, 3 }
		local now = collectgarbage("count")
		if now < peak then
			cycles += 1
			if cycles >= 3 then
				break
			end
		end
		peak = now
	end
	check(cycles >= 1, "a collection ran during the test")
	local got = P.resolve("#" .. _G.__keepId)
	check(got ~= nil and got.Name == "Keep", "an id survives garbage collection of the Lua reference")

	local destroying = signal()
	roblox.implementProperty("WedgePart", "Destroying", function()
		return destroying
	end)
	local w = Instance.new("WedgePart")
	w.Parent = holder
	local id = P.id(w)
	check(#destroying.conns == 1, "one Destroying connection")
	check(P.id(w) == id and #destroying.conns == 1, "the same id, connected once")
	destroying:Fire()
	check(P.id(w) == id, "the id is still readable during removal events")
	task.wait()
	check(P.resolve("#" .. id) == nil, "the id is gone after Destroying")

	if P._setLimit then
		P._setLimit(3)
		local list = {}
		for i = 1, 5 do
			local p = Instance.new("Part")
			p.Parent = holder
			list[i] = { inst = p, id = P.id(p) }
		end
		check(P.resolve("#" .. list[1].id) == nil and P.resolve("#" .. list[2].id) == nil, "the oldest ids expire past the bound")
		check(P.resolve("#" .. list[5].id) == list[5].inst, "the newest ids remain")
		check(P.id(list[1].inst) ~= list[1].id, "an evicted instance gets a new id")
	else
		check(false, "ids are bounded")
	end
	holder:Destroy()
end

-------------------------------------------------------------------------------
H.section("Main: post size limits and retries")
do
	local Ops, Sync, Mirror = H.require("Ops"), H.require("Sync"), H.require("Mirror")
	local saved = { dispatch = Ops.dispatch, opsInit = Ops.init, syncInit = Sync.init, mirrorInit = Mirror.init }
	local sendEvent
	Ops.init, Sync.init = function() end, function() end
	Mirror.init = function(fn)
		sendEvent = fn
	end
	local big = string.rep('"', 1500 * 1024)
	Ops.dispatch = function()
		return { big = big }
	end

	local LIMIT = 1024 * 1024
	local posts, unload, polls = {}, nil, 0
	local failNext = 1
	local http = {}
	function http:JSONEncode(v)
		return H.serde.encode("json", v)
	end
	function http:JSONDecode(s)
		return H.serde.decode("json", s)
	end
	function http:GenerateGUID()
		return "guid"
	end
	function http:RequestAsync(req)
		local reply = {}
		if string.find(req.Url, "/plugin/hello", 1, true) then
			reply = { session = "s", serverVersion = "t" }
		elseif string.find(req.Url, "/plugin/poll", 1, true) then
			polls += 1
			if polls > 3000 then
				unload()
			end
			task.wait(0.005)
			reply = { commands = polls == 1 and { { id = "1", op = "get", args = {} } } or {} }
		elseif string.find(req.Url, "/plugin/result", 1, true) or string.find(req.Url, "/plugin/event", 1, true) then
			if failNext > 0 and string.find(req.Url, "/plugin/result", 1, true) then
				failNext -= 1
				return { StatusCode = 500, Body = "{}" }
			end
			table.insert(posts, { url = req.Url, body = req.Body })
		end
		return { StatusCode = 200, Body = H.serde.encode("json", reply) }
	end
	local run = {}
	function run:IsEdit()
		return false
	end
	function run:IsServer()
		return true
	end
	local fakeGame = { Name = "P", PlaceId = 0, GameId = 0 }
	function fakeGame:GetService(name)
		return name == "HttpService" and http or run
	end
	local fakePlugin = { Unloading = {} }
	function fakePlugin.Unloading:Connect(fn)
		unload = fn
	end
	function fakePlugin:GetSetting()
		return nil
	end
	function fakePlugin:SetSetting() end
	run.PlayerRemoving = { Connect = function() end }
	local fakeRelay = { OnServerEvent = { Connect = function() end }, SetAttribute = function() end }
	H.requireWith("Main.server", {
		game = fakeGame,
		plugin = fakePlugin,
		Instance = { new = function() return fakeRelay end },
	})

	local function results()
		local parts, total = {}, nil
		for _, p in posts do
			if string.find(p.url, "/plugin/result", 1, true) then
				local d = H.serde.decode("json", p.body)
				parts[d.chunk + 1] = d.data
				total = d.chunks
			end
		end
		if total and #parts == total then
			return table.concat(parts)
		end
		return nil
	end
	for _ = 1, 800 do
		if results() then
			break
		end
		task.wait(0.005)
	end
	local joined = results()
	check(joined ~= nil, "the result arrived, after the failed post was retried")
	if joined then
		local decoded = H.serde.decode("json", joined)
		check(decoded.ok == true and decoded.result.big == big, "chunks join back to the result")
	end
	local largest = 0
	for _, p in posts do
		largest = math.max(largest, #p.body)
	end
	check(largest <= LIMIT, "every post fits the 1 MB request limit, largest " .. largest)

	table.clear(posts)
	check(sendEvent ~= nil, "Main gives the mirror its event sender")
	sendEvent("mirror_delta", { upserts = { { i = 1, src = big } }, removed = {} })
	local eventParts, n = {}, nil
	largest = 0
	for _, p in posts do
		local d = H.serde.decode("json", p.body)
		largest = math.max(largest, #p.body)
		check(d.s == "s", "event carries the session")
		if d.type == "chunk" then
			eventParts[d.chunk + 1] = d.data
			n = d.chunks
		end
	end
	check(n ~= nil and n > 1 and #eventParts == n, "a large delta is split")
	check(largest <= LIMIT, "every event post fits, largest " .. largest)
	if n and #eventParts == n then
		local ev = H.serde.decode("json", table.concat(eventParts))
		check(ev.type == "mirror_delta" and ev.s == "s" and ev.upserts[1].src == big, "the event joins back")
	end

	table.clear(posts)
	sendEvent("mirror_delta", { upserts = { { i = 2 } }, removed = {} })
	check(#posts == 1 and H.serde.decode("json", posts[1].body).type == "mirror_delta", "a small delta stays one plain post")

	unload()
	task.wait(0.03)
	Ops.dispatch, Ops.init, Sync.init, Mirror.init = saved.dispatch, saved.opsInit, saved.syncInit, saved.mirrorInit
end
