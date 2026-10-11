-- JSON <-> Roblox value conversion.
--
-- Wire format (both directions):
--   Vector3        [x, y, z]                     Vector2   [x, y]
--   Color3         "#RRGGBB"  (in: also [r,g,b] 0-255, or a BrickColor name)
--   CFrame         {p=[x,y,z], r=[rx,ry,rz]}     r = Orientation in degrees (Y-X-Z order)
--                  in: also {p, lookAt=[x,y,z]}, [x,y,z], or 12 numbers
--   Enum           "Metal"   (in: also "Enum.Material.Metal" or the numeric value)
--   BrickColor     "Bright red"
--   UDim2          [xScale, xOffset, yScale, yOffset]      UDim [scale, offset]
--   NumberRange    [min, max]
--   NumberSequence [[t, v, envelope?], ...]  (in: also a number or [from, to])
--   ColorSequence  [[t, "#hex"], ...]        (in: also "#hex" or ["#a", "#b"])
--   Rect           [minX, minY, maxX, maxY]
--   Font           {family="GothamSSm", weight="Bold", style="Normal"}
--   PhysicalProperties [density, friction, elasticity, frictionWeight, elasticityWeight] or false
--   Faces / Axes   ["Top", "Front"]
--   Instance       {ref="Workspace/Some/Path"}  (refs inside a build are resolved by the builder)

local Paths = require(script.Parent.Paths)

local Codec = {}

local function round(x)
	if x ~= x then
		return 0
	end
	if x == math.huge then
		return 1e300
	elseif x == -math.huge then
		return -1e300
	end
	local r = math.round(x * 10000) / 10000
	if r == 0 then
		return 0
	end
	return r
end
Codec.round = round

local function hex(c)
	return string.format(
		"#%02X%02X%02X",
		math.clamp(math.round(c.R * 255), 0, 255),
		math.clamp(math.round(c.G * 255), 0, 255),
		math.clamp(math.round(c.B * 255), 0, 255)
	)
end
Codec.hex = hex

local function num(v, what)
	local n = tonumber(v)
	if n == nil then
		error(string.format("expected number for %s, got %s", what or "value", typeof(v)), 0)
	end
	return n
end

local function arr(v, n, what)
	if type(v) ~= "table" then
		error(string.format("expected array of %d numbers for %s, got %s", n, what, typeof(v)), 0)
	end
	local x = v[1] or v.x or v.X
	if n == 2 then
		return num(x, what), num(v[2] or v.y or v.Y, what)
	elseif n == 3 then
		return num(x, what), num(v[2] or v.y or v.Y, what), num(v[3] or v.z or v.Z, what)
	end
	local out = {}
	for i = 1, n do
		out[i] = num(v[i], what)
	end
	return table.unpack(out)
end

function Codec.vector3(v)
	if typeof(v) == "Vector3" then
		return v
	end
	if type(v) == "number" then
		return Vector3.new(v, v, v)
	end
	return Vector3.new(arr(v, 3, "Vector3"))
end

