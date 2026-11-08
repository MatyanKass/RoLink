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

H.done()
