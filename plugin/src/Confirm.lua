-- A real yes/no question to the person at Studio. Used before something an
-- agent must not decide alone (publishing a place to live players). Anything
-- other than pressing the confirm button counts as "no".

local Confirm = {}

local pluginRef = nil
local widget = nil
local busy = false

local MIN_TIMEOUT, MAX_TIMEOUT, DEFAULT_TIMEOUT = 1, 600, 120

local BACKGROUND = Color3.fromRGB(37, 37, 41)
local TEXT = Color3.fromRGB(230, 230, 235)
local MUTED = Color3.fromRGB(160, 160, 168)
local DANGER = Color3.fromRGB(170, 55, 55)
local NEUTRAL = Color3.fromRGB(70, 70, 78)

function Confirm.init(plugin)
	pluginRef = plugin
end

local function label(parent, name, position, size, font, textSize, color)
	local l = Instance.new("TextLabel")
	l.Name = name
	l.Position = position
	l.Size = size
	l.BackgroundTransparency = 1
	l.Font = font
	l.TextSize = textSize
	l.TextColor3 = color
	l.TextWrapped = true
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextYAlignment = Enum.TextYAlignment.Top
	l.Parent = parent
	return l
end

local function button(parent, name, text, position, color)
	local b = Instance.new("TextButton")
	b.Name = name
	b.Text = text
	b.Position = position
	b.Size = UDim2.fromOffset(150, 32)
	b.BackgroundColor3 = color
	b.TextColor3 = Color3.new(1, 1, 1)
	b.Font = Enum.Font.GothamMedium
	b.TextSize = 14
	b.AutoButtonColor = true
	b.Parent = parent
	Instance.new("UICorner", b).CornerRadius = UDim.new(0, 6)
	return b
end

local function getWidget()
	if not widget then
		local info = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, false, true, 480, 300, 360, 240)
		widget = pluginRef:CreateDockWidgetPluginGui("RoLinkConfirm", info)
	end
	return widget
end

-- Blocks until answered. Returns { confirmed = boolean, reason = string? }.
function Confirm.show(args)
	if type(args.title) ~= "string" or type(args.text) ~= "string" then
		error("confirm_dialog needs title and text", 0)
	end
	if busy then
		return { confirmed = false, reason = "busy" }
	end
	busy = true

	local timeout = math.clamp(tonumber(args.timeout) or DEFAULT_TIMEOUT, MIN_TIMEOUT, MAX_TIMEOUT)
	local w = getWidget()
	w.Title = args.title

	local frame = Instance.new("Frame")
	frame.Name = "Root"
	frame.Size = UDim2.fromScale(1, 1)
	frame.BackgroundColor3 = BACKGROUND
	frame.BorderSizePixel = 0

	local pad = Instance.new("UIPadding")
	pad.PaddingTop = UDim.new(0, 12)
	pad.PaddingBottom = UDim.new(0, 12)
	pad.PaddingLeft = UDim.new(0, 12)
	pad.PaddingRight = UDim.new(0, 12)
	pad.Parent = frame

	label(frame, "Heading", UDim2.fromOffset(0, 0), UDim2.new(1, 0, 0, 24), Enum.Font.GothamBold, 16, TEXT).Text = args.title
	label(frame, "Body", UDim2.fromOffset(0, 32), UDim2.new(1, 0, 1, -112), Enum.Font.Gotham, 14, TEXT).Text = args.text
	local countdown = label(frame, "Countdown", UDim2.new(0, 0, 1, -72), UDim2.new(1, 0, 0, 20), Enum.Font.Gotham, 12, MUTED)

	-- Cancel sits first so a stray click on the usual spot does not publish
	local cancel = button(frame, "Cancel", "Cancel", UDim2.new(0, 0, 1, -40), NEUTRAL)
	local confirm = button(frame, "Confirm", tostring(args.confirmLabel or "Confirm"), UDim2.new(1, -150, 1, -40), DANGER)

	local answer = nil
	local connections = {
		confirm.MouseButton1Click:Connect(function()
			answer = answer or { confirmed = true }
		end),
		cancel.MouseButton1Click:Connect(function()
			answer = answer or { confirmed = false, reason = "cancelled" }
		end),
	}
	w:BindToClose(function()
		answer = answer or { confirmed = false, reason = "closed" }
	end)

	frame.Parent = w
	w.Enabled = true

	local deadline = os.clock() + timeout
	while not answer do
		local remaining = deadline - os.clock()
		if remaining <= 0 then
			answer = { confirmed = false, reason = "timeout" }
			break
		end
		countdown.Text = string.format("Closes in %d s and counts as Cancel.", math.ceil(remaining))
		task.wait(0.05)
	end

	for _, c in connections do
		c:Disconnect()
	end
	w.Enabled = false
	frame:Destroy()
	busy = false
	return answer
end

return Confirm
