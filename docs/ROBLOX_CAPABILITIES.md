# Roblox capabilities for RoLink

Working reference for the goal "an AI agent can do everything a human can do in Studio".
Researched 2026-11-08. Nothing here was exercised in a live Studio; it is documentation and forum evidence only.

**Legend.** `[C]` links to the page that states the claim (confirmed by reading that page). `[U]` is unconfirmed: a forum report,
an inference, or absence of evidence. Roblox docs change often, and several pages contradict each other; conflicts are listed in section 7.

Security shorthand: `Plugin` = PluginSecurity. `None` = no security tag (callable from plugins too, unless the page restricts it).
`Roblox` = RobloxScriptSecurity (not callable by plugins).

`None`-tagged members may still require a capability when the caller is sandboxed [C][caps]. Whether plugin context holds every capability is not documented in the pages read [U].

## 1. What a Studio plugin can do

### 1.1 Plugin object

| Area | Members | Security | Notes | Src |
|---|---|---|---|---|
| Toolbar, menus | `CreateToolbar`, `CreatePluginMenu`, `CreatePluginAction` | Plugin | Actions can appear in the shortcuts view | [C][plugin] |
| Dock widgets | `CreateDockWidgetPluginGuiAsync` | Plugin | ID must be stable; stores dock state | [C][plugin] |
| Mouse | `Activate`, `Deactivate`, `GetMouse`, `IsActivated` | Plugin | One active plugin at a time; mouse needs exclusive activation | [C][plugin] |
| Settings | `GetSetting`, `SetSetting` | Plugin | JSON values persist; can silently fail under concurrent Studio instances | [C][plugin] |
| CSG (legacy path) | `Union`, `Negate`, `Intersect`, `Separate` | Plugin | Prefer GeometryService for new code | [C][plugin] |
| Studio tools | `SelectRibbonTool`, `GetSelectedRibbonTool` | Plugin | Activates a Studio tool; requires a selected object | [C][plugin] |
| Drag | `StartDrag` | Plugin | Drag payload from a widget | [C][plugin] |
| Upload dialog | `SaveSelectedToRoblox` | Plugin | Opens the upload window (user-driven) | [C][plugin] |
| Save dialog | `PromptSaveSelectionAsync` | Plugin | User picks a file | [C][plugin] |
| FBX import | `ImportFbxRigAsync`, `ImportFbxAnimationAsync` | Plugin | Prompts for a file; animation lands as a KeyframeSequence | [C][plugin] |
| Pick animation | `PromptForExistingAssetIdAsync("Animation")` | Plugin | Only "Animation" supported; -1 on cancel | [C][plugin] |
| Identity | `GetStudioUserId` | Plugin | 0 if logged out | [C][plugin] |
| Open script | `OpenScript` | Plugin | Docs recommend `ScriptEditorService:OpenScriptDocumentAsync` | [C][plugin] |
| Lifecycle | `Unloading`, `Deactivation` | Plugin | Widgets and toolbars clean up automatically | [C][plugin] |

### 1.2 Services

