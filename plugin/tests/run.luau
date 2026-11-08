local H = require("./harness")
local roblox = H.roblox
local Vector3, CFrame, Color3 = roblox.Vector3, roblox.CFrame, roblox.Color3
local Instance = roblox.Instance

H.loadApi()
local Codec = H.require("Codec")
local Paths = H.require("Paths")
local Build = H.require("Build")
local Serialize = H.require("Serialize")
local Util = H.require("Util")

local check, near = H.check, H.near
local ws = H.workspace

-------------------------------------------------------------------------------
H.section("Codec")

near(Codec.decode("Vector3", { 1, 2, 3 }), Vector3.new(1, 2, 3), "vector3 array")
check(Codec.encode(Color3.fromRGB(255, 128, 0)) == "#FF8000", "color hex encode")
check(Codec.decode("Color3", "#ff8000") == Color3.fromRGB(255, 128, 0), "color hex decode")
check(Codec.decode("Color3", "#f80") == Color3.fromRGB(255, 136, 0), "short hex")
check(Codec.decode("Color3", { 10, 20, 30 }) == Color3.fromRGB(10, 20, 30), "color rgb array")
check(Codec.decode("Color3", "Bright red") == roblox.BrickColor.new("Bright red").Color, "color by brickcolor name")
check(not pcall(Codec.decode, "Color3", "nonsense"), "bad color errors")
check(Codec.decode("Enum:Material", "metal") == roblox.Enum.Material.Metal, "enum case-insensitive")
check(Codec.decode("Enum:Material", "Enum.Material.Neon") == roblox.Enum.Material.Neon, "enum full name")
local okEnum, errEnum = pcall(Codec.decode, "Enum:Material", "Steel")
check(not okEnum and string.find(errEnum, "Options") ~= nil, "bad enum lists options")

local cf = Codec.decode("CFrame", { p = { 1, 2, 3 }, r = { 10, 45, -30 } })
local back = Codec.encode(cf)
check(back.p[1] == 1 and back.p[3] == 3, "cframe pos round trip")
near(back.r[1], 10, "cframe rx")
near(back.r[2], 45, "cframe ry")
near(back.r[3], -30, "cframe rz")
near(Codec.decode("CFrame", { p = { 0, 0, 0 }, lookAt = { 0, 0, -5 } }).LookVector, Vector3.new(0, 0, -1), "lookAt")
check(Codec.encode(CFrame.new(1, 2, 3)).r == nil, "identity rotation omitted")

