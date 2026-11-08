// Project files <-> Studio instances.
//
// Project file: rolink.project.json or default.project.json (Rojo's format):
//   { "name": "...", "tree": { "$className": "DataModel", "ReplicatedStorage": { "Shared": { "$path": "src/shared" } } } }
//
// File mapping inside a $path directory:
//   Foo.server.lua(u)  -> Script        Foo.client.lua(u) -> LocalScript    Foo.lua(u) -> ModuleScript
//   dir/               -> Folder (or the script given by dir/init.server.luau, init.client.luau, init.luau)
//   Foo.model.json     -> model (RoLink build spec, or Rojo {ClassName, Properties, Children})
//   Foo.rbxm           -> binary model (exact copy, loaded via SerializationService)
//   Foo.txt            -> StringValue      Foo.json -> ModuleScript returning the decoded table
//   Foo.meta.json / init.meta.json -> {"properties": {...}} applied to Foo / the directory

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { type CompactApi, propsOf } from "./apidump.js";
import { log } from "./config.js";

export interface SyncItem {
  path: string[];
  class?: string;
  source?: string;
  props?: Record<string, unknown>;
  spec?: unknown;
  rbxm?: string;
  hash?: string;
  /** file backing this item (relative to project root) — not sent to the plugin */
  file?: string;
}

export interface Snapshot {
  items: SyncItem[];
  roots: string[][];
  /** instance path key -> directory that holds its children on disk */
  dirs: Map<string, string>;
  warnings: string[];
}

const SCRIPT_RE = /^(.*?)(\.server|\.client)?\.(lua|luau)$/;
const key = (p: string[]) => p.join("\u0000");

