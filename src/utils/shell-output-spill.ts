/**
 * Spill long shell outputs to per-session tempfiles.
 *
 * Captured PTY output that exceeds the truncation threshold is written to
 * `<tmpdir>/agent-sh-<pid>/<id>.out`. The in-memory exchange keeps only a
 * head+tail stub pointing at that path, so the agent can fetch the full
 * text via `read_file` on demand. The session dir is removed on process
 * exit; stale dirs from dead processes are swept lazily on first use.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR_PREFIX = "agent-sh-";

let sessionDir: string | null = null;
let cleanupRegistered = false;

export function getSessionDir(): string {
  if (sessionDir) return sessionDir;
  sessionDir = join(tmpdir(), `${DIR_PREFIX}${process.pid}`);
  mkdirSync(sessionDir, { recursive: true });
  sweepStaleDirs();
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    const cleanup = () => {
      if (!sessionDir) return;
      try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
      sessionDir = null;
    };
    process.on("exit", cleanup);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(sig, () => { cleanup(); process.exit(128); });
    }
  }
  return sessionDir;
}

export function spillOutput(id: number, text: string): string {
  const path = join(getSessionDir(), `${id}.out`);
  writeFileSync(path, text);
  return path;
}

function sweepStaleDirs(): void {
  const base = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(DIR_PREFIX)) continue;
    const pid = Number(name.slice(DIR_PREFIX.length));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (isProcessAlive(pid)) continue;
    const full = join(base, name);
    try {
      // Small safety check: only remove directories.
      if (statSync(full).isDirectory()) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {}
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but we can't signal it
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
