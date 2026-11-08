-- RoLink plugin entry point: connects Studio to the local RoLink server
-- (MCP bridge) and executes the commands it sends.

local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")

local Root = script.Parent
local Api = require(Root.Api)
local Ops = require(Root.Ops)
local Sync = require(Root.Sync)

local VERSION = "0.1.0"
local DEFAULT_PORT = 34872
local CHUNK = 900 * 1024

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

local function request(method, path, body)
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
	local data
	if res.Body and #res.Body > 0 then
		pcall(function()
			data = HttpService:JSONDecode(res.Body)
		end)
	end
	return res.StatusCode, data
end

local function postJson(path, tbl)
	return request("POST", path, HttpService:JSONEncode(tbl))
end

local function sendEvent(kind, payload)
	if not session then
		return
	end
	payload.s = session
	payload.type = kind
	postJson("/plugin/event", payload)
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
	-- split on UTF-8 boundaries: never cut inside a multibyte character
	local pieces = {}
	local len = #body
	local pos = 1
	while pos <= len do
		local stop = math.min(pos + CHUNK - 1, len)
		if stop < len then
			-- move back while the next byte is a continuation byte (10xxxxxx)
			while stop > pos do
				local b = string.byte(body, stop + 1)
				if b < 0x80 or b >= 0xC0 then
					break
				end
				stop -= 1
			end
		end
		table.insert(pieces, string.sub(body, pos, stop))
		pos = stop + 1
	end
	if #pieces == 0 then
		pieces[1] = ""
	end
	local n = #pieces
	for i, piece in pieces do
		postJson("/plugin/result", { s = session, id = id, chunk = i - 1, chunks = n, data = piece })
	end
end

-- ----------------------------------------------------------------- worker

local queue = {}
local workerBusy = false

local function runWorker()
	if workerBusy then
		return
	end
	workerBusy = true
	task.spawn(function()
		local okLoop, loopErr = pcall(function()
			while #queue > 0 do
				local cmd = table.remove(queue, 1)
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
		return false
	end
	session = data.session
	prevSession = nil
	if not Api.loaded() then
		local st, api = request("GET", "/plugin/api")
		if st == 200 and api then
			Api.load(api)
		else
			log("warning: could not load class table from server")
		end
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
					table.insert(queue, cmd)
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
	logBox.Size = UDim2.new(1, 0, 1, -36)
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
		wantConnected = true
		connectLoop()
	end
end
