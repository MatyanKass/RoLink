-- Camera framing for screenshots. The server captures the Studio window; to
-- crop it to the 3D viewport we draw two small magenta markers in its corners.
-- During a play-test the other DataModels draw cyan "probe" markers, so the server
-- can tell when the requested one is not the view Studio is showing.

local CoreGui = game:GetService("CoreGui")
local RunService = game:GetService("RunService")
local Selection = game:GetService("Selection")

local Build = require(script.Parent.Build)
local Codec = require(script.Parent.Codec)
local Paths = require(script.Parent.Paths)

local View = {}

local MARKER_NAME = "RoLinkShotMarkers"
local MARKER_SIZE = 6
local MARKER_COLORS = {
	target = Color3.fromRGB(255, 0, 255),
	probe = Color3.fromRGB(0, 255, 255),
}
local HOLD_NAME = "RoLinkShotCameraHold"
-- after the game's own camera (RenderPriority.Camera = 200) and anything bound at Last
local HOLD_PRIORITY = Enum.RenderPriority.Last.Value + 100

local function camera()
	return workspace.CurrentCamera
end

local function waitFrames(n)
	for _ = 1, n do
		RunService.Heartbeat:Wait()
	end
end

function View.setMarkers(on, kind)
	local old = CoreGui:FindFirstChild(MARKER_NAME)
	if old then
		old:Destroy()
	end
	if not on then
		return
	end
	local color = MARKER_COLORS[kind or "target"] or MARKER_COLORS.target
	local gui = Instance.new("ScreenGui")
	gui.Name = MARKER_NAME
	gui.IgnoreGuiInset = true
	pcall(function()
		gui.ScreenInsets = Enum.ScreenInsets.None
	end)
	gui.DisplayOrder = 2147483647
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	for _, corner in { Vector2.new(0, 0), Vector2.new(1, 1) } do
		local f = Instance.new("Frame")
		f.BorderSizePixel = 0
		f.BackgroundColor3 = color
		f.Size = UDim2.fromOffset(MARKER_SIZE, MARKER_SIZE)
		f.AnchorPoint = corner
		f.Position = UDim2.fromScale(corner.X, corner.Y)
		f.Parent = gui
	end
	gui.Parent = CoreGui
end

-- Everything visible in Workspace, ignoring Terrain, the Camera and huge
-- baseplates, so "frame the map" looks at the actual content.
local function workspaceContent()
	local list = {}
	for _, c in workspace:GetChildren() do
		if c:IsA("Terrain") or c:IsA("Camera") then
			continue
		end
		if c:IsA("BasePart") and (c.Name == "Baseplate" or c.Size.X * c.Size.Z > 250000) then
			continue
		end
		if c:IsA("PVInstance") or c:IsA("Folder") then
			table.insert(list, c)
		end
	end
	return list
end

local function basisOf(list)
	if #list == 1 and list[1]:IsA("PVInstance") then
		local ok, pivot = pcall(function()
			return list[1]:GetPivot()
		end)
		if ok then
			return pivot.Rotation
		end
	end
	return CFrame.identity
end

local VIEWS = {
	front = function(r)
		return r.LookVector, Vector3.yAxis
	end,
	back = function(r)
		return -r.LookVector, Vector3.yAxis
	end,
	right = function(r)
		return r.RightVector, Vector3.yAxis
	end,
	left = function(r)
		return -r.RightVector, Vector3.yAxis
	end,
	top = function(r)
		return r.UpVector, -r.LookVector
	end,
	bottom = function(r)
		return -r.UpVector, r.LookVector
	end,
	iso = function(r)
		return (r.LookVector + r.RightVector + r.UpVector * 0.9).Unit, Vector3.yAxis
	end,
	iso_back = function(r)
		return (-r.LookVector - r.RightVector + r.UpVector * 0.9).Unit, Vector3.yAxis
	end,
	iso_left = function(r)
		return (r.LookVector - r.RightVector + r.UpVector * 0.9).Unit, Vector3.yAxis
	end,
	bird = function(r)
		return (r.LookVector * 0.35 + r.UpVector).Unit, Vector3.yAxis
	end,
}
View.VIEWS = VIEWS

--[[
	View.frame(args)
	  targets   paths (or "@selection"); default: whole Workspace content
	  view      preset name (front/back/left/right/top/bottom/iso/iso_back/iso_left/bird) or "current"
	  cframe    explicit camera CFrame (wire format); overrides view
	  position + lookAt   explicit camera placement
	  distance  multiplier on the auto-fit distance (default 1)
	  fov       field of view to use
]]
function View.frame(args)
	local cam = camera()
	if args.fov then
		cam.FieldOfView = math.clamp(tonumber(args.fov) or 70, 1, 120)
	end
	if args.cframe then
		cam.CFrame = Codec.cframe(args.cframe)
		return
	end
	if args.position then
		local pos = Codec.vector3(args.position)
		local look = args.lookAt and Codec.vector3(args.lookAt) or (pos + Vector3.new(0, 0, -1))
		cam.CFrame = CFrame.lookAt(pos, look)
		cam.Focus = CFrame.new(look)
		return
	end
	local view = args.view or "iso"
	if view == "current" then
		return
	end
	local targets
	if args.targets then
		targets = Paths.resolveMany(args.targets)
	else
		targets = workspaceContent()
	end
	local b = Build.bounds(targets)
	if not b then
		error("targets have no spatial bounds", 0)
	end
	local fn = VIEWS[view]
	if not fn then
		error("unknown view '" .. tostring(view) .. "'", 0)
	end
	local dir, up = fn(basisOf(targets))
	local vp = cam.ViewportSize
	local aspect = (vp.Y > 0) and (vp.X / vp.Y) or (16 / 9)
	local tv = math.tan(math.rad(cam.FieldOfView) / 2)
	local th = tv * aspect
	if math.abs(dir:Dot(up)) > 0.999 then
		up = Vector3.zAxis
	end
	-- fit the 8 box corners: camera at center + dir*d looking along f = -dir;
	-- a corner offset q has depth d + q·f and must satisfy |q·r| <= depth*th, |q·u| <= depth*tv
	local look = CFrame.lookAt(Vector3.zero, -dir, up)
	local r, u, f = look.RightVector, look.UpVector, look.LookVector
	local half = b.size / 2
	local need = 0
	for _, sx in { -1, 1 } do
		for _, sy in { -1, 1 } do
			for _, sz in { -1, 1 } do
				local q = Vector3.new(half.X * sx, half.Y * sy, half.Z * sz)
				local qf = q:Dot(f)
				need = math.max(need, math.abs(q:Dot(r)) / th - qf, math.abs(q:Dot(u)) / tv - qf, -qf + 0.5)
			end
		end
	end
	local dist = math.max(need * 1.1, 2) * (tonumber(args.distance) or 1)
	local pos = b.center + dir * dist
	cam.CFrame = CFrame.lookAt(pos, b.center, up)
	cam.Focus = CFrame.new(b.center)
