// One stray rejection or watcher error must not take the MCP server down, but a
// process that never got going has to fail visibly instead of idling broken.

export function installProcessGuards(log: (...args: unknown[]) => void) {
  let started = false;
  const safeLog = (...args: unknown[]) => {
    try {
      log(...args);
    } catch {}
  };
  const handle = (kind: string) => (e: unknown) => {
    safeLog(`${kind}${started ? " (continuing)" : " during startup"}:`, e instanceof Error ? (e.stack ?? e.message) : e);
    if (!started) process.exit(1);
  };
  process.on("uncaughtException", handle("uncaught exception"));
  process.on("unhandledRejection", handle("unhandled rejection"));
  // the MCP client went away: without this listener the guard above would keep a dead server alive
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    safeLog("stdout error:", e);
  });
  return {
    ready() {
      started = true;
    },
  };
}