| Service | Useful members | Security | Limits / notes | Src |
|---|---|---|---|---|
| ChangeHistoryService | `TryBeginRecording`, `FinishRecording`, `Undo`, `Redo`, `ResetWaypoints`, `SetEnabled`, `OnUndo`, `OnRedo` | Plugin | `TryBeginRecording` returns nil during a solo play-test or if this plugin already records. `Undo`/`Redo` error during play. `SetWaypoint` is to be deprecated. `SetEnabled(false)` clears history | [C][chs] |
| Selection | `Get`, `Set`, `Add`, `Remove`, `SelectionChanged` | Plugin (event None) | Plugins and command bar only | [C][sel] |
| ScriptEditorService | `UpdateSourceAsync`, `GetEditorSource`, `FindScriptDocument`, `OpenScriptDocumentAsync`, `RegisterAutocompleteCallback`, `RegisterScriptAnalysisCallback`, `TextDocumentDid*` | Plugin | Update callback may not yield and may be re-invoked. Analysis callback only contributes diagnostics; no read of Studio's lint results found [U] | [C][ses] |
| StudioService | `ActiveScript`, `GridSize`, `RotateIncrement`, `UseLocalSpace`, `GetUserId`, `GetClassIcon`, `PromptImportFileAsync`, `PromptImportFilesAsync` | Mixed | File reads need a user prompt; returns nil over 100 MB. `Secrets` is Roblox-only | [C][studio] |
| StudioTestService | `ExecutePlayModeAsync`, `ExecuteRunModeAsync`, `ExecuteMultiplayerTestAsync(n, args)`, `EndTest`, `GetTestArgs`, `AddPlayers`, `LeaveTest`, `CanLeaveTest`, `EditModeActive` | Execute* Plugin | See 1.3 | [C][sts] |
| RunService | `Run`, `Pause`, `Stop` | Plugin | Simulation only: not a real Run test, `IsRunMode()` stays false. `Stop` keeps changes made during the run | [C][runsvc] |
| TestService | `Run`/`RunAsync`, `Check`, `Require`, `Fail`, `Done`, `ExecuteWithStudioRun`, `AutoRuns`, `NumberOfPlayers` | Run Plugin | `NumberOfPlayers > 0` opens a server plus that many windows | [C][testsvc] |
| LogService | `GetLogHistory`, `MessageOut`, `ClearOutput` | None | History capped at 512 entries by default. `MessageOut` fires for all engine output | [C][logsvc] |
| ScriptProfilerService | `ServerStart/Stop`, `ClientStart/Stop`, `ServerRequestData`, `DeserializeJSON`, `OnNewData` | Plugin | 1 to 10000 samples/s; powers the Script Profiler | [C][profiler] |
| DataModel | `GetObjects`, `GetJobsInfo`, `SetPlaceId`, `SetUniverseId` | Plugin | `GetObjects` loads library assets. `SavePlace` is deprecated | [C][dm] |
| SerializationService | `SerializeInstancesAsync`, `DeserializeInstancesAsync` | None, capability PluginOrOpenCloud | Binary `.rbxm` in a `buffer`; no stability contract; non-creatable instances and services throw | [C][ser] |
| ReflectionService | `GetClass`, `GetClasses`, `GetPropertiesOfClass`, `GetMethodsOfClass`, `GetEventsOfClass` | None | Returns Type, Serialized, Permits, parameters. No default values listed | [C][refl] |
| Instance (base) | `IsPropertyModified`, `ResetPropertyToDefault`, `QueryDescendants`, `UniqueId`, `Sandboxed`, `Capabilities` | see class | Useful for "changed properties only" serialization | [C][refl] |
| AssetService | `CreateAssetAsync`, `CreateAssetVersionAsync`, `CreateEditableMeshAsync`, `CreateEditableImageAsync`, `CreateMeshPartAsync`, `CreateDataModelContentAsync`, `LoadAssetAsync`, `GetAssetIdsForPackageAsync`, `GetAudioMetadataAsync`, `GetGamePlacesAsync`, `SavePlaceAsync`, `CreatePlaceAsync`, `ComposeDecalAsync` | None + capabilities | See 1.4 | [C][as] |
| InsertService | `LoadAsset`, `LoadAssetVersion`, `GetLatestAssetVersionAsync` | None | Ownership limited. For plugins the page points to `DataModel:GetObjects` | [C][insert] |
| GeometryService | `UnionAsync`, `SubtractAsync`, `IntersectAsync`, `FragmentAsync`, `GenerateFragmentSites`, `CalculateConstraintsToPreserve` | None, capability CSG | Terrain unsupported. Returns MeshParts if any input is a MeshPart | [C][geom] |
| MaterialService | `GetBaseMaterialOverride`, `SetBaseMaterialOverride`, `GetMaterialVariant` | None | Override name properties are not scriptable; use the methods | [C][mat] |
| KeyframeSequenceProvider | `GetKeyframeSequenceAsync`, `RegisterKeyframeSequence`, `RegisterActiveKeyframeSequence`, `GetAnimationsAsync` | None | IDs are temporary and Studio-only. Service is deprecated in favour of AnimationClipProvider | [C][ksp] [C][acp] |
| AnimationClipProvider | `GetAnimationClipAsync`, `GetClipEvaluatorAsync`, `RegisterAnimationClip`, `RegisterActiveAnimationClip`, `GetAnimationsAsync` | None | Register* IDs are Studio-only | [C][acp] |
| Terrain | `Fill*`, `ReadVoxels`, `WriteVoxels`, `ReadVoxelChannels`, `WriteVoxelChannels`, `CopyRegion`, `PasteRegion`, `ReplaceMaterial`, `Get/SetMaterialColor` | None | Max 4,194,304 voxels per region. Resolution must be 4. Extents ±32,000 cells | [C][terrain] |
| CollectionService | Tags, signals, `GetTagged`, `GetCollections` | None | | [C][cs] |
| DraggerService | Dragger settings | None, except three | `PartSnapEnabled`, `PivotSnapToGeometry`, `UseBoundingBoxes` are Roblox-only | [C][drag] |
| CaptureService | `CaptureScreenshot`, `TakeScreenshotCaptureAsync`, video capture (30 s max), gallery and share prompts | None, capability Capture | Returns a temporary contentId, no file export. Docs do not say plugins can use it | [C][capture] |
| AvatarCreationService | `AutoSetupAvatarAsync`, `ValidateUGCAccessoryAsync`, `ValidateUGCBodyPartAsync`, `ValidateUGCFullBodyAsync` | None | Validate* are Studio only. Plugin use of auto-setup is not documented | [C][avatar] |
| GenerationService | `GenerateModelAsync`, `SegmentMeshAsync`, `GenerateMeshAsync`, `LoadGeneratedMeshAsync` | None, capability DynamicGeneration | `SegmentMeshAsync` is Studio only. `GenerateMeshAsync` is server-only, `LoadGeneratedMeshAsync` client-only | [C][gen] |
| TextGenerator | `GenerateTextAsync`, `SystemPrompt`, `Temperature`, `TopP`, `Seed` | None | Starts at 100 requests/min and scales with concurrent users | [C][textgen] |
| AudioTextToSpeech | `Text`, `VoiceId`, `LoadAsync` | see class | 300-character text limit | [C][tts] |

### 1.3 Play-test control

- A plugin **can start a test**: `ExecutePlayModeAsync` (solo Test), `ExecuteRunModeAsync` (Run), `ExecuteMultiplayerTestAsync(1..8, args)` [C][sts].
- Each yields until the test ends and returns the value passed to `EndTest`. Solo variants return nil if ended another way [C][sts]. Run them in a coroutine.
- `args` is any serializable value; test scripts read it with `GetTestArgs`. The page warns of an issue when reading it from a client LocalScript [C][sts].
- `EndTest` and `AddPlayers` must be called from the **server** DataModel; `LeaveTest` from a **client** DataModel [C][sts].
- One multiplayer session per Studio. Calling while a test is running errors [C][sts].
- `RunService:Run()` is not equivalent to a Studio Run test [C][runsvc].

### 1.4 Asset creation from a plugin

| API | Input → type | Behaviour | Src |
|---|---|---|---|
| `AssetService:CreateAssetAsync(obj, type, params?)` | Instance root → `Model` or `Plugin`; EditableMesh → `Mesh`; EditableImage → `Image`; AudioTextToSpeech → `Audio` | **Locally loaded plugins only. Uploads without prompting.** `CreatorId` defaults to the Studio user. `IsPackage` defaults true for Model | [C][as] |
| `AssetService:CreateAssetVersionAsync` | Same, no Audio | New version of an existing asset | [C][as] |
| Same APIs, runtime reality | | Forum: may need File > Beta Features > "CreateAssetAsync Lua API", else "not available yet". Works in local plugin or command bar; blocked in Creator Store plugins. Reports conflict | [U][cabug] [U][bulkanim] |
| Same APIs from Luau Execution | | `CreatorId` and `CreatorType` are required there | [C][as] |
| `AssetService:PromptCreatePlatformContentAsync` | EditableImage | Server only; shows a publish dialog | [C][as] |
| `Plugin:SaveSelectedToRoblox` | Selection | Opens a dialog | [C][plugin] |

