// Environment, on-disk locations and the secret-scrubbing logger.

import os from "node:os";
import path from "node:path";

export const VERSION = "0.1.0";

export interface Creator {
  userId?: string;
  groupId?: string;
}

export interface PublishConfig {
  apiKey?: string;
  creator?: Creator;
  /** Experience that uploads get Use access to, when prepare_asset names none. */
  universeId?: number;
}

/** The key lives only in this process: it is read here and handed to OpenCloud. */
export function loadConfig(env: NodeJS.ProcessEnv): PublishConfig {
  const apiKey = env.ROBLOX_PUBLISH_API_KEY?.trim() || undefined;
  const groupId = env.ROBLOX_CREATOR_GROUP_ID?.trim() || undefined;
  const userId = env.ROBLOX_CREATOR_USER_ID?.trim() || undefined;
  const creator = groupId ? { groupId } : userId ? { userId } : undefined;
  const universeId = Number(env.ROBLOX_UNIVERSE_ID?.trim() || NaN);
  return { apiKey, creator, universeId: Number.isSafeInteger(universeId) && universeId > 0 ? universeId : undefined };
}

/** The user's config directory, so the queue survives reboots and temp cleaners. */
export function defaultStateDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (env.ROLINK_PUBLISH_STATE_DIR) return env.ROLINK_PUBLISH_STATE_DIR;
  const home = os.homedir();
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "RoLink", "publisher");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "RoLink", "publisher");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "rolink", "publisher");
}

/** Replaces every registered secret in any text about to leave this process. */
export class Redactor {
  private secrets: string[] = [];

  add(secret: string | undefined) {
    if (secret) this.secrets.push(secret);
  }

  text(s: string): string {
    let out = s;
    for (const secret of this.secrets) out = out.split(secret).join("<redacted>");
    return out;
  }
}

export type Log = (...parts: unknown[]) => void;

export function makeLog(redactor: Redactor, sink: (line: string) => void): Log {
  return (...parts) => sink(redactor.text(parts.map((p) => (typeof p === "string" ? p : p instanceof Error ? p.message : JSON.stringify(p))).join(" ")));
}

/** stdout belongs to the MCP stdio transport, so logs go to stderr. */
export const stderrSink = (line: string) => console.error("[rolink-publish]", line);
