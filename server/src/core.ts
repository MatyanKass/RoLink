// Tool implementations. Runs in whichever RoLink process owns the bridge port;
// other processes forward calls here through POST /rpc.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Bridge, type Context, type SessionInfo } from "./bridge.js";
import { getApi } from "./apidump.js";
import { log } from "./config.js";
import { captureStudio, cropToMarkers, downscale, toJpeg } from "./screenshot.js";
import { Project, SyncSession, findProjectFile } from "./sync.js";
import { randomUUID } from "node:crypto";
import { PREVIEW_EXTS, UPLOAD_EXTS, loadModel, prepareChunks, validateModelPath } from "./meshimport.js";
import { uploadConfig, uploadModel } from "./assetupload.js";

export interface ImageOut {
  data: string; // base64
  mimeType: string;
  label: string;
}
export interface ToolResult {
  text: string;
  images?: ImageOut[];
}

type Args = Record<string, any>;

export class Core {
  readonly bridge: Bridge;
  private sync?: SyncSession;
  private shotLock = Promise.resolve();

  constructor(bridge: Bridge) {
    this.bridge = bridge;
    bridge.apiProvider = () => getApi();
    bridge.on("plugin-event", (s: SessionInfo, ev: any) => {
      if (this.sync && s.context === "edit" && (ev.type === "source" || ev.type === "created")) {
        this.sync.onPluginEvent(ev).catch((e) => log("sync event failed", e));
      }
    });
    bridge.on("session", (s: SessionInfo) => {
      // Studio reconnected (or was reopened): push the project again
      if (this.sync && s.context === "edit" && s.placeName === this.sync.placeName) {
        setTimeout(() => this.sync?.fullSync().catch((e) => log("resync failed", e.message)), 500);
      }
    });
    getApi().catch((e) => log("API dump unavailable:", e.message));
  }

  private session(args: Args): SessionInfo {
    return this.bridge.pick((args.context as Context) ?? "edit", args.place);
  }

  private async op(args: Args, op: string, payload: unknown, timeoutMs?: number) {
    const s = this.session(args);
    return this.bridge.send(s.id, op, payload, timeoutMs);
  }

  async call(tool: string, args: Args = {}): Promise<ToolResult> {
    switch (tool) {
      case "status":
        return this.status();
      case "tree":
        return { text: renderTree(await this.op(args, "tree", pick(args, ["path", "depth", "maxNodes", "classes"]))) };
      case "inspect":
        return json(await this.op(args, "inspect", pick(args, ["path", "depth", "maxNodes", "source", "props"])));
      case "get":
        return json(await this.op(args, "get", pick(args, ["path", "props", "source"])));
      case "find":
        return json(
          await this.op(
            args,
            "find",
            pick(args, ["root", "class", "exactClass", "name", "tag", "attr", "attrValue", "text", "near", "radius", "within", "limit"]),
          ),
        );
      case "build":
        return json(
          await this.op(args, "build", pick(args, ["parent", "items", "origin", "defaults", "replace", "select"]), 180_000),
        );
      case "set":
        return json(await this.op(args, "set", pick(args, ["edits", "path", "props", "attrs", "tags", "untag", "name", "source"])));
      case "delete":
        return json(await this.op(args, "delete", { paths: args.paths ?? args.path }));
      case "clone":
        return json(await this.op(args, "clone", pick(args, ["path", "parent", "count", "offset", "cframe", "name"])));
      case "move":
        return json(
          await this.op(args, "move", pick(args, ["paths", "path", "to", "position", "by", "rotate", "orientation", "ground", "parent"])),
        );
      case "run":
        return this.run(args);
      case "selection":
        return json(await this.op(args, "selection", pick(args, ["set"])));
      case "undo":
        return json(await this.op(args, args.redo ? "redo" : "undo", { steps: args.steps ?? 1 }));
      case "terrain":
        return json(await this.op(args, "terrain", { ops: args.ops }, 120_000));
      case "camera":
        return json(await this.op(args, "camera", { set: args.set }));
      case "screenshot":
        return this.screenshot(args);
      case "export":
        return this.exportModel(args);
      case "import":
        return this.importFile(args);
      case "import_model":
        return this.importModel(args);
      case "sync_start":
        return this.syncStart(args);
      case "sync_stop":
        return this.syncStop();
      case "sync_status":
        return json(this.sync ? this.sync.status() : { active: false });
    }
    throw new Error(`unknown tool ${tool}`);
  }

  private status(): ToolResult {
    const sessions = this.bridge.list();
    const lines = [`RoLink bridge on port ${process.env.ROLINK_PORT ?? 34872}.`];
    if (sessions.length === 0) {
      lines.push("No Studio connected. Open a place in Roblox Studio; the RoLink plugin connects automatically (toolbar RoLink → panel → Connect).");
    } else {
      for (const s of sessions)
        lines.push(`• ${s.placeName} [${s.context}] placeId=${s.placeId} plugin v${s.pluginVersion} (last poll ${Math.round((Date.now() - s.lastSeen) / 1000)}s ago)`);
    }
    if (this.sync) {
      const st = this.sync.status();
      lines.push(`Sync: ${st.project} (${st.root}) → ${st.place}, ${st.items} items`);
    } else lines.push("Sync: off");
    return { text: lines.join("\n") };
  }

