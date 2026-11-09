-- Tests for ClientRelay: signing, what a client may send, forged and replayed messages,
-- and a full round trip over a fake RemoteEvent.

local H = ...
local serde = require("@lune/serde")
local task = require("@lune/task")
local check = H.check

local json = {
	decode = function(text)
		return serde.decode("json", text)
	end,
	encode = function(value)
		return serde.encode("json", value)
	end,
}

local Relay = H.requireWith("ClientRelay", {})

H.section("ClientRelay: HMAC-SHA256")

do
	-- RFC 4231, test cases 2 and 7 (the second has a key longer than a block)
	check(
		Relay.hmac("Jefe", "what do ya want for nothing?") == "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
		"RFC 4231 case 2"
	)
	check(
		Relay.hmac(
			string.rep("\170", 131),
			"This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm."
		) == "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
		"RFC 4231 case 7"
	)

	-- every padding boundary and some random data, against Lune's own implementation
	math.randomseed(1234)
	local mismatches = 0
	for length = 0, 200 do
		local bytes = table.create(length)
		for i = 1, length do
			bytes[i] = string.char(math.random(0, 255))
		end
		local message = table.concat(bytes)
		if Relay.hmac("secret", message) ~= serde.hmac("sha256", message, "secret") then
			mismatches += 1
		end
	end
	check(mismatches == 0, "matches a reference implementation at every length up to 200")
end

H.section("ClientRelay: what a client may send")

local function newState(session)
	return { session = session, inFlight = 0, lastId = 0 }
end
local function post(state, path, body)
	return Relay.authorize(state, "POST", path, json.encode(body), json)
end

do
	local state = newState("mine")
	check(post(newState(nil), "/plugin/hello", { context = "client" }) == "hello", "client hello allowed")
	check(post(newState(nil), "/plugin/hello", { context = "edit" }) == nil, "hello as edit refused")
	check(post(newState(nil), "/plugin/hello", { context = "server" }) == nil, "hello as server refused")
	check(post(newState(nil), "/plugin/hello", {}) == nil, "hello without context refused")
	check(post(state, "/plugin/hello", { context = "client", replaces = "other" }) == nil, "replacing another session refused")
	check(post(state, "/plugin/hello", { context = "client", replaces = "mine" }) == "hello", "replacing its own session allowed")

	check(post(state, "/plugin/result", { s = "mine", id = "1" }) == "result", "own result allowed")
	check(post(state, "/plugin/event", { s = "mine" }) == "event", "own event allowed")
	check(post(state, "/plugin/bye", { s = "mine" }) == "bye", "own bye allowed")
	check(post(state, "/plugin/result", { s = "edit-session", id = "1" }) == nil, "another session's result refused")
	check(post(newState(nil), "/plugin/result", { id = "1" }) == nil, "no session at all refused")

	check(Relay.authorize(state, "GET", "/plugin/api", nil, json) == "api", "class table allowed")
	check(Relay.authorize(state, "GET", "/plugin/poll?s=mine", nil, json) == "poll", "own poll allowed")
	check(Relay.authorize(state, "GET", "/plugin/poll?s=other", nil, json) == nil, "another session's poll refused")
	check(Relay.authorize(state, "GET", "/plugin/poll?s=mine&x=1", nil, json) == nil, "extra query refused")
	check(Relay.authorize(state, "GET", "/health", nil, json) == nil, "other GET refused")
	check(post(state, "/rpc", { op = "run" }) == nil, "/rpc refused")
	check(Relay.authorize(state, "POST", "/plugin/result", "not json", json) == nil, "bad JSON refused")
	check(Relay.authorize(state, "POST", "/plugin/result", string.rep("x", 1300 * 1024), json) == nil, "oversized body refused")
	check(Relay.authorize(state, "DELETE", "/plugin/result", "{}", json) == nil, "other method refused")

	local _, body = post(state, "/plugin/result", { s = "mine", id = "7" })
	check(json.decode(body).id == "7", "checked body is forwarded")
end

local function fakeSignal()
	local handlers = {}
	return {
		Connect = function(_, fn)
			table.insert(handlers, fn)
		end,
		fire = function(...)
			-- a real RemoteEvent crosses the network, so the sender always carries on first
			for _, fn in handlers do
				task.defer(fn, ...)
			end
		end,
	}
end

local function fakeRemote(player)
	local attributes = {}
	local remote = { OnServerEvent = fakeSignal(), OnClientEvent = fakeSignal(), sentToClient = {}, sentToServer = {} }
	function remote:SetAttribute(name, value)
		attributes[name] = value
	end
	function remote:GetAttribute(name)
		return attributes[name]
	end
	function remote:FireServer(...)
		table.insert(remote.sentToServer, table.pack(...))
		remote.OnServerEvent.fire(player, ...)
	end
	function remote:FireClient(_, ...)
		table.insert(remote.sentToClient, table.pack(...))
		remote.OnClientEvent.fire(...)
	end
	return remote
end

local function pollUntil(cond)
	for _ = 1, 400 do
		if cond() then
			return true
		end
		task.wait(0.005)
	end
	return false
