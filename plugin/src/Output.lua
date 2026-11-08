-- Output capture: a bounded ring buffer of what this DataModel printed, with a
-- sequence number so agents can poll incrementally. Each plugin instance
-- (edit / play server / play client) keeps its own ring; seq numbers start
-- from a time-derived base, so a cursor from an earlier play-test still reads
-- everything from the next one.

local Output = {}
Output.__index = Output

local DEFAULT_CAPACITY = 3000
local MAX_TEXT = 8000
local DEFAULT_LIMIT = 200
local MAX_LIMIT = 2000
-- how far back a ScriptContext.Error / MessageOut pair may be apart
local MATCH_WINDOW = 32

local LEVELS = { MessageOutput = "output", MessageInfo = "info", MessageWarning = "warning", MessageError = "error" }

local function nameLevel(messageType)
	return LEVELS[messageType.Name] or "output"
end

local function sameText(a, b)
	if a == b then
		return true
	end
	if a == "" or b == "" then
		return false
	end
	return string.find(a, b, 1, true) ~= nil or string.find(b, a, 1, true) ~= nil
end

function Output.new(opts)
	opts = opts or {}
	local now = opts.now or os.time
	local base = opts.base or math.max(0, now() - 1700000000) * 1000
	return setmetatable({
		capacity = opts.capacity or DEFAULT_CAPACITY,
		maxText = opts.maxText or MAX_TEXT,
		now = now,
		base = base,
		seq = base,
		first = base + 1,
		entries = {},
		echoes = {},
	}, Output)
end

function Output:_clip(text)
	text = tostring(text)
	if #text > self.maxText then
		return string.sub(text, 1, self.maxText) .. " …(truncated)"
	end
	return text
end

function Output:add(level, text, extra)
	self.seq += 1
	local e = { seq = self.seq, t = extra and extra.t or self.now(), level = level, text = self:_clip(text) }
	for k, v in extra or {} do
		e[k] = v
	end
	self.entries[e.seq] = e
	while self.seq - self.first + 1 > self.capacity do
		self.entries[self.first] = nil
		self.first += 1
	end
	return e
end

function Output:lastSeq()
	return self.seq
end

-- A line we already stored ourselves is about to come back through MessageOut.
function Output:expectEcho(level, text)
	local key = level .. "\0" .. self:_clip(text)
	self.echoes[key] = (self.echoes[key] or 0) + 1
end

function Output:clearEchoes()
	table.clear(self.echoes)
end

-- A line from LogService.MessageOut.
function Output:addMessage(level, text, t)
	local clipped = self:_clip(text)
	local key = level .. "\0" .. clipped
	if self.echoes[key] then
		self.echoes[key] = self.echoes[key] > 1 and self.echoes[key] - 1 or nil
		return nil
	end
	if level == "error" then
		for seq = math.max(self.first, self.seq - MATCH_WINDOW + 1), self.seq do
			local e = self.entries[seq]
			if e and e.fromError and not e.matched and sameText(e.text, clipped) then
				e.matched = true
				return e
			end
		end
	end
	return self:add(level, clipped, t and { t = t } or nil)
end

-- An error from ScriptContext.Error: the same error also arrives as a MessageOut
-- line, in either order, and must end up as one entry carrying the stack.
function Output:addError(message, stack, scriptName)
	local clipped = self:_clip(message)
	for seq = math.max(self.first, self.seq - MATCH_WINDOW + 1), self.seq do
		local e = self.entries[seq]
		if e and e.level == "error" and not e.fromError and e.stack == nil and sameText(e.text, clipped) then
			e.stack = stack
			e.script = scriptName
			return e
		end
	end
	return self:add("error", clipped, { stack = stack, script = scriptName, fromError = true })
end

function Output:attach(logService, scriptContext)
	local okHistory, history = pcall(function()
		return logService:GetLogHistory()
	end)
	if okHistory and type(history) == "table" then
		for _, item in history do
			self:addMessage(nameLevel(item.messageType), item.message, item.timestamp)
		end
	end
	local conns = {}
	table.insert(
		conns,
		logService.MessageOut:Connect(function(message, messageType)
			self:addMessage(nameLevel(messageType), message)
		end)
	)
	if scriptContext then
		table.insert(
			conns,
			scriptContext.Error:Connect(function(message, stack, source)
				local name
				if source then
					local ok, full = pcall(function()
						return source:GetFullName()
					end)
					name = ok and full or nil
				end
				self:addError(message, stack, name)
			end)
		)
	end
	return conns
end

local function levelSet(level)
	if level == nil then
		return nil
	end
	local set = {}
	if type(level) == "table" then
		for _, l in level do
			set[string.lower(tostring(l))] = true
		end
	else
		set[string.lower(tostring(level))] = true
	end
	return set
end

local function public(e)
	return { seq = e.seq, t = e.t, level = e.level, text = e.text, stack = e.stack, script = e.script }
end

function Output:read(opts)
	opts = opts or {}
	local since = tonumber(opts.since)
	local limit = math.clamp(tonumber(opts.limit) or DEFAULT_LIMIT, 1, MAX_LIMIT)
	local levels = levelSet(opts.level)
	local needle = opts.contains and string.lower(tostring(opts.contains)) or nil

	local function wanted(e)
		if levels and not levels[e.level] then
			return false
		end
		return needle == nil or string.find(string.lower(e.text), needle, 1, true) ~= nil
	end

	local out, truncated, nextSeq = {}, false, self.seq
	if since then
		for seq = math.max(self.first, math.floor(since) + 1), self.seq do
			local e = self.entries[seq]
			if e and wanted(e) then
				if #out >= limit then
					truncated = true
					nextSeq = out[#out].seq
					break
				end
				table.insert(out, public(e))
			end
		end
	else
		for seq = self.seq, self.first, -1 do
			local e = self.entries[seq]
			if e and wanted(e) then
				if #out >= limit then
					truncated = true
					break
				end
				table.insert(out, 1, public(e))
			end
		end
	end

	local missed = 0
	if since and since >= self.base and since < self.first - 1 then
		missed = self.first - 1 - since
	end
	return { entries = out, next = nextSeq, lastSeq = self.seq, oldestSeq = self.first, truncated = truncated, missed = missed }
end

return Output
