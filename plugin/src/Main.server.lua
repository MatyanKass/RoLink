-- RoLink plugin entry point: connects Studio to the local RoLink server
-- (MCP bridge) and executes the commands it sends.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

local Root = script.Parent
local Api = require(Root.Api)
local ClientRelay = require(Root.ClientRelay)
local Ops = require(Root.Ops)
local Sync = require(Root.Sync)
local Mirror = require(Root.Mirror)

local VERSION = "0.1.0"
local DEFAULT_PORT = 34872
-- A request body may be 1 MB. Each piece is JSON-encoded again inside the envelope, which
-- grows ordinary text by about 1.21x; a piece that grows past POST_LIMIT is halved.
local CHUNK = 700 * 1024
local POST_LIMIT = 960 * 1024
local POST_ATTEMPTS = 3

local context = RunService:IsEdit() and "edit" or (RunService:IsServer() and "server" or "client")
local port = plugin:GetSetting("RoLinkPort") or DEFAULT_PORT
local base = "http://127.0.0.1:" .. tostring(port)

local session = nil
local prevSession = nil -- last session id, sent as `replaces` on reconnect
local wantConnected = false
local loopRunning = false
local statusText = "Disconnected"
local ui = nil
local logLines = {}

local function log(msg)
	table.insert(logLines, os.date("%H:%M:%S") .. "  " .. msg)
	if #logLines > 60 then
		table.remove(logLines, 1)
	end
	if ui then
		ui.refresh()
	end
end

local function setStatus(s)
	statusText = s
	if ui then
		ui.refresh()
	end
end

local function sendDirect(method, path, body)
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = base .. path,
			Method = method,
			Headers = { ["Content-Type"] = "application/json" },
			Body = body,
		})
	end)
	if not ok then
		return nil, tostring(res)
	end
	return res.StatusCode, res.Body
end

local function relayKey()
	return plugin:GetSetting(ClientRelay.KEY_SETTING)
end

-- Every DataModel of this plugin shares its settings; game code cannot read them.
if context ~= "client" and type(relayKey()) ~= "string" then
	plugin:SetSetting(ClientRelay.KEY_SETTING, HttpService:GenerateGUID(false) .. HttpService:GenerateGUID(false))
end

-- A play-test client cannot use HttpService; its traffic goes through the server context.
local send = sendDirect
if context == "client" then
	send = ClientRelay.attachClient(function(rejected)
		-- game code can make a same-named RemoteEvent; take the first one not yet rejected
		local storage = game:GetService("ReplicatedStorage")
		local deadline = os.clock() + 30
		while true do
			for _, c in storage:GetChildren() do
				if c.Name == ClientRelay.NAME and c:IsA("RemoteEvent") and not rejected[c] then
					return c
				end
			end
			if os.clock() >= deadline then
				return nil
			end
			task.wait(0.25)
		end
	end, relayKey, function()
		local players = game:GetService("Players")
		while not players.LocalPlayer do
			task.wait(0.1)
		end
		return players.LocalPlayer.UserId
	end, HttpService:GenerateGUID(false))
end

local function request(method, path, body)
	local status, text = send(method, path, body)
	if not status then
		return nil, tostring(text)
	end
	local data
	if text and #text > 0 then
		pcall(function()
			data = HttpService:JSONDecode(text)
		end)
	end
	return status, data
end

local function postJson(path, tbl)
	return request("POST", path, HttpService:JSONEncode(tbl))
end

-- Sends and checks the answer. Retries what may pass next time, not what the server refused.
local function postChecked(path, tbl)
	local status, detail
	local body = HttpService:JSONEncode(tbl)
	for attempt = 1, POST_ATTEMPTS do
		status, detail = request("POST", path, body)
		if status == 200 then
			return true
		end
		if status and status >= 400 and status < 500 and status ~= 429 then
			break
		end
		if attempt < POST_ATTEMPTS then
			task.wait(0.2 * attempt)
		end
	end
	return false, "HTTP " .. tostring(status) .. (type(detail) == "string" and (" " .. detail) or "")
end