### 1.5 EditableMesh, EditableImage

| Item | Limit | Src |
|---|---|---|
| EditableMesh vertices | 60,000 | [C][emesh] |
| EditableMesh triangles | 20,000 (a quad counts as 2) | [C][emesh] |
| EditableImage size | 1024×1024, read-only after creation | [C][eimg] |
| Memory | Clients have strict budgets; server, Studio and plugins have none | [C][emesh] [C][eimg] |
| Published games | Off until "Enable Mesh / Image APIs" is on (Creator Dashboard or Experience Settings) | [C][emesh] |
| Loading existing assets | Only assets owned by or shared with the experience owner, Studio user, or player; group assets need an edit role | [C][emesh] [C][eimg] |
| Persistence with the place | Pages do not define it. RoLink's own note says preview meshes are not saved | [U] |
| Larger EditableImage in plugins | One forum reply says so | [U][capforum] |

Screenshots: `CaptureService` content can reportedly be turned into an EditableImage and read back, but forum reports conflict and one plugin report says it began yielding forever [U][capforum]. RoLink's Windows window capture avoids this dependency.

### 1.6 Input from plugins

| Mechanism | Status | Src |
|---|---|---|
| `VirtualInputManager` (`SendKeyEvent`, `SendMouseButtonEvent`, ...) | All 28 members are Roblox-only; "no functionality to developers" | [C][vim] [C][vimdoc] |
| `VirtualUser` | Docs page lists no own members and says the service is unmaintained. Legacy members and their security not checked [U] | [C][vuser] |
| Plugin mouse | `Plugin:GetMouse` reads the mouse; it does not inject input | [C][plugin] |
| Roblox's built-in MCP | Has `user_keyboard_input`, `user_mouse_input`, `character_navigation`, but as built-in tools, not a plugin API | [C][mcp] |
| OS-level `SendInput` from a companion process | Not a Roblox API; should work on a focused Studio window | [U] |

### 1.7 HTTP from plugins

- `localhost` and `127.0.0.1` are allowed for talking to separately distributed software on the same computer [C][http].
- Plugins ignore the game's Allow HTTP Requests setting, per the 2020 announcement [C][pluginhttp]. Current docs do not restate this [U].
- In-game limit is 500 requests/min, and Open Cloud has 2,500/min per game server [C][http]. Plugin-specific limit not found [U].
- In-game calls allow only `x-api-key` and `content-type` headers for Open Cloud, and `x-api-key` must be a `Secret` [C][http]. Whether this binds plugins is unconfirmed [U].

### 1.8 Permission prompts users see

| Prompt | Trigger | Persistence | Src |
|---|---|---|---|
| HTTP domain permission | First request to a new domain; subdomains separately | Editable in Plugin Management | [C][http] [C][pluginhttp] |
| Script injection | First time a plugin inserts or modifies a script | Stored per plugin, shown once | [C][scriptperm] |
| Local plugins exempt from HTTP prompts | 2020 forum reply | Verify | [U][pluginhttp] |
| `CreateAssetAsync` | None by design | | [C][as] |
| `StudioService:PromptImportFile*` | File picker every time | | [C][studio] |
| `ImportFbx*`, `PromptSaveSelectionAsync`, `SaveSelectedToRoblox` | Dialog every time | | [C][plugin] |

### 1.9 What plugins cannot do

| Limit | Src |
|---|---|
| Read or write arbitrary local files without a user prompt or a localhost companion | [C][studio] [C][http] |
| Use `StudioPublishService` (publish, save-to-Roblox dialogs): all 17 members Roblox-only | [C][publish] |
| Change device emulation: `StudioDeviceEmulatorService` is Roblox-only | [C][device] |
| Inject input: VirtualInputManager is Roblox-only | [C][vim] |
| Read local experience secrets (`StudioService.Secrets`) | [C][studio] |
| Use `CreatorStoreService` | [C][creatorsvc] |
| Change `AssetService.AllowInsertFreeAssets` (Roblox-only; set it in Experience Settings) | [C][as] |
| Undo/redo during play | [C][chs] |
| Sync binary properties live (Terrain, CSG, `MeshPart.MeshId`), per Rojo's docs | [C][rojo] |

### 1.10 Script Capabilities (Toolbox quarantine primitive)

- Mark a Model, Folder or Script `Sandboxed = true`, with allowed `Capabilities`. Requires `Workspace.SandboxedInstanceMode = Experimental` [C][caps].
- Without `AccessOutsideWrite`, scripts cannot reach instances outside the container [C][caps]. `getfenv`/`setfenv` are blocked [C][caps].
- Changing `Sandboxed`/`Capabilities` from code is gated by `CapabilityControl` [C][caps]. Whether plugin context holds it: [U], test it.
- Nested containers intersect capabilities [C][caps].
- Announcement: Creator Store assets are auto-sandboxed, with high-risk capabilities blocked; a pause of auto-sandboxing for Toolbox Models and Folders was announced, and its status is unknown [C][sandbox] [U].
- `LoadAssetAsync` returns a Model with `Sandboxed = true` and no capabilities [C][as].
- Creator Store search exposes `hasScripts`, `scriptCount`, `instanceCounts`, `capabilities.shouldSandbox` in the model schema, but the docs do not confirm these return in search results [C][cstore] [U].

## 2. Open Cloud

Limits are per minute per API key owner unless noted. All are at `https://apis.roblox.com` unless noted.

Global behaviour: limits apply across all keys of an owner; OAuth is per token; 429s carry `x-ratelimit-*` and `retry-after` [C][rate]. Undocumented limits may apply [C][rate].

Keys: scoped by API and operation, optionally by experience and IP/CIDR. **Keys unused for 60 days auto-expire** [C][apikeys].

### 2.1 Assets

