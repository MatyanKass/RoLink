-- import_animation support: reports a rig's joints to the server and builds a
-- KeyframeSequence from the poses it computes (see docs/ANIMATION.md).

local KeyframeSequenceProvider = game:GetService("KeyframeSequenceProvider")
local Selection = game:GetService("Selection")
local ServerStorage = game:GetService("ServerStorage")

local Paths = require(script.Parent.Paths)

local Animation = {}

local DEFAULT_FOLDER = "RoLinkAnimations"
local MAX_PREVIEW_SECONDS = 15
local staged = {}

local function rotationOf(cf)
	local c = { cf:GetComponents() }
	return { c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12] }
end

function Animation.rigInfo(args)
	local rig = Paths.one(args.rig)
	local root = rig:FindFirstChild("HumanoidRootPart") or (rig:IsA("Model") and rig.PrimaryPart)
	if not root or not root:IsA("BasePart") then
		error("rig needs a HumanoidRootPart or PrimaryPart: " .. Paths.of(rig), 0)
	end
	local rootCf = root.CFrame
	local joints = { [root.Name] = { r = rotationOf(CFrame.new()) } }
	for _, d in rig:GetDescendants() do
		if d:IsA("Motor6D") and d.Part0 and d.Part1 then
			local frame = rootCf:ToObjectSpace(d.Part0.CFrame * d.C0)
			joints[d.Part1.Name] = { parent = d.Part0.Name, r = rotationOf(frame) }
		elseif d:IsA("Bone") then
			local frame = rootCf:ToObjectSpace(d.WorldCFrame)
			joints[d.Name] = { parent = d.Parent.Name, r = rotationOf(frame) }
		end
	end
	local kind = "custom"
	if joints.LowerTorso or joints.UpperTorso then
		kind = "R15"
	elseif joints.Torso and joints["Left Arm"] then
		kind = "R6"
	end
	return { type = kind, root = root.Name, joints = joints }
end

function Animation.stage(args)
	local st = staged[args.importId]
	if not st then
		st = {}
		staged[args.importId] = st
	end
	st[args.index] = args.chunk
	return { staged = args.index }
end

function Animation.discard(args)
	staged[args.importId] = nil
	return { discarded = true }
end

local function targetFolder(args)
	if args.target then
		return Paths.one(args.target)
	end
	local f = ServerStorage:FindFirstChild(DEFAULT_FOLDER)
	if not f then
		f = Instance.new("Folder")
		f.Name = DEFAULT_FOLDER
		f.Parent = ServerStorage
	end
	return f
end

local function newPose(name)
	local p = Instance.new("Pose")
	p.Name = name
	p.Weight = 1
	p.EasingStyle = Enum.PoseEasingStyle.Linear
	p.EasingDirection = Enum.PoseEasingDirection.In
	p.CFrame = CFrame.new()
	return p
end

function Animation.build(args)
	local st = staged[args.importId]
	staged[args.importId] = nil
	if not st then
		error("no staged animation data for this import", 0)
	end
	local parent = targetFolder(args)
	local name = args.name or "Animation"
	local existing = parent:FindFirstChild(name)
	if existing and not args.replace then
		error(string.format("%s already exists; pass replace:true to overwrite it", Paths.of(existing)), 0)
	end

	local tree = args.tree or {}
	local seq = Instance.new("KeyframeSequence")
	seq.Name = name
	seq.Loop = args.loop == true
	seq.Priority = Enum.AnimationPriority[args.priority or "Action"]

	local frames, poses, lastTime = 0, 0, 0
	for i = 1, args.count do
		local chunk = st[i]
		if not chunk then
			error("animation chunk " .. i .. " is missing", 0)
		end
		for _, kf in chunk do
			local frame = Instance.new("Keyframe")
			frame.Time = kf.t
			lastTime = math.max(lastTime, kf.t)
			local made = {}
			local function ensure(part)
				local p = made[part]
				if p then
					return p
				end
				p = newPose(part)
				made[part] = p
				poses += 1
				local up = tree[part]
				if part == args.root or up == nil then
					p.Parent = frame
				else
					p.Parent = ensure(up)
				end
				return p
			end
			for part, v in kf.p do
				ensure(part).CFrame = CFrame.new(v[1], v[2], v[3], v[4], v[5], v[6], v[7])
			end
			frame.Parent = seq
			frames += 1
			if frames % 200 == 0 then
				task.wait()
			end
		end
	end

	if existing then
		existing:Destroy()
	end
	seq.Parent = parent
	Selection:Set({ seq })
	return { created = Paths.ref(seq), keyframes = frames, poses = poses, length = lastTime }
end

local function animatorHost(rig)
	return rig:FindFirstChildOfClass("Humanoid") or rig:FindFirstChildOfClass("AnimationController")
end

-- Plays the sequence once on the rig in edit mode. The id is temporary and only
-- exists in this Studio session; nothing here is saved or undoable.
function Animation.preview(args)
	local seq = Paths.one(args.path)
	local rig = Paths.one(args.rig)
	local host = animatorHost(rig)
	if not host then
		error("preview needs a rig with a Humanoid or AnimationController: " .. Paths.of(rig), 0)
	end
	local id = KeyframeSequenceProvider:RegisterKeyframeSequence(seq)
	local anim = Instance.new("Animation")
	anim.AnimationId = id

	local animator = host:FindFirstChildOfClass("Animator")
	local tempAnimator = animator == nil
	if tempAnimator then
		animator = Instance.new("Animator")
		animator.Parent = host
	end

	-- preview is not an undo step: whatever happens, take the temporary Animator and the
	-- posed joints back out, or they would be saved with the place
	local track
	local played = 0
	local ok, err = pcall(function()
		track = animator:LoadAnimation(anim)
		local seconds = math.min(tonumber(args.seconds) or track.Length, MAX_PREVIEW_SECONDS)
		if seconds <= 0 then
			seconds = 1
		end
		track:Play(0)
		local dt = 1 / 30
		while played < seconds do
			animator:StepAnimations(dt)
			task.wait(dt)
			played += dt
		end
	end)
	pcall(function()
		if track then
			track:Stop(0)
			animator:StepAnimations(0)
			track:Destroy()
		end
	end)
	anim:Destroy()
	for _, d in rig:GetDescendants() do
		if d:IsA("Motor6D") then
			pcall(function()
				d.Transform = CFrame.new()
			end)
		end
	end
	if tempAnimator then
		animator:Destroy()
	end
	if not ok then
		error("animation preview failed: " .. tostring(err), 0)
	end
	return { id = id, temporary = true, seconds = played }
end

return Animation