local ns = Codec.decode("NumberSequence", { { 0, 1 }, { 1, 0 } })
check(#ns.Keypoints == 2 and ns.Keypoints[2].Value == 0, "number sequence")
local cs = Codec.decode("ColorSequence", { "#ff0000", "#0000ff" })
check(cs.Keypoints[1].Value == Color3.new(1, 0, 0), "color sequence 2-stop")
check(Codec.decode("UDim2", { 0.5, 10, 1, -20 }) == roblox.UDim2.new(0.5, 10, 1, -20), "udim2")
local f = Codec.decode("Font", { family = "GothamSSm", weight = "Bold" })
check(f.Weight == roblox.Enum.FontWeight.Bold, "font weight")
check(Codec.encode(f).family == "GothamSSm", "font family short")
check(Codec.decode("bool", "true") == true, "bool")
check(Codec.decode("ContentId", 123) == "rbxassetid://123", "content id from number")
check(Codec.round(1 / 3) == 0.3333, "rounding")

check(Codec.decodeAttr({ Color3 = "#00ff00" }) == Color3.new(0, 1, 0), "typed attr")
check(Codec.decodeAttr(5) == 5, "plain attr")
check(Codec.encodeAttr(Vector3.new(1, 2, 3)).Vector3[2] == 2, "attr encode wrap")

-------------------------------------------------------------------------------
H.section("Util.base64")

local raw = "hello\0world\255!"
local b = roblox and buffer.fromstring(raw)
local enc = Util.base64Encode(b)
check(enc == "aGVsbG8Ad29ybGT/IQ==", "base64 encode " .. enc)
check(buffer.tostring(Util.base64Decode(enc)) == raw, "base64 round trip")
for len = 0, 7 do
	local s = string.rep("x", len)
	check(buffer.tostring(Util.base64Decode(Util.base64Encode(buffer.fromstring(s)))) == s, "base64 len " .. len)
end

-------------------------------------------------------------------------------
H.section("Build: frames, repeat, mirror, span, refs")

local spec = {
	class = "Model",
	name = "Generator",
	origin = { p = { 10, 0, 5 }, r = { 0, 90, 0 } },
	primary = "Base",
	attrs = { Tier = 2, Glow = { Color3 = "#ffaa00" } },
	tags = { "Machine" },
	children = {
		{ name = "Base", size = { 8, 1, 6 }, at = { 0, 0.5, 0 }, color = "#3a3f47", material = "DiamondPlate" },
		{ name = "Body", size = { 6, 4, 4 }, at = { 0, 3, 0 }, color = "#c8a23a", material = "Metal",
			children = {
				{ class = "Attachment", name = "Out", at = { 3, 0, 0 } },
				{ class = "PointLight", name = "Lamp", Brightness = 2, Range = 12, Color = "#ffcc66" },
			} },
		{ name = "Leg%d", size = { 1, 1, 1 }, at = { 3, 0.5, 2 }, mirror = { "x", "z" } },
		{ name = "Fin%d", size = { 0.2, 3, 4 }, at = { -2.5, 3, 0 }, ["repeat"] = { count = 6, step = { 1, 0, 0 } } },
		{ name = "Pipe", shape = "Cylinder", span = { { 3, 5, 0 }, { 3, 5, 10 } }, thickness = 1, color = "#888888" },
		{ class = "WeldConstraint", name = "W", Part0 = { ref = "./Base" }, Part1 = { ref = "./Body" } },
		{ name = "Bad", size = { 1, 1, 1 }, Colour = "#ff0000", Transparency = "abc" },
	},
}

local res = Build.run(ws, { spec }, {})
local model = res.created[1]
check(model and model.Name == "Generator", "model created")
check(model.Parent == ws, "parented")
check(model.PrimaryPart and model.PrimaryPart.Name == "Base", "primary part set")

local origin = CFrame.new(10, 0, 5) * CFrame.fromOrientation(0, math.rad(90), 0)
near(model:GetPivot(), origin, "model pivot = origin")
local base = model:FindFirstChild("Base")
near(base.CFrame.Position, origin * Vector3.new(0, 0.5, 0), "base position in model frame")
check(base.Anchored == true, "builder anchors parts")
check(base.Material == roblox.Enum.Material.DiamondPlate, "material shorthand")
check(Codec.hex(base.Color) == "#3A3F47", "color shorthand")
-- rotated frame: local +X maps to world -Z when yaw is 90°
local body = model:FindFirstChild("Body")
local att = body:FindFirstChild("Out")
near(att.CFrame.Position, Vector3.new(3, 0, 0), "attachment stays local to its part")
check(body:FindFirstChild("Lamp").Range == 12, "PascalCase prop on node")
check(Codec.hex(body:FindFirstChild("Lamp").Color) == "#FFCC66", "light color")

local legs = {}
for _, c in model:GetChildren() do
	if c.Name == "Leg1" then
		table.insert(legs, c)
	end
end
check(#legs == 4, "mirror x,z gives 4 legs (got " .. #legs .. ")")
local seen = {}
for _, l in legs do
	local lp = origin:PointToObjectSpace(l.CFrame.Position)
	seen[string.format("%d,%d", math.round(lp.X), math.round(lp.Z))] = true
end
check(seen["3,2"] and seen["-3,2"] and seen["3,-2"] and seen["-3,-2"], "legs at mirrored corners")

local fins = 0
for i = 1, 6 do
	local fin = model:FindFirstChild("Fin" .. i)
	if fin then
		fins += 1
		near(origin:PointToObjectSpace(fin.CFrame.Position), Vector3.new(-2.5 + (i - 1), 3, 0), "fin " .. i .. " position")
	end
end
check(fins == 6, "6 fins")

local pipe = model:FindFirstChild("Pipe")
near(pipe.Size, Vector3.new(10, 1, 1), "cylinder span size along X")
near(pipe.CFrame.Position, origin * Vector3.new(3, 5, 5), "span midpoint")
local axis = pipe.CFrame.RightVector -- cylinder axis
local want = (origin * Vector3.new(3, 5, 10) - origin * Vector3.new(3, 5, 0)).Unit
check(math.abs(axis:Dot(want)) > 0.999, "cylinder axis follows span")

local w = model:FindFirstChild("W")
check(w.Part0 == base and w.Part1 == body, "relative refs resolved")
check(model:GetAttribute("Tier") == 2, "number attr")
check(model:GetAttribute("Glow") == Color3.fromRGB(255, 170, 0), "typed attr")
check(model:HasTag("Machine"), "tag")

local sawColour, sawTransp = false, false
for _, wmsg in res.warnings do
	if string.find(wmsg, "Colour", 1, true) and string.find(wmsg, "did you mean", 1, true) then
		sawColour = true
	end
	if string.find(wmsg, "Transparency", 1, true) then
		sawTransp = true
	end
end
check(sawColour, "unknown prop warns with suggestion")
check(sawTransp, "bad value warns")

-------------------------------------------------------------------------------
H.section("Serialize round trip")

local node = Serialize.node(model, {})
check(node.class == "Model" and node.origin ~= nil, "root model has origin")
check(node.primary == "Base", "primary serialized")
local json = H.serde.encode("json", node)
local node2 = H.serde.decode("json", json)
node2.name = "Generator2"
local res2 = Build.run(ws, { node2 }, {})
local model2 = res2.created[1]
check(#res2.warnings == 0, "rebuild has no warnings: " .. table.concat(res2.warnings, " | "))

local function partsByPath(m)
	local out = {}
	for _, d in m:GetDescendants() do
		out[Paths.relative(d, m)] = d
	end
	return out
end
local a, bb = partsByPath(model), partsByPath(model2)
local compared = 0
for path, inst in a do
	local other = bb[path]
	check(other ~= nil, "rebuilt has " .. path)
	if other and inst:IsA("BasePart") then
		compared += 1
		near(inst.CFrame, other.CFrame, path .. " cframe")
		near(inst.Size, other.Size, path .. " size")
		check(inst.Color == other.Color, path .. " color")
		check(inst.Material == other.Material, path .. " material")
		check(inst.Shape == other.Shape or not inst:IsA("Part"), path .. " shape")
	end
end
check(compared >= 10, "compared parts: " .. compared)
check(model2:FindFirstChild("W").Part0 == model2:FindFirstChild("Base"), "refs survive round trip")
near(model2:GetPivot(), model:GetPivot(), "pivot survives round trip")

-------------------------------------------------------------------------------
H.section("Paths")

local dup = Instance.new("Folder")
dup.Name = "Dups"
dup.Parent = ws
for i = 1, 3 do
	local p = Instance.new("Part")
	p.Name = "Wall"
	p.Parent = dup
end
local second = dup:GetChildren()[2]
check(Paths.of(second) == "Workspace/Dups/Wall[2]", "indexed path " .. Paths.of(second))
check(Paths.resolve("Workspace/Dups/Wall[2]") == second, "resolve indexed")
check(Paths.resolve("Workspace.Dups") == dup, "dotted path")
check(Paths.resolve("#" .. Paths.id(second)) == second, "id path")
check(Paths.resolve("Workspace/Generator/Body/Out") == att, "deep path")
check(not pcall(Paths.resolveMany, { "Workspace/Nope" }), "missing path errors")

-------------------------------------------------------------------------------
H.section("Build: replace + defaults")

Build.run(ws, { { name = "Box", size = { 2, 2, 2 } } }, {})
Build.run(ws, { { name = "Box", size = { 3, 3, 3 } } }, { replace = true, defaults = { material = "Wood" } })
local boxes = 0
for _, c in ws:GetChildren() do
	if c.Name == "Box" then
		boxes += 1
		near(c.Size, Vector3.new(3, 3, 3), "replaced box size")
		check(c.Material == roblox.Enum.Material.Wood, "defaults.material applied")
	end
end
check(boxes == 1, "replace leaves one box")

local top = Build.run(ws, { { name = "Shifted", size = { 1, 1, 1 }, at = { 1, 0, 0 } } }, { origin = { p = { 100, 0, 0 } } })
near(top.created[1].CFrame.Position, Vector3.new(101, 0, 0), "build origin offsets top-level items")

-------------------------------------------------------------------------------
H.section("MeshImport (mocked EditableMesh)")

do
	local calls = { verts = {}, tris = {}, normals = 0, faceNormals = 0, uvs = 0 }
	local FakeEM = {}
	FakeEM.__index = FakeEM
	function FakeEM:AddVertex(p)
		table.insert(calls.verts, p)
		return #calls.verts + 100
	end
	function FakeEM:AddTriangle(a, b, c)
		table.insert(calls.tris, { a, b, c })
		return #calls.tris
	end
	function FakeEM:AddNormal(_)
		calls.normals += 1
		return calls.normals
	end
	function FakeEM:SetFaceNormals(_, ids)
		check(#ids == 3, "face normals get 3 ids")
		calls.faceNormals += 1
	end
	function FakeEM:AddUV(_)
		calls.uvs += 1
		return calls.uvs
	end
	function FakeEM:SetFaceUVs() end
	local fakeAssets = {
		CreateEditableMesh = function()
			return setmetatable({}, FakeEM)
		end,
		CreateMeshPartAsync = function(_, content)
			check(content.obj ~= nil, "CreateMeshPartAsync gets Content.fromObject(em)")
			return Instance.new("MeshPart")
		end,
	}
	local fakeGame = {
		GetService = function(_, n)
			if n == "AssetService" then
				return fakeAssets
			end
			return H.game:GetService(n)
		end,
	}
	local MeshImport = H.requireWith("MeshImport", {
		game = fakeGame,
		Content = { fromObject = function(o) return { obj = o } end },
	})

	local function packF32(list)
		local b = buffer.create(#list * 4)
		for i, v in list do
			buffer.writef32(b, (i - 1) * 4, v)
		end
		return Util.base64Encode(b)
	end
	local function packU32(list)
		local b = buffer.create(#list * 4)
		for i, v in list do
			buffer.writeu32(b, (i - 1) * 4, v)
		end
		return Util.base64Encode(b)
	end
	local chunk = {
		name = "Quad",
		color = { 1, 0, 0 },
		center = { 0, 0.5, 0 },
		size = { 2, 1, 0 },
		positions = packF32({ -1, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, -1, 0.5, 0 }),
		normals = packF32({ 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1 }),
		uvs = packF32({ 0, 1, 1, 1, 1, 0, 0, 0 }),
		indices = packU32({ 0, 1, 2, 0, 2, 3 }),
	}
	MeshImport.stage({ importId = "t1", index = 1, chunk = chunk })
	local model, n = MeshImport.build({ importId = "t1", count = 1, name = "Imp", position = { 10, 0, 0 } }, ws)
	check(#calls.verts == 4, "4 vertices added")
	near(calls.verts[3], Vector3.new(1, 0.5, 0), "vertex decoded from float32")
	check(#calls.tris == 2 and calls.tris[2][3] == 104, "triangles use vertex ids")
	check(calls.normals == 4 and calls.faceNormals == 2 and calls.uvs == 4, "normals/uvs set per face")
	check(n == 1 and model.Name == "Imp" and model.Parent == ws, "model parented")
	local part = model:FindFirstChild("Quad")
	check(part ~= nil and part.Color == Color3.new(1, 0, 0), "material color applied")
	near(part.CFrame.Position, Vector3.new(10, 0.5, 0), "part placed at chunk center + position")
	check(part.Anchored == true, "anchored by default")
	check(not pcall(MeshImport.build, { importId = "t1", count = 1 }, ws), "staged data is consumed")
	model:Destroy()
end

-------------------------------------------------------------------------------
H.section("Codec round trip of every common type")
do
	local R = roblox
	local cases = {
		{ "Color3", Color3.fromRGB(12, 34, 56) },
		{ "UDim", R.UDim.new(0.5, 7) },
		{ "UDim2", R.UDim2.new(0.25, 3, 0.75, -4) },
		{ "Vector2", R.Vector2.new(1.5, -2) },
		{ "Vector3", Vector3.new(1, 2.5, -3) },
		{ "Rect", R.Rect.new(1, 2, 3, 4) },
		{ "NumberRange", R.NumberRange.new(1, 5) },
		{ "NumberSequence", R.NumberSequence.new({ R.NumberSequenceKeypoint.new(0, 1), R.NumberSequenceKeypoint.new(1, 2, 0.5) }) },
		{ "ColorSequence", R.ColorSequence.new({ R.ColorSequenceKeypoint.new(0, Color3.fromRGB(255, 0, 0)), R.ColorSequenceKeypoint.new(1, Color3.fromRGB(0, 0, 255)) }) },
		{ "BrickColor", R.BrickColor.new("Bright red") },
		{ "Enum:Material", R.Enum.Material.Metal },
	}
	for _, c in cases do
		local back = Codec.decode(c[1], Codec.encode(c[2]))
		check(back == c[2], c[1] .. " survives encode/decode, got " .. tostring(back))
	end
	near(Codec.decode("CFrame", Codec.encode(CFrame.new(1, 2, 3) * CFrame.Angles(0, 1, 0))), CFrame.new(1, 2, 3) * CFrame.Angles(0, 1, 0), "CFrame round trip")
	local font = Codec.decode("Font", { family = "GothamSSm", weight = "Bold", style = "Italic" })
	local fe = Codec.encode(font)
	check(fe.family == "GothamSSm" and fe.weight == "Bold" and fe.style == "Italic", "Font round trip")
	check(Codec.decode("Content", "rbxassetid://7").Uri == "rbxassetid://7", "Content from asset id")
end

-------------------------------------------------------------------------------
H.section("Mirror")
do
	local Mirror = H.require("Mirror")
	local holder = Instance.new("Folder")
	holder.Name = "MirrorTest"
	holder.Parent = ws
	local hid = Paths.id(holder)

	local res = Mirror.apply({ ops = {
		{ op = "create", t = -1, parent = hid, class = "Model", name = "M", props = { PrimaryPart = { ref = "./Base" } } },
		{ op = "create", t = -2, parent = -1, class = "Part", name = "Base", props = { Size = { 2, 2, 2 }, CFrame = { p = { 0, 5, 0 } }, Color = "#FF0000", Material = "Metal" } },
		{ op = "create", t = -3, parent = -2, class = "ProximityPrompt", name = "P", props = { ActionText = "Open" } },
		{ op = "create", t = -4, parent = -1, class = "Weld", name = "W", props = { Part0 = { ref = "./Base" } } },
		{ op = "create", t = -5, parent = hid, class = "NotAClass", name = "Nope" },
		{ op = "create", t = -6, parent = hid, class = "UnionOperation", name = "U" },
		{ op = "create", t = -7, parent = hid, class = "ScreenGui", name = "G" },
		{ op = "create", t = -8, parent = -7, class = "Frame", name = "F", props = { Size = { 0, 100, 0, 50 } } },
		{ op = "create", t = -9, parent = -8, class = "UICorner", name = "C" },
		{ op = "create", t = -10, parent = -8, class = "TextLabel", name = "L", props = { Text = "Hi", TextColor3 = "#FFFFFF" } },
		{ op = "create", t = -11, parent = hid, class = "RemoteEvent", name = "R" },
		{ op = "create", t = -12, parent = hid, class = "ModuleScript", name = "Mod", source = "return 1" },
	} })
	local m = holder:FindFirstChild("M")
	local base = m:FindFirstChild("Base")
	check(m.PrimaryPart == base, "ref resolved after the batch, though the target came later")
	check(m:FindFirstChild("W").Part0 == base, "weld ref")
	check(base.Anchored == true and base.Color == Color3.fromRGB(255, 0, 0) and base.Material == roblox.Enum.Material.Metal, "builder defaults and props on a new part")
	check(base:FindFirstChild("P").ActionText == "Open", "ProximityPrompt attached in edit mode")
	check(holder:FindFirstChild("Nope") == nil and holder:FindFirstChild("U") == nil, "bad class and recipe-less union not created")
	local errText = ""
	for _, e in res.errors do
		errText ..= e.where .. ":" .. e.message .. "|"
	end
	check(#res.errors == 2 and string.find(errText, "NotAClass", 1, true) ~= nil and string.find(errText, "csg", 1, true) ~= nil, "errors reported: " .. errText)
	local g = holder:FindFirstChild("G")
	check(g:FindFirstChild("F"):FindFirstChild("C"):IsA("UICorner") and g:FindFirstChild("F"):FindFirstChild("L").Text == "Hi", "GUI tree built")
	check(holder:FindFirstChild("Mod").Source == "return 1", "script source")
	check(#res.created == 10, "created count " .. #res.created)

	local node = Mirror._encodeNode(m)
	check(node.props.PrimaryPart.ref == "./Base", "relative ref encoded")
	check(node.props.Pivot ~= nil, "model pivot encoded")
	local pnode = Mirror._encodeNode(base)
	check(pnode.props.Size[1] == 2 and pnode.props.Color == "#FF0000" and pnode.props.Material == "Metal", "part props encoded")
	check(pnode.props.Anchored == nil, "builder default omitted")
	check(pnode.props.Position == nil, "derived props skipped")

	-- only listed properties change; pivot moves first, explicit CFrames win
	Mirror.apply({ ops = { { op = "set", id = Paths.id(base), props = { Transparency = 0.5 }, name = "Renamed" } } })
	check(base.Transparency == 0.5 and base.Name == "Renamed" and base.Color == Color3.fromRGB(255, 0, 0), "partial set keeps the rest")
	Mirror.apply({ ops = { { op = "set", id = Paths.id(m), props = { Pivot = { p = { 0, 50, 0 } } } } } })
	near(base.CFrame.Position, Vector3.new(0, 50, 0), "Pivot moves the model")

	local bad = Mirror.apply({ ops = { { op = "set", id = Paths.id(base), props = { Nonsense = 1, Color = "#00FF00" } } } })
	check(#bad.errors == 1 and base.Color == Color3.fromRGB(0, 255, 0), "unknown property reported, valid one applied")
	Mirror.apply({ ops = { { op = "destroy", id = Paths.id(holder:FindFirstChild("R")) } } })
	check(holder:FindFirstChild("R") == nil, "destroy")
	holder:Destroy()
end

-------------------------------------------------------------------------------
H.section("build makes GUI classes and attachments")
do
	local holder = Instance.new("Folder")
	holder.Parent = ws
	local r = Build.run(holder, { {
		class = "ScreenGui", name = "Ui",
		children = { { class = "Frame", name = "F", size = { 0, 40, 0, 20 }, children = {
			{ class = "UICorner", name = "C" },
			{ class = "TextLabel", name = "L", Text = "x" },
		} } },
	}, {
		class = "Part", name = "Host", size = { 1, 1, 1 },
		children = { { class = "ProximityPrompt", name = "P", ActionText = "Go" }, { class = "Decal", name = "D", Face = "Top" } },
	} })
	check(#r.warnings == 0, "no warnings: " .. table.concat(r.warnings, ";"))
	local f = holder:FindFirstChild("Ui"):FindFirstChild("F")
	check(f.Size == roblox.UDim2.new(0, 40, 0, 20), "lower-case size works on a GuiObject")
	check(f:FindFirstChild("C") ~= nil, "UICorner")
	check(holder:FindFirstChild("Host"):FindFirstChild("P").ActionText == "Go", "attached prompt")
	check(holder:FindFirstChild("Host"):FindFirstChild("D").Face == roblox.Enum.NormalId.Top, "attached decal")
	holder:Destroy()
end

local luauLib = require("@lune/luau")
local fsLib = require("@lune/fs")
luauLib.load(fsLib.readFile("playtest.luau"), { debugName = "playtest" })(H)
luauLib.load(fsLib.readFile("editor.luau"), { debugName = "editor" })(H)


-------------------------------------------------------------------------------
H.section("Toolbox: quarantine and release")

do
	local game = H.game
	local ServerStorage = game:GetService("ServerStorage")
	local ProductInfo = {}
	local loadCalls = 0
	local objects -- set per test: function(id) -> Instance list for GetObjects

	roblox.implementMethod("Selection", "Set", function() end)

	local function makeAsset()
		local m = Instance.new("Model")
		m.Name = "LoadedAsset"
		local s = Instance.new("Script")
		s.Name = "Main"
		s.Source = "print('hi')"
		s.Enabled = true
		s.Parent = m
		local off = Instance.new("Script")
		off.Name = "WasOff"
		off.Enabled = false
		off.Parent = m
		local ls = Instance.new("LocalScript")
		ls.Name = "Client"
		ls.Enabled = true
		ls.Parent = s
		local mod = Instance.new("ModuleScript")
		mod.Name = "Lib"
		mod.Source = "return {}"
		mod.Parent = m
		local p = Instance.new("Part")
		p.Name = "Block"
		p.Parent = m
		local snd = Instance.new("Sound")
		snd.SoundId = "rbxassetid://555"
		snd.Parent = p
		return m
	end

	roblox.implementMethod("InsertService", "LoadAsset", function(_, id)
		loadCalls += 1
		if id == 404 or id == 405 then
			error("HTTP 403 (Asset is not trusted for this place)")
		end
		return makeAsset()
	end)
	roblox.implementMethod("DataModel", "GetObjects", function(_, url)
		local id = tonumber(string.match(url, "%d+"))
		if objects then
			return objects(id)
		end
		error("no such asset")
	end)
	roblox.implementMethod("MarketplaceService", "GetProductInfoAsync", function(_, id)
		local info = ProductInfo[id]
		if not info then
			error("no info")
		end
		return info
	end)
	roblox.implementMethod("InsertService", "GetFreeModelsAsync", function(_, q, page)
		local results = {}
		for i = 1, 21 do
			results[i] = { Name = q .. i, AssetId = page * 100 + i, AssetVersionId = 1, CreatorName = "Maker" }
		end
		return { { CurrentStartIndex = page * 21 + 1, TotalCount = 21, Results = results } }
	end)

	ProductInfo[999] = { Name = " Fancy/Tree\u{200B} ", Creator = { CreatorTargetId = 1, Name = "Maker", HasVerifiedBadge = true } }
	ProductInfo[555] = { Name = "Song", Creator = { CreatorTargetId = 42, Name = "Other" } }

	local Toolbox = H.require("Toolbox")
	local before = #ws:GetChildren()
	local r = Toolbox.insert({ assetId = 999 })

	check(r.path == "ServerStorage/RoLinkQuarantine/Fancy_Tree_999", "quarantine path, name sanitized: " .. tostring(r.path))
	check(#ws:GetChildren() == before, "nothing added to Workspace")
	local q = ServerStorage:FindFirstChild("RoLinkQuarantine")
	check(q ~= nil and q.ClassName == "Folder", "quarantine folder")
	local c = q:FindFirstChild("Fancy_Tree_999")
	check(c ~= nil, "container under quarantine")
	for _, d in c:GetDescendants() do
		if d:IsA("Script") or d:IsA("LocalScript") then
			check(d.Enabled == false, "disabled: " .. d.Name)
		end
	end
	check(r.loader == "LoadAsset", "loader reported")
	check(r.creator.id == 1 and r.creator.verified == true, "creator info")
	check(r.counts.parts == 1, "part count")
	check(#r.scripts == 4, "all script kinds collected, got " .. #r.scripts)
	local byName = {}
	for _, s in r.scripts do
		byName[s.name] = s
	end
	check(byName.Main.source == "print('hi')" and byName.Main.wasEnabled == true, "source + original state")
	check(byName.WasOff.wasEnabled == false, "was already disabled")
	check(byName.Client.path == "Main/Client", "relative path")
	check(byName.Client.class == "LocalScript", "class")
	check(byName.Lib.class == "ModuleScript" and byName.Lib.wasEnabled == nil, "module has no enabled state")
	check(byName.Main.runContext == "Legacy", "run context")
	check(#r.assetRefs == 1 and r.assetRefs[1].id == 555 and r.assetRefs[1].creatorId == 42, "referenced asset resolved")

	local calls = loadCalls
	local again = Toolbox.insert({ assetId = 999 })
	check(loadCalls == calls and again.existing == true and again.path == r.path, "second insert reuses quarantine")

	check(not pcall(Toolbox.insert, { assetId = "abc" }), "bad id")
	check(not pcall(Toolbox.insert, { assetId = -1 }), "negative id")

	-- fallback loader
	objects = function()
		local p = Instance.new("Part")
		p.Name = "Solo"
		local sc = Instance.new("Script")
		sc.Enabled = true
		sc.Parent = p
		return { p }
	end
	local fb = Toolbox.insert({ assetId = 404 })
	check(fb.loader == "GetObjects", "fallback loader used")
	check(string.find(fb.path, "RoLinkQuarantine/Asset_404", 1, true) ~= nil, "fallback name: " .. fb.path)
	local fbC = q:FindFirstChild("Asset_404")
	check(fbC:FindFirstChild("Solo"):FindFirstChildOfClass("Script").Enabled == false, "fallback disabled too")
	objects = nil
	local okLoad, errLoad = pcall(Toolbox.insert, { assetId = 405 })
	check(not okLoad and string.find(errLoad, "405", 1, true) ~= nil, "load failure names the id: " .. tostring(errLoad))

	-- release
	local notInQ = Instance.new("Part")
	notInQ.Name = "Outsider"
	notInQ.Parent = ws
	check(not pcall(Toolbox.release, { path = "Workspace/Outsider", target = "Workspace" }), "only quarantined items can be released")
	notInQ:Destroy()
	check(not pcall(Toolbox.release, { path = r.path .. "/Main", target = "Workspace" }), "only direct children of quarantine")
	check(not pcall(Toolbox.release, { path = r.path, target = "ServerStorage/RoLinkQuarantine" }), "cannot release into quarantine")

	-- a script added after the scan never gets enabled
	local late = Instance.new("Script")
	late.Name = "Late"
	late.Parent = c

	local rel = Toolbox.release({ path = fb.path, target = "Workspace" })
	check(rel.moved.path == "Workspace/Solo", "single child unwrapped: " .. rel.moved.path)
	check(ws.Solo:FindFirstChildOfClass("Script").Enabled == false, "scripts stay disabled by default")
	check(rel.enabled == 0 and rel.disabled == 1, "counts when disabled")
	ws.Solo:Destroy()

	local rel2 = Toolbox.release({ path = r.path, target = "Workspace", enableScripts = true })
	check(rel2.moved.path == "Workspace/Fancy_Tree", "multi-child container renamed: " .. rel2.moved.path)
	local out = ws:FindFirstChild("Fancy_Tree")
	check(out.Main.Enabled == true, "originally enabled script enabled")
	check(out.Main.Client.Enabled == true, "nested script enabled")
	check(out.WasOff.Enabled == false, "originally disabled stays disabled")
	check(out.Late.Enabled == false and rel2.unknownScripts == 1, "script added after the scan stays disabled")
	check(out:GetAttribute("RoLinkAssetId") == nil and out.Main:GetAttribute("RoLinkWasEnabled") == nil, "quarantine attributes removed")
	out:Destroy()

	-- plugin-side search fallback
	local s = Toolbox.search({ query = "tree", kind = "model", limit = 25 })
	check(#s.results == 25 and s.results[1].name == "tree1" and s.results[1].creator == "Maker", "paged free model search")
	check(s.results[22].id == 101, "second page reached")
	check(not pcall(Toolbox.search, { query = "x", kind = "audio" }), "kinds without a Studio API are refused")
end

-------------------------------------------------------------------------------
H.section("Animation: rig info, KeyframeSequence build, preview")

do
	local game = H.game
	local ServerStorage = game:GetService("ServerStorage")
	local Animation = H.require("Animation")

	local function part(name, parent, cf)
		local p = Instance.new("Part")
		p.Name = name
		p.CFrame = cf or CFrame.new()
		p.Parent = parent
		return p
	end
	local function motor(part0, part1, c0)
		local m = Instance.new("Motor6D")
		m.Part0 = part0
		m.Part1 = part1
		m.C0 = c0
		m.Parent = part1
	end
	local rig = Instance.new("Model")
	rig.Name = "Rig"
	-- rig facing +X in the world: joint frames must be relative to the root
	local rootCf = CFrame.new(10, 3, 0) * CFrame.Angles(0, math.rad(90), 0)
	local hrp = part("HumanoidRootPart", rig, rootCf)
	local lower = part("LowerTorso", rig, rootCf)
	local arm = part("LeftUpperArm", rig, rootCf)
	motor(hrp, lower, CFrame.new(0, -1, 0))
	motor(lower, arm, CFrame.new(-1, 0, 0) * CFrame.Angles(0, math.rad(90), 0))
	rig.Parent = ws

	local info = Animation.rigInfo({ rig = "Workspace/Rig" })
	check(info.type == "R15", "rig kind detected: " .. tostring(info.type))
	check(info.root == "HumanoidRootPart", "root part")
	check(info.joints.LowerTorso.parent == "HumanoidRootPart", "joint parent")
	near(info.joints.LowerTorso.r[1], 1, "identity joint frame")
	near(info.joints.LeftUpperArm.r[3], 1, "rotated joint frame relative to root", 1e-3)

	check(not pcall(Animation.build, { importId = "none", count = 1, name = "A" }), "unstaged data refused")

	local kf = {
		{ t = 0, p = { LowerTorso = { 0, 0, 0, 0, 0, 0, 1 }, LeftUpperArm = { 0, 0, 0, 0, 0, 0, 1 } } },
		{ t = 0.5, p = { LowerTorso = { 0, 1, 0, 0, 0, 0, 1 }, LeftUpperArm = { 0, 0, 0, 0.7071068, 0, 0, 0.7071068 } } },
	}
	Animation.stage({ importId = "a1", index = 1, chunk = { kf[1] } })
	Animation.stage({ importId = "a1", index = 2, chunk = { kf[2] } })
	local built = Animation.build({
		importId = "a1", count = 2, name = "Walk", root = "HumanoidRootPart",
		tree = { LowerTorso = "HumanoidRootPart", LeftUpperArm = "LowerTorso" },
		loop = true, priority = "Movement",
	})
	check(built.created.path == "ServerStorage/RoLinkAnimations/Walk", "default target: " .. built.created.path)
	check(built.keyframes == 2 and built.poses == 6, "counts, got " .. built.keyframes .. "/" .. built.poses)
	local seq = ServerStorage.RoLinkAnimations.Walk
	check(seq.ClassName == "KeyframeSequence" and seq.Loop == true, "sequence props")
	check(seq.Priority == roblox.Enum.AnimationPriority.Movement, "priority")
	local frames = seq:GetChildren()
	table.sort(frames, function(a, b)
		return a.Time < b.Time
	end)
	check(#frames == 2 and frames[2].Time == 0.5, "keyframes under sequence")
	local rootPose = frames[2]:FindFirstChild("HumanoidRootPart")
	check(rootPose ~= nil and rootPose.ClassName == "Pose", "root pose named after the root part")
	near(rootPose.CFrame.Position, Vector3.new(0, 0, 0), "unposed ancestor identity")
	local lp = rootPose:FindFirstChild("LowerTorso")
	near(lp.CFrame.Position, Vector3.new(0, 1, 0), "nested pose translation")
	local ap = lp:FindFirstChild("LeftUpperArm")
	check(ap.EasingStyle == roblox.Enum.PoseEasingStyle.Linear, "linear easing")
	near(ap.CFrame, CFrame.new(0, 0, 0, 0.7071068, 0, 0, 0.7071068), "quaternion pose")

	check(not pcall(Animation.build, { importId = "a1", count = 2, name = "Walk" }), "staged data consumed")

	Animation.stage({ importId = "a2", index = 1, chunk = { kf[1] } })
	check(not pcall(Animation.build, { importId = "a2", count = 2, name = "Partial", root = "HumanoidRootPart", tree = {} }), "missing chunk refused")
	Animation.discard({ importId = "a2" })

	Animation.stage({ importId = "a3", index = 1, chunk = { kf[1] } })
	local okDup, errDup = pcall(Animation.build, { importId = "a3", count = 1, name = "Walk", root = "HumanoidRootPart", tree = { LowerTorso = "HumanoidRootPart", LeftUpperArm = "LowerTorso" } })
	check(not okDup and string.find(errDup, "replace", 1, true) ~= nil, "duplicate name asks for replace: " .. tostring(errDup))
	Animation.stage({ importId = "a4", index = 1, chunk = { kf[1] } })
	local re = Animation.build({ importId = "a4", count = 1, name = "Walk", root = "HumanoidRootPart", replace = true, tree = { LowerTorso = "HumanoidRootPart", LeftUpperArm = "LowerTorso" } })
	check(re.keyframes == 1 and #ServerStorage.RoLinkAnimations:GetChildren() == 1, "replace swaps the sequence")

	-- preview: temporary id, played through Animator, Animator cleaned up
	local registered
	roblox.implementMethod("KeyframeSequenceProvider", "RegisterKeyframeSequence", function(_, s)
		registered = s
		return "rbxassetid://temp-hash"
	end)
	local stepped, stopped = 0, false
	roblox.implementMethod("Animator", "LoadAnimation", function(_, a)
		return {
			Length = 0.1,
			Play = function() end,
			Stop = function()
				stopped = true
			end,
			AdjustSpeed = function() end,
			Destroy = function() end,
			animationId = a.AnimationId,
		}
	end)
	roblox.implementMethod("Animator", "StepAnimations", function()
		stepped += 1
	end)
	local hum = Instance.new("Humanoid")
	hum.Parent = rig
	local pv = Animation.preview({ path = "ServerStorage/RoLinkAnimations/Walk", rig = "Workspace/Rig", seconds = 0.05 })
	check(registered ~= nil and pv.id == "rbxassetid://temp-hash", "temporary id registered")
	check(pv.temporary == true, "marked temporary")
	check(stepped > 0 and stopped, "stepped then stopped")
	check(hum:FindFirstChildOfClass("Animator") == nil, "temporary Animator removed")
	check(not pcall(Animation.preview, { path = "ServerStorage/RoLinkAnimations/Walk", rig = "Workspace" }), "preview needs a rig with Humanoid/AnimationController")

	rig:Destroy()
	ServerStorage.RoLinkAnimations:Destroy()
end

-------------------------------------------------------------------------------
H.section("Build: publisher placeholders")

do
	local res = Build.run(ws, { { class = "Sound", name = "Pending", attrs = { RoLinkPendingAsset = "abc-123" } } }, {})
	local sound = res.created[1]
	check(sound.ClassName == "Sound" and sound.Parent == ws, "placeholder Sound created")
	check(sound:GetAttribute("RoLinkPendingAsset") == "abc-123", "placeholder carries the pending attribute")
	check(#res.warnings == 0, "no build warnings: " .. table.concat(res.warnings, "; "))
	sound:Destroy()

	local decal = Build.run(ws, { { class = "Decal", name = "Poster", attrs = { RoLinkPendingAsset = "x" } } }, {}).created[1]
	check(decal.ClassName == "Decal" and decal:GetAttribute("RoLinkPendingAsset") == "x", "placeholder Decal created")
	decal:Destroy()
end

-------------------------------------------------------------------------------
H.section("Main: ops that bypass the worker queue")
do
	local task = require("@lune/task")
	local Ops = H.require("Ops")
	for _, set in { Ops.immediate, Ops.concurrent } do
		for op in set do
			check(type(Ops[op]) == "function", op .. " is a real op")
			check(not Ops.mutating[op], op .. " does not change the place")
		end
	end

	local Sync, Mirror = H.require("Sync"), H.require("Mirror")
	local saved = { dispatch = Ops.dispatch, opsInit = Ops.init, syncInit = Sync.init, mirrorInit = Mirror.init }
	Ops.init, Sync.init, Mirror.init = function() end, function() end, function() end

	local started, finished, hold = {}, {}, { playtest_scenario = true, perf_stats = true }
	Ops.dispatch = function(op)
		started[op] = true
		while hold[op] do
			task.wait(0.005)
		end
		finished[op] = true
		return {}
	end

	local polls = 0
	local unload
	local http = {}
	function http:RequestAsync(req)
		local reply = {}
		if string.find(req.Url, "/plugin/hello", 1, true) then
			reply = { session = "s", serverVersion = "t" }
		elseif string.find(req.Url, "/plugin/poll", 1, true) then
			polls += 1
			if polls > 2000 then
				unload() -- a failed check must not leave this loop keeping Lune alive
			end
			task.wait(0.005)
			if polls == 1 then
				reply = { commands = {
					{ id = "1", op = "playtest_scenario", args = {} },
					{ id = "2", op = "set", args = {} },
					{ id = "3", op = "output_read", args = {} },
					{ id = "4", op = "perf_stats", args = {} },
				} }
			else
				reply = { commands = {} }
			end
		end
		return { StatusCode = 200, Body = H.serde.encode("json", reply) }
	end
	function http:JSONEncode(v)
		return H.serde.encode("json", v)
	end
	function http:JSONDecode(s)
		return H.serde.decode("json", s)
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

	H.requireWith("Main.server", { game = fakeGame, plugin = fakePlugin })
	local function waitFor(cond)
		for _ = 1, 200 do
			if cond() then
				return true
			end
			task.wait(0.005)
		end
		return false
	end

	check(waitFor(function()
		return started.playtest_scenario and started.perf_stats and started.output_read
	end), "a concurrent op and an output read start while a scenario holds the worker")
	check(finished.output_read == true, "the output read finished during the scenario")
	check(not started.set, "an ordinary op waits for the worker")

	hold.playtest_scenario = nil
	check(waitFor(function()
		return finished.set
	end), "the queue moves on while the concurrent op is still running")
	check(not finished.perf_stats, "the concurrent op was still running")

	hold.perf_stats = nil
	check(waitFor(function()
		return finished.perf_stats
	end), "the concurrent op finishes")

	unload()
	task.wait(0.03)
	Ops.dispatch, Ops.init, Sync.init, Mirror.init = saved.dispatch, saved.opsInit, saved.syncInit, saved.mirrorInit
end

H.done()