| Endpoint | Scope | Limit |
|---|---|---|
| `POST /assets/v1/assets` | `asset:read`, `asset:write` | 120 |
| `GET`/`PATCH /assets/v1/assets/{id}` | read / read+write | 120 |
| `GET /assets/v1/assets/{id}/versions[/{n}]` | `asset:read` | 100 |
| `POST .../versions:rollback`, `:archive`, `:restore` | read+write | 100 |
| `GET /assets/v1/operations/{id}` | `asset:read` | 300 |
| `PATCH /asset-permissions-api/v1/assets/permissions` | `asset-permissions:write` | 100 |
| `GET /asset-delivery-api/v1/assetId/{id}[/version/{n}]` | `legacy-asset:manage` | 1000 |
| `GET /cloud/v2/users/{id}/asset-quotas` | `asset:read` | 60 |
| `POST /cloud/v2/universes/{id}:generateSpeechAsset` | `universe:write`, `asset:read`, `asset:write` | 4/s |

All [C][ocassets].

- Result: poll the operation until `done`, then read `response` (`assetId`, `revisionId`, `moderationResult.moderationState`) or `error` [C][usage].
- `moderationState`: `Reviewing`, `Rejected`, `Approved` per the model text; the guide example uses `MODERATION_STATE_APPROVED`. Handle both [C][ocassets] [C][usage].
- Grant fields: `grantToDependencies`, `parentVersionNumber`. `SubjectType`: User, Group, GroupRoleset, All, Universe. `AssetAction`: Edit, Use, Download, CopyFromRcc, UpdateFromRcc [C][ocassets].
- Creating uses `creationContext` with `creator`, `assetPrivacy`, `expectedPrice` (seen in examples) [C][ocassets].
- Plugins cannot be uploaded with an API key as of the Oct 2025 thread; cookie auth only [C][morecloud]. Current status [U].

### 2.2 Luau Execution

| Endpoint | Scope | Limit |
|---|---|---|
| `POST /universes/{u}/luau-execution-session-task-binary-inputs` | `...:write` | 5 |
| `POST /universes/{u}/places/{p}[/versions/{v}]/luau-execution-session-tasks` | `...:write` | 5 |
| `GET .../tasks/{id}` | `:read` or `:write` | 200 |
| `GET .../tasks/{id}/logs` | `:read` or `:write` | 45 |

Scope prefix `universe.place.luau-execution-session`.

Limits: 5 min runtime (default), 4 MB script, 4 MB return values, 450 KB logs, 24 h retention, 10 incomplete tasks per place, 100 MiB binary input, 256 MiB binary output [C][luau].

- Headless, with "full DataModel and engine Luau API access" [C][luau].
- Saving: intro says use `SavePlaceAsync`; the task model says changes "cannot be persisted". See section 7 [C][luau].
- A hidden cap of about 30 task creates/hour was reported, with a later "fixed" reply [U][luaucap].
- Each task starts fresh; no multi-task sessions [U][luausess].
- Serialization works in tasks, per `SerializationService` [C][ser].

### 2.3 Places

| Endpoint | Scope | Limit | Notes |
|---|---|---|---|
| `POST /universes/v1/{u}/places/{p}/versions` | `universe-places:write` | 30 | `versionType` Saved or Published, RBXL or RBXLX |
| `PATCH /assets/v1/assets/{placeId}` | assets Read+Write | not stated | Set `published: true`, else unpublished version. Status via operations |
| `GET`/`PATCH /cloud/v2/universes/{u}/places/{p}` | `universe.place:write` | 100 | 409 if an active Team Create session is open |
| `GET`/`PATCH .../instances/{id}`, `:listChildren` | `universe.place.instance:*` | 45 | Beta; returns operations; 500 KB response cap; `Source` up to 200,000 bytes |
| `GET /place-version-history-api/v1/{p}/history`, `/contributors` | `universe.place:read` | 120 | Experimental |
| `POST .../version/{v}/notes` | `universe.place:write` | 100 | Experimental |

Sources: [C][places] [C][pubguide].

- Place upload does not update EditableImage, EditableMesh, PartOperation, SurfaceAppearance, BaseWrap instances [C][pubguide]. Practical impact on rbxl built outside Studio: [U].
- Place size up to 100 MB [C][placefiles]. Applies to the API? [U]

### 2.4 Universes, messaging, secrets, observability

| Endpoint | Scope | Limit |
|---|---|---|
| `GET`/`PATCH /cloud/v2/universes/{u}` | `universe:write` for PATCH | 100 |
| `POST /cloud/v2/universes/{u}:restartServers` | `universe:write` | 30 |
| `POST /cloud/v2/universes/{u}:publishMessage` | `universe-messaging-service:publish` | 5000 |
| `POST /messaging-service/v1/universes/{u}/topics/{t}` | same | 5000 |
| `.../universes/{u}/secrets` (CRUD, public-key) | `universe.secret:read/write` | 120; max 500 |
| `/server-management/v1/.../game-servers`, `.../{jobId}/logs` | `universe:read` | 100 |
| `/server-management/v1/universes/{u}/restarts`, `:forecast` | read / write | 100 |

Sources: [C][universes] [C][obs].

Messaging: topic 80 chars, message 1 KiB; shares limits with engine MessagingService [C][msg].

### 2.5 Data and memory stores

| Family | Base | Scopes | Limit |
|---|---|---|---|
| Standard v2 | `/cloud/v2/universes/{u}/data-stores[/.../entries]` | `universe-datastores.control:*`, `.objects:*`, `.versions:list` | 1,000,000 plus datastore throttling |
| Standard v1 | `/datastores/v1/universes/{u}/standard-datastores` | same family | 5,000 |
| Ordered v2 | `/cloud/v2/universes/{u}/ordered-data-stores/...` | `universe.ordered-data-store.scope.entry:*` | 1,000,000 |
| Memory queues | `.../memory-store/queues/{q}/items`, `:read`, `:discard` | `memory-store.queue:add/dequeue/discard` | 1,000,000 |
| Memory maps | `.../memory-store/sorted-maps/{m}/items` | `memory-store.sorted-map:read/write` | 1,000,000 |
| Flush | `.../memory-store:flush` | `memory-store:flush` | 1,000,000 |
| Snapshot | `.../data-stores:snapshot` | `universe-datastores.control:snapshot` | 60; 1 per UTC day |

All [C][storage]. Page sizes vary; partial updates are unsupported in v2 (omitted fields clear); deletions purge after 30 days [C][storage].

