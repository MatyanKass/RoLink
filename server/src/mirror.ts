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
  dropSensitive,
  emptyLayout,
  inJson,
  isContainer,
  isScript,
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
import { clean } from "./toolbox.js";

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

/** Marker and manifest: which files and directories this mirror wrote (and so owns). */
const MARKER = ".rolink-mirror.json";
const TMP_DIR = ".rolink-tmp";
const TRASH_DIR = ".rolink-trash";
/** Agent edits that lost to a Studio change, kept instead of overwritten. */
const CONFLICT_DIR = ".rolink-conflicts";
const ROOT_FILES = new Set(["AGENTS.md", "_tree.txt", "_errors.log", MARKER]);
/** Trash generations of earlier runs kept on start; older ones are removed (they hold only mirror-owned files). */
const KEEP_TRASH_RUNS = 3;
const TRASH_RUN = /^run-\d{8}T\d{6}/;
/** An edit whose apply keeps failing while Studio answers is left on disk, listed, and no longer retried. */
const MAX_APPLY_ATTEMPTS = 3;
const MAX_FOREIGN_LISTED = 1000;
const STRUCTURE_FILES = new Set(["_props.json", "model.json", "gui.json"]);
const MAX_ERROR_LINES = 500;
const DUMP_TIMEOUT = 120_000;
/** must outlast the watcher's awaitWriteFinish, or a folder and its files land in separate batches */
const MIN_DISK_DEBOUNCE = 250;
const MAX_DEFERRALS = 20;
const DEFAULT_DELETE_THRESHOLD = 25;
/** The rolling budget below makes a higher per-batch limit meaningless. */
const MAX_DELETE_THRESHOLD = 100;
const DEFAULT_DESTROY_BUDGET = 100;
const DEFAULT_DESTROY_WINDOW_MS = 60_000;
/** upserts whose parent has not arrived yet; a parent can come in a later delta */
const MAX_HELD_ORPHANS = 20_000;

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
  /** instances disk edits may destroy within destroyWindowMs, across batches */
  destroyBudget?: number;
  destroyWindowMs?: number;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const isUnder = (rel: string, dir: string) => rel.startsWith(dir + "/");
const dirOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const baseOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");

/**
 * A relative path read from the manifest on disk, which anything can edit: only plain
 * segments below the root, and never a dot-entry (.git, .rolink-*), are accepted.
 */
export function ownedPathOk(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 2000) return false;
  if (/[\\:\0]/.test(rel) || rel.startsWith("/")) return false;
  return rel.split("/").every((seg) => seg.length > 0 && !seg.startsWith(".") && seg !== "..");
}

/** A file name the mirror itself could have written inside a service directory. */
function mirrorFileName(base: string) {
  return STRUCTURE_FILES.has(base) || parseLooseFile(base) !== null || parseModelFile(base) !== null;
}