export function findProjectFile(dir: string): string | null {
  for (const name of ["rolink.project.json", "default.project.json"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  const any = fs.readdirSync(dir).find((f) => f.endsWith(".project.json"));
  return any ? path.join(dir, any) : null;
}

// ------------------------------------------------------------ value conversion

function hex01(c: number[]) {
  const h = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`.toUpperCase();
}

/** Rojo property value -> RoLink wire value. `type` comes from the API table. */
export function convertRojoValue(type: string | undefined, v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const [k, inner] = Object.entries(v as Record<string, unknown>)[0] ?? [];
    if (k === "Color3" || k === "Color3uint8") {
      const arr = inner as number[];
      return k === "Color3uint8" ? `#${arr.map((x) => x.toString(16).padStart(2, "0")).join("")}`.toUpperCase() : hex01(arr);
    }
    if (k === "CFrame") return convertRojoValue("CFrame", inner);
    if (k === "Enum") return inner;
    if (k && /^[A-Z]/.test(k) && Object.keys(v).length === 1) return convertRojoValue(k, inner);
    if (type === "CFrame" && (v as any).position) {
      const p = (v as any).position as number[];
      const o = ((v as any).orientation as number[][]) ?? [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
      return [...p, ...o[0], ...o[1], ...o[2]];
    }
  }
  if (type === "Color3" && Array.isArray(v)) return hex01(v as number[]);
  return v;
}

function convertProps(api: CompactApi | undefined, className: string, props: Record<string, unknown> | undefined) {
  if (!props) return undefined;
  const types = api ? propsOf(api, className) : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = convertRojoValue(types[k], v);
  return out;
}

/** Rojo .model.json -> RoLink build node. */
function rojoModelToSpec(api: CompactApi | undefined, m: any, name?: string): any {
  const cls = m.ClassName ?? "Folder";
  const node: any = { class: cls };
  if (m.Name ?? name) node.name = m.Name ?? name;
  const props = convertProps(api, cls, m.Properties);
  if (props) {
    if (props.CFrame !== undefined) {
      node.cf = props.CFrame;
      delete props.CFrame;
    }
    if (props.Size !== undefined) {
      node.size = props.Size;
      delete props.Size;
    }
    node.props = props;
  }
  if (m.Attributes) node.attrs = m.Attributes;
  if (Array.isArray(m.Children)) node.children = m.Children.map((c: any) => rojoModelToSpec(api, c));
  return node;
}

// ------------------------------------------------------------ snapshot

export class Project {
  readonly root: string;
  readonly file: string;
  name = "";
  private api?: CompactApi;

  constructor(projectFile: string, api?: CompactApi) {
    this.file = projectFile;
    this.root = path.dirname(projectFile);
    this.api = api;
  }

  async snapshot(): Promise<Snapshot> {
    const json = JSON.parse(await fsp.readFile(this.file, "utf8"));
    this.name = json.name ?? path.basename(this.root);
    const snap: Snapshot = { items: [], roots: [], dirs: new Map(), warnings: [] };
    await this.walkNode(json.tree ?? {}, [], snap);
    return snap;
  }

  /** absolute fs paths referenced by $path (for the watcher) */
  async watchedPaths(): Promise<string[]> {
    const json = JSON.parse(await fsp.readFile(this.file, "utf8"));
    const out = [this.file];
    const visit = (n: any) => {
      if (!n || typeof n !== "object") return;
      if (typeof n.$path === "string") out.push(path.resolve(this.root, n.$path));
      for (const [k, v] of Object.entries(n)) if (!k.startsWith("$")) visit(v);
    };
    visit(json.tree);
    return out;
  }

  private async walkNode(node: any, instPath: string[], snap: Snapshot) {
    const children = Object.entries(node).filter(([k]) => !k.startsWith("$"));
    const cls: string | undefined = node.$className;

    if (typeof node.$path === "string") {
      const abs = path.resolve(this.root, node.$path);
      if (!fs.existsSync(abs)) {
        snap.warnings.push(`$path not found: ${node.$path}`);
      } else if (fs.statSync(abs).isDirectory()) {
        snap.roots.push(instPath);
        if (instPath.length <= 1) {
          // a service maps straight onto a directory: its files become children
          if (instPath.length === 1 && node.$properties)
            snap.items.push({ path: instPath, props: convertProps(this.api, instPath[0], node.$properties) });
          snap.dirs.set(key(instPath), abs);
          await this.walkDirChildren(abs, instPath, snap);
        } else {
          await this.walkDir(abs, instPath, snap, cls, node.$properties);
        }
      } else {
        await this.walkFile(abs, instPath, snap);
      }
    } else if (instPath.length === 1) {
      if (node.$properties) snap.items.push({ path: instPath, props: convertProps(this.api, instPath[0], node.$properties) });
    } else if (instPath.length > 1) {
      const c = cls ?? "Folder";
      snap.items.push({ path: instPath, class: c, props: convertProps(this.api, c, node.$properties) });
    }

    for (const [name, child] of children) await this.walkNode(child, [...instPath, name], snap);
  }

  private async readMeta(file: string): Promise<{ properties?: Record<string, unknown>; className?: string } | null> {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return null;
    }
  }

  private async walkDir(abs: string, instPath: string[], snap: Snapshot, forcedClass?: string, extraProps?: any) {
    const entries = await fsp.readdir(abs);
    const init = entries.find((e) => /^init(\.server|\.client)?\.(lua|luau)$/.test(e));
    const meta = entries.includes("init.meta.json") ? await this.readMeta(path.join(abs, "init.meta.json")) : null;
    let item: SyncItem;
    if (init) {
      const m = SCRIPT_RE.exec(init)!;
      const c = m[2] === ".server" ? "Script" : m[2] === ".client" ? "LocalScript" : "ModuleScript";
      const file = path.join(abs, init);
      item = { path: instPath, class: c, source: await fsp.readFile(file, "utf8"), file: this.rel(file) };
    } else {
      item = { path: instPath, class: forcedClass ?? meta?.className ?? "Folder", file: this.rel(abs) };
    }
    const props = { ...(extraProps ?? {}), ...(meta?.properties ?? {}) };
    if (Object.keys(props).length) item.props = convertProps(this.api, item.class!, props);
    snap.items.push(item);
    snap.dirs.set(key(instPath), abs);
    await this.walkDirChildren(abs, instPath, snap);
  }

  private async walkDirChildren(abs: string, instPath: string[], snap: Snapshot) {
    const entries = (await fsp.readdir(abs)).sort();
    for (const e of entries) {
      if (e.startsWith(".") || /^init(\.server|\.client)?\.(lua|luau)$/.test(e) || e === "init.meta.json") continue;
      const full = path.join(abs, e);
      const st = await fsp.stat(full);
      if (st.isDirectory()) {
        await this.walkDir(full, [...instPath, e], snap);
      } else {
        const name = instanceName(e);
        if (name) await this.walkFile(full, [...instPath, name], snap);
      }
    }
  }

  private async walkFile(abs: string, instPath: string[], snap: Snapshot) {
    const base = path.basename(abs);
    const file = this.rel(abs);
    const metaFile = abs.replace(/(\.server|\.client)?\.(lua|luau|txt|json|rbxm)$/, "") + ".meta.json";
    const meta = metaFile !== abs && fs.existsSync(metaFile) ? await this.readMeta(metaFile) : null;
    const m = SCRIPT_RE.exec(base);
    let item: SyncItem | null = null;
    if (base.endsWith(".model.json")) {
      const text = await fsp.readFile(abs, "utf8");
      try {
        const j = JSON.parse(text);
        const spec = j.ClassName ? rojoModelToSpec(this.api, j) : j;
        item = { path: instPath, spec, hash: sha1(text), file };
      } catch (e) {
        snap.warnings.push(`${file}: bad JSON (${String(e)})`);
      }
    } else if (base.endsWith(".rbxm")) {
      const buf = await fsp.readFile(abs);
      item = { path: instPath, rbxm: buf.toString("base64"), hash: sha1(buf), file };
    } else if (m) {
      const c = m[2] === ".server" ? "Script" : m[2] === ".client" ? "LocalScript" : "ModuleScript";
      item = { path: instPath, class: c, source: await fsp.readFile(abs, "utf8"), file };
    } else if (base.endsWith(".txt")) {
      item = { path: instPath, class: "StringValue", props: { Value: await fsp.readFile(abs, "utf8") }, file };
    } else if (base.endsWith(".json") && !base.endsWith(".meta.json") && !base.endsWith(".project.json")) {
      const text = await fsp.readFile(abs, "utf8");
      item = {
        path: instPath,
        class: "ModuleScript",
        source: `return game:GetService("HttpService"):JSONDecode(${luaLongString(text)})`,
        file,
      };
    }
    if (!item) return;
    if (meta?.properties && item.class) item.props = { ...(item.props ?? {}), ...convertProps(this.api, item.class, meta.properties) };
    snap.items.push(item);
  }

  rel(abs: string) {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }
}