### 2.6 Monetization

| Endpoint | Scope | Limit |
|---|---|---|
| `POST`/`PATCH /game-passes/v1/universes/{u}/game-passes[/{id}]` | `game-pass:write` | 5/s |
| `GET .../game-passes/creator`, `/{id}/creator` | `game-pass:read` | 10/s |
| `POST`/`PATCH /developer-products/v2/universes/{u}/developer-products[/{id}]` | `developer-product:write` | 3/s |
| `GET .../developer-products/creator`, `/{id}/creator` | `developer-product:read` | 10/s |

Sources: [C][passes] [C][products]. Icons and localized names use `legacy-*:manage` scopes at 100/min [C][passes] [C][products].

### 2.7 Creator Store

| Endpoint | Scope | Limit |
|---|---|---|
| `POST /toolbox-service/v2/assets:search` | `creator-store-product:read` | 1000 |
| `GET`/`POST`/`PATCH /cloud/v2/creator-store-products[/{id}]` | `creator-store-product:read/write` | 30 |
| `/toolbox-service/v1/saves` and `:bulkDelete` | `creator-store-save:read/write` | 200 |

Search supports `query`, `searchCategoryType`, facets, tags, included/excluded subtypes, instance types. `query` and `image` are mutually exclusive [C][cstore]. Creator fields include `verified`; votes include `upVotes`, `downVotes`. No moderation field in search [C][cstore].

### 2.8 Thumbnails, inventory, others

| Family | Endpoint | Auth / scope | Limit | Src |
|---|---|---|---|---|
| Thumbnails | `thumbnails.roblox.com POST /v1/batch` (`type: Asset`) | Cookie listed; docs are inconsistent | none listed | [C][thumbs] |
| Inventory | `GET /cloud/v2/users/{id}/inventory-items` | `user.inventory-item:read` | 100 (OAuth 20) | [C][inv] |
| Created assets | No documented "list my created assets" | | | [U][inv] |
| Team Create | `/legacy-develop/v1/universes/{u}/teamcreate` | `legacy-team-collaboration:manage` | 100 | [C][team] |
| Translate | `POST /cloud/v2/universes/{u}:translateText` | `universe:write` | 10,000 | [C][genai] |
| Other families | Accounts, advertising, analytics, avatars, badges, bans, configs, friends, experiments, game events, groups, localization, matchmaking, notifications, private servers, trades, users | see index | | [C][cloudindex] |

## 3. Asset limits and publishing paths

Open Cloud per-call content cap is **20 MB** [C][usage].

| Type | Formats | Limits | Update content via API | Src |
|---|---|---|---|---|
| Animation | `.rbxm`, `.rbxmx` | Upload as `model/x-rbxm`. Externally edited files may fail | Not stated | [C][usage] |
| Audio | `.mp3`, `.ogg`, `.wav`, `.flac` | 20 MB, 7 min, ≤48 kHz, mono or stereo 2.0, 3.0, 5.1; quota conflicts, see section 7 | No | [C][usage] [C][audio] |
| Decal/Image | `.png`, `.jpeg`, `.bmp`, `.tga` | Under 8000×8000 | No | [C][usage] |
| Mesh | Roblox format only | Accepts content from Asset Delivery; for new meshes, use Model or Importer | No | [C][usage] |
| Model | `.fbx`, `.gltf`, `.glb`, `.rbxm`, `.rbxmx` | Creates a Model containing MeshParts, uploaded as a package | `.fbx` only | [C][usage] |
| Video | `.mp4`, `.mov` | 5 min, 4096×2160, 3.75 GB; 20/day for ID-verified 13+ | No | [C][usage] |

Mesh and texture rules:

| Rule | Value | Src |
|---|---|---|
| Triangles per mesh | 20,000 (docs); forum staff describe about 21k due to 16-bit indices | [C][meshspec] [U][tri21k] |
| Older paths at 10k triangles | Forum reports for Asset Manager and other importers | [U][assetlimit] |
| Bone influences per vertex | 4 | [C][meshspec] |
| Animation tracks per export | 1 | [C][meshspec] |
| Materials per mesh | 1 | [C][texspec] |
| Texture size | 4096×4096 in one section, 1024×1024 in another | [C][texspec] |
| PBR map format | Albedo and Normal RGB 24-bit, Normal OpenGL tangent; Roughness, Metalness, Emissive 8-bit | [C][texspec] |
| FBX object count | Forum: 200 objects per FBX | [U][assetlimit] |
| Generated materials | 512×512 with normal, roughness, metalness | [C][matgen] |

### Animation publishing paths

| Path | Works for agent? | Src |
|---|---|---|
| Open Cloud `POST /assets/v1/assets`, type Animation, `.rbxm` | **Yes**, needs an API key. The documented headless path | [C][usage] [C][morecloud] |
| `AssetService:CreateAssetAsync` for KeyframeSequence | Community plugins do it with beta toggle in a local plugin; `Animation` is not in the doc's type list | [U][bulkanim] [U][cabug] |
| `Plugin:SaveSelectedToRoblox` | User dialog | [C][plugin] |
| `data.roblox.com/ide/publish/UploadNewAnimation` | Legacy cookie endpoint, deprecation planned about Jan 2026 | [C][morecloud] |
| `RegisterKeyframeSequence` / `RegisterAnimationClip` | Studio-only preview IDs | [C][ksp] [C][acp] |
| `ImportFbxAnimationAsync` | Prompts for a file | [C][plugin] |
| 3D Importer glTF animations | Studio UI | [U][gltf] |

Feeding Open Cloud: `SerializeInstancesAsync` on a KeyframeSequence produces engine-made `.rbxm` bytes, which should avoid the "edited outside Studio" warning [U]. Use `.rbxm`: `.rbxmx` with `model/x-rbxmx` returned a 400 in one report [U][morecloud]. An announcement covers sharing animations with connections and groups; its details were not read [U][animshare].

## 4. Roblox's own MCP and similar tools

### 4.1 Built-in Studio MCP

Enable under Assistant > ... > Manage MCP Servers. Local stdio via `%LOCALAPPDATA%\Roblox\mcp.bat` on Windows. Studio must be open [C][mcp].

