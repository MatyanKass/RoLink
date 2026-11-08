// Client for a running RoLink server: GET /health and POST /rpc on 127.0.0.1.
// Only instance paths and asset ids go over this link, never the Open Cloud key.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StudioSession {
  context: string;
  placeName: string;
  placeId: number;
  /** 0 for a place that was never published. */
  gameId?: number;
  connectedAt: number;
}

/** Same rule as RoLink's Bridge.pick, so "connected" means the RPC will land. */
function matches(s: StudioSession, place: string) {
  return s.placeName.toLowerCase().includes(place.toLowerCase()) || String(s.placeId) === place;
}

export class StudioOffline extends Error {}

export class RoLinkClient {
  constructor(readonly port: number) {}

  private get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Edit-mode Studios, newest first. Empty when RoLink itself is not running. */
  async editSessions(): Promise<StudioSession[]> {
    try {
      const r = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(5_000) });
      const body: any = await r.json();
      if (!body?.rolink) return [];
      return (body.sessions as StudioSession[]).filter((s) => s.context === "edit").sort((a, b) => b.connectedAt - a.connectedAt);
    } catch {
      return [];
    }
  }

  async isConnected(place: string): Promise<boolean> {
    return (await this.editSessions()).some((s) => matches(s, place));
  }

  /** A handle for the Studio a command should stick to across restarts. */
  async currentPlace(preferred?: string): Promise<string | undefined> {
    const sessions = await this.editSessions();
    if (preferred) return sessions.some((s) => matches(s, preferred)) ? preferred : undefined;
    const s = sessions[0];
    return s && (s.placeId ? String(s.placeId) : s.placeName);
  }

  private token(): string {
    // re-read every call: the server writes a fresh token each time it starts
    try {
      return fs.readFileSync(path.join(os.tmpdir(), `rolink-${this.port}.token`), "utf8").trim();
    } catch {
      return "";
    }
  }

  /** Calls a RoLink tool and returns its JSON result. */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 75_000): Promise<any> {
    let r: Response;
    try {
      r = await fetch(`${this.base}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rolink-token": this.token() },
        body: JSON.stringify({ tool, args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      throw new StudioOffline(`RoLink is not reachable on port ${this.port}: ${e?.message ?? e}`);
    }
    if (r.status === 401) throw new Error(`RoLink on port ${this.port} rejected the token; is it running as another user?`);
    const body: any = await r.json();
    if (!body.ok) throw new Error(String(body.error ?? "RoLink call failed"));
    const text: string = body.result?.text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** The instance at `instancePath`, or undefined if nothing is there. */
  async getInstance(instancePath: string, property: string, place: string): Promise<{ class: string; attrs: Record<string, unknown> } | undefined> {
    try {
      return await this.call("get", { path: instancePath, props: [property], place });
    } catch (e: any) {
      if (/^not found:/.test(String(e?.message))) return undefined;
      throw e;
    }
  }
}