  private async run(args: Args): Promise<ToolResult> {
    const r = await this.op(args, "run", { code: args.code, args: args.args }, (args.timeout ?? 60) * 1000);
    const parts: string[] = [];
    if (r.output?.length) parts.push("output:\n" + r.output.join("\n"));
    if (r.ok) parts.push("returns: " + JSON.stringify(r.returns ?? []));
    else parts.push("ERROR: " + r.error);
    return { text: parts.join("\n\n") };
  }

  private async screenshot(args: Args): Promise<ToolResult> {
    // one capture at a time: they all move the same camera
    const prev = this.shotLock;
    let release!: () => void;
    this.shotLock = new Promise((r) => (release = r));
    await prev;
    try {
      return await this.screenshotInner(args);
    } finally {
      release();
    }
  }

  private async screenshotInner(args: Args): Promise<ToolResult> {
    const s = this.session(args);
    const views: string[] = args.cframe || args.position ? ["custom"] : (args.views ?? [args.view ?? (args.targets ? "iso" : "current")]);
    const maxW = Math.min(args.maxWidth ?? 1280, 2560);
    const images: ImageOut[] = [];
    const notes: string[] = [];
    let restore: unknown;
    try {
      for (const view of views) {
        const prep = await this.bridge.send(
          s.id,
          "shot_prepare",
          {
            targets: args.targets,
            view: view === "custom" ? undefined : view,
            cframe: args.cframe,
            position: args.position,
            lookAt: args.lookAt,
            distance: args.distance,
            fov: args.fov,
            hideSelection: args.hideSelection,
          },
          30_000,
        );
        restore ??= prep.prev;
        const shot = await captureStudio(s.placeName);
        const crop = cropToMarkers(shot.image);
        if (!crop.found) notes.push(`${view}: viewport markers not found, returning the whole Studio window`);
        const img = downscale(crop.image, maxW, Math.round(maxW * 0.75));
        images.push({ data: toJpeg(img).toString("base64"), mimeType: "image/jpeg", label: `${view} ${img.width}×${img.height}` });
      }
    } finally {
      await this.bridge.send(s.id, "shot_finish", { prev: restore, restore: args.restore !== false }, 15_000).catch(() => {});
    }
    return { text: [`${images.length} screenshot(s): ${images.map((i) => i.label).join(", ")}`, ...notes].join("\n"), images };
  }

  private resolveFile(file: string) {
    if (path.isAbsolute(file)) return file;
    const base = this.sync?.project.root;
    if (!base) throw new Error("relative file path needs an active sync project (or pass an absolute path)");
    return path.resolve(base, file);
  }

  private async exportModel(args: Args): Promise<ToolResult> {
    const file = this.resolveFile(args.file);
    const format = args.format ?? (file.endsWith(".rbxm") ? "rbxm" : "json");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (format === "rbxm") {
      const r = await this.op(args, "export_rbxm", { path: args.path }, 120_000);
      await fsp.writeFile(file, Buffer.from(r.data, "base64"));
      return { text: `wrote ${file} (${r.bytes} bytes, exact binary copy)` };
    }
    const r = await this.op(args, "inspect", { path: args.path, maxNodes: 100_000, source: true }, 120_000);
    const node = r.nodes[0];
    for (const k of ["path", "id", "bounds", "instances"]) delete node[k];
    if (args.keepPosition === false) delete node.origin;
    await fsp.writeFile(file, JSON.stringify(node, null, 2) + "\n", "utf8");
    const opaque = JSON.stringify(node).includes('"opaque":true');
    return {
      text:
        `wrote ${file} (${r.nodes[0] ? "1 root" : "nothing"}${r.truncated ? ", TRUNCATED" : ""})` +
        (opaque ? "\nnote: contains Unions/CSG parts whose geometry JSON can't hold — export as .rbxm for an exact copy" : ""),
    };
  }

  private async importFile(args: Args): Promise<ToolResult> {
    const file = this.resolveFile(args.file);
    if (file.endsWith(".rbxm")) {
      const data = (await fsp.readFile(file)).toString("base64");
      return json(await this.op(args, "import_rbxm", { data, parent: args.parent, replace: args.replace, cframe: args.cframe }, 120_000));
    }
    const node = JSON.parse(await fsp.readFile(file, "utf8"));
    if (args.cframe) {
      if (node.class === "Model" || node.children) node.origin = args.cframe;
      else node.cf = args.cframe;
    }
    return json(await this.op(args, "build", { parent: args.parent, items: [node], replace: args.replace }, 180_000));
  }