| Group | Tools |
|---|---|
| Scripts | `script_read`, `multi_edit`, `script_search` (10 results), `script_grep` (50 results) |
| Scene | `search_game_tree`, `inspect_instance`, `execute_luau` (Edit, Client, Server) |
| Play | `get_studio_state`, `start_stop_play`, `get_console_output`, `screen_capture` |
| Input | `character_navigation`, `user_keyboard_input`, `user_mouse_input` |
| Assets | `search_asset`, `insert_asset`, `upload_image`, `store_image` |
| Generation | `generate_mesh`, `generate_material`, `generate_procedural_model`, `wait_job_finished` |
| Other | `subagent` (explore, playtest), `http_get` (Roblox docs only), `skill`, `list_roblox_studios` |

All [C][mcp].

RoLink has no equivalent for: input, generation, console output, play control (planned). The built-in server has no file mirror, build-spec language, terrain ops, undo, export/import, or Open Cloud publishing in its documented list [C][mcp].

### 4.2 Others

| Tool | What it offers | Status | Src |
|---|---|---|---|
| `Roblox/studio-rust-mcp-server` | `run_code`, `insert_model`, `get_console_output`, `start_stop_play`, `run_script_in_play_mode`, `get_studio_mode` | Archived 2026-04-03, points to built-in MCP | [C][rustmcp] |
| RbxSync | 19 tools: extract, sync, `run_test`, bot observe/move/action, harness logs, git | Active listing | [C][rbxsync] |
| robloxstudio-mcp (boshyxd) | 31-tool inspector edition listed; about 43 in full | Archived 2026-06-06; fork by Chrrxs | [C][boshy] |
| Rojo | File-first sync: scripts, `.rbxm(x)`, `.model.json`, `.meta.json`, `.toml`, `.csv`, `.txt`, `.json`, projects | Cannot live-sync Terrain, CSG, `MeshId` | [C][rojo] |
| Argon | CLI, VS Code, plugin; two-way sync of code and instances with properties; builds binary/XML; CI | Active | [C][argon] |
| Script Sync (Roblox) | Script and Folder classes only. 10,000 scripts per root, 128 roots. Team Create aware. Ignores attributes and tags; can lose data | Beta | [C][sync] |
| Lune | Luau runtime; optional library for Roblox place and model files | Active | [C][lune] |
| Rokit, Wally, selene, StyLua, luau-lsp | Toolchain, packages, lint, format, LSP | Listed by Roblox | [C][external] |
| Mantle, Asphalt, rbxcloud | Deployment, asset upload, Open Cloud CLI | Not researched | [U] |

## 5. Studio features with no plugin API

Confirmed means the relevant members were read and are Roblox-only. Unconfirmed means the pages read show only a UI and no API was found, which does not prove absence.

| Human action | Status | Evidence / nearest API |
|---|---|---|
| Publish or Save to Roblox from File menu | Confirmed no API | [C][publish]. Use Open Cloud with a built place file |
| Device emulator selection | Confirmed no API | [C][device] |
| Real keyboard, mouse, gamepad, touch in play | Confirmed no API | [C][vim] |
| Dragger snap toggles (3 props) | Confirmed no API | [C][drag] |
| Move/rotate/scale gizmo use | Equivalent by property set | `SelectRibbonTool` only activates [C][plugin] |
| Debugger from outside Studio | Script Sync docs: not controllable from an external editor | [C][sync] |
| Material Generator | Docs describe only UI; built-in MCP has `generate_material` | [C][matgen] [C][mcp] [U] |
| Texture Generator on a mesh | No API found | [U] |
| Animation Editor (timeline, IK, curves) | No editor API found; data objects are scriptable | [U] |
| Avatar Setup UI | `AutoSetupAvatarAsync` exists, plugin use unstated | [C][avatar] [U] |
| 3D Importer with its preview and settings | Only `ImportFbx*` prompts and Open Cloud Model upload | [C][plugin] [C][usage] |
| Terrain Editor brushes | Voxel APIs can reproduce results, brush UI itself no API found | [C][terrain] [U] |
| Experience Settings dialog | Partly via `PATCH` universe/place; full config is cookie-only `develop.roblox.com` | [C][universes] [C][places] |
| Allow Third Party Assets, Mesh/Image API toggles | Settings UI or Dashboard | [C][as] [C][emesh] |
| Team Create commit, session UI | Enable/membership endpoints exist; no commit API found | [C][team] [U] |
| MicroProfiler | No API found; Script Profiler has one | [C][profiler] [U] |
| Open an arbitrary local file silently | Needs a prompt or a companion | [C][studio] |
| Whole-place export to `.rbxl` | Serialization rejects services; no API found | [C][ser] [U] |

## 6. Gaps vs RoLink

Assumes the planned work lands: play-test control, file mirror of all services including GUI and any class, asset publisher, Toolbox quarantine, animations, docs. Ranked by value to a solo developer.

