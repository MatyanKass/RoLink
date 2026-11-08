-- import_model support: builds EditableMesh-backed MeshParts from chunks the
-- server parsed (preview mode), or inserts an uploaded asset (upload mode).
--
-- Preview parts are NOT persisted when the place is saved/published — the
-- EditableMesh content lives only in this Studio session.

local AssetService = game:GetService("AssetService")
local InsertService = game:GetService("InsertService")

local Util = require(script.Parent.Util)

local MeshImport = {}

local staged = {} -- importId -> { [index] = chunk }
local keepAlive = setmetatable({}, { __mode = "k" }) -- MeshPart -> EditableMesh

local function f32(b64)
	local buf = Util.base64Decode(b64)
	local n = buffer.len(buf) // 4
	return buf, n
end

function MeshImport.stage(args)
	assert(type(args.importId) == "string", "importId required")
	local t = staged[args.importId]
	if not t then
		t = {}
		staged[args.importId] = t
	end
	t[args.index] = args.chunk
	return { staged = args.index }
end

function MeshImport.discard(args)
	staged[args.importId] = nil
	return { discarded = true }
end

-- Build one EditableMesh from a chunk. Returns the EditableMesh.
function MeshImport.editableFromChunk(chunk)
	local em = AssetService:CreateEditableMesh({})
	local pbuf, pn = f32(chunk.positions)
	local vcount = pn // 3
	local vids = table.create(vcount)
	for i = 0, vcount - 1 do
		local o = i * 12
		vids[i + 1] = em:AddVertex(Vector3.new(buffer.readf32(pbuf, o), buffer.readf32(pbuf, o + 4), buffer.readf32(pbuf, o + 8)))
	end
	local nids, uvids
	if chunk.normals then
		local nbuf = f32(chunk.normals)
		nids = table.create(vcount)
		for i = 0, vcount - 1 do
			local o = i * 12
			nids[i + 1] = em:AddNormal(Vector3.new(buffer.readf32(nbuf, o), buffer.readf32(nbuf, o + 4), buffer.readf32(nbuf, o + 8)))
		end
	end
	if chunk.uvs then
		local ubuf = f32(chunk.uvs)
		uvids = table.create(vcount)
		for i = 0, vcount - 1 do
			local o = i * 8
			uvids[i + 1] = em:AddUV(Vector2.new(buffer.readf32(ubuf, o), buffer.readf32(ubuf, o + 4)))
		end
	end
	local ibuf, icount = f32(chunk.indices)
	for t = 0, icount // 3 - 1 do
		local o = t * 12
		local a = buffer.readu32(ibuf, o) + 1
		local b = buffer.readu32(ibuf, o + 4) + 1
		local c = buffer.readu32(ibuf, o + 8) + 1
		local ok, face = pcall(em.AddTriangle, em, vids[a], vids[b], vids[c])
		if ok and face then
			if nids then
				em:SetFaceNormals(face, { nids[a], nids[b], nids[c] })
			end
			if uvids then
				em:SetFaceUVs(face, { uvids[a], uvids[b], uvids[c] })
			end
		end
	end
	return em
end

local function vec(t, default)
	if type(t) == "table" then
		return Vector3.new(t[1] or 0, t[2] or 0, t[3] or 0)
	end
	return default
end

-- Mutating: runs inside the dispatcher's ChangeHistory recording.
function MeshImport.build(args, parent)
	local chunks = staged[args.importId]
	staged[args.importId] = nil
	if not chunks then
		error("no staged mesh data for this import (Studio reconnected?)", 0)
	end
	for i = 1, args.count do
		if not chunks[i] then
			error(("mesh chunk %d of %d is missing"):format(i, args.count), 0)
		end
	end
	local base = CFrame.new(vec(args.position, Vector3.zero))
	local model = Instance.new("Model")
	model.Name = args.name or "ImportedModel"
	local made = 0
	for i = 1, args.count do
		local chunk = chunks[i]
		local ok, part = pcall(function()
			local em = MeshImport.editableFromChunk(chunk)
			local mp = AssetService:CreateMeshPartAsync(Content.fromObject(em))
			keepAlive[mp] = em
			return mp
		end)
		if not ok then
			model:Destroy()
			error(("building mesh part %d/%d (%s) failed: %s"):format(i, args.count, tostring(chunk.name), tostring(part)), 0)
		end
		part.Name = chunk.name or ("Part" .. i)
		local s = chunk.size
		part.Size = Vector3.new(math.max(s[1], 0.001), math.max(s[2], 0.001), math.max(s[3], 0.001))
		part.CFrame = base * CFrame.new(vec(chunk.center, Vector3.zero))
		part.Anchored = args.anchored ~= false
		if chunk.color then
			part.Color = Color3.new(chunk.color[1], chunk.color[2], chunk.color[3])
		end
		if chunk.transparency and chunk.transparency > 0 then
			part.Transparency = math.clamp(chunk.transparency, 0, 1)
		end
		part.Parent = model
		made += 1
	end
	model:SetAttribute("RoLinkPreviewImport", true)
	model.WorldPivot = base
	model.Parent = parent
	return model, made
end

-- Mutating: insert an uploaded asset.
function MeshImport.insert(args, parent)
	local id = tonumber(args.assetId)
	assert(id, "assetId required")
	local root
	local ok, err = pcall(function()
		local container = InsertService:LoadAsset(id)
		local kids = container:GetChildren()
		if #kids == 1 then
			root = kids[1]
			root.Parent = nil
			container:Destroy()
		else
			root = container
		end
	end)
	if not ok then
		local ok2, objs = pcall(function()
			return game:GetObjects("rbxassetid://" .. id)
		end)
		if not ok2 or not objs or #objs == 0 then
			error(("asset %d uploaded but could not be inserted (it may still be in moderation): %s"):format(id, tostring(err)), 0)
		end
		if #objs == 1 then
			root = objs[1]
		else
			root = Instance.new("Model")
			for _, o in objs do
				o.Parent = root
			end
		end
	end
	if not root:IsA("Model") and root:IsA("BasePart") then
		local m = Instance.new("Model")
		root.Parent = m
		root = m
	end
	root.Name = args.name or root.Name
	local anchored = args.anchored ~= false
	for _, d in root:GetDescendants() do
		if d:IsA("BasePart") then
			d.Anchored = anchored
		end
	end
	if root:IsA("Model") then
		local sf = args.scale
		if args.fitSize then
			local _, size = root:GetBoundingBox()
			local largest = math.max(size.X, size.Y, size.Z)
			if largest > 0 then
				sf = args.fitSize / largest
			end
		end
		if sf and sf > 0 and sf ~= 1 then
			root:ScaleTo(root:GetScale() * sf)
		end
		if args.position then
			-- bottom-center to the requested point
			local cf, size = root:GetBoundingBox()
			local target = vec(args.position, Vector3.zero)
			local delta = target - (cf.Position - Vector3.new(0, size.Y / 2, 0))
			root:PivotTo(root:GetPivot() + delta)
		end
	end
	root:SetAttribute("RoLinkAssetId", id)
	root.Parent = parent
	return root
end

return MeshImport
