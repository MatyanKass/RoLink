// Live two-way mirror of a Studio place on disk (see AGENTS_MD in mirrorformat.ts).
//
// The server keeps a shadow of the place. Studio -> disk: the plugin sends
// current instance state, the shadow is updated and the affected files are
// re-rendered. Disk -> Studio: changed files are diffed against the shadow and
// sent as ops. Echoes die on their own: every file write is recorded by content
// hash, so a watcher event for content we already know is ignored, and a Studio
// delta equal to the shadow changes nothing.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { log } from "./config.js";
import {
  AGENTS_MD,
  type DocNode,
  GUI_CLASSES,
  type Layout,
  type LooseEntry,
  type MNode,
  type ModelEntry,
  type NodeDiff,
  type Rec,
  type Unit,
  diffNode,
  inJson,
  isContainer,
  layoutTree,
  matchChildren,
  modelChildByTokens,
  parseDoc,
  parseLooseDir,
  parseLooseFile,
  parseModelDir,
  parseModelFile,
  sameContainerKind,
  sameValue,
  treeOverview,
  worldIndex,
} from "./mirrorformat.js";
import { encodeName, nameProblem, safeComponent } from "./mirrorname.js";
import type { SendFn } from "./sync.js";

export const DEFAULT_SERVICES = [
  "Workspace",
  "ReplicatedStorage",
  "ReplicatedFirst",
  "ServerScriptService",
  "ServerStorage",
  "StarterGui",
  "StarterPack",
  "StarterPlayer",
  "Lighting",
  "SoundService",
  "Teams",
  "Chat",
  "TextChatService",
  "MaterialService",
];

const MARKER = ".rolink-mirror.json";
const TMP_DIR = ".rolink-tmp";
const TRASH_DIR = ".rolink-trash";
const ROOT_FILES = new Set(["AGENTS.md", "_tree.txt", "_errors.log", MARKER]);
const MAX_ERROR_LINES = 500;
const DUMP_TIMEOUT = 120_000;
/** must outlast the watcher's awaitWriteFinish, or a folder and its files land in separate batches */
const MIN_DISK_DEBOUNCE = 250;
const MAX_DEFERRALS = 20;

interface Wire {
  i: number;
  p: number;
  c: string;
  n: string;
  props?: Rec;
  attrs?: Rec;
  tags?: string[];
  src?: string;
}

export interface MirrorOptions {
  dir: string;
  services?: string[];
  deleteThreshold?: number;
  debounceMs?: number;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const isUnder = (rel: string, dir: string) => rel.startsWith(dir + "/");
const dirOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const baseOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

function subtreeSize(n: MNode): number {
  let c = 1;
  for (const k of n.children) c += subtreeSize(k);
  return c;
}
function inside(n: MNode | null, root: MNode): boolean {
  for (let c = n; c; c = c.parent) if (c === root) return true;
  return false;
}

/** Services a Rojo project maps, to detect overlap with the mirror. null = cannot tell, assume all. */
export function projectServices(projectFile: string): string[] | null {
  try {
    const tree = JSON.parse(fs.readFileSync(projectFile, "utf8")).tree ?? {};
    if (tree.$path) return null;
    return Object.keys(tree).filter((k) => !k.startsWith("$"));
  } catch {
    return null;
  }
}

interface Op extends Rec {
  op: "create" | "set" | "destroy";
}

class Plan {
  moves: Op[] = [];
  creates: Op[] = [];
  sets = new Map<number, Op>();
  destroys: Op[] = [];
  /** provisional id -> the file that asked for it (to report a failed create) */
  origin = new Map<number, string>();
  touched = new Set<string>();

  set(id: number, fields: Rec | NodeDiff) {
    const cur = this.sets.get(id) ?? ({ op: "set", id } as Op);
    Object.assign(cur, fields);
    this.sets.set(id, cur);
  }
  get ops(): Op[] {
    return [...this.moves, ...this.creates, ...this.sets.values(), ...this.destroys];
  }
  get empty() {
    return this.moves.length + this.creates.length + this.sets.size + this.destroys.length === 0;
  }
}

export class MirrorSession {
  readonly root: string;
  readonly services: string[];
  readonly placeName: string;
  private send: SendFn;
  private threshold: number;
  private debounce: number;

  private nodes = new Map<number, MNode>();
  private roots: MNode[] = [];
  private others: string[] = [];
  private layout: Layout = { files: new Map(), dirs: new Map(), skipped: [] };
  private diskFiles = new Map<string, string>();
  private diskDirs = new Set<string>();
  private rejected = new Map<string, string>();
  private errors: string[] = [];
  private refusals: { time: string; reason: string }[] = [];
  private lastHashes = new Map<string, string>();
  private knownSkipped = new Set<string>();

  private watcher?: FSWatcher;
  private pending = new Set<string>();
  private diskTimer?: NodeJS.Timeout;
  private renderTimer?: NodeJS.Timeout;
  private q: Promise<unknown> = Promise.resolve();
  private dumping = false;
  private buffered: any[] = [];
  private tmpId = -1;
  private stopped = false;
  private applied = 0;
  private lastActivity = "";
  private deferrals = 0;