  private async importModel(args: Args): Promise<ToolResult> {
    const mode: string = args.mode ?? "auto";
    if (!["auto", "preview", "upload"].includes(mode)) throw new Error(`mode must be auto | preview | upload`);
    const cfg = uploadConfig();
    const useUpload = mode === "upload" || (mode === "auto" && !!cfg);
    const v = validateModelPath(args.path, useUpload ? UPLOAD_EXTS : [...PREVIEW_EXTS, ".fbx"]);
    if (!useUpload && v.ext === ".fbx")
      throw new Error(".fbx can only be imported via upload mode: set ROBLOX_API_KEY and ROBLOX_CREATOR_USER_ID (or ROBLOX_CREATOR_GROUP_ID) for the RoLink server, or convert to .glb/.obj");
    const name: string = args.name ?? path.basename(v.file, v.ext);
    const s = this.session(args);
    const common = { parent: args.parent, name, position: args.position, anchored: args.anchored ?? true, scale: args.scale, fitSize: args.fitSize };

    if (useUpload) {
      if (!cfg) throw new Error("upload mode needs ROBLOX_API_KEY and ROBLOX_CREATOR_USER_ID or ROBLOX_CREATOR_GROUP_ID in the RoLink server environment");
      const up = await uploadModel(cfg, v.file, v.ext, name, { timeoutMs: 180_000 });
      const r = await this.bridge.send(s.id, "insert_asset", { ...common, assetId: up.assetId }, 120_000);
      return json({ mode: "upload", assetId: up.assetId, ...r });
    }

    const groups = await loadModel(v.file, v.ext);
    const prep = prepareChunks(groups, { scale: args.scale, fitSize: args.fitSize, flipFaces: args.flipFaces });
    const importId = randomUUID();
    try {
      // stage chunks one per command (keeps each poll response ~1 MB), then build in one undo step
      for (let i = 0; i < prep.chunks.length; i++)
        await this.bridge.send(s.id, "mesh_stage", { importId, index: i + 1, chunk: prep.chunks[i] }, 60_000);
      const r = await this.bridge.send(s.id, "mesh_build", { ...common, importId, count: prep.chunks.length, size: prep.size }, 300_000);
      return json({
        mode: "preview",
        ...r,
        parts: prep.chunks.length,
        triangles: prep.triangles,
        vertices: prep.vertices,
        size: prep.size.map((x) => +x.toFixed(3)),
        scale: +prep.scale.toPrecision(6),
        note: "Preview parts are EditableMesh-based and are NOT saved with the place. Use mode=upload (Open Cloud key) for a persistent asset.",
      });
    } catch (e) {
      await this.bridge.send(s.id, "mesh_discard", { importId }, 15_000).catch(() => {});
      throw e;
    }
  }

  private async syncStart(args: Args): Promise<ToolResult> {
    const dir = path.resolve(args.project);
    const projectFile = fs.existsSync(dir) && fs.statSync(dir).isFile() ? dir : findProjectFile(dir);
    if (!projectFile) throw new Error(`no *.project.json in ${dir}`);
    const s = this.session(args);
    if (this.sync) await this.sync.stop();
    let api;
    try {
      api = await getApi();
    } catch {}
    const project = new Project(projectFile, api);
    const send = (op: string, payload: unknown, t?: number) => {
      const cur = this.bridge.pick("edit", s.placeName);
      return this.bridge.send(cur.id, op, payload, t);
    };
    this.sync = new SyncSession(project, send, s.placeName);
    try {
      const res = await this.sync.start();
      return json({ syncing: projectFile, place: s.placeName, ...res });
    } catch (e) {
      this.sync = undefined;
      throw e;
    }
  }

  private async syncStop(): Promise<ToolResult> {
    if (!this.sync) return { text: "sync was not running" };
    await this.sync.stop();
    this.sync = undefined;
    return { text: "sync stopped" };
  }
}

function pick(a: Args, keys: string[]) {
  const o: Args = {};
  for (const k of keys) if (a[k] !== undefined) o[k] = a[k];
  return o;
}

function json(v: unknown): ToolResult {
  return { text: JSON.stringify(v) };
}

// ------------------------------------------------------------ tree rendering

const fmtV = (v?: number[]) => (v ? v.map((x) => +x.toFixed(2)).join("×") : "");
const fmtP = (v?: number[]) => (v ? `(${v.map((x) => +x.toFixed(1)).join(", ")})` : "");

function renderTree(r: { roots: any[]; nodes: number }): string {
  const lines: string[] = [];
  const visit = (n: any, indent: string) => {
    let line = `${indent}${n.n} [${n.c}]`;
    if (n.x) line += ` ×${n.x}`;
    if (n.s) line += ` ${fmtV(n.s)}`;
    if (n.p) line += ` @${fmtP(n.p)}`;
    if (n.parts !== undefined) line += ` ${n.parts} parts`;
    if (n.lines) line += ` ${n.lines} lines`;
    if (!n.ch && n.k) line += ` (+${n.k} children)`;
    line += `  #${n.id}`;
    lines.push(line);
    if (n.ch) {
      for (const c of n.ch) visit(c, indent + "  ");
      if (n.cut) lines.push(`${indent}  … (node budget reached)`);
    }
  };
  for (const r0 of r.roots) {
    lines.push(`== ${r0.path}`);
    visit(r0, "");
  }
  lines.push(`(${r.nodes} nodes; "#id" can be used as a path; same-name siblings collapse to "×N")`);
  return lines.join("\n");
}