end

local KEY = "shared-key"

local function newPair(handler)
	local player = { Name = "P", UserId = 42 }
	local remote = fakeRemote(player)
	local calls = {}
	Relay.attachServer(remote, { PlayerRemoving = fakeSignal() }, function(method, path, body)
		table.insert(calls, method .. " " .. path)
		task.wait(0.01)
		return handler(method, path, body)
	end, json, function()
		return KEY
	end, "server-nonce")
	local request = Relay.attachClient(function()
		return remote
	end, function()
		return KEY
	end, function()
		return player.UserId
	end, "client-nonce")
	return request, remote, calls, player
end

H.section("ClientRelay: round trip")

do
	local big = string.rep("абв", 150 * 1024) -- about 900 KB of two-byte characters
	local request, _, calls = newPair(function(_, path)
		if path == "/plugin/hello" then
			return 200, json.encode({ session = "s1" })
		elseif path == "/plugin/api" then
			return 200, big
		elseif path == "/plugin/event" then
			return nil, "connection refused"
		end
		return 200, json.encode({ commands = {} })
	end)

	local results = {}
	task.spawn(function()
		results.hello = { request("POST", "/plugin/hello", json.encode({ context = "client" })) }
		results.poll = { request("GET", "/plugin/poll?s=s1") }
		results.api = { request("GET", "/plugin/api") }
		results.event = { request("POST", "/plugin/event", json.encode({ s = "s1", type = "x" })) }
		results.refused = { request("GET", "/health") }
		results.done = true
	end)

	check(pollUntil(function()
		return results.done
	end), "all requests answered")
	check(results.hello[1] == 200 and json.decode(results.hello[2]).session == "s1", "hello goes through")
	check(results.poll[1] == 200, "poll with the registered session goes through")
	check(results.api[1] == 200 and results.api[2] == big, "a large reply arrives whole")
	check(results.event[1] == nil and results.event[2] == "connection refused", "a network failure is reported as one")
	check(results.refused[1] == 403, "a refused route answers 403")
	check(table.find(calls, "GET /health") == nil, "a refused route never reaches the bridge")
end

H.section("ClientRelay: game scripts cannot use it")

do
	local request, remote, calls, player = newPair(function(_, path)
		if path == "/plugin/hello" then
			return 200, json.encode({ session = "s1" })
		end
		return 200, json.encode({ commands = {} })
	end)

	-- a LocalScript fires the event itself: wrong or missing signature, odd argument types
	remote.OnServerEvent.fire(player, "n", 1, "POST", "/plugin/hello", '{"context":"client"}', "bad")
	remote.OnServerEvent.fire(player, "n", 2, "POST", "/plugin/hello", '{"context":"client"}')
	remote.OnServerEvent.fire(player, {}, {}, {}, {}, {}, {})
	remote.OnServerEvent.fire(player)
	task.wait(0.05)
	check(#calls == 0, "unsigned requests never reach the bridge")
	check(#remote.sentToClient == 0, "unsigned requests get no reply")

	-- a genuine request is under way while a server script forges its answer
	local result
	task.spawn(function()
		result = { request("POST", "/plugin/hello", json.encode({ context = "client" })) }
	end)
	task.wait(0)
	local forged = '{"commands":[{"id":"x","op":"run","args":{"code":"evil()"}}]}'
	remote.OnClientEvent.fire(1, 200, forged, 1, 1, "bad")
	remote.OnClientEvent.fire(1, 200, forged, 1, 1, Relay.hmac("wrong key", forged))
	remote.OnClientEvent.fire(1, 200, {}, 1, 1, "bad")
	remote.OnClientEvent.fire(1, 200, forged, 2, 1, "bad")
	check(pollUntil(function()
		return result ~= nil
	end), "the genuine reply still arrives after forged ones")
	check(result[1] == 200 and json.decode(result[2]).session == "s1", "only the genuine reply is accepted")

	-- a server script fires a captured signed request again
	local before = #calls
	local captured = remote.sentToServer[1]
	check(captured ~= nil, "the request was captured")
	remote.OnServerEvent.fire(player, table.unpack(captured, 1, captured.n))
	task.wait(0.05)
	check(#calls == before, "a replayed request is ignored")

	-- signed for one player, sent as another
	local other = { Name = "Q", UserId = 43 }
	remote.OnServerEvent.fire(other, table.unpack(captured, 1, captured.n))
	task.wait(0.05)
	check(#calls == before, "a request signed for another player is ignored")

	-- a reply captured from an earlier request does not answer a later one
	local capturedReply = remote.sentToClient[1]
	local second
	task.spawn(function()
		second = { request("GET", "/plugin/poll?s=s1") }
	end)
	task.wait(0)
	remote.OnClientEvent.fire(2, table.unpack(capturedReply, 2, capturedReply.n))
	check(pollUntil(function()
		return second ~= nil
	end), "the later request is answered")
	check(second[1] == 200 and json.decode(second[2]).commands ~= nil, "a captured reply does not answer a later request")
end