function instanceName(file: string): string | null {
  if (file.endsWith(".meta.json") || file.endsWith(".project.json")) return null;
  if (file.endsWith(".model.json")) return file.slice(0, -".model.json".length);
  const m = SCRIPT_RE.exec(file);
  if (m) return m[1];
  for (const ext of [".rbxm", ".txt", ".json"]) if (file.endsWith(ext)) return file.slice(0, -ext.length);
  return null;
}

/** Lua long-bracket literal whose level does not occur in the text. */
export function luaLongString(text: string): string {
  let eq = "";
  while (text.includes(`]${eq}]`)) eq += "=";
  // a leading newline right after the opening bracket is dropped by Lua
  return `[${eq}[${text.startsWith("\n") || text.startsWith("\r") ? "\n" : ""}${text}]${eq}]`;
}

/** Instance name safe to use as a single file name inside the sync tree. */
export function safeFileName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 200) return false;
  if (/[\/\\:*?"<>|\x00-\x1f\x7f]/.test(name)) return false;
  if (name === "." || name === ".." || name.includes("..")) return false;
  if (/[. ]$/.test(name)) return false; // Windows strips these
  return true;
}

function sha1(x: string | Buffer) {
  return createHash("sha1").update(x).digest("hex");
}

/** What the plugin receives (no local file paths). */
export function wireItem(i: SyncItem) {
  const { file: _f, ...rest } = i;
  return rest;
}

export function diff(prev: Snapshot, next: Snapshot) {
  const before = new Map(prev.items.map((i) => [key(i.path), JSON.stringify(wireItem(i))]));
  const upsert: SyncItem[] = [];
  const seen = new Set<string>();
  for (const i of next.items) {
    const k = key(i.path);
    seen.add(k);
    if (before.get(k) !== JSON.stringify(wireItem(i))) upsert.push(i);
  }
  const remove: string[][] = [];
  for (const i of prev.items) if (!seen.has(key(i.path))) remove.push(i.path);
  return { upsert, remove };
}

// ------------------------------------------------------------ live session

export type SendFn = (op: string, args: unknown, timeoutMs?: number) => Promise<any>;

export class SyncSession {
  readonly project: Project;
  private snap?: Snapshot;
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private send: SendFn;
  private busy = Promise.resolve();
  lastResult: unknown;
  readonly placeName: string;
  /** recent Studio->file writes we should not echo back */
  private ownWrites = new Map<string, number>();
  log: string[] = [];

  constructor(project: Project, send: SendFn, placeName: string) {
    this.project = project;
    this.send = send;
    this.placeName = placeName;
  }

  private note(msg: string) {
    this.log.push(`${new Date().toLocaleTimeString()} ${msg}`);
    if (this.log.length > 100) this.log.shift();
    log(`[sync] ${msg}`);
  }

  async start() {
    const res = await this.fullSync();
    const paths = await this.project.watchedPaths();
    this.watcher = chokidar.watch(paths, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 } });
    this.watcher.on("all", (_ev, p) => {
      const t = this.ownWrites.get(path.resolve(p));
      if (t && Date.now() - t < 1500) return;
      this.schedule();
    });
    await new Promise<void>((resolve) => {
      this.watcher!.once("ready", () => resolve());
      setTimeout(resolve, 5000);
    });
    return res;
  }

  async stop() {
    await this.watcher?.close();
    clearTimeout(this.timer);
    try {
      await this.send("sync", { action: "stop" }, 10_000);
    } catch {}
  }

  async fullSync() {
    this.snap = await this.project.snapshot();
    const res = await this.send(
      "sync",
      { action: "full", items: this.snap.items.map(wireItem), roots: this.snap.roots },
      180_000,
    );
    this.lastResult = res;
    this.note(`full sync: ${this.snap.items.length} items, created ${res.created}, updated ${res.updated}, removed ${res.removed}`);
    return { items: this.snap.items.length, warnings: this.snap.warnings, ...res };
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.busy = this.busy.then(() => this.pushChanges()).catch((e) => this.note(`push failed: ${e.message}`));
    }, 120);
  }

  private async pushChanges() {
    if (!this.snap) return;
    const next = await this.project.snapshot();
    const { upsert, remove } = diff(this.snap, next);
    this.snap = next;
    if (upsert.length === 0 && remove.length === 0) return;
    const res = await this.send("sync", { action: "patch", upsert: upsert.map(wireItem), remove }, 120_000);
    this.lastResult = res;
    this.note(`push: ${upsert.map((u) => u.path.join("/")).join(", ") || "-"}${remove.length ? `; removed ${remove.length}` : ""}`);
  }

  /** Studio edited / created a script: write it to disk. */
  async onPluginEvent(ev: { type: string; path: string[]; class: string; source: string }) {
    if (!this.snap) return;
    if (!Array.isArray(ev.path) || ev.path.length === 0 || typeof ev.source !== "string") return;
    const k = key(ev.path);
    let item = this.snap.items.find((i) => key(i.path) === k);
    let target: string | undefined;
    if (item?.file && item.source !== undefined) {
      target = path.resolve(this.project.root, item.file);
    } else if (ev.type === "created") {
      const parentDir = this.snap.dirs.get(key(ev.path.slice(0, -1)));
      if (!parentDir) return;
      const name = ev.path[ev.path.length - 1];
      if (!safeFileName(name)) {
        this.note(`skipped Studio-created script with unsafe name ${JSON.stringify(name)}`);
        return;
      }
      const suffix = ev.class === "Script" ? ".server.luau" : ev.class === "LocalScript" ? ".client.luau" : ".luau";
      target = path.resolve(parentDir, name + suffix);
      const root = path.resolve(this.project.root);
      const rel = path.relative(root, target);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        this.note(`refused to write outside the sync root: ${target}`);
        return;
      }
      if (fs.existsSync(target)) return;
      item = { path: ev.path, class: ev.class, source: ev.source, file: this.project.rel(target) };
      this.snap.items.push(item);
    }
    if (!target || !item) return;
    const current = fs.existsSync(target) ? await fsp.readFile(target, "utf8") : null;
    if (current === ev.source) return;
    this.ownWrites.set(path.resolve(target), Date.now());
    await fsp.writeFile(target, ev.source, "utf8");
    item.source = ev.source;
    this.note(`Studio → ${this.project.rel(target)}`);
  }

  status() {
    return {
      project: this.project.name,
      root: this.project.root,
      place: this.placeName,
      items: this.snap?.items.length ?? 0,
      warnings: this.snap?.warnings ?? [],
      recent: this.log.slice(-15),
    };
  }
}
