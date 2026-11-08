// Prepared uploads and the moderation queue, on disk. Several MCP processes can
// share one file: every change is load-mutate-save under a lock file.

import fs from "node:fs";
import path from "node:path";
import type { CopyrightResult } from "./copyright.js";
import type { AssetKind } from "./media.js";

export interface Target {
  path: string;
  class: string;
  property: string;
  place?: string;
}

export interface Prepared {
  prepareId: string;
  file: string;
  fileName: string;
  kind: AssetKind;
  name: string;
  description: string;
  sha256: string;
  contentType: string;
  target?: Target;
  copyright: CopyrightResult;
  acceptedPhrases: string[];
  /** Experience that gets Use access after the upload, as shown in the summary. */
  universeId?: number;
  createdAt: number;
  usedAt?: number;
}

export type EntryStatus = "uploading" | "processing" | "reviewing" | "approved" | "applied" | "rejected" | "failed";

export interface QueueEntry {
  prepareId: string;
  kind: AssetKind;
  name: string;
  status: EntryStatus;
  operationPath?: string;
  assetId?: string;
  revisionId?: string;
  reason?: string;
  lastError?: string;
  target?: Target;
  /** Studio this entry belongs to, fixed the first time one is seen. */
  place?: string;
  placeholder?: { created: boolean; error?: string; note?: string };
  universeId?: number;
  /** Use access for that experience; pending entries are retried by the poller. */
  grant?: { status: "pending" | "granted" | "failed"; error?: string };
  createdAt: number;
  updatedAt: number;
}

export interface State {
  version: 1;
  prepares: Record<string, Prepared>;
  queue: QueueEntry[];
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export class StateStore {
  readonly file: string;
  private lockFile: string;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "state.json");
    this.lockFile = path.join(dir, "state.lock");
    if (!fs.existsSync(this.file)) this.save({ version: 1, prepares: {}, queue: [] });
  }

  read(): State {
    return JSON.parse(fs.readFileSync(this.file, "utf8")) as State;
  }

  private save(state: State) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (e) {
        // Windows: antivirus or a reader can briefly hold the target open
        if (attempt >= 10) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  }

  private async acquire() {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(this.lockFile, "wx"));
        return;
      } catch (e: any) {
        if (e.code !== "EEXIST" && e.code !== "EPERM") throw e;
        try {
          if (Date.now() - fs.statSync(this.lockFile).mtimeMs > LOCK_STALE_MS) fs.rmSync(this.lockFile, { force: true });
        } catch {
          // released between the two calls
        }
        if (Date.now() > deadline) throw new Error(`Publisher state is locked: ${this.lockFile}`);
        await new Promise((r) => setTimeout(r, 15));
      }
    }
  }

  /** `fn` runs synchronously under the lock; if it throws nothing is saved. */
  async mutate<T>(fn: (s: State) => T): Promise<T> {
    await this.acquire();
    try {
      const state = this.read();
      const out = fn(state);
      this.save(state);
      return out;
    } finally {
      fs.rmSync(this.lockFile, { force: true });
    }
  }

  /** Merges `patch` into one entry and stamps it. */
  update(prepareId: string, patch: Partial<QueueEntry>): Promise<void> {
    return this.mutate((s) => {
      const e = s.queue.find((q) => q.prepareId === prepareId);
      if (e) Object.assign(e, patch, { updatedAt: Date.now() });
    });
  }
}
