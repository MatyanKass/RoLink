local Codec = require(script.Parent.Codec)

local Util = {}

-- Encode arbitrary Lua values (return values of user code etc.) to JSON-safe data.
function Util.deepEncode(v, depth, seen)
	depth = depth or 0
	local t = typeof(v)
	if t == "table" then
		if depth > 6 then
			return "<table>"
		end
		seen = seen or {}
		if seen[v] then
			return "<cycle>"
		end
		seen[v] = true
		local isArray = #v > 0
		local out = {}
		local n = 0
		for k, val in v do
			n += 1
			if n > 500 then
				break
			end
			if isArray and type(k) == "number" then
				out[k] = Util.deepEncode(val, depth + 1, seen)
			else
				out[tostring(k)] = Util.deepEncode(val, depth + 1, seen)
			end
		end
		return out
	elseif t == "function" or t == "thread" or t == "userdata" or t == "RBXScriptSignal" or t == "RBXScriptConnection" then
		return "<" .. t .. ">"
	end
	return Codec.encode(v)
end

local ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local ENC = {}
local DEC = {}
for i = 1, 64 do
	ENC[i - 1] = string.byte(ALPHA, i)
	DEC[string.byte(ALPHA, i)] = i - 1
end

function Util.base64Encode(buf)
	local len = buffer.len(buf)
	local outLen = math.ceil(len / 3) * 4
	local out = buffer.create(outLen)
	local o = 0
	for i = 0, len - 1, 3 do
		local b0 = buffer.readu8(buf, i)
		local b1 = i + 1 < len and buffer.readu8(buf, i + 1) or 0
		local b2 = i + 2 < len and buffer.readu8(buf, i + 2) or 0
		local n = b0 * 65536 + b1 * 256 + b2
		buffer.writeu8(out, o, ENC[bit32.extract(n, 18, 6)])
		buffer.writeu8(out, o + 1, ENC[bit32.extract(n, 12, 6)])
		buffer.writeu8(out, o + 2, i + 1 < len and ENC[bit32.extract(n, 6, 6)] or 61)
		buffer.writeu8(out, o + 3, i + 2 < len and ENC[bit32.extract(n, 0, 6)] or 61)
		o += 4
	end
	return buffer.tostring(out)
end

function Util.base64Decode(s)
	s = string.gsub(s, "[^%w%+/=]", "")
	local len = #s
	local pad = 0
	if string.sub(s, -2) == "==" then
		pad = 2
	elseif string.sub(s, -1) == "=" then
		pad = 1
	end
	local outLen = (len // 4) * 3 - pad
	local out = buffer.create(math.max(outLen, 0))
	local o = 0
	for i = 1, len, 4 do
		local c0 = DEC[string.byte(s, i)] or 0
		local c1 = DEC[string.byte(s, i + 1)] or 0
		local c2 = DEC[string.byte(s, i + 2)] or 0
		local c3 = DEC[string.byte(s, i + 3)] or 0
		local n = c0 * 262144 + c1 * 4096 + c2 * 64 + c3
		if o < outLen then
			buffer.writeu8(out, o, bit32.extract(n, 16, 8))
		end
		if o + 1 < outLen then
			buffer.writeu8(out, o + 1, bit32.extract(n, 8, 8))
		end
		if o + 2 < outLen then
			buffer.writeu8(out, o + 2, bit32.extract(n, 0, 8))
		end
		o += 3
	end
	return out
end

return Util