| # | Capability RoLink would still lack | Enabling API | Effort and risk |
|---|---|---|---|
| 1 | **Console output tool** across edit, server, client, with filters and "since" cursor | `LogService.MessageOut`, `GetLogHistory` [C][logsvc] in each DataModel | Small. Without it, agents cannot see test failures from other scripts |
| 2 | **Ship the game**: publish a version, then restart servers | `POST /universes/v1/.../versions` or `PATCH /assets/v1/assets/{id}`; `:restartServers`; version notes [C][places] [C][pubguide] [C][universes] | Medium. Plugin cannot save the place, so a `.rbxl` must come from the mirror via Lune or rbx-dom; PartOperation and SurfaceAppearance caveat [C][pubguide] |
| 3 | **Real player input** in a test: keys, mouse, GUI clicks, walking | No public API [C][vim]. Options: proxy built-in `user_*_input` tools [C][mcp]; OS `SendInput` from the native capture helper [U]; `Humanoid:MoveTo` in the client DataModel [U] | Medium. Proxying built-in MCP also covers #7 |
| 4 | **Sharing after upload**: grant Use to the universe, include dependencies, check quotas, wait on moderation | `asset-permissions`, `asset-quotas`, operations [C][ocassets] | Small if not already in the publisher. Without it, animations and audio can fail at runtime [U] |
| 5 | **Data operations**: read, edit, snapshot saves; memory store; live messages | Open Cloud storage and `publishMessage` [C][storage] [C][universes] | Small. Needs guard rails: v2 update clears omitted fields [C][storage] |
| 6 | **Live game diagnostics**: server list, logs by job, restart status | `server-management` endpoints [C][obs] | Small |
| 7 | **AI asset generation** | `GenerationService:GenerateModelAsync`, `SegmentMeshAsync` [C][gen]; `generateSpeechAsset` [C][ocassets]; `translateText` [C][genai]; built-in `generate_mesh`, `generate_material` [C][mcp] | Medium. Check `DynamicGeneration` from plugin context [U] |
| 8 | **Headless cloud runs** for CI tests and batch edits without Studio | Luau Execution [C][luau]; Instance API for script patches [C][places] | Medium. 5 tasks/min, 5 min limit |
| 9 | **Monetization setup**: create and price passes and products | `/game-passes/v1`, `/developer-products/v2` [C][passes] [C][products] | Small |
| 10 | **Performance data** | `ScriptProfilerService` [C][profiler]; `DataModel:GetJobsInfo` [C][dm]; `Stats` [U] | Medium |
| 11 | **Multi-client scenarios**, if the planned control is solo only: 1 to 8 clients, staggered joins | `ExecuteMultiplayerTestAsync`, `AddPlayers` [C][sts] | Small add-on |
| 12 | **Static analysis** on Luau before pushing | External `luau-lsp`, `selene` [C][external]; Studio lint read path not found [U] | Small |
| 13 | **Experience metadata**: name, icon, thumbnails, localization | `PATCH` universe [C][universes]; guides [C][cloudindex] | Small |
| 14 | **UGC validation** and avatar setup | `ValidateUGC*`, `AutoSetupAvatarAsync` [C][avatar] | Niche |
| 15 | **Device emulation** | None [C][device]; approximate by resizing the window [U] | Not achievable through the API |

Implementation notes for the planned work:

- Any-class mirror: use `ReflectionService` for live class and property data and `IsPropertyModified` for changed-only output [C][refl]. `plugin/tests/api.json` is a static snapshot.
- Anything unsupported falls back to `.rbxm` through `SerializationService`, which rejects services and non-creatable instances [C][ser].
- Publisher: prefer `CreateAssetAsync` for Model, Mesh, Image when RoLink is installed locally and the beta toggle allows it, since no API key is required [C][as] [U][cabug]; fall back to Open Cloud.
- Toolbox quarantine: insert with `AssetService:LoadAssetAsync` semantics or `GetObjects` plus `Sandboxed` [C][as] [C][dm]; test whether plugin code can set `Capabilities` [U]. Pre-screen with `hasScripts`, `scriptCount` [C][cstore].
- `ExecutePlay*` blocks its caller; keep the RPC loop alive in a separate thread [C][sts].

## 7. Doc conflicts to verify in practice

| Topic | Conflict | Sources |
|---|---|---|
| Audio monthly quota | 100 verified / 10 unverified, vs 2,000 verified / 100 unverified per 30 days | [C][usage] vs [C][audio] |
| Luau Execution saving | "save changes using SavePlaceAsync" vs "cannot be persisted" | [C][luau] |
| Texture max | 4096 vs 1024 | [C][texspec] |
| Video and 20 MB cap | 3.75 GB limit listed beside a 20 MB per-call cap | [C][usage] |
| Mesh triangles | 20,000 in docs; about 21k in forum; 10k on some paths | [C][meshspec] [U][tri21k] [U][assetlimit] |
| `GetTestArgs` source | Multiplayer section says readable; `GetTestArgs` names only Play and Run | [C][sts] |
| `CreateAssetAsync` in plugins | Docs: locally loaded plugins. Forum: needs beta toggle, reports of it failing | [C][as] vs [U][cabug] |
| Animation via `CreateAssetAsync` | Not in doc's list; forum shows use | [C][as] vs [U][bulkanim] |
| `.rbxmx` animation upload | Doc lists it; one report of a 400 with `model/x-rbxmx` | [C][usage] vs [U][morecloud] |
| Two publish endpoints | `POST .../versions` and `PATCH /assets/v1/assets/{placeId}` both documented | [C][places] [C][pubguide] |
| `LoadGeneratedMeshAsync` return | MeshPart vs Model with a MeshPart | [C][gen] |
| `GenerateMeshAsync` lifecycle | Forum post says the original API is being sunset; reference still lists it | [U][gen4d] [C][gen] |