function Codec.color3(v)
	if typeof(v) == "Color3" then
		return v
	end
	if type(v) == "string" then
		local h = string.match(v, "^#?(%x+)$")
		if h and (#h == 6 or #h == 3) then
			if #h == 3 then
				h = string.gsub(h, "(%x)", "%1%1")
			end
			return Color3.fromRGB(tonumber(string.sub(h, 1, 2), 16), tonumber(string.sub(h, 3, 4), 16), tonumber(string.sub(h, 5, 6), 16))
		end
		local bc = BrickColor.new(v)
		if bc.Name == v then
			return bc.Color
		end
		error("bad color '" .. v .. "' (use \"#RRGGBB\", [r,g,b] 0-255 or a BrickColor name)", 0)
	end
	if type(v) == "table" then
		local r, g, b = arr(v, 3, "Color3")
		return Color3.fromRGB(r, g, b)
	end
	error("bad color value: " .. typeof(v), 0)
end

local function cframeFrom(v)
	if typeof(v) == "CFrame" then
		return v
	end
	if type(v) ~= "table" then
		error("expected CFrame object {p=[x,y,z], r=[rx,ry,rz]}", 0)
	end
	if #v == 12 then
		return CFrame.new(arr(v, 12, "CFrame"))
	end
	if #v == 3 then
		return CFrame.new(arr(v, 3, "CFrame"))
	end
	local p = v.p or v.pos or v.position or v.at
	local pos = p and Codec.vector3(p) or Vector3.zero
	if v.lookAt then
		return CFrame.lookAt(pos, Codec.vector3(v.lookAt))
	end
	local r = v.r or v.rot or v.orientation
	if r then
		local rx, ry, rz = arr(r, 3, "rotation")
		return CFrame.new(pos) * CFrame.fromOrientation(math.rad(rx), math.rad(ry), math.rad(rz))
	end
	return CFrame.new(pos)
end
Codec.cframe = cframeFrom

-- Rotation part of a CFrame as Orientation degrees.
function Codec.orientation(cf)
	local rx, ry, rz = cf:ToOrientation()
	return { round(math.deg(rx)), round(math.deg(ry)), round(math.deg(rz)) }
end

local function enumItem(enumName, v)
	local enum = Enum[enumName]
	if type(v) == "number" then
		local item = enum:FromValue(v)
		if item then
			return item
		end
	elseif type(v) == "string" then
		local name = string.match(v, "^Enum%.%w+%.(%w+)$") or v
		local ok, item = pcall(function()
			return enum[name]
		end)
		if ok and item then
			return item
		end
		-- case-insensitive fallback ("metal" -> Metal)
		local lname = string.lower(name)
		for _, it in enum:GetEnumItems() do
			if string.lower(it.Name) == lname then
				return it
			end
		end
	elseif typeof(v) == "EnumItem" then
		return v
	end
	local names = {}
	for i, it in enum:GetEnumItems() do
		if i > 25 then
			table.insert(names, "…")
			break
		end
		table.insert(names, it.Name)
	end
	error(string.format("bad %s value '%s'. Options: %s", enumName, tostring(v), table.concat(names, ", ")), 0)
end

local function numberSequence(v)
	if type(v) == "number" then
		return NumberSequence.new(v)
	end
	if type(v) == "table" and type(v[1]) == "number" then
		return NumberSequence.new(v[1], v[2] or v[1])
	end
	local kps = {}
	for _, k in v do
		table.insert(kps, NumberSequenceKeypoint.new(num(k[1]), num(k[2]), tonumber(k[3]) or 0))
	end
	return NumberSequence.new(kps)
end

local function colorSequence(v)
	if type(v) == "string" then
		return ColorSequence.new(Codec.color3(v))
	end
	if type(v) == "table" and type(v[1]) == "string" then
		return ColorSequence.new(Codec.color3(v[1]), Codec.color3(v[2] or v[1]))
	end
	local kps = {}
	for _, k in v do
		table.insert(kps, ColorSequenceKeypoint.new(num(k[1]), Codec.color3(k[2])))
	end
	return ColorSequence.new(kps)
end

local function font(v)
	if typeof(v) == "Font" then
		return v
	end
	if type(v) == "string" then
		if string.find(v, "://", 1, true) then
			return Font.new(v)
		end
		local ok, f = pcall(Font.fromName, v)
		if ok then
			return f
		end
		return Font.fromEnum(enumItem("Font", v))
	end
	local family = v.family or "SourceSansPro"
	if not string.find(family, "://", 1, true) then
		family = "rbxasset://fonts/families/" .. family .. ".json"
	end
	return Font.new(
		family,
		v.weight and enumItem("FontWeight", v.weight) or Enum.FontWeight.Regular,
		v.style and enumItem("FontStyle", v.style) or Enum.FontStyle.Normal
	)
end

local function enumList(ctor, enumName, v)
	if type(v) == "string" then
		v = { v }
	end
	local items = {}
	for _, n in v do
		table.insert(items, enumItem(enumName, n))
	end
	return ctor(table.unpack(items))
end

-- Decode a JSON value into a Roblox value of type `t` (type string from Api,
-- e.g. "Vector3", "Enum:Material", "bool"). `t == nil` infers from `current`.
function Codec.decode(t, v, current)
	if t == nil and current ~= nil then
		local tc = typeof(current)
		if tc == "EnumItem" then
			t = "Enum:" .. tostring(current.EnumType)
		elseif tc == "boolean" then
			t = "bool"
		elseif tc == "Instance" then
			t = "ref"
		else
			t = tc
		end
	end
	if t == nil then
		-- best effort by shape
		if type(v) == "table" and #v == 3 then
			return Vector3.new(arr(v, 3, "Vector3"))
		end
		return v
	end

	if t == "bool" or t == "boolean" then
		return v == true or v == "true" or v == 1
	elseif t == "number" or t == "float" or t == "double" or t == "int" or t == "int64" then
		return num(v)
	elseif t == "string" or t == "ContentId" then
		if type(v) == "number" then
			return "rbxassetid://" .. tostring(v)
		end
		return tostring(v)
	elseif t == "Content" then
		if type(v) == "number" then
			v = "rbxassetid://" .. tostring(v)
		end
		return Content.fromUri(tostring(v))
	elseif string.sub(t, 1, 5) == "Enum:" then
		return enumItem(string.sub(t, 6), v)
	elseif t == "Vector3" then
		return Codec.vector3(v)
	elseif t == "Vector2" then
		return Vector2.new(arr(v, 2, "Vector2"))
	elseif t == "Vector3int16" then
		return Vector3int16.new(arr(v, 3, "Vector3int16"))
	elseif t == "Vector2int16" then
		return Vector2int16.new(arr(v, 2, "Vector2int16"))
	elseif t == "Color3" then
		return Codec.color3(v)
	elseif t == "BrickColor" then
		if type(v) == "number" then
			return BrickColor.new(v)
		end
		if type(v) == "string" and string.sub(v, 1, 1) == "#" then
			return BrickColor.new(Codec.color3(v))
		end
		return BrickColor.new(v)
	elseif t == "CFrame" then
		return cframeFrom(v)
	elseif t == "UDim" then
		if type(v) == "number" then
			return UDim.new(0, v)
		end
		return UDim.new(arr(v, 2, "UDim"))
	elseif t == "UDim2" then
		return UDim2.new(arr(v, 4, "UDim2"))
	elseif t == "NumberRange" then
		if type(v) == "number" then
			return NumberRange.new(v)
		end
		return NumberRange.new(arr(v, 2, "NumberRange"))
	elseif t == "NumberSequence" then
		return numberSequence(v)
	elseif t == "ColorSequence" then
		return colorSequence(v)
	elseif t == "Rect" then
		return Rect.new(arr(v, 4, "Rect"))
	elseif t == "Font" then
		return font(v)
	elseif t == "PhysicalProperties" then
		if v == false or v == nil or v == "default" then
			return nil
		end
		if type(v) == "string" then
			return PhysicalProperties.new(enumItem("Material", v))
		end
		return PhysicalProperties.new(num(v[1]), num(v[2]), num(v[3]), tonumber(v[4]) or 1, tonumber(v[5]) or 1)
	elseif t == "Faces" then
		return enumList(Faces.new, "NormalId", v)
	elseif t == "Axes" then
		return enumList(Axes.new, "Axis", v)
	elseif t == "ref" then
		-- refs are resolved by callers (they know the base); accept Instances
		if typeof(v) == "Instance" or v == nil then
			return v
		end
		error("instance references must be {ref=\"path\"}", 0)
	end
	return v
end

-- Encode a Roblox value for JSON.
function Codec.encode(v)
	local t = typeof(v)
	if t == "number" then
		return round(v)
	elseif t == "string" or t == "boolean" or t == "nil" then
		return v
	elseif t == "Vector3" then
		return { round(v.X), round(v.Y), round(v.Z) }
	elseif t == "Vector2" then
		return { round(v.X), round(v.Y) }
	elseif t == "Vector3int16" then
		return { v.X, v.Y, v.Z }
	elseif t == "Vector2int16" then
		return { v.X, v.Y }
	elseif t == "Color3" then
		return hex(v)
	elseif t == "BrickColor" then
		return v.Name
	elseif t == "EnumItem" then
		return v.Name
	elseif t == "CFrame" then
		local p = v.Position
		local r = Codec.orientation(v)
		if r[1] == 0 and r[2] == 0 and r[3] == 0 then
			return { p = { round(p.X), round(p.Y), round(p.Z) } }
		end
		return { p = { round(p.X), round(p.Y), round(p.Z) }, r = r }
	elseif t == "UDim" then
		return { round(v.Scale), v.Offset }
	elseif t == "UDim2" then
		return { round(v.X.Scale), v.X.Offset, round(v.Y.Scale), v.Y.Offset }
	elseif t == "NumberRange" then
		return { round(v.Min), round(v.Max) }
	elseif t == "NumberSequence" then
		local out = {}
		for _, k in v.Keypoints do
			if k.Envelope ~= 0 then
				table.insert(out, { round(k.Time), round(k.Value), round(k.Envelope) })
			else
				table.insert(out, { round(k.Time), round(k.Value) })
			end
		end
		return out
	elseif t == "ColorSequence" then
		local out = {}
		for _, k in v.Keypoints do
			table.insert(out, { round(k.Time), hex(k.Value) })
		end
		return out
	elseif t == "Rect" then
		return { round(v.Min.X), round(v.Min.Y), round(v.Max.X), round(v.Max.Y) }
	elseif t == "Font" then
		local fam = string.match(v.Family, "^rbxasset://fonts/families/(.-)%.json$") or v.Family
		return { family = fam, weight = v.Weight.Name, style = v.Style.Name }
	elseif t == "PhysicalProperties" then
		return { round(v.Density), round(v.Friction), round(v.Elasticity), round(v.FrictionWeight), round(v.ElasticityWeight) }
	elseif t == "Faces" then
		local out = {}
		for _, n in { "Top", "Bottom", "Left", "Right", "Front", "Back" } do
			if v[n] then
				table.insert(out, n)
			end
		end
		return out
	elseif t == "Axes" then
		local out = {}
		for _, n in { "X", "Y", "Z" } do
			if v[n] then
				table.insert(out, n)
			end
		end
		return out
	elseif t == "Content" then
		local ok, uri = pcall(function()
			return v.Uri
		end)
		return ok and uri or nil
	elseif t == "Instance" then
		return { ref = Paths.of(v) }
	elseif t == "table" then
		return v
	end
	return tostring(v)
end

-- Attributes: primitives as-is; other types wrapped as {TypeName = value}.
local ATTR_TYPES = {
	Vector3 = true, Vector2 = true, Color3 = true, CFrame = true, UDim = true, UDim2 = true,
	NumberRange = true, NumberSequence = true, ColorSequence = true, Rect = true, BrickColor = true, Font = true,
}

function Codec.decodeAttr(v)
	if type(v) ~= "table" then
		return v
	end
	for k, inner in v do
		if type(k) == "string" and ATTR_TYPES[k] then
			return Codec.decode(k, inner)
		end
	end
	if #v == 3 and type(v[1]) == "number" then
		return Vector3.new(v[1], v[2], v[3])
	end
	error("unsupported attribute value; wrap typed values like {\"Color3\": \"#ff0000\"}", 0)
end

function Codec.encodeAttr(v)
	local t = typeof(v)
	if t == "number" then
		return round(v)
	elseif t == "string" or t == "boolean" then
		return v
	elseif t == "EnumItem" then
		return v.Name
	end
	return { [t] = Codec.encode(v) }
end

return Codec
