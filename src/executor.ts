import { spawn, type ChildProcess } from "node:child_process";
import { stripAnsi } from "./utils/ansi.js";

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024; // 256KB

export interface ExecutorSession {
  id: string;
  command: string;
  output: string;          // accumulated, ANSI-stripped
  exitCode: number | null;
  done: boolean;
  truncated: boolean;
  process: ChildProcess | null;
  resolve?: () => void;
}


/**
 * Spawn a command in an isolated child process with piped I/O.
 * Does NOT use the user's PTY — completely separate process.
 */
export function executeCommand(opts: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  maxOutputBytes?: number;
  onOutput?: (chunk: string) => void;
}): { session: ExecutorSession; done: Promise<void> } {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  const session: ExecutorSession = {
    id: "",
    command: opts.command,
    output: "",
    exitCode: null,
    done: false,
    truncated: false,
    process: null,
  };

  const done = new Promise<void>((resolve) => {
    session.resolve = resolve;
  });

  // Build env — filter undefined values
  const env: Record<string, string> = {};
  const source = opts.env ?? process.env;
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined) env[k] = v;
  }

  let child: ChildProcess;
  try {
    child = spawn("/bin/bash", ["-c", opts.command], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env,
      detached: true,
    });
  } catch (err) {
    session.exitCode = -1;
    session.output = `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`;
    session.done = true;
    session.resolve?.();
    return { session, done };
  }

  session.process = child;

  const handleData = (data: Buffer) => {
    const raw = data.toString("utf-8");
    const clean = stripAnsi(raw);

    // Accumulate cleaned output for the agent
    session.output += clean;

    // Enforce output cap — truncate from beginning, keep tail
    if (session.output.length > maxOutput) {
      session.output = session.output.slice(-maxOutput);
      session.truncated = true;
    }

    // Real-time streaming callback
    opts.onOutput?.(raw);
  };

  child.stdout?.on("data", handleData);
  child.stderr?.on("data", handleData);

  // Timeout handler
  const timer = setTimeout(() => {
    if (!session.done) {
      killSession(session);
    }
  }, timeout);

  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    session.exitCode = code ?? (signal ? -1 : null);
    session.done = true;
    session.process = null;
    session.resolve?.();
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    if (!session.done) {
      session.exitCode = -1;
      session.output += `\nProcess error: ${err.message}`;
      session.done = true;
      session.process = null;
      session.resolve?.();
    }
  });

  return { session, done };
}

/**
 * Kill a running session's process group.
 * Sends SIGTERM first, then SIGKILL after 5 seconds.
 */
export function killSession(session: ExecutorSession): void {
  const proc = session.process;
  if (!proc || !proc.pid) return;

  try {
    // Kill the entire process group
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    // Process may already be dead
  }

  // Fallback: SIGKILL after 5 seconds
  const fallback = setTimeout(() => {
    if (!session.done && proc.pid) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // Ignore
      }
    }
  }, 5000);

  // Don't let the timer keep the process alive
  fallback.unref();
}