[plugin]: https://create.roblox.com/docs/reference/engine/classes/Plugin.md
[chs]: https://create.roblox.com/docs/reference/engine/classes/ChangeHistoryService.md
[sel]: https://create.roblox.com/docs/reference/engine/classes/Selection.md
[ses]: https://create.roblox.com/docs/reference/engine/classes/ScriptEditorService.md
[studio]: https://create.roblox.com/docs/reference/engine/classes/StudioService.md
[sts]: https://create.roblox.com/docs/reference/engine/classes/StudioTestService.md
[runsvc]: https://create.roblox.com/docs/reference/engine/classes/RunService.md
[testsvc]: https://create.roblox.com/docs/reference/engine/classes/TestService.md
[logsvc]: https://create.roblox.com/docs/reference/engine/classes/LogService.md
[profiler]: https://create.roblox.com/docs/reference/engine/classes/ScriptProfilerService.md
[dm]: https://create.roblox.com/docs/reference/engine/classes/DataModel.md
[ser]: https://create.roblox.com/docs/reference/engine/classes/SerializationService.md
[refl]: https://create.roblox.com/docs/reference/engine/classes/ReflectionService.md
[as]: https://create.roblox.com/docs/reference/engine/classes/AssetService.md
[insert]: https://create.roblox.com/docs/reference/engine/classes/InsertService.md
[geom]: https://create.roblox.com/docs/reference/engine/classes/GeometryService.md
[mat]: https://create.roblox.com/docs/reference/engine/classes/MaterialService.md
[ksp]: https://create.roblox.com/docs/reference/engine/classes/KeyframeSequenceProvider.md
[acp]: https://create.roblox.com/docs/reference/engine/classes/AnimationClipProvider.md
[terrain]: https://create.roblox.com/docs/reference/engine/classes/Terrain.md
[cs]: https://create.roblox.com/docs/reference/engine/classes/CollectionService.md
[drag]: https://create.roblox.com/docs/reference/engine/classes/DraggerService.md
[capture]: https://create.roblox.com/docs/reference/engine/classes/CaptureService.md
[avatar]: https://create.roblox.com/docs/reference/engine/classes/AvatarCreationService.md
[gen]: https://create.roblox.com/docs/reference/engine/classes/GenerationService.md
[textgen]: https://create.roblox.com/docs/reference/engine/classes/TextGenerator.md
[tts]: https://create.roblox.com/docs/reference/engine/classes/AudioTextToSpeech.md
[emesh]: https://create.roblox.com/docs/reference/engine/classes/EditableMesh.md
[eimg]: https://create.roblox.com/docs/reference/engine/classes/EditableImage.md
[vimdoc]: https://create.roblox.com/docs/reference/engine/classes/VirtualInputManager.md
[vuser]: https://create.roblox.com/docs/reference/engine/classes/VirtualUser.md
[creatorsvc]: https://create.roblox.com/docs/reference/engine/classes/CreatorStoreService.md
[vim]: https://robloxapi.github.io/ref/class/VirtualInputManager.html
[publish]: https://robloxapi.github.io/ref/class/StudioPublishService.html
[device]: https://robloxapi.github.io/ref/class/StudioDeviceEmulatorService.html
[http]: https://create.roblox.com/docs/en-us/cloud-services/http-service.md
[pluginhttp]: https://devforum.roblox.com/t/introducing-plugin-http-permissions/493269
[scriptperm]: https://devforum.roblox.com/t/introducing-plugin-script-modification-permissions/877312
[caps]: https://create.roblox.com/docs/en-us/scripting/capabilities.md
[sandbox]: https://devforum.roblox.com/t/protect-your-games-with-script-capabilities-sandboxing/4634642
[capforum]: https://devforum.roblox.com/t/captures-apis-are-now-available/2838188?page=7
[cabug]: https://devforum.roblox.com/t/assetservice-createassetasync-and-createassetversionasync-are-broken/4527300
[bulkanim]: https://devforum.roblox.com/t/bulkanim-publisher-roblox-studio-plugin/4532642
[rate]: https://create.roblox.com/docs/en-us/cloud/reference/rate-limits.md
[apikeys]: https://create.roblox.com/docs/en-us/cloud/auth/api-keys.md
[ocassets]: https://create.roblox.com/docs/cloud/reference/features/assets.md
[usage]: https://create.roblox.com/docs/cloud/guides/usage-assets.md
[morecloud]: https://devforum.roblox.com/t/open-cloud-upload-support-for-more-asset-types/4022082
[luau]: https://create.roblox.com/docs/cloud/reference/features/luau-execution.md
[luaucap]: https://devforum.roblox.com/t/luau-execution-task-creation-has-an-undocumented-30hour-limit-per-api-key-owner-far-below-the-documented-5min/4890044
[luausess]: https://devforum.roblox.com/t/allow-the-creation-of-luau-execution-sessions/4221716
[places]: https://create.roblox.com/docs/cloud/reference/features/places.md
[pubguide]: https://create.roblox.com/docs/cloud/guides/usage-place-publishing.md
[placefiles]: https://create.roblox.com/docs/projects/place-files
[universes]: https://create.roblox.com/docs/cloud/reference/features/universes.md
[obs]: https://create.roblox.com/docs/cloud/reference/features/observability.md
[msg]: https://create.roblox.com/docs/cloud/guides/usage-messaging.md
[storage]: https://create.roblox.com/docs/cloud/reference/features/storage.md
[passes]: https://create.roblox.com/docs/cloud/reference/features/game-passes.md
[products]: https://create.roblox.com/docs/cloud/reference/features/developer-products.md
[cstore]: https://create.roblox.com/docs/cloud/reference/features/creator-store.md
[thumbs]: https://create.roblox.com/docs/cloud/reference/features/thumbnails.md
[inv]: https://create.roblox.com/docs/cloud/reference/features/inventories.md
[team]: https://create.roblox.com/docs/cloud/reference/features/team-create.md
[genai]: https://create.roblox.com/docs/cloud/reference/features/generative-ai.md
[cloudindex]: https://create.roblox.com/docs/cloud/llms.txt
[audio]: https://create.roblox.com/docs/en-us/audio/assets.md
[meshspec]: https://create.roblox.com/docs/en-us/art/modeling/specifications.md
[texspec]: https://create.roblox.com/docs/en-us/art/modeling/texture-specifications.md
[matgen]: https://create.roblox.com/docs/studio/material-generator
[tri21k]: https://devforum.roblox.com/t/whats-roblox-current-mesh-triangle-limit/2414597
[assetlimit]: https://devforum.roblox.com/t/what-are-the-limitations-to-modeling-and-importing-to-roblox/2453057
[gltf]: https://devforum.roblox.com/t/3d-importer-gltf-file-support-full-release/2584034?page=2
[animshare]: https://devforum.roblox.com/t/sharing-animation-assets-with-connections-and-groups/3892540
[gen4d]: https://devforum.roblox.com/t/beta-4d-generation-unlock-new-types-of-gameplay/4331818
[mcp]: https://create.roblox.com/docs/studio/mcp.md
[rustmcp]: https://github.com/Roblox/studio-rust-mcp-server
[rbxsync]: https://docs.rbxsync.dev/mcp/tools
[boshy]: https://github.com/boshyxd/robloxstudio-mcp
[rojo]: https://rojo.space/docs/v7/sync-details/
[argon]: https://github.com/argon-rbx/argon
[sync]: https://create.roblox.com/docs/en-us/scripting/sync.md
[lune]: https://github.com/lune-org/lune
[external]: https://create.roblox.com/docs/en-us/projects/external-tools.md