-- Largest cut at or below `stop` that does not split a UTF-8 character.
local function utf8Cut(text, stop)
	while stop > 1 do
		local b = string.byte(text, stop + 1)
		if b == nil or b < 0x80 or b >= 0xC0 then
			break
		end
		stop -= 1
	end
	return stop
end

-- Pieces of `body` ready to post, each small enough once encoded again.
local function splitBody(body)
	local pieces = {}
	local len = #body
	local pos = 1
	while pos <= len do
		local stop = pos + CHUNK - 1
		if stop < len then
			stop = pos - 1 + utf8Cut(string.sub(body, pos, stop + 4), CHUNK)
		else
			stop = len
		end
		table.insert(pieces, string.sub(body, pos, stop))
		pos = stop + 1
	end
	local i = 1
	while i <= #pieces do
		local piece = pieces[i]
		if #piece > 1024 and #HttpService:JSONEncode(piece) > POST_LIMIT then
			local half = utf8Cut(piece, math.floor(#piece / 2))
			pieces[i] = string.sub(piece, 1, half)
			table.insert(pieces, i + 1, string.sub(piece, half + 1))
		else
			i += 1
		end
	end
	if #pieces == 0 then
		pieces[1] = ""
	end
	return pieces
end

local eventSeq = 0

local function sendEvent(kind, payload)
	if not session then
		return
	end
	payload.s = session
	payload.type = kind
	local okEnc, body = pcall(function()
		return HttpService:JSONEncode(payload)
	end)
	if not okEnc then
		log("could not encode " .. kind .. ": " .. tostring(body))
		return
	end
	local sent, why
	if #body <= CHUNK then
		sent, why = postChecked("/plugin/event", payload)
	else
		eventSeq += 1
		local pieces = splitBody(body)
		for i, piece in pieces do
			sent, why = postChecked("/plugin/event", { s = session, type = "chunk", id = tostring(eventSeq), chunk = i - 1, chunks = #pieces, data = piece })
			if not sent then
				break
			end
		end
	end
	if not sent then
		log("could not send " .. kind .. ": " .. tostring(why))
	end
end

-- ----------------------------------------------------------------- results

local function postResult(id, ok, result)
	local okEnc, body = pcall(function()
		if ok then
			return '{"ok":true,"result":' .. HttpService:JSONEncode(result == nil and {} or result) .. "}"
		end
		return HttpService:JSONEncode({ ok = false, error = tostring(result) })
	end)
	if not okEnc then
		body = HttpService:JSONEncode({ ok = false, error = "result is not JSON-encodable: " .. tostring(body) })
	end
	local pieces = splitBody(body)
	local n = #pieces
	for i, piece in pieces do
		local sent, why = postChecked("/plugin/result", { s = session, id = id, chunk = i - 1, chunks = n, data = piece })
		if not sent then
			error("chunk " .. i .. "/" .. n .. ": " .. tostring(why), 0)
		end
	end
end

-- ----------------------------------------------------------------- worker

local queue = {}
local workerBusy = false

local function execute(cmd)
	local t0 = os.clock()
	local ok, res = pcall(Ops.dispatch, cmd.op, cmd.args)
	local ms = math.floor((os.clock() - t0) * 1000)
	if ok then
		log(string.format("%s  ✓ %dms", cmd.op, ms))
	else
		log(string.format("%s  ✗ %s", cmd.op, tostring(res)))
	end
	local okPost, postErr = pcall(postResult, cmd.id, ok, res)
	if not okPost then
		log("could not send result: " .. tostring(postErr))
	end
end

local function runWorker()
	if workerBusy then
		return
	end
	workerBusy = true
	task.spawn(function()
		local okLoop, loopErr = pcall(function()
			while #queue > 0 do
				execute(table.remove(queue, 1))
			end
		end)
		workerBusy = false
		if not okLoop then
			log("worker error: " .. tostring(loopErr))
		end
		if #queue > 0 then
			runWorker()
		end
	end)
end

-- ----------------------------------------------------------------- connection

local function ensureApi()
	if Api.loaded() then
		return true
	end
	local st, api = request("GET", "/plugin/api")
	if st == 200 and api then
		Api.load(api)
		return true
	end
	return false
end

local helloFailureShown = false

local function hello()
	local status, data = postJson("/plugin/hello", {
		context = context,
		placeName = game.Name,
		placeId = game.PlaceId,
		gameId = game.GameId,
		pluginVersion = VERSION,
		replaces = session or prevSession,
	})
	if status ~= 200 or not data or not data.session then
		-- Play-test contexts have no panel, so this is the only place the reason can show up.
		if context ~= "edit" and not helloFailureShown then
			helloFailureShown = true
			warn(("[RoLink] %s context cannot reach the server: %s %s"):format(context, tostring(status), tostring(data)))
		end
		return false
	end
	session = data.session
	prevSession = nil
	if not ensureApi() then
		log("warning: could not load class table from server")
	end
	log("connected (server " .. tostring(data.serverVersion) .. ")")
	setStatus("Connected")
	return true
end

local function connectLoop()
	if loopRunning then
		return
	end
	loopRunning = true
	task.spawn(function()
		local backoff = 1
		while wantConnected do
			if not session then
				setStatus("Waiting for RoLink server on port " .. port .. "…")
				if hello() then
					backoff = 1
				else
					task.wait(backoff)
					backoff = math.min(backoff * 2, 5)
					continue
				end
			end
			local status, data = request("GET", "/plugin/poll?s=" .. session)
			if not wantConnected then
				break
			end
			if status == 200 and data then
				for _, cmd in data.commands or {} do
					if Ops.immediate[cmd.op] or Ops.concurrent[cmd.op] then
						task.spawn(execute, cmd)
					else
						table.insert(queue, cmd)
					end
				end
				if #queue > 0 then
					runWorker()
				end
			elseif status == 410 then
				prevSession = session
				session = nil
				log("server forgot this session, reconnecting")
			else
				prevSession = session
				session = nil
				setStatus("Server unreachable, retrying…")
				task.wait(backoff)
				backoff = math.min(backoff * 2, 5)
			end
		end
		loopRunning = false
	end)
end

local function connect()
	wantConnected = true
	plugin:SetSetting("RoLinkAutoConnect", true)
	connectLoop()
end

local function disconnect()
	wantConnected = false
	plugin:SetSetting("RoLinkAutoConnect", false)
	if session then
		local s = session
		session = nil
		task.spawn(postJson, "/plugin/bye", { s = s })
	end
	setStatus("Disconnected")
	log("disconnected")
end

Ops.init(plugin)
Sync.init(sendEvent)
Mirror.init(sendEvent, plugin, ensureApi)

plugin.Unloading:Connect(function()
	wantConnected = false
	if session then
		postJson("/plugin/bye", { s = session })
	end
end)

-- ----------------------------------------------------------------- UI (edit only)

if context == "edit" then
	local toolbar = plugin:CreateToolbar("RoLink")
	local button = toolbar:CreateButton("RoLink", "Connect Studio to Claude (RoLink MCP)", "rbxasset://textures/StudioToolbox/AssetPreview/more.png", "RoLink")
	button.ClickableWhenViewportHidden = true

	local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, false, 320, 260, 260, 180)
	local widget = plugin:CreateDockWidgetPluginGui("RoLinkPanel", info)
	widget.Title = "RoLink"

	local frame = Instance.new("Frame")
	frame.Size = UDim2.fromScale(1, 1)
	frame.BackgroundColor3 = Color3.fromRGB(37, 37, 41)
	frame.BorderSizePixel = 0
	frame.Parent = widget

	local pad = Instance.new("UIPadding")
	pad.PaddingTop = UDim.new(0, 8)
	pad.PaddingLeft = UDim.new(0, 8)
	pad.PaddingRight = UDim.new(0, 8)
	pad.PaddingBottom = UDim.new(0, 8)
	pad.Parent = frame

	local status = Instance.new("TextLabel")
	status.Size = UDim2.new(1, -96, 0, 28)
	status.BackgroundTransparency = 1
	status.Font = Enum.Font.GothamMedium
	status.TextSize = 14
	status.TextXAlignment = Enum.TextXAlignment.Left
	status.TextTruncate = Enum.TextTruncate.AtEnd
	status.Parent = frame

	local toggle = Instance.new("TextButton")
	toggle.Size = UDim2.fromOffset(88, 28)
	toggle.Position = UDim2.new(1, -88, 0, 0)
	toggle.Font = Enum.Font.GothamMedium
	toggle.TextSize = 13
	toggle.TextColor3 = Color3.new(1, 1, 1)
	toggle.AutoButtonColor = true
	toggle.Parent = frame
	Instance.new("UICorner", toggle).CornerRadius = UDim.new(0, 6)

	local logBox = Instance.new("TextLabel")
	logBox.Position = UDim2.fromOffset(0, 36)
	logBox.Size = UDim2.new(1, 0, 1, -72)
	logBox.BackgroundColor3 = Color3.fromRGB(28, 28, 31)
	logBox.BorderSizePixel = 0
	logBox.Font = Enum.Font.Code
	logBox.TextSize = 12
	logBox.TextColor3 = Color3.fromRGB(190, 190, 196)
	logBox.TextXAlignment = Enum.TextXAlignment.Left
	logBox.TextYAlignment = Enum.TextYAlignment.Bottom
	logBox.TextWrapped = true
	logBox.ClipsDescendants = true
	logBox.Parent = frame
	Instance.new("UICorner", logBox).CornerRadius = UDim.new(0, 6)
	local logPad = Instance.new("UIPadding")
	logPad.PaddingLeft = UDim.new(0, 6)
	logPad.PaddingBottom = UDim.new(0, 4)
	logPad.Parent = logBox

	local notice = Instance.new("TextLabel")
	notice.Position = UDim2.new(0, 0, 1, -32)
	notice.Size = UDim2.new(1, 0, 0, 32)
	notice.BackgroundTransparency = 1
	notice.Font = Enum.Font.Gotham
	notice.TextSize = 11
	notice.TextColor3 = Color3.fromRGB(150, 150, 158)
	notice.TextWrapped = true
	notice.TextXAlignment = Enum.TextXAlignment.Left
	notice.Text = "Publishing to Roblox: you are responsible for the rights to everything published, including what an agent picks."
	notice.Parent = frame

	ui = {
		refresh = function()
			local connected = session ~= nil
			status.Text = (connected and "● " or "○ ") .. statusText
			status.TextColor3 = connected and Color3.fromRGB(90, 220, 130) or Color3.fromRGB(220, 180, 90)
			toggle.Text = wantConnected and "Disconnect" or "Connect"
			toggle.BackgroundColor3 = wantConnected and Color3.fromRGB(120, 60, 60) or Color3.fromRGB(50, 110, 200)
			local start = math.max(1, #logLines - 14)
			logBox.Text = table.concat(logLines, "\n", start)
			button:SetActive(connected)
		end,
	}

	toggle.MouseButton1Click:Connect(function()
		if wantConnected then
			disconnect()
		else
			connect()
		end
	end)
	button.Click:Connect(function()
		widget.Enabled = not widget.Enabled
	end)
	ui.refresh()

	if plugin:GetSetting("RoLinkAutoConnect") ~= false then
		connect()
	end
else
	-- Play-test DataModels connect too, so runtime state can be inspected.
	if plugin:GetSetting("RoLinkAutoConnect") ~= false and plugin:GetSetting("RoLinkPlayConnect") ~= false then
		if context == "server" then
			local storage = game:GetService("ReplicatedStorage")
			local remote = Instance.new("RemoteEvent")
			remote.Name = ClientRelay.NAME
			remote.Archivable = false
			-- a same-named child made by game code would catch the client's traffic first
			local function evict(child)
				if child ~= remote and child.Name == ClientRelay.NAME then
					pcall(function()
						child.Name = ClientRelay.NAME .. "_foreign"
					end)
				end
			end
			for _, child in storage:GetChildren() do
				evict(child)
			end
			storage.ChildAdded:Connect(evict)
			remote.Parent = storage
			ClientRelay.attachServer(remote, game:GetService("Players"), sendDirect, {
				decode = function(text)
					return HttpService:JSONDecode(text)
				end,
				encode = function(value)
					return HttpService:JSONEncode(value)
				end,
			}, relayKey, HttpService:GenerateGUID(false))
		end
		wantConnected = true
		connectLoop()
	end
end
