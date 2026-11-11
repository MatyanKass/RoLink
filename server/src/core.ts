// Tool implementations. Runs in whichever RoLink process owns the bridge port;
// other processes forward calls here through POST /rpc.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Bridge, PluginError, type Context, type SessionBinding, type SessionInfo } from "./bridge.js";
import { getApi } from "./apidump.js";
import { POLL_HOLD_MS, log } from "./config.js";
import { type Image, captureStudio, cropToMarkers, downscale, toJpeg } from "./screenshot.js";
import { Project, SyncSession, findProjectFile } from "./sync.js";
import { DEFAULT_SERVICES, MirrorSession, projectServices } from "./mirror.js";
import { randomUUID } from "node:crypto";
import { PREVIEW_EXTS, UPLOAD_EXTS, loadModel, prepareChunks, validateModelPath } from "./meshimport.js";
import { uploadConfig, uploadModel } from "./assetupload.js";
import { Playtests } from "./playtest.js";
import { toolboxInsert, toolboxRelease, toolboxSearch } from "./toolbox.js";
import { importAnimation } from "./animation.js";
import { editorTool } from "./editor.js";

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
  private syncBinding?: SessionBinding;
  private mirror?: MirrorSession;
  private mirrorBinding?: SessionBinding;
  private shotLock = Promise.resolve();
  private readonly playtests: Playtests;

  constructor(
    bridge: Bridge,
    private readonly api: () => Promise<unknown> = getApi,
    /** the Studio window grab; replaced in tests */
    private readonly capture: (titleHint: string) => Promise<{ image: Image; title: string }> = captureStudio,
  ) {
    this.bridge = bridge;
    this.playtests = new Playtests(bridge);
    bridge.apiProvider = () => this.api();
    const boundTo = (b: SessionBinding | undefined, s: SessionInfo) => !!b && this.bridge.isBound(b, s.id);
    bridge.on("plugin-event", (s: SessionInfo, ev: any) => {
      if (ev.type === "mirror_delta" && this.mirror && boundTo(this.mirrorBinding, s)) this.mirror.onDelta(ev);
      if (this.sync && boundTo(this.syncBinding, s) && (ev.type === "source" || ev.type === "created")) {
        this.sync.onPluginEvent(ev).catch((e) => log("sync event failed", e));
      }
    });
    bridge.on("session", (s: SessionInfo) => {
      if (this.mirror && boundTo(this.mirrorBinding, s)) {
        setTimeout(() => this.mirror?.resync().catch((e) => log("mirror resync failed", e.message)), 500);
      }
      // Studio reconnected: push the project again
      if (this.sync && boundTo(this.syncBinding, s)) {
        setTimeout(() => this.sync?.fullSync().catch((e) => log("resync failed", e.message)), 500);
      }
    });
    this.api().catch((e) => log("API dump unavailable:", e.message));
  }

  private session(args: Args): SessionInfo {
    return this.bridge.pick((args.context as Context) ?? "edit", args.place);
  }

  private async op(args: Args, op: string, payload: unknown, timeoutMs?: number) {
    const s = this.session(args);
    return this.bridge.send(s.id, op, payload, timeoutMs);
  }

  /**
   * One session for every step of a multi-step tool (staged chunks, then a build): picked
   * once, so a newer Studio connecting halfway cannot receive the rest of the steps.
   */
  private pinned(args: Args) {
    let s: SessionInfo | undefined;
    return (op: string, payload: unknown, timeoutMs?: number) => {
      s ??= this.session(args);
      return this.bridge.send(s.id, op, payload, timeoutMs);
    };
  }

  /**
   * Every tool result carries what the mirror has to say: edits that are on disk but not in
   * Studio (each time, until they land) and one-time notices such as conflicts.
   */
  async call(tool: string, args: Args = {}): Promise<ToolResult> {
    try {
      const r = await this.callTool(tool, args);
      const w = this.mirrorWarnings();
      return w.length ? { ...r, text: `${r.text}\n\n${w.join("\n")}` } : r;
    } catch (e: any) {
      const w = this.mirrorWarnings();
      if (w.length && e instanceof Error) e.message = `${e.message}\n\n${w.join("\n")}`;
      throw e;
    }
  }

  private mirrorWarnings(): string[] {
    const m = this.mirror;
    if (!m) return [];
    const out = m.takeAlerts().map((a) => `WARNING (mirror): ${a}`);
    const pending = m.pendingWarning();
    if (pending) {
      const studio = this.mirrorStudio();
      out.push(`WARNING (mirror): ${pending}${studio.connected ? "" : ` ${studio.note}`}`);
    }
    return out;
  }

  /** Whether the Studio the mirror is bound to is connected now, and under which name. */
  private mirrorStudio(): { connected: boolean; placeName?: string; placeId?: number; note?: string } {
    if (!this.mirrorBinding) return { connected: false };
    try {
      const s = this.bridge.resolve(this.mirrorBinding);
      return { connected: true, placeName: s.placeName, placeId: s.placeId };
    } catch {
      const others = this.bridge.list().filter((s) => s.context === "edit" && !s.duplicate);
      return {
        connected: false,
        note:
          `The Studio this mirror was started on ("${this.mirrorBinding.placeName}") is not connected.` +
          (others.length ? ` Connected now: ${others.map((s) => `"${s.placeName}"`).join(", ")}; the mirror does not move to another Studio by itself.` : "") +
          " If it does not come back, copy what you need, then mirror_stop and mirror_start (the restart moves the mirror's own files to .rolink-trash).",
      };
    }
  }

  private async callTool(tool: string, args: Args): Promise<ToolResult> {
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
        return json(await this.op(args, "set", clearNullRefs(pick(args, ["edits", "path", "props", "attrs", "tags", "untag", "name", "source"]))));
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
      case "toolbox_search":
        return toolboxSearch(args, this.pinned(args));
      case "toolbox_insert":
        return toolboxInsert(args, this.pinned(args));
      case "toolbox_release":
        return toolboxRelease(args, this.pinned(args));
      case "import_animation":
        return importAnimation(args, this.pinned(args));
      case "sync_start":
        return this.syncStart(args);
      case "sync_stop":
        return this.syncStop();
      case "sync_status":
        return json(this.sync ? this.sync.status() : { active: false });
      case "mirror_start":
        return this.mirrorStart(args);
      case "mirror_stop":
        return this.mirrorStop();
      case "mirror_status":
        return json(this.mirror ? { ...this.mirror.status(), studio: this.mirrorStudio() } : { active: false });
      case "playtest_start":
        return json(await this.playtests.start(args));
      case "playtest_stop":
        return json(await this.playtests.stop(args));
      case "playtest_status":
        return json(await this.playtests.status(args));
      case "playtest_scenario":
        return json(await this.playtests.scenario(args));
      case "output_read":
        return json(await this.playtests.outputRead(args));
      case "multiplayer_test":
        return json(await this.playtests.multiplayer(args));
      case "profile_scripts":
        return json(await this.playtests.profile(args));
      case "perf_stats":
        return json(await this.op(args, "perf_stats", pick(args, ["sample"]), 15_000));
      case "align":
      case "distribute":
      case "weld_model":
      case "set_collision_groups":
      case "select_and_focus":
      case "script_outline":
      case "script_search":
      case "script_diagnostics":
      case "generate_model":
        return editorTool(tool, args, this.pinned(args));
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
        lines.push(`• ${s.placeName} [${s.context}] placeId=${s.placeId} plugin v${s.pluginVersion} (last poll ${Math.round((Date.now() - s.lastSeen) / 1000)}s ago)${s.duplicate ? " DUPLICATE of a live session for this place: gets no commands until that one closes or expires. If you did not open this place twice, another program on this PC may be posing as Studio." : ""}`);
    }
    if (this.sync) {
      const st = this.sync.status();
      lines.push(`Sync: ${st.project} (${st.root}) → ${st.place}, ${st.items} items`);
    } else lines.push("Sync: off");
    if (this.mirror) {
      const st = this.mirrorStudio();
      lines.push(`Mirror: ${this.mirror.root} -> ${this.mirror.placeName}${st.connected ? (st.placeName !== this.mirror.placeName ? ` (now named "${st.placeName}")` : "") : " (that Studio is NOT connected)"}`);
    } else lines.push("Mirror: off");
    return { text: lines.join("\n") };
  }

  private async run(args: Args): Promise<ToolResult> {
    const timeout = Math.max(1, Number(args.timeout ?? 30));
    // the plugin enforces `timeout` itself (cancels the code); we wait a bit longer for its answer
    const r = await this.op(args, "run", { code: args.code, args: args.args, timeout }, (timeout + 15) * 1000);
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

  /**
   * The other DataModels of a running play-test of the same place. They draw cyan probe markers
   * during a capture, so a capture that shows one of them instead of the requested context is
   * recognised instead of returned as if it were the requested view.
   */
  private probeSessions(target: SessionInfo): SessionInfo[] {
    const now = Date.now();
    const live = this.bridge
      .list()
      .filter((x) => x.id !== target.id && !x.duplicate && x.placeId === target.placeId && (x.busy || now - x.lastSeen <= POLL_HOLD_MS + 5_000));
    const testRunning = target.context !== "edit" || live.some((x) => x.context !== "edit");
    return testRunning ? live : [];
  }

  private async screenshotInner(args: Args): Promise<ToolResult> {
    const s = this.session(args);
    const ctx = s.context;
    const views: string[] = args.cframe || args.position ? ["custom"] : (args.views ?? [args.view ?? (args.targets ? "iso" : "current")]);
    const maxW = Math.min(args.maxWidth ?? 1280, 2560);
    const images: ImageOut[] = [];
    const notes: string[] = [];
    const warnings: string[] = [];
    const probes = this.probeSessions(s);
    const testRunning = ctx !== "edit" || probes.length > 0;
    let probesOn = false;
    let restore: unknown;
    let finish: any;
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
        if (probes.length && !probesOn) {
          probesOn = true;
          await Promise.all(probes.map((p) => this.bridge.send(p.id, "shot_markers", { on: true, kind: "probe" }, 5_000).catch(() => {})));
        }
        const shot = await this.capture(s.placeName);
        const crop = cropToMarkers(shot.image);
        if (!crop.found) {
          if (cropToMarkers(shot.image, "probe").found) throw new PluginError(notOnScreen(ctx));
          if (testRunning) {
            throw new PluginError(
              `Could not find the ${ctx} viewport in the captured Studio window, so no image is returned (a whole-window capture would not show the ${ctx} view). Studio may be minimized or covered by another window, or showing a view other than ${ctx}.`,
            );
          }
          notes.push(`${view}: viewport markers not found, returning the whole Studio window`);
        }
        if (prep.cameraHeld === false) warnings.push(cameraOverridden(view));
        const img = downscale(crop.image, maxW, Math.round(maxW * 0.75));
        images.push({ data: toJpeg(img).toString("base64"), mimeType: "image/jpeg", label: `${view} ${img.width}×${img.height}` });
      }
    } finally {
      if (probesOn) await Promise.all(probes.map((p) => this.bridge.send(p.id, "shot_markers", { on: false }, 5_000).catch(() => {})));
      finish = await this.bridge.send(s.id, "shot_finish", { prev: restore, restore: args.restore !== false }, 15_000).catch(() => undefined);
    }
    if (finish?.cameraHeld === false && !warnings.length) warnings.push(cameraOverridden(views[views.length - 1]));
    const head = `${images.length} screenshot(s) of the ${ctx} view: ${images.map((i) => i.label).join(", ")}`;
    return { text: [...warnings, head, ...notes].join("\n"), images };
  }

  private resolveFile(file: string) {
    if (path.isAbsolute(file)) return file;
    const base = this.sync?.project.root;
    if (!base) throw new Error("relative file path needs an active sync project (or pass an absolute path)");
    return path.resolve(base, file);
  }

  /** cwd or the active sync project root */
  private isInsideWorkArea(file: string) {
    const abs = path.resolve(file);
    const roots = [process.cwd(), this.sync?.project.root].filter((x): x is string => !!x).map((r) => path.resolve(r));
    return roots.some((r) => {
      const rel = path.relative(r, abs);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
  }

  private async exportModel(args: Args): Promise<ToolResult> {
    const file = this.resolveFile(args.file);
    const format = args.format ?? (file.endsWith(".rbxm") ? "rbxm" : "json");
    if (!args.overwrite && fs.existsSync(file) && !this.isInsideWorkArea(file)) {
      throw new Error(`${file} already exists and is outside the working folder / sync project; pass overwrite:true to replace it`);
    }
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
      // whichever placement the file saved would otherwise win over the argument
      for (const k of ["cf", "origin", "at", "rot"]) delete node[k];
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
    if (this.mirror) this.assertNoOverlap(projectFile, this.mirror.services);
    if (this.sync) {
      const old = this.sync;
      // stopped is stopped: whatever fails below must not leave it reported as running
      this.sync = undefined;
      this.syncBinding = undefined;
      await old.stop();
    }
    let api;
    try {
      api = (await this.api()) as Awaited<ReturnType<typeof getApi>>;
    } catch {}
    const project = new Project(projectFile, api);
    const binding = this.bridge.bind(s.id);
    const send = async (op: string, payload: unknown, t?: number) => this.bridge.send(this.bridge.resolve(binding).id, op, payload, t);
    this.sync = new SyncSession(project, send, s.placeName);
    this.syncBinding = binding;
    try {
      const res = await this.sync.start();
      return json({ syncing: projectFile, place: s.placeName, ...res });
    } catch (e) {
      const failed = this.sync;
      this.sync = undefined;
      this.syncBinding = undefined;
      // a start that got as far as the watcher must not keep watching
      await failed?.stop().catch(() => {});
      throw e;
    }
  }

  private assertNoOverlap(projectFile: string, mirrored: string[]) {
    const mapped = projectServices(projectFile);
    const shared = mapped === null ? mirrored : mapped.filter((m) => mirrored.includes(m));
    if (shared.length) {
      throw new Error(`mirror and sync cannot run on the same content (${shared.join(", ")}): stop one first with mirror_stop or sync_stop`);
    }
  }

  private async mirrorStart(args: Args): Promise<ToolResult> {
    if (this.mirror) throw new Error(`a mirror is already running at ${this.mirror.root}; call mirror_stop first`);
    if (typeof args.dir !== "string" || !args.dir) throw new Error("dir is required");
    const services: string[] = args.services?.length ? args.services : DEFAULT_SERVICES;
    if (this.sync) this.assertNoOverlap(this.sync.project.file, services);
    const s = this.session(args);
    try {
      await this.api();
    } catch (e: any) {
      throw new Error(`mirror_start refused: the Roblox API dump could not be loaded (${e?.message ?? e}). Without it every property would be missing from the files. Check the network connection and try again.`);
    }
    const binding = this.bridge.bind(s.id);
    const send = async (op: string, payload: unknown, t?: number) => this.bridge.send(this.bridge.resolve(binding).id, op, payload, t);
    const m = new MirrorSession({ dir: args.dir, services, deleteThreshold: args.deleteThreshold }, send, s.placeName);
    this.mirror = m;
    this.mirrorBinding = binding;
    try {
      return json(await m.start());
    } catch (e) {
      this.mirror = undefined;
      await m.stop().catch(() => {});
      throw e;
    }
  }

  private async mirrorStop(): Promise<ToolResult> {
    if (!this.mirror) return { text: "mirror was not running" };
    // said now: once stopped, nothing else reports them
    const warnings = this.mirrorWarnings();
    const pending = this.mirror.status().unappliedEdits.map((u) => u.file);
    await this.mirror.stop();
    this.mirror = undefined;
    this.mirrorBinding = undefined;
    const lines = ["mirror stopped; the files stay on disk but are no longer live"];
    if (pending.length) lines.push(`NOT applied to Studio (still only on disk): ${pending.join(", ")}`);
    return { text: [...lines, ...warnings].join("\n") };
  }

  private async syncStop(): Promise<ToolResult> {
    if (!this.sync) return { text: "sync was not running" };
    await this.sync.stop();
    this.sync = undefined;
    return { text: "sync stopped" };
  }
}

function notOnScreen(ctx: Context): string {
  const advice: Record<Context, string> = {
    edit: 'While a play-test runs, Studio shows the test, not the edit-mode viewport. Use context "client" (what the player sees) or "server", or stop the test with playtest_stop to capture edit mode.',
    server: `Studio is showing the client's view. Use context "client", or ask the user to switch the test view to Server (Test tab, Client/Server toggle).`,
    client: "Studio is showing another view of the test (the server, or another client's window). Ask the user to switch the view to the client, or use the context Studio shows.",
  };
  return `The ${ctx} view is not on screen, so no image is returned (it would show another DataModel). ${advice[ctx]}`;
}

function cameraOverridden(view: string): string {
  return `WARNING: the game's own camera script moved the camera during the capture, so the "${view}" image shows the game's camera, not the requested one. In a scenario, set workspace.CurrentCamera.CameraType to Scriptable and stop the game's camera updates first, or take the screenshot in edit mode.`;
}

/** A JSON null would vanish on the way into Luau, so it is sent as the explicit "clear" form. */
function clearNullRefs(a: Args): Args {
  const fix = (props?: Args) => props && Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v === null ? { ref: false } : v]));
  const out: Args = { ...a };
  if (a.props) out.props = fix(a.props);
  if (Array.isArray(a.edits)) out.edits = a.edits.map((e: Args) => (e?.props ? { ...e, props: fix(e.props) } : e));
  return out;
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