function readText(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

interface Unapplied {
  since: string;
  reason: string;
  attempts: number;
}

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
  /** new directories that stand for an instance that already exists */
  adopted = new Set<string>();

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
  private destroyBudget: number;
  private destroyWindow: number;
  private recentDestroys: { at: number; count: number }[] = [];

  private nodes = new Map<number, MNode>();
  private roots: MNode[] = [];
  private others: string[] = [];
  private layout: Layout = emptyLayout();
  private diskFiles = new Map<string, string>();
  private diskDirs = new Set<string>();
  private rejected = new Map<string, string>();
  private errors: string[] = [];
  private refusals: { time: string; reason: string }[] = [];
  private lastHashes = new Map<string, string>();
  private knownSkipped = new Set<string>();
  /** disk edits not in Studio yet: an apply failed, or Studio was unreachable */
  private unapplied = new Map<string, Unapplied>();
  /** agent versions kept in CONFLICT_DIR because Studio's change won */
  private conflicts: { time: string; file: string; kept?: string; reason: string }[] = [];
  /** files in service folders the mirror did not write, found at start: left alone */
  private foreign: string[] = [];
  private foreignCount = 0;
  /** files the mirror did not write sitting where it wants to write: never overwritten */
  private blocked = new Set<string>();
  /** files to put back from the shadow even though their disk content is not one we wrote */
  private forceRestore = new Set<string>();
  /** one-time notices for the agent, delivered with its next tool result */
  private alerts: string[] = [];
  /** an apply failed: the shadow may not match Studio, so nothing is written until a dump succeeds */
  private stale = false;
  /** the render right after a dump: a file both sides changed is a conflict, and Studio wins it */
  private reconciling = false;
  private manifestSig = "";
  private startedAt = new Date().toISOString();
  private trashRun?: string;

  private watcher?: FSWatcher;
  private pending = new Set<string>();
  private diskTimer?: NodeJS.Timeout;
  private renderTimer?: NodeJS.Timeout;
  private q: Promise<unknown> = Promise.resolve();
  private dumping = false;
  private buffered: any[] = [];
  private held = new Map<number, Wire>();
  private heldOverflowLogged = false;
  private tmpId = -1;
  private stopped = false;
  private applied = 0;
  private lastActivity = "";
  private deferrals = 0;

  constructor(opts: MirrorOptions, send: SendFn, placeName: string) {
    this.root = path.resolve(opts.dir);
    this.services = opts.services?.length ? opts.services : DEFAULT_SERVICES;
    const t = opts.deleteThreshold;
    this.threshold = t === undefined || Number.isNaN(t) ? DEFAULT_DELETE_THRESHOLD : Math.min(MAX_DELETE_THRESHOLD, Math.max(0, Math.floor(t)));
    this.debounce = opts.debounceMs ?? 200;
    this.destroyBudget = opts.destroyBudget ?? DEFAULT_DESTROY_BUDGET;
    this.destroyWindow = opts.destroyWindowMs ?? DEFAULT_DESTROY_WINDOW_MS;
    this.send = send;
    this.placeName = placeName;
  }

  // ---------------------------------------------------------- lifecycle

  async start() {
    await this.prepareRoot();
    const res = await this.enqueue(async () => {
      await this.dumpAll();
      await this.render();
      await this.findForeign();
      return { instances: this.nodes.size, files: this.diskFiles.size };
    });
    await this.startWatcher();
    const extra: Record<string, unknown> = {};
    if (this.trashRun) extra.earlierRunMovedTo = `${TRASH_DIR}/${this.trashRun}`;
    if (this.foreignCount) {
      extra.foreignFiles = this.foreign.slice(0, 20);
      extra.foreignNote = `${this.foreignCount} file(s) in the service folders were not written by the mirror; they are left as they are and not applied to Studio (see mirror_status)`;
    }
    return { dir: this.root, place: this.placeName, services: this.roots.map((s) => s.name), ...res, ...extra };
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.diskTimer);
    clearTimeout(this.renderTimer);
    await this.watcher?.close();
    await this.q.catch(() => {});
    await this.writeManifest().catch(() => {});
    try {
      await this.send("mirror", { action: "stop" }, 10_000);
    } catch {}
  }

  /**
   * Reload from Studio: after a reconnect, or an edit it did not take. A file only Studio
   * changed is rewritten; a file only the agent changed keeps the agent's version, which is
   * then applied; a file both changed is a conflict: Studio's version is written and the
   * agent's is kept in CONFLICT_DIR and reported.
   */
  resync(why = "after reconnect") {
    return this.enqueue(async () => {
      if (this.stopped) return;
      await this.dumpAll();
      this.stale = false;
      this.reconciling = true;
      try {
        await this.render();
      } finally {
        this.reconciling = false;
      }
      this.note(`resynced from Studio ${why}`);
      if (this.unapplied.size) {
        for (const rel of this.unapplied.keys()) this.pending.add(rel);
        this.schedule();
      }
    });
  }

  status() {
    return {
      active: !this.stopped,
      dir: this.root,
      place: this.placeName,
      services: this.roots.map((s) => s.name),
      instances: this.nodes.size,
      heldOrphans: this.held.size,
      files: this.diskFiles.size,
      deleteThreshold: this.threshold,
      batchesApplied: this.applied,
      waitingForStudio: this.stale,
      unappliedEdits: [...this.unapplied].slice(0, 50).map(([file, u]) => ({ file, ...u })),
      unappliedCount: this.unapplied.size,
      conflicts: this.conflicts.slice(-20),
      foreignFiles: this.foreign.slice(0, 50),
      foreignCount: this.foreignCount,
      blockedFiles: [...this.blocked].slice(0, 50),
      refusedDeletes: this.refusals.slice(-10),
      rejectedFiles: [...this.rejected.keys()].slice(0, 50),
      recentErrors: this.errors.slice(-10),
      lastActivity: this.lastActivity,
    };
  }

  /** Notices the agent has not seen yet; each is handed out once. */
  takeAlerts(): string[] {
    return this.alerts.splice(0);
  }

  /** A standing warning while disk edits are not in Studio, or null. */
  pendingWarning(): string | null {
    if (!this.unapplied.size) return null;
    const list = [...this.unapplied.keys()].slice(0, 5).join(", ");
    const more = this.unapplied.size > 5 ? ` and ${this.unapplied.size - 5} more` : "";
    return `${this.unapplied.size} file edit(s) are on disk but NOT in Studio yet (${list}${more}). They are kept and applied when Studio answers again; see mirror_status.`;
  }

  private alert(msg: string) {
    const m = clean(msg, 1000);
    if (!this.alerts.includes(m)) this.alerts.push(m);
    if (this.alerts.length > 20) this.alerts.splice(0, this.alerts.length - 20);
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

  private logError(raw: string) {
    // goes into a file agents read: nothing in it may start a new line or hide text
    const msg = clean(raw, 2000);
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
    // dot-entries (.git, .gitignore, .vscode...) never make a folder "not empty": they are never touched
    if (entries.some((e) => !e.startsWith(".")) && !entries.includes(MARKER)) {
      throw new Error(`${this.root} is not empty and is not a RoLink mirror; pick an empty or new folder`);
    }
    if (entries.includes(MARKER)) await this.retireEarlierRun(entries);
    await fsp.rm(path.join(this.root, TMP_DIR), { recursive: true, force: true });
    await fsp.mkdir(path.join(this.root, TMP_DIR), { recursive: true });
    await this.writeManifest(true);
  }

  /**
   * Files of an earlier run are stale. Only what that run wrote (its manifest) moves to a
   * new generation in TRASH_DIR; everything else in the folder stays where it is.
   */
  private async retireEarlierRun(entries: string[]) {
    let manifest: any = null;
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(this.root, MARKER), "utf8"));
    } catch {}
    const owned = Array.isArray(manifest?.files)
      ? { files: (manifest.files as unknown[]).filter(ownedPathOk), dirs: (Array.isArray(manifest.dirs) ? (manifest.dirs as unknown[]) : []).filter(ownedPathOk) }
      : await this.legacyOwned(entries);
    const run = `run-${stamp()}-${randomUUID().slice(0, 8)}`;
    const trashRel = `${TRASH_DIR}/${run}`;
    const dirs = new Set(owned.dirs);
    const checked = new Set<string>();
    let moved = 0;
    for (const rel of owned.files) {
      try {
        const st = await fsp.lstat(this.abs(rel));
        if (!st.isFile()) continue;
        await this.assertNoSymlink(dirOf(rel) || rel, checked);
        await fsp.mkdir(this.abs(dirOf(`${trashRel}/${rel}`)), { recursive: true });
        await fsp.rename(this.abs(rel), this.abs(`${trashRel}/${rel}`));
        moved++;
        for (let d = dirOf(rel); d; d = dirOf(d)) dirs.add(d);
      } catch {}
    }
    // directories the mirror made: removed only once empty, so anything else in them keeps them
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      try {
        const st = await fsp.lstat(this.abs(d));
        if (st.isDirectory()) await fsp.rmdir(this.abs(d));
      } catch {}
    }
    if (moved) {
      this.trashRun = run;
      this.note(`moved ${moved} file(s) of the earlier run to ${trashRel}`);
    }
    // older generations hold only files a mirror wrote; anything else in TRASH_DIR (from older versions) is kept
    try {
      const runs = (await fsp.readdir(this.abs(TRASH_DIR))).filter((e) => TRASH_RUN.test(e)).sort();
      for (const old of runs.slice(0, Math.max(0, runs.length - KEEP_TRASH_RUNS))) {
        await fsp.rm(this.abs(`${TRASH_DIR}/${old}`), { recursive: true, force: true });
      }
    } catch {}
  }

  /**
   * A marker from before the manifest: the files the mirror would have written are those with
   * a mirror file name inside a service directory. Nothing outside the service directories.
   */
  private async legacyOwned(entries: string[]) {
    const services = new Set([...DEFAULT_SERVICES, ...this.services].map((s) => encodeName(s)));
    const files: string[] = [];
    const dirs: string[] = [];
    const walk = async (rel: string, depth: number) => {
      if (depth > 64) return;
      let list: fs.Dirent[];
      try {
        list = await fsp.readdir(this.abs(rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        if (e.name.startsWith(".")) continue;
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          dirs.push(child);
          await walk(child, depth + 1);
        } else if (e.isFile() && mirrorFileName(e.name)) files.push(child);
      }
    };
    for (const top of entries) {
      if (!services.has(top)) continue;
      const st = await fsp.lstat(this.abs(top)).catch(() => undefined);
      if (!st?.isDirectory()) continue;
      dirs.push(top);
      await walk(top, 0);
    }
    return { files, dirs };
  }

  /** The marker, with what this run owns: a later start moves exactly these and nothing else. */
  private async writeManifest(force = false) {
    const files = [...this.diskFiles.keys()].sort();
    const dirs = [...this.diskDirs].sort();
    const sig = sha(files.join("\n") + "\0" + dirs.join("\n"));
    if (!force && sig === this.manifestSig) return;
    const body = JSON.stringify({ version: 2, place: this.placeName, startedAt: this.startedAt, files, dirs }) + "\n";
    await this.atomicWrite(MARKER, body);
    this.manifestSig = sig;
  }

  /** Files in the service folders that the mirror did not write: listed, never moved. */
  private async findForeign() {
    const found: string[] = [];
    let count = 0;
    const walk = async (rel: string, depth: number) => {
      if (depth > 64) return;
      let list: fs.Dirent[];
      try {
        list = await fsp.readdir(this.abs(rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        if (e.name.startsWith(".")) continue;
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(child, depth + 1);
        else if (!this.diskFiles.has(child)) {
          count++;
          if (found.length < MAX_FOREIGN_LISTED) found.push(child);
        }
      }
    };
    for (const s of this.roots) await walk(encodeName(s.name), 0);
    this.foreign = found.sort();
    this.foreignCount = count;
    if (count) this.note(`${count} file(s) in the service folders were not written by the mirror; left as they are`);
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
    // a dump that dies halfway must not leave a partial shadow for the next render to act on
    const saved = { nodes: this.nodes, roots: this.roots, others: this.others, held: this.held };
    try {
      const start = await this.send("mirror", { action: "start", services: this.services }, 30_000);
      this.nodes = new Map();
      this.roots = [];
      this.held = new Map();
      this.others = Array.isArray(start?.others) ? start.others.filter((x: unknown) => typeof x === "string") : [];
      for (;;) {
        const r = await this.send("mirror", { action: "next" }, DUMP_TIMEOUT);
        for (const w of r?.nodes ?? []) this.ingest(w);
        if (r?.done !== false) break;
      }
    } catch (e) {
      Object.assign(this, saved);
      throw e;
    } finally {
      this.dumping = false;
      // Also after a failed dump: these changes are newer than the restored shadow, and left
      // buffered they would be replayed over the next dump, bringing back stale or deleted instances.
      for (const ev of this.buffered.splice(0)) this.applyDelta(ev);
    }
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
    const n: MNode = { id: w.i, parent: parent ?? null, cls: w.c, name: w.n, props: dropSensitive(w.props) ?? {}, attrs: w.attrs, tags: w.tags, source: w.src, children: [] };
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
      ["props", dropSensitive(w.props) ?? {}],
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
      this.forgetHeld(id);
      const n = this.nodes.get(id);
      if (n && n.parent) this.dropSubtree(n);
    }
    for (const w of ev.upserts ?? []) {
      if (w && typeof w.i === "number" && typeof w.p === "number" && w.p !== 0 && !this.nodes.has(w.p)) {
        this.hold(w);
      } else {
        if (w) this.held.delete(w.i);
        this.ingest(w);
      }
    }
    this.adoptHeld();
  }

  /** Keeps an upsert until its parent exists; the plugin may split one batch over several deltas. */
  private hold(w: Wire) {
    this.held.delete(w.i);
    this.held.set(w.i, w);
    if (this.held.size <= MAX_HELD_ORPHANS) return;
    this.held.delete(this.held.keys().next().value!);
    if (!this.heldOverflowLogged) {
      this.heldOverflowLogged = true;
      this.logError(`more than ${MAX_HELD_ORPHANS} instances are waiting for a parent; the oldest are being dropped`);
    }
  }

  private adoptHeld() {
    for (let progress = this.held.size > 0; progress; ) {
      progress = false;
      for (const [id, w] of this.held) {
        if (!this.nodes.has(w.p)) continue;
        this.held.delete(id);
        this.ingest(w);
        progress = true;
      }
    }
  }

  private forgetHeld(id: number) {
    if (this.held.size === 0) return;
    this.held.delete(id);
    for (const [child, w] of this.held) if (w.p === id) this.forgetHeld(child);
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

  /**
   * `mayReplace` runs synchronously right before the rename, so nothing in this process can
   * slip between it and the rename, and an outside writer has only a sub-millisecond window.
   * Returns false, leaving the target alone, when it says no.
   */
  private async atomicWrite(rel: string, text: string, mayReplace?: () => boolean) {
    const tmp = path.join(this.root, TMP_DIR, randomUUID());
    await fsp.writeFile(tmp, text, "utf8");
    const target = this.abs(rel);
    for (let i = 0; ; i++) {
      if (mayReplace && !mayReplace()) {
        await fsp.rm(tmp, { force: true });
        return false;
      }
      try {
        fs.renameSync(tmp, target);
        return true;
      } catch (e: any) {
        if (i >= 6 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
          await fsp.rm(tmp, { force: true });
          throw e;
        }
        await new Promise((r) => setTimeout(r, 15 * (i + 1)));
      }
    }
  }

  /** Keeps an agent's version of a file that Studio's version replaces or removes. */
  private keepConflict(rel: string, text: string, reason: string) {
    const kept = `${CONFLICT_DIR}/${stamp()}/${rel}`;
    fs.mkdirSync(path.dirname(this.abs(kept)), { recursive: true });
    fs.writeFileSync(this.abs(kept), text, "utf8");
    this.conflicts.push({ time: new Date().toISOString(), file: rel, kept, reason });
    if (this.conflicts.length > 200) this.conflicts.splice(0, this.conflicts.length - 200);
    this.logError(`CONFLICT ${rel}: ${reason}; your version is kept at ${kept}`);
    this.alert(`mirror conflict on ${rel}: ${reason}. Studio's version is in the file now; your version is kept at ${kept}. Re-apply what you still need.`);
    return kept;
  }

  private async render() {
    if (this.stopped && this.diskFiles.size) return;
    if (this.stale) {
      // the shadow may not match Studio after a failed apply: write nothing from it until a dump succeeds
      await this.writeRootFiles();
      return;
    }
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
        const now = readText(this.abs(rel));
        if (now !== null && sha(now) !== this.diskFiles.get(rel) && !this.forceRestore.has(rel)) {
          // the agent edited it after our last write: keep that edit before the file goes
          this.keepConflict(rel, now, "Studio removed or renamed this instance after you edited its file");
          this.unapplied.delete(rel);
        }
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
    for (const rel of [...this.blocked]) if (!fs.existsSync(this.abs(rel))) this.blocked.delete(rel);
    const writes: [string, string, string][] = [];
    for (const [rel, unit] of layout.files) {
      const h = sha(unit.content);
      if (this.diskFiles.get(rel) === h) continue;
      if (this.rejected.has(rel)) continue; // keep the agent's broken file so it can be fixed
      if (this.blocked.has(rel)) continue; // not ours: never overwritten
      writes.push([rel, unit.content, h]);
    }
    let written = 0;
    for (let i = 0; i < writes.length; i += 32) {
      await Promise.all(
        writes.slice(i, i + 32).map(async ([rel, text, h]) => {
          const known = this.diskFiles.get(rel);
          try {
            await this.assertNoSymlink(dirOf(rel), checked);
            const force = this.forceRestore.has(rel);
            let outcome: "written" | "foreign" | "agent" | "same" | "conflict" | "restored" = "written";
            let conflictText = "";
            // runs right before the rename: decides from what is on disk at that moment
            const replaced = await this.atomicWrite(rel, text, () => {
              outcome = "written";
              const now = readText(this.abs(rel));
              if (now === null) {
                // the agent deleted a file Studio has changed meanwhile: Studio's version comes back
                if (this.reconciling && known !== undefined && !force) outcome = "restored";
              } else if (!force) {
                const nowHash = sha(now);
                if (known === undefined) {
                  if (nowHash === h) {
                    this.diskFiles.set(rel, h);
                    outcome = "same";
                    return false;
                  }
                  outcome = "foreign";
                  return false;
                }
                if (nowHash !== known) {
                  if (nowHash === h) {
                    this.diskFiles.set(rel, h);
                    outcome = "same";
                    return false;
                  }
                  if (!this.reconciling) {
                    outcome = "agent";
                    return false;
                  }
                  outcome = "conflict";
                  conflictText = now;
                }
              }
              if (outcome === "conflict") this.keepConflict(rel, conflictText, "Studio changed this file while your edit to it was not applied");
              this.diskFiles.set(rel, h); // before the rename, so its watcher event is recognised
              return true;
            });
            const o = outcome as string;
            if (replaced) {
              written++;
              this.forceRestore.delete(rel);
              if (o === "conflict") this.unapplied.delete(rel);
              if (o === "restored") {
                this.unapplied.delete(rel);
                this.conflicts.push({ time: new Date().toISOString(), file: rel, reason: "you deleted this file, but Studio changed the instance meanwhile; Studio's version was written back" });
                this.logError(`CONFLICT ${rel}: deleted on disk but changed in Studio; Studio's version was written back`);
                this.alert(`mirror conflict on ${rel}: you deleted it while Studio changed the instance; Studio's version was written back. Delete it again if you still mean it.`);
              }
            } else if (o === "agent") {
              // an agent saved this file since we last wrote it: its edit wins, the watcher brings it in
              this.diskFiles.set(rel, known!);
              this.pending.add(rel);
              this.schedule();
            } else if (o === "same") {
              this.unapplied.delete(rel);
            } else if (o === "foreign") {
              this.blocked.add(rel);
              this.logError(`KEPT ${rel}: this file was not written by the mirror, so it is not overwritten; Studio's version of the instance is not written until you move or delete it`);
              this.alert(`mirror: ${rel} was not written by the mirror and is left as it is; the mirror's file for that instance is written once you move or delete it`);
            }
          } catch (e: any) {
            // what was there is unchanged: still ours if it was, so the next render tries again
            if (known !== undefined) this.diskFiles.set(rel, known);
            else this.diskFiles.delete(rel);
            this.logError(`could not write ${rel}: ${e.message}`);
          }
        }),
      );
    }
    for (const rel of [...this.forceRestore]) if (!layout.files.has(rel)) this.forceRestore.delete(rel);
    await this.writeRootFiles();
    await this.writeManifest().catch((e) => this.logError(`could not write ${MARKER}: ${e.message}`));
    if (written) this.note(`wrote ${written} file(s)`);
  }

  private async writeRootFiles() {
    await this.writeRootFile("AGENTS.md", AGENTS_MD);
    await this.writeRootFile("_tree.txt", treeOverview(this.roots, this.others));
    await this.writeRootFile("_errors.log", this.errors.join("\n") + (this.errors.length ? "\n" : ""));
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

  /** Disk edits that are not in Studio. Returns false for the ones given up on. */
  private markUnapplied(paths: string[], reason: string, attempt: boolean) {
    const now = new Date().toISOString();
    const gaveUp: string[] = [];
    for (const rel of paths) {
      if (!rel) continue;
      const u = this.unapplied.get(rel) ?? { since: now, reason, attempts: 0 };
      u.reason = clean(reason, 300);
      if (attempt) u.attempts++;
      this.unapplied.set(rel, u);
      if (u.attempts >= MAX_APPLY_ATTEMPTS) {
        this.unapplied.delete(rel);
        const text = readText(this.abs(rel));
        if (text !== null) this.rejected.set(rel, sha(text));
        gaveUp.push(rel);
      }
    }
    if (gaveUp.length) {
      this.logError(`REJECTED ${gaveUp.join(", ")}: Studio failed to apply ${MAX_APPLY_ATTEMPTS} times (${reason}); the files are left as you wrote them and are not retried until you edit them again`);
      this.alert(`mirror: Studio failed to apply ${gaveUp.slice(0, 5).join(", ")}${gaveUp.length > 5 ? " and more" : ""} ${MAX_APPLY_ATTEMPTS} times (${reason}). Your files are left as you wrote them and listed under rejectedFiles in mirror_status.`);
    }
  }

  private async processBatch(paths: string[]) {
    if (this.stopped) return;
    const wasUnapplied = paths.filter((p) => this.unapplied.has(p));
    if (this.stale) {
      // the last apply failed and Studio has not been reloaded since: hold these until it is
      const held = paths.filter((p) => p && !this.blocked.has(p));
      if (held.length) {
        this.markUnapplied(held, "Studio has not answered since an earlier apply failed", false);
        await this.writeRootFiles();
      }
      return;
    }
    const outcome = await this.processBatchInner(paths);
    if (outcome === "deferred" || outcome === "failed") return;
    for (const p of paths) this.unapplied.delete(p);
    const applied = wasUnapplied.filter((p) => !this.rejected.has(p));
    if (outcome === "applied" && applied.length) {
      this.alert(`mirror: ${applied.length} kept edit(s) reached Studio after it answered again: ${applied.slice(0, 5).join(", ")}${applied.length > 5 ? " ..." : ""}`);
    }
  }

  private async processBatchInner(paths: string[]): Promise<"deferred" | "failed" | "refused" | "applied" | "none"> {
    // what disk looked like to us before this batch: restored if Studio does not take it
    const snapFiles = new Map(this.diskFiles);
    const snapDirs = new Set(this.diskDirs);
    let blockedGone = false;
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
      if (this.blocked.has(rel)) {
        // a file the mirror did not write, where it wants to write: ignored until moved or deleted
        if (!fs.existsSync(this.abs(rel))) {
          this.blocked.delete(rel);
          blockedGone = true;
        }
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

    // a file in a directory an earlier render left alone, because it held nothing yet
    for (const rel of added.keys()) {
      const d = dirOf(rel);
      if (!d || addedDirs.has(d) || this.layout.dirs.has(d)) continue;
      const e = this.dirEntry(d);
      const parent = e && this.parentFor(d, e.owner);
      if (e && parent && this.existingFor(d, e, parent)) addedDirs.add(d);
    }

    // a new folder whose files are still being written: wait for them, so the render of the
    // new instance cannot overwrite a model.json / gui.json the agent is about to finish
    if (this.deferrals < MAX_DEFERRALS) {
      for (const d of addedDirs) {
        const entries = await fsp.readdir(this.abs(d), { withFileTypes: true }).catch(() => []);
        if (entries.some((e) => e.isFile() && !added.has(`${d}/${e.name}`))) {
          this.deferrals++;
          for (const rel of paths) this.pending.add(rel);
          this.schedule();
          return "deferred";
        }
      }
    }
    this.deferrals = 0;

    if (!fs.existsSync(this.root)) rootGone = true;
    const missingService = rootGone ? undefined : this.roots.find((s) => !fs.existsSync(this.abs(encodeName(s.name))));
    if (rootGone) {
      await this.refuse("the mirror folder was removed", [...this.diskFiles.keys()], true);
      return "refused";
    }
    if (missingService) {
      const dir = encodeName(missingService.name);
      const all = [...this.diskFiles.keys()].filter((f) => isUnder(f, dir));
      await this.refuse(`the service directory ${missingService.name} was removed; nothing was applied`, [...all, ...removedFiles, ...modified.keys()], false);
      return "refused";
    }
    if (added.size + modified.size + addedDirs.size + removedFiles.size + removedDirs.size === 0) {
      if (blockedGone) await this.render();
      return "none";
    }

    // ---- plan (read-only): parse everything, find renames, count deletions
    const docs = new Map<string, DocNode>();
    for (const list of [added, modified]) {
      for (const [rel, f] of list) {
        if (!rel.endsWith(".json")) continue;
        const r = parseDoc(f.text);
        if (r.error !== undefined) {
          this.reject(rel, f.hash, r.error);
          list.delete(rel);
        } else if (r.doc.hasChildren && baseOf(rel) === "_props.json") {
          this.reject(rel, f.hash, '"children" is not allowed in _props.json; delete files instead, or edit children in model.json');
          list.delete(rel);
        } else docs.set(rel, r.doc);
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
    for (const rel of modified.keys()) {
      const doc = docs.get(rel);
      if (!doc) continue;
      let u = this.layout.files.get(rel);
      if (!u) {
        // an edit made together with a directory rename: the layout still has the old path
        const m = dirMoves.find((x) => isUnder(rel, x.to));
        if (m) u = this.layout.files.get(m.from + rel.slice(m.to.length));
      }
      if (u) destroyCount += this.countRemoved(u.node, doc, u.kind !== "json");
    }
    for (const rel of added.keys()) {
      const base = baseOf(rel);
      const doc = docs.get(rel);
      if (!doc?.hasChildren || (base !== "model.json" && base !== "gui.json")) continue;
      const node = this.layout.dirs.get(dirOf(rel));
      if (node) destroyCount += this.countRemoved(node, doc, true);
    }
    const refuseBatch = async (reason: string) => {
      // a new file where the layout has one (a re-added model.json) is put back too
      const restore = [...removedFiles, ...restoreLater, ...modified.keys(), ...[...added.keys()].filter((r) => this.layout.files.has(r)), ...(await this.undoMoves(dirMoves, fileMoves))];
      await this.refuse(reason, restore, false);
      return "refused" as const;
    };
    if (destroyCount > this.threshold) {
      return refuseBatch(`batch would destroy ${destroyCount} instances (limit ${this.threshold}); nothing was applied. Use the delete tool for intentional bulk deletes`);
    }
    let destroyEntry: { at: number; count: number } | undefined;
    if (destroyCount > 0) {
      const now = Date.now();
      this.recentDestroys = this.recentDestroys.filter((e) => now - e.at < this.destroyWindow);
      const recent = this.recentDestroys.reduce((sum, e) => sum + e.count, 0);
      if (recent + destroyCount > this.destroyBudget) {
        return refuseBatch(
          `batch would destroy ${destroyCount} instances on top of ${recent} in the last ${Math.round(this.destroyWindow / 1000)} s (limit ${this.destroyBudget}); nothing was applied. Use the delete tool for intentional bulk deletes`,
        );
      }
      destroyEntry = { at: now, count: destroyCount };
      this.recentDestroys.push(destroyEntry);
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
    for (const rel of restoreLater) {
      this.diskFiles.delete(rel);
      this.forceRestore.add(rel);
    }

    for (const rel of [...addedDirs].sort((a, b) => a.length - b.length)) this.createDir(rel, docs.get(`${rel}/gui.json`)?.cls, plan);
    const order = (r: string) => (["model.json", "gui.json", "_props.json"].includes(baseOf(r)) ? 0 : 1);
    for (const rel of [...added.keys()].sort((a, b) => order(a) - order(b) || a.length - b.length)) {
      this.createFromFile(rel, added.get(rel)!, docs.get(rel), plan);
    }
    for (const [rel, f] of modified) this.applyModified(rel, f, docs.get(rel), plan);
    // what the agent wrote is on disk now; a render that names it differently replaces it
    for (const list of [added, modified]) for (const [rel, f] of list) this.diskFiles.set(rel, f.hash);
    for (const rel of addedDirs) {
      // an adopted directory with nothing in it is not part of the layout yet: the render must leave it for the agent
      const emptyAdoption = plan.adopted.has(rel) && ![...this.diskFiles.keys()].some((f) => isUnder(f, rel));
      if (this.layout.dirs.has(rel) && !emptyAdoption) this.diskDirs.add(rel);
    }

    if (plan.empty) {
      await this.render();
      return "none";
    }
    let res: any;
    try {
      res = await this.send("mirror_apply", { ops: plan.ops }, 120_000);
    } catch (e: any) {
      // Never write the shadow over these edits: it is not what Studio has, and the edits are the agent's.
      // Bookkeeping goes back to before the batch, so the files read as changed and are applied again.
      this.diskFiles = snapFiles;
      this.diskDirs = snapDirs;
      for (const n of plan.creates) this.dropProvisional(n.t as number);
      // nothing was destroyed: the retry must not be charged twice against the budget
      if (destroyEntry) this.recentDestroys = this.recentDestroys.filter((x) => x !== destroyEntry);
      this.stale = true;
      const reason = clean(String(e?.message ?? e), 300);
      const touched = paths.filter((p) => p && !this.blocked.has(p));
      this.logError(`could not apply to Studio (${reason}); your edits stay on disk and are applied again once Studio is reloaded: ${touched.slice(0, 10).join(", ")}${touched.length > 10 ? " ..." : ""}`);
      this.markUnapplied(touched, reason, true);
      this.alert(`mirror: Studio did not take your file edits (${reason}). They are kept on disk, NOT in Studio yet, and are applied again once Studio answers: ${touched.slice(0, 5).join(", ")}${touched.length > 5 ? " ..." : ""}`);
      await this.writeRootFiles();
      // queued, not awaited: this batch holds the queue. If Studio is gone it fails, and a reconnect resyncs
      void this.resync("after a failed apply").catch(() => {});
      return "failed";
    }
    for (const c of res?.created ?? []) this.adopt(c.t, c.node);
    for (const c of plan.creates) if (this.nodes.has(c.t as number)) this.failCreate(c.t as number, plan);
    this.applyDelta({ upserts: res?.nodes ?? [] });
    for (const e of res?.errors ?? []) this.logError(`REJECTED ${e.where ?? "edit"}: ${e.message ?? e}`);
    this.applied++;
    this.note(`applied ${plan.ops.length} change(s) from disk`);
    await this.render();
    return "applied";
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
    n.props = dropSensitive(w.props) ?? {};
    n.attrs = w.attrs;
    n.tags = w.tags;
    n.source = w.src;
    this.touch(n);
  }

  private async refuse(reason: string, files: string[], rootGone: boolean) {
    this.refusals.push({ time: new Date().toISOString(), reason: clean(reason, 2000) });
    this.logError(`REFUSED: ${reason}`);
    // disk is restored from the shadow so it keeps matching Studio
    for (const f of files) {
      this.diskFiles.delete(f);
      this.forceRestore.add(f);
    }
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

  /** A refused batch must not keep its renames: put them back. Returns the files to restore from the shadow. */
  private async undoMoves(dirMoves: { from: string; to: string }[], fileMoves: { from: string; to: string }[]): Promise<string[]> {
    const restore: string[] = [];
    const undo = async (from: string, to: string) => {
      try {
        await fsp.rename(this.abs(to), this.abs(from));
      } catch (e: any) {
        this.logError(`could not move ${to} back to ${from}: ${e.message}`);
      }
    };
    for (const m of dirMoves) {
      for (const k of [...this.diskFiles.keys()]) if (isUnder(k, m.to)) this.diskFiles.delete(k);
      for (const d of [...this.diskDirs]) if (d === m.to || isUnder(d, m.to)) this.diskDirs.delete(d);
      restore.push(...this.filesUnder(m.from, this.diskFiles.keys()).map((f) => `${m.from}/${f}`));
      await undo(m.from, m.to);
    }
    for (const m of fileMoves) {
      this.diskFiles.delete(m.to);
      restore.push(m.from);
      await undo(m.from, m.to);
    }
    return restore;
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
    return modelChildByTokens(parent, owner, this.layout.ownerAliases);
  }

  private applyMove(node: MNode, entryName: string, parent: MNode | null, rel: string, plan: Plan) {
    // a shortened file name stands for the instance's real name
    const name = this.layout.longNames.get(entryName.toLowerCase()) ?? entryName;
    const problem = name === node.name ? null : nameProblem(name);
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
    const existing = this.existingFor(rel, e, parent);
    if (existing) {
      this.layout.dirs.set(rel, existing);
      plan.adopted.add(rel);
      return;
    }
    const n = this.createNode(parent, isGui ? (guiClass ?? "ScreenGui") : e.cls, e.name, undefined, undefined, rel, plan);
    if (n) this.layout.dirs.set(rel, n);
  }

  /**
   * The instance a new directory stands for, when it already exists but has been a single
   * file so far: `Lamp.Part/` beside `Lamp.Part.json`, or `StarterPlayerScripts/` for a
   * service child that is not creatable. A plain name never adopts a script or a container.
   */
  private existingFor(rel: string, e: { name: string; cls: string }, parent: MNode): MNode | null {
    if (this.isModelDir(dirOf(rel))) return null;
    const twin = this.layout.files.get(`${rel}.json`);
    if (twin?.kind === "json" && this.nodes.get(twin.node.id) === twin.node) return twin.node;
    const plain = e.cls === "Folder" && !baseOf(rel).endsWith(".Folder");
    const same = parent.children.filter((c) => c.name === e.name && (plain ? !isScript(c.cls) && !isContainer(c.cls) && c.cls !== "Folder" : c.cls === e.cls));
    return same.length === 1 ? same[0] : null;
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
      const owner = modelChildByTokens(parent, e.owner, this.layout.ownerAliases);
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
    if (node.cls === "MeshPart" && "MeshId" in doc.props && !sameValue(doc.props.MeshId, node.props.MeshId)) {
      this.reject(rel, undefined, `MeshId of "${node.name}" is read-only once the MeshPart exists; make a new MeshPart with the other mesh instead`);
      delete doc.props.MeshId;
    }
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
