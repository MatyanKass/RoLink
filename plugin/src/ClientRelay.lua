-- Roblox refuses HttpService on a play-test client ("Http requests can only be executed by
-- game server"), so the client context sends its bridge traffic through the server context
-- over a RemoteEvent.
--
-- Game scripts can see that RemoteEvent, fire it and listen to it, and a forged reply could
-- hand the client plugin a command to run with plugin rights. So every message is signed
-- with a key kept in plugin settings, which every DataModel of this plugin shares and game
-- code cannot read. Anything unsigned is dropped without a reply. Nonces and increasing ids
-- stop a captured message from being sent again.

local ClientRelay = {}

ClientRelay.NAME = "__RoLinkClientRelay"
ClientRelay.KEY_SETTING = "RoLinkRelayKey"

local PIECE = 200 * 1024
local MAX_BODY = 1200 * 1024
local MAX_IN_FLIGHT = 6
local REQUEST_TIMEOUT = 60
-- how long a relay that has not yet sent one valid reply gets before the client tries another
local VERIFY_TIMEOUT = 15

------------------------------------------------------------------------ HMAC-SHA256

local ROUND = {
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

local rrotate, bxor, band, bnot, rshift, byteswap = bit32.rrotate, bit32.bxor, bit32.band, bit32.bnot, bit32.rshift, bit32.byteswap

local function sha256(message)
	local length = #message
	local total = length + 1 + ((55 - length) % 64) + 8
	local data = buffer.create(total)
	buffer.writestring(data, 0, message)
	buffer.writeu8(data, length, 0x80)
	buffer.writeu32(data, total - 8, byteswap(math.floor(length / 0x20000000)))
	buffer.writeu32(data, total - 4, byteswap(length * 8 % 0x100000000))

	local h0, h1, h2, h3 = 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a
	local h4, h5, h6, h7 = 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	local w = table.create(64, 0)

	for offset = 0, total - 64, 64 do
		for i = 1, 16 do
			w[i] = byteswap(buffer.readu32(data, offset + (i - 1) * 4))
		end
		for i = 17, 64 do
			local a, b = w[i - 15], w[i - 2]
			local s0 = bxor(rrotate(a, 7), rrotate(a, 18), rshift(a, 3))
			local s1 = bxor(rrotate(b, 17), rrotate(b, 19), rshift(b, 10))
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) % 0x100000000
		end
		local a, b, c, d, e, f, g, h = h0, h1, h2, h3, h4, h5, h6, h7
		for i = 1, 64 do
			local s1 = bxor(rrotate(e, 6), rrotate(e, 11), rrotate(e, 25))
			local ch = bxor(band(e, f), band(bnot(e), g))
			local t1 = h + s1 + ch + ROUND[i] + w[i]
			local s0 = bxor(rrotate(a, 2), rrotate(a, 13), rrotate(a, 22))
			local maj = bxor(band(a, b), band(a, c), band(b, c))
			h, g, f, e, d, c, b, a = g, f, e, (d + t1) % 0x100000000, c, b, a, (t1 + s0 + maj) % 0x100000000
		end
		h0 = (h0 + a) % 0x100000000
		h1 = (h1 + b) % 0x100000000
		h2 = (h2 + c) % 0x100000000
		h3 = (h3 + d) % 0x100000000
		h4 = (h4 + e) % 0x100000000
		h5 = (h5 + f) % 0x100000000
		h6 = (h6 + g) % 0x100000000
		h7 = (h7 + h) % 0x100000000
	end
	return string.pack(">I4I4I4I4I4I4I4I4", h0, h1, h2, h3, h4, h5, h6, h7)
end

local function xorPad(key, value)
	local out = table.create(64)
	for i = 1, 64 do
		out[i] = string.char(bxor(string.byte(key, i) or 0, value))
	end
	return table.concat(out)
end

-- Lower-case hex HMAC-SHA256.
function ClientRelay.hmac(key, message)
	if #key > 64 then
		key = sha256(key)
	end
	local raw = sha256(xorPad(key, 0x5c) .. sha256(xorPad(key, 0x36) .. message))
	return (string.gsub(raw, ".", function(c)
		return string.format("%02x", string.byte(c))
	end))
end

-- Length prefixes, so that moving text from one field to another changes the result.
local function frame(...)
	local parts = {}
	for i = 1, select("#", ...) do
		local value = select(i, ...)
		local text = value == nil and "" or tostring(value)
		parts[i] = (value == nil and "-" or tostring(#text)) .. ":" .. text
	end
	return table.concat(parts)
end

local function requestMac(key, serverNonce, userId, clientNonce, id, method, path, body)
	return ClientRelay.hmac(key, frame("request", serverNonce, userId, clientNonce, id, method, path, body))
end

local function replyMac(key, clientNonce, id, status, text)
	return ClientRelay.hmac(key, frame("reply", clientNonce, id, status, text))
end

------------------------------------------------------------------------ what may be forwarded

local SESSION_ROUTES = {
	["/plugin/result"] = "result",
	["/plugin/event"] = "event",
	["/plugin/bye"] = "bye",
}

-- Signed messages come from the plugin; this keeps the relay to what a client context needs
-- even so. Returns route, body to send; or nil, reason.
function ClientRelay.authorize(state, method, path, body, json)
	if method == "GET" then
		if path == "/plugin/api" then
			return "api", nil
		end
		local polled = string.match(path, "^/plugin/poll%?s=([%w%-]+)$")
		if polled and polled == state.session then
			return "poll", nil
		end
		return nil, "route not allowed from a client"
	end
	if method ~= "POST" or type(body) ~= "string" or #body > MAX_BODY then
		return nil, "request not allowed from a client"
	end
	local isHello = path == "/plugin/hello"
	local route = SESSION_ROUTES[path]
	if not isHello and not route then
		return nil, "route not allowed from a client"
	end
	local ok, decoded = pcall(json.decode, body)
	if not ok or type(decoded) ~= "table" then
		return nil, "body is not a JSON object"
	end
	if isHello then
		if decoded.context ~= "client" then
			return nil, "a client can only register as a client context"
		end
		if decoded.replaces ~= nil and decoded.replaces ~= state.session then
			return nil, "a client can only replace its own session"
		end
		return "hello", json.encode(decoded)
	end
	if state.session == nil or decoded.s ~= state.session then
		return nil, "not this client's session"
	end
	return route, json.encode(decoded)
end

------------------------------------------------------------------------ transport

-- Largest cut at or below the piece size that does not split a UTF-8 character.
local function pieceEnd(text, start)
	local stop = start + PIECE - 1
	if stop >= #text then
		return #text
	end
	while stop > start do
		local nextByte = string.byte(text, stop + 1)
		if nextByte < 0x80 or nextByte >= 0xC0 then
			break
		end
		stop -= 1
	end
	return stop
end

local function split(text)
	local pieces = {}
	local start = 1
	while start <= #text do
		local stop = pieceEnd(text, start)
		table.insert(pieces, string.sub(text, start, stop))
		start = stop + 1
	end
	if #pieces == 0 then
		pieces[1] = ""
	end
	return pieces
end

-- Server context. `send(method, path, body)` returns status, text; or nil, reason.
function ClientRelay.attachServer(remote, players, send, json, getKey, serverNonce)
	local states = {}
	remote:SetAttribute("nonce", serverNonce)

	local function reply(player, key, clientNonce, id, status, text)
		text = text or ""
		local mac = replyMac(key, clientNonce, id, status, text)
		local pieces = split(text)
		for i, piece in pieces do
			if not pcall(remote.FireClient, remote, player, id, status, piece, i, #pieces, mac) then
				return
			end
		end
	end

	remote.OnServerEvent:Connect(function(player, clientNonce, id, method, path, body, mac)
		if type(clientNonce) ~= "string" or type(id) ~= "number" or id % 1 ~= 0 or type(method) ~= "string" or type(path) ~= "string" then
			return
		end
		if (body ~= nil and type(body) ~= "string") or type(mac) ~= "string" or (body and #body > MAX_BODY) then
			return
		end
		local key = getKey()
		if type(key) ~= "string" or requestMac(key, serverNonce, player.UserId, clientNonce, id, method, path, body) ~= mac then
			return
		end
		local state = states[player]
		if not state then
			state = { session = nil, inFlight = 0, lastId = 0, clientNonce = clientNonce }
			states[player] = state
		end
		if clientNonce ~= state.clientNonce or id <= state.lastId then
			return
		end
		state.lastId = id
		if state.inFlight >= MAX_IN_FLIGHT then
			reply(player, key, clientNonce, id, 429, json.encode({ error = "relay busy" }))
			return
		end
		local route, checked = ClientRelay.authorize(state, method, path, body, json)
		if not route then
			reply(player, key, clientNonce, id, 403, json.encode({ error = checked }))
			return
		end
		state.inFlight += 1
		local status, text = send(method, path, checked)
		state.inFlight -= 1
		if not status then
			reply(player, key, clientNonce, id, 0, tostring(text))
			return
		end
		if status == 200 and route == "hello" then
			local ok, data = pcall(json.decode, text)
			if ok and type(data) == "table" and type(data.session) == "string" then
				state.session = data.session
			end
		elseif status == 200 and route == "bye" then
			state.session = nil
		end
		reply(player, key, clientNonce, id, status, text)
	end)

	players.PlayerRemoving:Connect(function(player)
		states[player] = nil
	end)
end

-- Client context. `getRemote(rejected)` yields until a RemoteEvent with the relay's name
-- that is not in `rejected` exists, or returns nil. Game code can make a RemoteEvent with
-- the same name; it cannot sign replies, so a remote that has never given one valid reply
-- is dropped after `verifyTimeout` seconds and the next one is tried.
-- Returns request(method, path, body) -> status, text; or nil, reason.
function ClientRelay.attachClient(getRemote, getKey, getUserId, clientNonce, opts)
	local verifyTimeout = (opts and opts.verifyTimeout) or VERIFY_TIMEOUT
	local remote = nil
	local remoteConn = nil
	local verified = false
	local rejected = setmetatable({}, { __mode = "k" })
	local pending = {}
	local nextId = 0

	local function dropRemote(which)
		if remote ~= which then
			return
		end
		rejected[which] = true
		remote = nil
		verified = false
		local conn = remoteConn
		if conn then
			pcall(function()
				conn:Disconnect()
			end)
		end
		remoteConn = nil
	end

	local function onReply(id, status, piece, index, total, mac)
		local entry = pending[id]
		if not entry or type(status) ~= "number" or type(piece) ~= "string" or type(mac) ~= "string" then
			return
		end
		if type(index) ~= "number" or type(total) ~= "number" or index % 1 ~= 0 or index < 1 or index > total then
			return
		end
		if entry.parts[index] == nil then
			entry.received += 1
		end
		entry.parts[index] = piece
		if entry.received < total then
			return
		end
		local text = table.concat(entry.parts, "", 1, total)
		if replyMac(entry.key, clientNonce, id, status, text) ~= mac then
			-- forged or mixed pieces: keep waiting for the genuine reply
			entry.parts = {}
			entry.received = 0
			return
		end
		pending[id] = nil
		if entry.remote == remote then
			verified = true
		end
		if status == 0 then
			task.spawn(entry.thread, nil, text)
		else
			task.spawn(entry.thread, status, text)
		end
	end

	return function(method, path, body)
		local key = getKey()
		if type(key) ~= "string" then
			return nil, "the relay key is missing from plugin settings"
		end
		local found = remote or getRemote(rejected)
		if not found then
			-- nothing else to try: give the rejected ones another chance next time
			table.clear(rejected)
			return nil, "the play-test server context has no RoLink relay"
		end
		if not remote then
			remote = found
			verified = false
			remoteConn = remote.OnClientEvent:Connect(onReply)
		end
		local current = remote
		local serverNonce = current:GetAttribute("nonce")
		if type(serverNonce) ~= "string" then
			dropRemote(current)
			return nil, "the RoLink relay has no nonce"
		end
		-- may yield (waits for LocalPlayer): done before the request is registered and timed
		local userId = getUserId()
		nextId += 1
		local id = nextId
		local entry = { thread = coroutine.running(), parts = {}, received = 0, key = key, remote = current }
		pending[id] = entry
		task.delay(verified and REQUEST_TIMEOUT or verifyTimeout, function()
			if pending[id] == entry then
				pending[id] = nil
				if not verified then
					-- never answered with a valid signature: likely a look-alike made by game code
					dropRemote(current)
				end
				task.spawn(entry.thread, nil, "the relay did not answer")
			end
		end)
		local mac = requestMac(key, serverNonce, userId, clientNonce, id, method, path, body)
		current:FireServer(clientNonce, id, method, path, body, mac)
		return coroutine.yield()
	end
end

return ClientRelay