  constructor(opts: MirrorOptions, send: SendFn, placeName: string) {
    this.root = path.resolve(opts.dir);
    this.services = opts.services?.length ? opts.services : DEFAULT_SERVICES;
    this.threshold = opts.deleteThreshold ?? 25;
    this.debounce = opts.debounceMs ?? 200;
    this.send = send;
    this.placeName = placeName;
  }

  // ---------------------------------------------------------- lifecycle

  async start() {
    await this.prepareRoot();
    const res = await this.enqueue(async () => {
      await this.dumpAll();
      await this.render();
      return { instances: this.nodes.size, files: this.diskFiles.size };
    });
    await this.startWatcher();
    return { dir: this.root, place: this.placeName, services: this.roots.map((s) => s.name), ...res };
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.diskTimer);
    clearTimeout(this.renderTimer);
    await this.watcher?.close();
    await this.q.catch(() => {});
    try {
      await this.send("mirror", { action: "stop" }, 10_000);
    } catch {}
  }

  /** Studio reconnected: it is the source of truth again. */
  resync() {
    return this.enqueue(async () => {
      if (this.stopped) return;
      await this.dumpAll();
      await this.render();
      this.note("resynced from Studio after reconnect");
    });
  }

  status() {
    return {
      active: !this.stopped,
      dir: this.root,
      place: this.placeName,
      services: this.roots.map((s) => s.name),
      instances: this.nodes.size,
      files: this.diskFiles.size,
      deleteThreshold: this.threshold,
      batchesApplied: this.applied,
      refusedDeletes: this.refusals.slice(-10),
      rejectedFiles: [...this.rejected.keys()].slice(0, 50),
      recentErrors: this.errors.slice(-10),
      lastActivity: this.lastActivity,
    };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.q.then(fn);
    this.q = p.catch((e) => this.logError(`internal: ${e?.message ?? e}`));
    return p;
  }

  private note(msg: string) {
    this.lastActivity = `${new Date().toISOString()} ${msg}`;
    log(`[mirror] ${msg}`);
  }

  private logError(msg: string) {
    this.errors.push(`${new Date().toISOString()} ${msg}`);
    if (this.errors.length > MAX_ERROR_LINES) this.errors.splice(0, this.errors.length - MAX_ERROR_LINES);
    log(`[mirror] ${msg}`);
  }

  private async prepareRoot() {
    if (path.parse(this.root).root === this.root) throw new Error(`refusing to mirror into a filesystem root: ${this.root}`);
    let st: fs.Stats | undefined;
    try {
      st = await fsp.lstat(this.root);
    } catch {}
    if (st?.isSymbolicLink()) throw new Error(`mirror dir is a symlink: ${this.root}`);
    if (st && !st.isDirectory()) throw new Error(`mirror dir is a file: ${this.root}`);
    await fsp.mkdir(this.root, { recursive: true });
    const entries = await fsp.readdir(this.root);
    if (entries.length && !entries.includes(MARKER)) {
      throw new Error(`${this.root} is not empty and is not a RoLink mirror; pick an empty or new folder`);
    }
    // files from an earlier run are stale: keep the latest copy aside rather than delete them
    const old = entries.filter((e) => !e.startsWith(".rolink-") && !ROOT_FILES.has(e));
    if (old.length) {
      const trash = path.join(this.root, TRASH_DIR);
      await fsp.rm(trash, { recursive: true, force: true });
      await fsp.mkdir(trash, { recursive: true });
      for (const e of old) await fsp.rename(path.join(this.root, e), path.join(trash, e));
    }
    await fsp.rm(path.join(this.root, TMP_DIR), { recursive: true, force: true });
    await fsp.mkdir(path.join(this.root, TMP_DIR), { recursive: true });
    await fsp.writeFile(path.join(this.root, MARKER), JSON.stringify({ place: this.placeName, startedAt: new Date().toISOString() }) + "\n");
  }

