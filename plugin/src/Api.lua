-- Class/property table received from the RoLink server (built from the Roblox
-- API dump). Answers "what type is Part.Material" and "which properties should
-- be serialized for a MeshPart".

local Api = {}

local classes = nil -- [className] = { super = string?, props = { [prop] = typeString } }
local flatCache = {}

function Api.load(data)
	classes = data and data.classes or nil
	flatCache = {}
end

function Api.loaded()
	return classes ~= nil
end

-- All serializable properties of a class (inherited included): { [name] = type }
function Api.props(className)
	local cached = flatCache[className]
	if cached then
		return cached
	end
	local out = {}
	local chain = {}
	local c = className
	while c and classes and classes[c] do
		table.insert(chain, classes[c])
		c = classes[c].super
	end
	for i = #chain, 1, -1 do
		for k, v in chain[i].props do
			out[k] = v
		end
	end
	flatCache[className] = out
	return out
end

function Api.propType(className, prop)
	return Api.props(className)[prop]
end

function Api.hasClass(className)
	return classes ~= nil and classes[className] ~= nil
end

local function distance(a, b)
	local la, lb = #a, #b
	if math.abs(la - lb) > 3 then
		return 99
	end
	local prev = {}
	for j = 0, lb do
		prev[j] = j
	end
	for i = 1, la do
		local cur = { [0] = i }
		local ca = string.byte(a, i)
		for j = 1, lb do
			local cost = (ca == string.byte(b, j)) and 0 or 1
			cur[j] = math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
		end
		prev = cur
	end
	return prev[lb]
end

-- Closest property names, for "unknown property" errors.
function Api.suggest(className, prop)
	local lower = string.lower(prop)
	local scored = {}
	for name in Api.props(className) do
		local ln = string.lower(name)
		local d = distance(ln, lower)
		if d <= 2 or (#lower >= 4 and (string.find(ln, lower, 1, true) or string.find(lower, ln, 1, true))) then
			table.insert(scored, { name = name, d = d })
		end
	end
	table.sort(scored, function(x, y)
		if x.d ~= y.d then
			return x.d < y.d
		end
		return x.name < y.name
	end)
	local hits = {}
	for i = 1, math.min(#scored, 4) do
		hits[i] = scored[i].name
	end
	return hits
end

return Api