end

local function sameCFrame(a, b)
	return (a.Position - b.Position).Magnitude < 0.01 and a.LookVector:Dot(b.LookVector) > 0.9999 and a.UpVector:Dot(b.UpVector) > 0.9999
end

-- A play-test client's camera scripts set the camera every frame. While a capture is
-- prepared the requested camera is set again after them each frame, and every Heartbeat
-- checks that it held; `overridden` records a frame where something else won.
local hold = nil

local function stopHold()
	local h = hold
	hold = nil
	if not h then
		return nil
	end
	if h.bound then
		pcall(function()
			RunService:UnbindFromRenderStep(HOLD_NAME)
		end)
	end
	for _, c in h.conns do
		c:Disconnect()
	end
	return h
end

local function startHold(cam, want, fov)
	stopHold()
	local h = { want = want, fov = fov, overridden = false, frames = 0, conns = {} }
	local function apply()
		if workspace.CurrentCamera ~= cam then
			return
		end
		cam.CFrame = want
		if fov then
			cam.FieldOfView = fov
		end
	end
	h.bound = pcall(function()
		RunService:BindToRenderStep(HOLD_NAME, HOLD_PRIORITY, apply)
	end)
	if not h.bound then
		table.insert(h.conns, RunService.RenderStepped:Connect(apply))
	end
	table.insert(
		h.conns,
		RunService.Heartbeat:Connect(function()
			h.frames += 1
			if workspace.CurrentCamera ~= cam or not sameCFrame(cam.CFrame, want) then
				h.overridden = true
			end
		end)
	)
	hold = h
	return h
end

-- Only a running game moves the camera on its own.
local function playClient()
	return not RunService:IsEdit() and RunService:IsClient()
end

local function movesCamera(args)
	return args.cframe ~= nil or args.position ~= nil or args.fov ~= nil or (args.view or "iso") ~= "current"
end

-- Prepare the viewport for a capture. Returns what's needed to restore it.
function View.prepare(args)
	local cam = camera()
	local prev = {
		cframe = Codec.encode(cam.CFrame),
		focus = Codec.encode(cam.Focus),
		fov = cam.FieldOfView,
		selection = {},
	}
	if args.hideSelection ~= false then
		for _, s in Selection:Get() do
			table.insert(prev.selection, Paths.id(s))
		end
		Selection:Set({})
	end
	local okFrame, frameErr = pcall(View.frame, args)
	if not okFrame then
		-- no capture follows, so nothing else would restore what was just changed
		pcall(function()
			View.finish({ prev = prev })
		end)
		error(frameErr, 0)
	end
	local h = nil
	if playClient() and movesCamera(args) then
		h = startHold(cam, cam.CFrame, args.fov and cam.FieldOfView or nil)
	else
		stopHold()
	end
	View.setMarkers(args.markers ~= false)
	waitFrames(4)
	task.wait(0.12)
	local vp = cam.ViewportSize
	local out = { prev = prev, viewport = { vp.X, vp.Y }, camera = Codec.encode(cam.CFrame) }
	if h then
		-- false: the game's camera won at least one frame, so the capture may not show the requested view
		out.cameraHeld = not h.overridden and h.frames > 0
	end
	return out
end

-- Markers only, no camera: what another DataModel of a running test draws while one is captured.
function View.markers(args)
	View.setMarkers(args.on == true, args.kind)
	if args.on == true then
		waitFrames(2)
		task.wait(0.05)
	end
	return true
end

function View.finish(args)
	View.setMarkers(false)
	local h = stopHold()
	local prev = args.prev
	if prev and args.restore ~= false then
		local cam = camera()
		cam.CFrame = Codec.cframe(prev.cframe)
		if prev.focus then
			cam.Focus = Codec.cframe(prev.focus)
		end
		if prev.fov then
			cam.FieldOfView = prev.fov
		end
	end
	if prev and prev.selection and #prev.selection > 0 then
		local list = {}
		for _, id in prev.selection do
			local inst = Paths.resolve(id)
			if inst then
				table.insert(list, inst)
			end
		end
		Selection:Set(list)
	end
	if h then
		return { cameraHeld = not h.overridden and h.frames > 0, frames = h.frames }
	end
	return true
end

return View