  private async startWatcher() {
    await this.watcher?.close();
    const ignored = (p: string) => {
      const rel = this.rel(p);
      if (rel === "") return false;
      if (rel.split("/").some((seg) => seg.startsWith("."))) return true;
      return ROOT_FILES.has(rel);
    };
    const w = chokidar.watch(this.root, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
    });
    this.watcher = w;
    w.on("all", (_ev, p) => {
      this.pending.add(this.rel(p));
      this.schedule();
    });
    w.on("error", (e) => log("[mirror] watcher:", String(e)));
    await new Promise<void>((resolve) => {
      w.once("ready", () => resolve());
      setTimeout(resolve, 5000);
    });
  }

  private rel(abs: string) {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }
  private abs(rel: string) {
    return path.join(this.root, ...rel.split("/"));
  }

  // ---------------------------------------------------------- Studio -> shadow

  private async dumpAll() {
    this.dumping = true;
    try {
      const start = await this.send("mirror", { action: "start", services: this.services }, 30_000);
      this.nodes.clear();
      this.roots = [];
      this.others = Array.isArray(start?.others) ? start.others.filter((x: unknown) => typeof x === "string") : [];
      for (;;) {
        const r = await this.send("mirror", { action: "next" }, DUMP_TIMEOUT);
        for (const w of r?.nodes ?? []) this.ingest(w);
        if (r?.done !== false) break;
      }
    } finally {
      this.dumping = false;
    }
    for (const ev of this.buffered.splice(0)) this.applyDelta(ev);
  }

  private ingest(w: Wire) {
    if (!w || typeof w.i !== "number" || typeof w.p !== "number" || typeof w.c !== "string" || typeof w.n !== "string") return;
    if (w.c.length > 200 || w.n.length > 1000) return;
    const existing = this.nodes.get(w.i);
    const parent = w.p === 0 ? null : this.nodes.get(w.p);
    if (w.p !== 0 && !parent) return; // parent left the mirror
    if (w.p === 0 && !this.services.includes(w.n)) return;
    if (existing) {
      this.updateNode(existing, w, parent ?? null);
      return;
    }
    const n: MNode = { id: w.i, parent: parent ?? null, cls: w.c, name: w.n, props: w.props ?? {}, attrs: w.attrs, tags: w.tags, source: w.src, children: [] };
    this.nodes.set(w.i, n);
    if (parent) parent.children.push(n);
    else this.roots.push(n);
    this.touch(n);
  }

  private updateNode(n: MNode, w: Wire, parent: MNode | null) {
    let changed = false;
    if (n.name !== w.n) {
      n.name = w.n;
      changed = true;
    }
    if (n.cls !== w.c) {
      n.cls = w.c;
      changed = true;
    }
    if (n.parent !== parent) {
      if (parent && inside(parent, n)) return; // would be a cycle: malformed
      this.detach(n);
      this.attach(n, parent);
      changed = true;
    }
    const fields: (["props" | "attrs" | "tags" | "source", unknown])[] = [
      ["props", w.props ?? {}],
      ["attrs", w.attrs],
      ["tags", w.tags],
      ["source", w.src],
    ];
    for (const [k, v] of fields) {
      if (!sameValue(n[k] ?? null, v ?? null)) {
        (n as any)[k] = v;
        changed = true;
      }
    }
    if (changed) this.touch(n);
  }

  private touch(n: MNode | null) {
    for (let c = n; c; c = c.parent) c.cache = undefined;
    this.scheduleRender();
  }

  private detach(n: MNode) {
    const sibs = n.parent ? n.parent.children : this.roots;
    const i = sibs.indexOf(n);
    if (i >= 0) sibs.splice(i, 1);
    this.touch(n.parent);
  }

  private attach(n: MNode, parent: MNode | null) {
    n.parent = parent;
    (parent ? parent.children : this.roots).push(n);
    this.touch(n);
  }

  private dropSubtree(n: MNode) {
    this.detach(n);
    const visit = (c: MNode) => {
      this.nodes.delete(c.id);
      c.children.forEach(visit);
    };
    visit(n);
  }

  onDelta(ev: { upserts?: Wire[]; removed?: number[] }) {
    if (this.dumping) {
      this.buffered.push(ev);
      return;
    }
    void this.enqueue(async () => this.applyDelta(ev));
  }

  private applyDelta(ev: { upserts?: Wire[]; removed?: number[] }) {
    for (const id of ev.removed ?? []) {
      const n = this.nodes.get(id);
      if (n && n.parent) this.dropSubtree(n);
    }
    const orphans: Wire[] = [];
    for (const w of ev.upserts ?? []) {
      if (w && w.p !== 0 && !this.nodes.has(w.p)) orphans.push(w);
      else this.ingest(w);
    }
    // a parent can arrive after its child within one delta
    for (let pass = 0; pass < 3 && orphans.length; pass++) {
      for (const w of orphans.splice(0)) {
        if (this.nodes.has(w.p)) this.ingest(w);
        else orphans.push(w);
      }
    }
  }

  private scheduleRender() {
    if (this.stopped || this.dumping) return;
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      void this.enqueue(() => this.render());
    }, this.debounce);
  }

  // ---------------------------------------------------------- shadow -> disk

  private computeLayout() {
    const ws = this.roots.find((s) => s.cls === "Workspace" || s.name === "Workspace");
    this.layout = layoutTree(this.roots, worldIndex(ws), safeComponent);
    return this.layout;
  }

  /** every directory below the root must be real, never a link */
  private async assertNoSymlink(rel: string, checked: Set<string>) {
    const parts = rel.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (checked.has(cur)) continue;
      let st: fs.Stats | undefined;
      try {
        st = await fsp.lstat(this.abs(cur));
      } catch {
        return;
      }
      if (st.isSymbolicLink()) throw new Error(`symlink inside the mirror, not followed: ${cur}`);
      checked.add(cur);
    }
  }

  private async atomicWrite(rel: string, text: string) {
    const tmp = path.join(this.root, TMP_DIR, randomUUID());
    await fsp.writeFile(tmp, text, "utf8");
    const target = this.abs(rel);
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(tmp, target);
        return;
      } catch (e: any) {
        if (i >= 6 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
          await fsp.rm(tmp, { force: true });
          throw e;
        }
        await new Promise((r) => setTimeout(r, 15 * (i + 1)));
      }
    }
  }

  private async render() {
    if (this.stopped && this.diskFiles.size) return;
    const layout = this.computeLayout();
    for (const s of layout.skipped) {
      if (!this.knownSkipped.has(s)) {
        this.knownSkipped.add(s);
        this.logError(`not mirrored: ${s}`);
      }
    }
    await fsp.mkdir(path.join(this.root, TMP_DIR), { recursive: true });
    const checked = new Set<string>();
    // deletes first: on a case-insensitive disk "wall"->"Wall" would delete the new file otherwise
    for (const rel of [...this.diskFiles.keys()]) {
      if (layout.files.has(rel) || this.rejected.has(rel)) continue;
      try {
        await this.assertNoSymlink(dirOf(rel) || baseOf(rel), checked);
        await fsp.rm(this.abs(rel), { force: true });
        this.diskFiles.delete(rel);
      } catch (e: any) {
        this.logError(`could not remove ${rel}: ${e.message}`);
      }
    }
    const staleDirs = [...this.diskDirs].filter((d) => !layout.dirs.has(d)).sort((a, b) => b.length - a.length);
    for (const d of staleDirs) {
      try {
        await this.assertNoSymlink(d, checked);
        await fsp.rmdir(this.abs(d));
      } catch {}
      this.diskDirs.delete(d);
    }
    for (const d of [...layout.dirs.keys()].sort((a, b) => a.length - b.length)) {
      if (this.diskDirs.has(d)) continue;
      try {
        await this.assertNoSymlink(d, checked);
        await fsp.mkdir(this.abs(d), { recursive: true });
        this.diskDirs.add(d);
      } catch (e: any) {
        this.logError(`could not create ${d}: ${e.message}`);
      }
    }
    const writes: [string, string, string][] = [];
    for (const [rel, unit] of layout.files) {
      const h = sha(unit.content);
      if (this.diskFiles.get(rel) === h) continue;
      if (this.rejected.has(rel)) continue; // keep the agent's broken file so it can be fixed
      writes.push([rel, unit.content, h]);
    }
    for (let i = 0; i < writes.length; i += 32) {
      await Promise.all(
        writes.slice(i, i + 32).map(async ([rel, text, h]) => {
          try {
            await this.assertNoSymlink(dirOf(rel), checked);
            // an agent saved this file since we last wrote it: its edit wins, the watcher brings it in
            const known = this.diskFiles.get(rel);
            if (known !== undefined) {
              const now = await fsp.readFile(this.abs(rel), "utf8").catch(() => null);
              if (now !== null && sha(now) !== known) {
                this.pending.add(rel);
                this.schedule();
                return;
              }
            }
            this.diskFiles.set(rel, h); // before the write, so its watcher event is recognised
            await this.atomicWrite(rel, text);
          } catch (e: any) {
            this.diskFiles.delete(rel);
            this.logError(`could not write ${rel}: ${e.message}`);
          }
        }),
      );
    }
    await this.writeRootFile("AGENTS.md", AGENTS_MD);
    await this.writeRootFile("_tree.txt", treeOverview(this.roots, this.others));
    await this.writeRootFile("_errors.log", this.errors.join("\n") + (this.errors.length ? "\n" : ""));
    if (writes.length) this.note(`wrote ${writes.length} file(s)`);
  }

  private async writeRootFile(name: string, text: string) {
    const h = sha(text);
    if (this.lastHashes.get(name) === h) return;
    await this.atomicWrite(name, text);
    this.lastHashes.set(name, h);
  }

  // ---------------------------------------------------------- disk -> Studio

  private schedule() {
    if (this.stopped) return;
    clearTimeout(this.diskTimer);
    this.diskTimer = setTimeout(() => {
      const batch = [...this.pending];
      this.pending.clear();
      void this.enqueue(() => this.processBatch(batch));
    }, Math.max(this.debounce, MIN_DISK_DEBOUNCE));
  }

  private reject(rel: string, hash: string | undefined, reason: string) {
    if (hash) this.rejected.set(rel, hash);
    this.logError(`REJECTED ${rel}: ${reason}`);
  }

  private async processBatch(paths: string[]) {
    if (this.stopped) return;
    const added = new Map<string, { text: string; hash: string }>();
    const modified = new Map<string, { text: string; hash: string }>();
    const addedDirs = new Set<string>();
    let removedFiles = new Set<string>();
    let removedDirs = new Set<string>();
    let rootGone = false;

    for (const rel of paths) {
      if (rel === "") {
        if (!fs.existsSync(this.root)) rootGone = true;
        continue;
      }
      let st: fs.Stats | undefined;
      try {
        st = await fsp.lstat(this.abs(rel));
      } catch {}
      if (st?.isSymbolicLink()) {
        this.logError(`REJECTED ${rel}: symlinks are not followed`);
        continue;
      }
      if (st?.isDirectory()) {
        if (!this.diskDirs.has(rel)) addedDirs.add(rel);
        continue;
      }
      if (st?.isFile()) {
        let text: string;
        try {
          text = await fsp.readFile(this.abs(rel), "utf8");
        } catch {
          continue; // vanished again; a later event will tell
        }
        const hash = sha(text);
        if (this.diskFiles.get(rel) === hash || this.rejected.get(rel) === hash) continue;
        this.rejected.delete(rel);
        (this.diskFiles.has(rel) ? modified : added).set(rel, { text, hash });
        continue;
      }
      this.rejected.delete(rel);
      if (this.diskFiles.has(rel)) removedFiles.add(rel);
      if (this.diskDirs.has(rel)) removedDirs.add(rel);
    }
    // a directory can vanish before all its events arrive: treat what is gone as gone
    for (const f of [...removedFiles]) {
      for (let d = dirOf(f); d && this.diskDirs.has(d) && !fs.existsSync(this.abs(d)); d = dirOf(d)) removedDirs.add(d);
    }
    for (const d of removedDirs) for (const f of this.diskFiles.keys()) if (isUnder(f, d)) removedFiles.add(f);

    // a new folder whose files are still being written: wait for them, so the render of the
    // new instance cannot overwrite a model.json / gui.json the agent is about to finish
    if (this.deferrals < MAX_DEFERRALS) {
      for (const d of addedDirs) {
        const entries = await fsp.readdir(this.abs(d), { withFileTypes: true }).catch(() => []);
        if (entries.some((e) => e.isFile() && !added.has(`${d}/${e.name}`))) {
          this.deferrals++;
          for (const rel of paths) this.pending.add(rel);
          this.schedule();
          return;
        }
      }
    }
    this.deferrals = 0;

    if (!fs.existsSync(this.root)) rootGone = true;
    const missingService = rootGone ? undefined : this.roots.find((s) => !fs.existsSync(this.abs(encodeName(s.name))));
    if (rootGone) return this.refuse("the mirror folder was removed", [...this.diskFiles.keys()], true);
    if (missingService) {
      const dir = encodeName(missingService.name);
      const all = [...this.diskFiles.keys()].filter((f) => isUnder(f, dir));
      return this.refuse(`the service directory ${missingService.name} was removed; nothing was applied`, [...all, ...removedFiles, ...modified.keys()], false);
    }
    if (added.size + modified.size + addedDirs.size + removedFiles.size + removedDirs.size === 0) return;

    // ---- plan (read-only): parse everything, find renames, count deletions
    const docs = new Map<string, DocNode>();
    for (const list of [added, modified]) {
      for (const [rel, f] of list) {
        if (!rel.endsWith(".json")) continue;
        const r = parseDoc(f.text);
        if (r.error !== undefined) {
          this.reject(rel, f.hash, r.error);
          list.delete(rel);
        } else docs.set(rel, r.doc!);
      }
    }

    const dirMoves = this.findDirMoves(removedDirs, addedDirs, removedFiles, added, modified);
    const fileMoves = this.findFileMoves(removedFiles, added);
    const destroyed = new Set<MNode>();
    let destroyCount = 0;
    const markDestroy = (n: MNode) => {
      for (const d of destroyed) if (inside(n, d)) return;
      destroyed.add(n);
      destroyCount += subtreeSize(n);
    };
    for (const d of removedDirs) {
      const n = this.layout.dirs.get(d);
      if (n && (!n.parent || !this.dirCovered(d, removedDirs))) markDestroy(n);
    }
    const restoreLater: string[] = [];
    for (const f of removedFiles) {
      const u = this.layout.files.get(f);
      if (!u || [...removedDirs].some((d) => isUnder(f, d))) continue;
      if (u.kind === "props" || u.kind === "model" || u.kind === "init") restoreLater.push(f);
      else markDestroy(u.node);
    }
    for (const [rel, f] of modified) {
      const u = this.layout.files.get(rel);
      if (!u) continue;
      void f;
      const doc = docs.get(rel);
      if (doc) destroyCount += this.countRemoved(u.node, doc, u.kind !== "json");
    }
    if (destroyCount > this.threshold) {
      return this.refuse(
        `batch would destroy ${destroyCount} instances (limit ${this.threshold}); nothing was applied. Use the delete tool for intentional bulk deletes`,
        [...removedFiles, ...restoreLater, ...modified.keys()],
        false,
      );
    }

    // ---- mutate the shadow and build the ops
    const plan = new Plan();
    for (const m of dirMoves) this.applyDirMove(m, plan);
    if (dirMoves.length) this.computeLayout();
    for (const m of fileMoves) this.applyFileMove(m, plan);
    if (fileMoves.length) this.computeLayout();
    for (const n of destroyed) {
      plan.destroys.push({ op: "destroy", id: n.id });
      this.dropSubtree(n);
    }
    for (const rel of restoreLater) this.diskFiles.delete(rel);

    for (const rel of [...addedDirs].sort((a, b) => a.length - b.length)) this.createDir(rel, docs.get(`${rel}/gui.json`)?.cls, plan);
    const order = (r: string) => (["model.json", "gui.json", "_props.json"].includes(baseOf(r)) ? 0 : 1);
    for (const rel of [...added.keys()].sort((a, b) => order(a) - order(b) || a.length - b.length)) {
      this.createFromFile(rel, added.get(rel)!, docs.get(rel), plan);
    }
    for (const [rel, f] of modified) this.applyModified(rel, f, docs.get(rel), plan);
    // what the agent wrote is on disk now; a render that names it differently replaces it
    for (const list of [added, modified]) for (const [rel, f] of list) this.diskFiles.set(rel, f.hash);
    for (const rel of addedDirs) if (this.layout.dirs.has(rel)) this.diskDirs.add(rel);

    if (plan.empty) {
      await this.render();
      return;
    }
    let res: any;
    try {
      res = await this.send("mirror_apply", { ops: plan.ops }, 120_000);
    } catch (e: any) {
      this.logError(`could not apply to Studio (${e.message}); the files will be reconciled on reconnect`);
      for (const n of plan.creates) this.dropProvisional(n.t as number);
      await this.render();
      return;
    }
    for (const c of res?.created ?? []) this.adopt(c.t, c.node);
    for (const c of plan.creates) if (this.nodes.has(c.t as number)) this.failCreate(c.t as number, plan);
    this.applyDelta({ upserts: res?.nodes ?? [] });
    for (const e of res?.errors ?? []) this.logError(`REJECTED ${e.where ?? "edit"}: ${e.message ?? e}`);
    this.applied++;
    this.note(`applied ${plan.ops.length} change(s) from disk`);
    await this.render();
  }

  private dirCovered(d: string, removed: Set<string>) {
    for (const o of removed) if (o !== d && isUnder(d, o)) return true;
    return false;
  }

  private dropProvisional(id: number) {
    const n = this.nodes.get(id);
    if (n) this.dropSubtree(n);
  }

  private failCreate(id: number, plan: Plan) {
    const rel = plan.origin.get(id);
    this.dropProvisional(id);
    if (rel && this.diskFiles.has(rel)) {
      this.rejected.set(rel, this.diskFiles.get(rel)!);
    }
  }

  private adopt(tmp: number, w: Wire) {
    const n = this.nodes.get(tmp);
    if (!n || !w || typeof w.i !== "number") return;
    this.nodes.delete(tmp);
    n.id = w.i;
    this.nodes.set(w.i, n);
    n.name = w.n;
    n.cls = w.c;
    n.props = w.props ?? {};
    n.attrs = w.attrs;
    n.tags = w.tags;
    n.source = w.src;
    this.touch(n);
  }

  private async refuse(reason: string, files: string[], rootGone: boolean) {
    this.refusals.push({ time: new Date().toISOString(), reason });
    this.logError(`REFUSED: ${reason}`);
    // disk is restored from the shadow so it keeps matching Studio
    for (const f of files) this.diskFiles.delete(f);
    if (rootGone) {
      this.diskDirs.clear();
      this.lastHashes.clear();
      await fsp.mkdir(this.root, { recursive: true });
      await this.render();
      await this.startWatcher();
      return;
    }
    for (const d of [...this.diskDirs]) if (!fs.existsSync(this.abs(d))) this.diskDirs.delete(d);
    await this.render();
  }

  private countRemoved(n: MNode, doc: DocNode, inModel: boolean): number {
    if (!doc.hasChildren) return 0;
    const m = matchChildren(n.children.filter(inJson(inModel)), doc.children);
    let c = 0;
    for (const r of m.removed) c += subtreeSize(r);
    for (const p of m.pairs) c += this.countRemoved(p.old, p.doc, inModel);
    return c;
  }

  // ---- renames

  private filesUnder(dir: string, source: Iterable<string>) {
    const out: string[] = [];
    for (const f of source) if (isUnder(f, dir)) out.push(f.slice(dir.length + 1));
    return out.sort();
  }

  private findDirMoves(removedDirs: Set<string>, addedDirs: Set<string>, removedFiles: Set<string>, added: Map<string, { text: string; hash: string }>, modified: Map<string, { text: string; hash: string }>) {
    const moves: { from: string; to: string; node: MNode }[] = [];
    const tops = (s: Set<string>) => [...s].filter((d) => ![...s].some((o) => o !== d && isUnder(d, o)));
    for (const from of tops(removedDirs)) {
      const node = this.layout.dirs.get(from);
      if (!node || !node.parent) continue;
      const list = this.filesUnder(from, this.diskFiles.keys());
      for (const to of tops(addedDirs)) {
        const entry = this.dirEntry(to);
        if (!entry || !sameContainerKind(entry.cls, node.cls)) continue;
        const listNew = this.filesUnder(to, added.keys());
        if (list.length !== listNew.length || list.some((f, i) => f !== listNew[i])) continue;
        moves.push({ from, to, node });
        removedDirs.delete(from);
        for (const d of [...removedDirs]) if (isUnder(d, from)) removedDirs.delete(d);
        addedDirs.delete(to);
        this.diskDirs.add(to);
        for (const d of [...addedDirs]) {
          if (isUnder(d, to)) {
            this.diskDirs.add(d);
            addedDirs.delete(d);
          }
        }
        for (const f of list) {
          const oldRel = `${from}/${f}`;
          const newRel = `${to}/${f}`;
          const file = added.get(newRel)!;
          // recorded at its new path; an edit made together with the rename is still applied
          if (this.diskFiles.get(oldRel) === file.hash) this.diskFiles.set(newRel, file.hash);
          else modified.set(newRel, file);
          removedFiles.delete(oldRel);
          added.delete(newRel);
        }
        break;
      }
    }
    return moves;
  }

  private dirEntry(rel: string): { name: string; cls: string; owner?: string[] } | null {
    const base = baseOf(rel);
    const parentRel = dirOf(rel);
    if (this.isModelDir(parentRel)) {
      const e = parseModelDir(base);
      return e && e.kind === "model" ? { name: e.name, cls: e.cls, owner: e.owner } : null;
    }
    const e = parseLooseDir(base) as Extract<LooseEntry, { kind: "dir" }>;
    return { name: e.name, cls: e.cls };
  }

  private isModelDir(rel: string) {
    const n = this.layout.dirs.get(rel);
    return /\.(model|gui)$/.test(rel) && !!n && isContainer(n.cls);
  }

  private parentFor(rel: string, owner?: string[]): MNode | null {
    const parent = this.layout.dirs.get(dirOf(rel));
    if (!parent) return null;
    if (!owner?.length) return parent;
    return modelChildByTokens(parent, owner);
  }

  private applyMove(node: MNode, name: string, parent: MNode | null, rel: string, plan: Plan) {
    const problem = nameProblem(name);
    if (problem) return this.reject(rel, undefined, problem);
    if (!parent) return this.reject(rel, undefined, "its new location does not exist in the place");
    if (inside(parent, node)) return this.reject(rel, undefined, "cannot move an instance into itself");
    const op: Op = { op: "set", id: node.id };
    if (node.name !== name) op.name = name;
    if (node.parent !== parent) op.parent = parent.id;
    if (op.name === undefined && op.parent === undefined) return;
    plan.moves.push(op);
    if (node.parent !== parent) {
      this.detach(node);
      this.attach(node, parent);
    }
    node.name = name;
    this.touch(node);
  }

  private applyDirMove(m: { from: string; to: string; node: MNode }, plan: Plan) {
    const e = this.dirEntry(m.to);
    this.applyMove(m.node, e!.name, this.parentFor(m.to, e!.owner), m.to, plan);
  }

  private findFileMoves(removedFiles: Set<string>, added: Map<string, { text: string; hash: string }>) {
    const moves: { from: string; to: string; unit: Unit }[] = [];
    const byHash = new Map<string, string[]>();
    for (const [rel, f] of added) (byHash.get(f.hash) ?? byHash.set(f.hash, []).get(f.hash)!).push(rel);
    for (const from of removedFiles) {
      const h = this.diskFiles.get(from);
      const unit = this.layout.files.get(from);
      if (!h || !unit || unit.kind === "props" || unit.kind === "model" || unit.kind === "init") continue;
      const candidates = byHash.get(h);
      if (!candidates?.length) continue;
      const i = candidates.findIndex((to) => this.compatibleMove(unit, to));
      if (i < 0) continue;
      const to = candidates.splice(i, 1)[0];
      moves.push({ from, to, unit });
    }
    for (const m of moves) {
      removedFiles.delete(m.from);
      this.diskFiles.set(m.to, added.get(m.to)!.hash);
      added.delete(m.to);
    }
    return moves;
  }

  private fileEntry(rel: string): (LooseEntry | ModelEntry) | null {
    const file = baseOf(rel);
    return this.isModelDir(dirOf(rel)) ? parseModelFile(file) : parseLooseFile(file);
  }

  private compatibleMove(unit: Unit, to: string) {
    const e = this.fileEntry(to);
    if (!e || e.kind === "init" || e.kind === "dir" || e.kind === "model") return false;
    return e.cls === unit.node.cls;
  }

  private applyFileMove(m: { from: string; to: string; unit: Unit }, plan: Plan) {
    const e = this.fileEntry(m.to)!;
    if ("owner" in e) {
      const name = e.kind === "script" ? e.name : m.unit.node.name;
      this.applyMove(m.unit.node, name, this.parentFor(m.to, e.owner), m.to, plan);
    } else if (e.kind === "script" || e.kind === "json") {
      this.applyMove(m.unit.node, e.name, this.parentFor(m.to), m.to, plan);
    }
  }

  // ---- creates

  private createNode(parent: MNode, cls: string, name: string, doc: DocNode | undefined, source: string | undefined, rel: string, plan: Plan): MNode | null {
    const problem = nameProblem(name);
    if (problem) {
      this.reject(rel, undefined, problem);
      return null;
    }
    const id = this.tmpId--;
    const n: MNode = { id, parent, cls, name, props: doc?.props ?? {}, attrs: doc?.attrs, tags: doc?.tags, source, children: [] };
    this.nodes.set(id, n);
    parent.children.push(n);
    this.touch(n);
    plan.origin.set(id, rel);
    const op: Op = { op: "create", t: id, parent: parent.id, class: cls, name };
    if (doc && Object.keys(doc.props).length) op.props = doc.props;
    if (doc?.attrs) op.attrs = doc.attrs;
    if (doc?.tags) op.tags = doc.tags;
    if (source !== undefined) op.source = source;
    if (doc?.csg) op.csg = doc.csg;
    plan.creates.push(op);
    for (const c of doc?.children ?? []) this.createNode(n, c.cls!, c.name!, c, undefined, rel, plan);
    return n;
  }

  private createDir(rel: string, guiClass: string | undefined, plan: Plan) {
    const e = this.dirEntry(rel);
    if (!e) return this.reject(rel, undefined, "inside a model only <Name>.model and <Name>.gui directories are allowed");
    const parent = this.parentFor(rel, e.owner);
    if (!parent) return this.reject(rel, undefined, "its parent is not in the place (services are created by Studio)");
    const isGui = /\.gui$/.test(rel);
    if (isGui && guiClass && !GUI_CLASSES.has(guiClass)) return this.reject(rel, undefined, `gui.json class must be ScreenGui, SurfaceGui or BillboardGui, not ${guiClass}`);
    const n = this.createNode(parent, isGui ? (guiClass ?? "ScreenGui") : e.cls, e.name, undefined, undefined, rel, plan);
    if (n) this.layout.dirs.set(rel, n);
  }

  private createFromFile(rel: string, f: { text: string; hash: string }, doc: DocNode | undefined, plan: Plan) {
    const base = baseOf(rel);
    if (!rel.includes("/")) return this.reject(rel, f.hash, "only service directories live at the top level");
    const parent = this.layout.dirs.get(dirOf(rel));
    if (!parent) return this.reject(rel, f.hash, "its directory is not part of the place");
    if (base === "_props.json" || base === "model.json" || base === "gui.json") {
      if (base !== "_props.json" && !this.isModelDir(dirOf(rel))) return this.reject(rel, f.hash, `${base} belongs in a Name.model / Name.gui directory`);
      if (doc) this.applyDoc(parent, doc, base !== "_props.json", rel, plan);
      return;
    }
    if (this.isModelDir(dirOf(rel))) {
      const e = parseModelFile(base);
      if (!e || e.kind === "model") return this.reject(rel, f.hash, "not a valid file name inside a model (see AGENTS.md)");
      const owner = modelChildByTokens(parent, e.owner);
      if (!owner) return this.reject(rel, f.hash, `owner "${e.owner.join("+")}" not found in the model`);
      if (e.kind === "script") this.createNode(owner, e.cls, e.name, undefined, f.text, rel, plan);
      else if (doc) this.createNode(owner, e.cls, doc.name ?? e.cls, doc, undefined, rel, plan);
      return;
    }
    const e = parseLooseFile(base);
    if (!e) return this.reject(rel, f.hash, "not a mirror file name (see AGENTS.md); it was ignored");
    if (e.kind === "script") this.createNode(parent, e.cls, e.name, undefined, f.text, rel, plan);
    else if (e.kind === "json" && doc) this.createNode(parent, e.cls, e.name, doc, undefined, rel, plan);
    else if (e.kind === "init") plan.set(parent.id, { source: f.text });
  }

  // ---- modifications

  private applyDoc(node: MNode, doc: DocNode, inModel: boolean, rel: string, plan: Plan) {
    if (doc.csg) return this.reject(rel, undefined, `"${node.name}" already exists; "csg" only applies when an instance is created (remove the key, or use a new name)`);
    const d = diffNode(node, doc);
    if (d) plan.set(node.id, d);
    if (!doc.hasChildren) return;
    const m = matchChildren(node.children.filter(inJson(inModel)), doc.children);
    for (const p of m.pairs) {
      if (p.doc.name !== p.old.name) {
        const problem = nameProblem(p.doc.name!);
        if (problem) this.reject(rel, undefined, problem);
        else plan.set(p.old.id, { name: p.doc.name });
      }
      this.applyDoc(p.old, p.doc, inModel, rel, plan);
    }
    for (const a of m.added) this.createNode(node, a.cls!, a.name!, a, undefined, rel, plan);
    for (const r of m.removed) {
      plan.destroys.push({ op: "destroy", id: r.id });
      this.dropSubtree(r);
    }
  }

  private applyModified(rel: string, f: { text: string }, doc: DocNode | undefined, plan: Plan) {
    const u = this.layout.files.get(rel);
    if (!u) return;
    if (u.kind === "script" || u.kind === "init") {
      if (u.node.source !== f.text) plan.set(u.node.id, { source: f.text });
      return;
    }
    if (!doc) return;
    if (u.kind === "ownedJson") {
      const want = doc.name ?? u.node.cls;
      if (want !== u.node.name) {
        const problem = nameProblem(want);
        if (problem) this.reject(rel, undefined, problem);
        else plan.set(u.node.id, { name: want });
      }
    }
    if (u.kind === "model" && doc.cls && doc.cls !== u.node.cls) return this.reject(rel, undefined, `"class" of an existing ${u.node.cls} cannot change; make a new directory instead`);
    this.applyDoc(u.node, doc, u.kind !== "json", rel, plan);
  }
}
