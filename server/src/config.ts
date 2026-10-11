import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const PORT = Number(process.env.ROLINK_PORT ?? 34872);
export const HOST = "127.0.0.1";

/** How long a plugin long-poll is held open before returning an empty batch. */
export const POLL_HOLD_MS = 15_000;
/** A session that has not polled for this long is considered gone. */
export const SESSION_TTL_MS = 45_000;
/** Default time we wait for the plugin to answer a command. */
export const COMMAND_TIMEOUT_MS = 60_000;

const here = path.dirname(fileURLToPath(import.meta.url));
/** server/ directory (dist/.. or src/..). */
export const SERVER_DIR = path.resolve(here, "..");
export const CACHE_DIR = path.join(SERVER_DIR, "cache");
export const SCRIPTS_DIR = path.join(SERVER_DIR, "scripts");

export function log(...args: unknown[]) {
  // stdout belongs to the MCP stdio transport, so all logging goes to stderr.
  console.error("[rolink]", ...args);
}
