#!/usr/bin/env node
// RoLink MCP server (stdio). Owns the Studio bridge port, or — when another
// RoLink process already does — forwards every tool call to it.

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge } from "./bridge.js";
import { HOST, PORT, SERVER_DIR, VERSION, log } from "./config.js";
import { Core, type ToolResult } from "./core.js";

const bridge = new Bridge();
let core: Core | undefined;

async function ensureOwner(): Promise<boolean> {
  if (core) return true;
  if (await bridge.listen()) {
    core = new Core(bridge);
    bridge.rpcHandler = (tool, args) => core!.call(tool, args as any);
    return true;
  }
  return false;
}

async function callTool(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (core) return core.call(tool, args);
  try {
    const r = await fetch(`http://${HOST}:${PORT}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
    });
    const body = (await r.json()) as { ok: boolean; result?: ToolResult; error?: string };
    if (!body.ok) throw new Error(body.error ?? "rpc failed");
    return body.result!;
  } catch (e: any) {
    // the owning process went away: take the port over
    if (e?.cause?.code === "ECONNREFUSED" && (await ensureOwner())) return core!.call(tool, args);
    throw e;
  }
}

const GUIDE_FILE = path.resolve(SERVER_DIR, "..", "docs", "BUILD_FORMAT.md");

const INSTRUCTIONS = `RoLink drives a live Roblox Studio (edit mode) — changes appear instantly, no play/restart needed, and every write is one undo step (Ctrl+Z in Studio or the undo tool).

Paths: "Workspace/Map/Tower", "Workspace/Wall[2]" (2nd same-named child), "#42" (id from earlier results), "@selection".

Workflow for quality builds: look first (status → tree → screenshot), build in small named batches with the build tool (JSON, local coordinates), then VERIFY with screenshot (views: iso/front/top…) and fix. Call the guide tool once before your first build — it documents the node format (at/rot/size/color/material, repeat, mirror, span, csg, refs).
Scale: character ≈5 studs tall, door 4×7, floor-to-ceiling 10–14, walkway ≥6. Snap to 0.25/0.5 studs. Name everything.
Code: use sync_start on a project folder (Rojo-style *.project.json) — files are pushed to Studio on save, Studio edits come back to files. Use run for one-off Luau in Studio (edit mode).`;

const server = new McpServer({ name: "rolink", version: VERSION }, { instructions: INSTRUCTIONS });

const target = {
  place: z.string().optional().describe("Studio place name (substring) when several Studios are open"),
  context: z.enum(["edit", "server", "client"]).optional().describe("Which DataModel: edit (default) or a running play-test's server/client"),
};
const pathArg = z.union([z.string(), z.array(z.string())]);

function reg(name: string, description: string, shape: Record<string, z.ZodTypeAny>, readOnly = false) {
  server.registerTool(
    name,
    { description, inputSchema: { ...shape, ...target }, annotations: { readOnlyHint: readOnly } },
    async (args: Record<string, unknown>) => {
      try {
        const r = await callTool(name, args);
        const content: any[] = [{ type: "text", text: r.text }];
        for (const img of r.images ?? []) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        return { content };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true };
      }
    },
  );
}

server.registerTool(
  "guide",
  { description: "RoLink build-spec format and modelling rules. Read once before building.", annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: fs.existsSync(GUIDE_FILE) ? fs.readFileSync(GUIDE_FILE, "utf8") : "guide missing" }] }),
);

reg("status", "Connected Studio sessions and sync state.", {}, true);

reg(
  "tree",
  "Outline of the instance tree (compact text). Same-named siblings collapse to ×N. Shows sizes/positions of parts and models, part counts, script line counts and #ids.",
  {
    path: pathArg.optional().describe('Root(s), default "Workspace". E.g. "ReplicatedStorage", "@selection"'),
    depth: z.number().int().optional().describe("Levels below the root (default 2)"),
    maxNodes: z.number().int().optional().describe("Node budget (default 400)"),
    classes: z.array(z.string()).optional().describe("Only show these classes (IsA), plus containers"),
  },
  true,
);

reg(
  "inspect",
  "Full description of instance(s) in the build-spec format (only non-default properties; children relative to the parent's frame). The output can be edited and fed back to build.",
  {
    path: pathArg.describe("Target(s)"),
    depth: z.number().int().optional(),
    maxNodes: z.number().int().optional().describe("Default 1500"),
    source: z.boolean().optional().describe("Include script sources"),
    props: z.enum(["changed", "none"]).optional(),
  },
  true,
);

reg(
  "get",
  "All property values of one instance (or only the listed ones), plus attributes, tags and script Source.",
  { path: z.string(), props: z.array(z.string()).optional(), source: z.boolean().optional() },
  true,
);

reg(
  "find",
  "Search descendants. All filters combine. Returns paths, ids, sizes/positions; with `text`, matching script lines.",
  {
    root: pathArg.optional().describe("Default Workspace; use \"game\" for everything"),
    class: z.string().optional().describe("IsA filter, e.g. BasePart, Model, LuaSourceContainer"),
    exactClass: z.string().optional(),
    name: z.string().optional().describe("Case-insensitive substring; starting with ^ = Lua pattern"),
    tag: z.string().optional(),
    attr: z.string().optional(),
    attrValue: z.any().optional(),
    text: z.string().optional().describe("Script source contains this text"),
    near: z.array(z.number()).optional().describe("[x,y,z] point; use with radius"),
    radius: z.number().optional(),
    within: z.object({ min: z.array(z.number()), max: z.array(z.number()) }).optional(),
    limit: z.number().int().optional().describe("Default 100"),
  },
  true,
);

reg(
  "build",
  `Create instances from build-spec JSON (see the guide tool). Atomic: on error nothing is created. Node essentials:
{"class":"Model","name":"Tower","children":[{"name":"Base","size":[8,1,8],"at":[0,0.5,0],"color":"#5a5f66","material":"Concrete"}]}
at/rot are LOCAL to the parent node's frame (rot = degrees). Extras: repeat {count,step,rotStep}, mirror "x"|["x","z"], span [[a],[b]] + thickness, csg {op:"subtract",with:[nodes]}, mesh, asset, primary, refs {"ref":"./Base"}, any Roblox property as PascalCase key.`,
  {
    items: z.any().describe("Array of nodes (or one node)"),
    parent: z.string().optional().describe('Parent path, default "Workspace"'),
    origin: z.any().optional().describe('World frame for top-level items: {"p":[x,y,z],"r":[rx,ry,rz]}'),
    defaults: z.record(z.string(), z.any()).optional().describe('Applied to every new part, e.g. {"material":"SmoothPlastic"}'),
    replace: z.boolean().optional().describe("Replace same-named existing children of parent (iterate on a model)"),
    select: z.boolean().optional().describe("Select the result in Studio (default true)"),
  },
);

reg(
  "set",
  "Change properties / attributes / tags / name / Source of existing instances. Use `edits` for different changes on several targets.",
  {
    path: pathArg.optional(),
    props: z.record(z.string(), z.any()).optional().describe('e.g. {"Color":"#ff0000","Material":"Neon","Transparency":0.2}'),
    attrs: z.record(z.string(), z.any()).optional(),
    tags: z.array(z.string()).optional(),
    untag: z.array(z.string()).optional(),
    name: z.string().optional(),
    source: z.string().optional().describe("New script Source"),
    edits: z.array(z.any()).optional().describe("[{path, props?, attrs?, tags?, untag?, name?, source?}]"),
  },
);

reg("delete", "Destroy instances.", { paths: pathArg });

reg(
  "clone",
  "Duplicate an instance. With count+offset makes a row of copies.",
  {
    path: z.string(),
    parent: z.string().optional(),
    count: z.number().int().optional(),
    offset: z.array(z.number()).optional().describe("World offset between copies [x,y,z]"),
    cframe: z.any().optional(),
    name: z.string().optional().describe('"Lamp%d" numbers the copies'),
  },
);

reg(
  "move",
  "Move/rotate/reparent models and parts by their pivot.",
  {
    paths: pathArg,
    to: z.any().optional().describe("Absolute pivot CFrame {p,r}"),
    position: z.array(z.number()).optional().describe("Keep rotation, set position"),
    by: z.array(z.number()).optional().describe("World offset"),
    rotate: z.array(z.number()).optional().describe("Extra rotation in degrees around own pivot"),
    orientation: z.array(z.number()).optional().describe("Absolute orientation in degrees"),
    ground: z.boolean().optional().describe("Drop so the bottom rests on whatever is below"),
    parent: z.string().optional(),
  },
);

reg(
  "run",
  "Run Luau in Studio (plugin context, edit mode by default — or a play-test with context). print/warn are captured; return values are returned. `args` is available as a global. One undo step.",
  {
    code: z.string(),
    args: z.any().optional(),
    timeout: z.number().optional().describe("Seconds, default 60"),
  },
);

reg("selection", "Get Studio's current selection, or set it (also highlights things for the user).", { set: pathArg.optional() });

reg("undo", "Undo (or redo) the last Studio change(s).", { steps: z.number().int().optional(), redo: z.boolean().optional() });

reg(
  "screenshot",
  "Look at the scene: frames the camera and captures Studio's 3D viewport. Studio must be visible (not minimized). Several views → several images. The user's camera is restored afterwards.",
  {
    targets: pathArg.optional().describe("What to frame. Omit with no view = current camera; omit with a view = whole Workspace"),
    view: z.string().optional().describe("front | back | left | right | top | bottom | iso | iso_back | iso_left | bird | current"),
    views: z.array(z.string()).optional().describe('Several views, e.g. ["front","iso","top"]'),
    position: z.array(z.number()).optional().describe("Explicit camera position (with lookAt)"),
    lookAt: z.array(z.number()).optional(),
    cframe: z.any().optional(),
    distance: z.number().optional().describe("Multiplier on the auto-fit distance (0.6 = closer)"),
    fov: z.number().optional(),
    maxWidth: z.number().int().optional().describe("Default 1280"),
    restore: z.boolean().optional().describe("Restore the camera afterwards (default true)"),
    hideSelection: z.boolean().optional(),
  },
  true,
);

reg("camera", "Read the Studio camera, or move it (set = same options as screenshot).", { set: z.any().optional() });

reg(
  "terrain",
  "Sculpt Terrain. ops: [{op:\"block\",cf,size,material} | {op:\"ball\",center,radius,material} | {op:\"cylinder\",cf,height,radius,material} | {op:\"wedge\",cf,size,material} | {op:\"replace\",min,max,from,to} | {op:\"clear\",min?,max?}]",
  { ops: z.array(z.any()) },
);

reg(
  "export",
  "Save an instance from Studio to a file: .model.json (readable build spec, version-control friendly) or .rbxm (exact binary copy incl. unions/meshes). Relative paths are inside the synced project.",
  {
    path: z.string(),
    file: z.string(),
    format: z.enum(["json", "rbxm"]).optional(),
    keepPosition: z.boolean().optional().describe("JSON: keep the world origin (default true)"),
  },
);

reg(
  "import",
  "Load a .model.json or .rbxm file into Studio.",
  {
    file: z.string(),
    parent: z.string().optional(),
    replace: z.boolean().optional(),
    cframe: z.any().optional().describe("Place it here"),
  },
);

reg(
  "import_model",
  `Import a 3D model file from this PC (.obj/.gltf/.glb/.stl; .fbx only in upload mode) into Studio, visible immediately.
mode "preview": parsed locally and built from EditableMesh MeshParts (no account needed, material colors only, NOT saved with the place).
mode "upload": uploaded via Roblox Open Cloud (needs ROBLOX_API_KEY + ROBLOX_CREATOR_USER_ID/GROUP_ID on the server), then inserted — persistent, keeps textures.
mode "auto" (default): upload if a key is configured, else preview. One undo step.`,
  {
    path: z.string().describe("Absolute path of the model file on this PC"),
    parent: z.string().optional().describe('Parent path, default "Workspace"'),
    name: z.string().optional().describe("Model name (default: file name)"),
    scale: z.number().optional().describe("Uniform scale factor (file units → studs), default 1"),
    fitSize: z.number().optional().describe("Scale so the largest dimension is this many studs (overrides scale)"),
    position: z.array(z.number()).optional().describe("[x,y,z] world position of the model's bottom-center (default: origin)"),
    anchored: z.boolean().optional().describe("Default true"),
    mode: z.enum(["auto", "preview", "upload"]).optional(),
    flipFaces: z.boolean().optional().describe("Preview: reverse triangle winding if the model looks inside-out"),
  },
);

reg(
  "sync_start",
  "Start live file sync for a project folder (Rojo-compatible *.project.json). Pushes everything now, then every file save; scripts edited in Studio are written back.",
  { project: z.string().describe("Project folder or *.project.json path") },
);
reg("sync_stop", "Stop file sync.", {});
reg("sync_status", "Sync state and recent sync activity.", {}, true);

async function main() {
  if (process.argv.includes("--daemon")) {
    // bridge only (no stdio MCP): `npm run serve`; MCP processes will proxy to it
    if (!(await ensureOwner())) {
      log(`port ${PORT} is already in use`);
      process.exit(1);
    }
    return;
  }
  if (!(await ensureOwner())) {
    try {
      const r = await fetch(`http://${HOST}:${PORT}/health`);
      const h = (await r.json()) as { rolink?: boolean };
      if (!h.rolink) throw new Error("not rolink");
      log(`another RoLink process owns port ${PORT}; forwarding calls to it`);
    } catch {
      log(`port ${PORT} is busy and not a RoLink server — set ROLINK_PORT`);
    }
  }
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log("fatal", e);
  process.exit(1);
});
