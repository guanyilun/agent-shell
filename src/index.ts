#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { Shell } from "./shell.js";
import { createCore } from "./core.js";
import { palette as p } from "./utils/palette.js";
import tuiRenderer from "./extensions/tui-renderer.js";
import slashCommands from "./extensions/slash-commands.js";
import fileAutocomplete from "./extensions/file-autocomplete.js";
import shellRecall from "./extensions/shell-recall.js";
import shellExec from "./extensions/shell-exec.js";
import { loadExtensions } from "./extension-loader.js";
import type { AgentShellConfig } from "./types.js";

/**
 * Capture the user's full shell environment asynchronously.
 * This picks up env vars exported in .zshrc/.bashrc that the
 * Node.js process doesn't have.
 *
 * Uses -l (login shell) instead of -i to avoid TTY blocking issues.
 */
async function captureShellEnvAsync(shell: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    try {
      const child = spawn(shell, ["-l", "-c", "env -0"], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });

      let output = "";
      child.stdout?.on("data", (data) => {
        output += data.toString("utf-8");
      });

      child.on("close", (code) => {
        if (code !== 0 || !output) {
          resolve({}); // Return empty to trigger fallback
          return;
        }
        const env: Record<string, string> = {};
        for (const entry of output.split("\0")) {
          const eq = entry.indexOf("=");
          if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
        resolve(env);
      });

      child.on("error", () => {
        resolve({}); // Return empty to trigger fallback
      });

      // Safety timeout
      setTimeout(() => {
        child.kill("SIGTERM");
        resolve({});
      }, 5000);
    } catch {
      resolve({});
    }
  });
}

/**
 * Merge captured shell env into base env, only adding keys that don't exist.
 * This preserves any runtime modifications while adding missing shell vars.
 */
function mergeShellEnv(baseEnv: Record<string, string>, shellEnv: Record<string, string>): Record<string, string> {
  const merged = { ...baseEnv };
  for (const [key, value] of Object.entries(shellEnv)) {
    // Only add if key doesn't exist or is empty in base env
    if (!(key in merged) || !merged[key]) {
      merged[key] = value;
    }
  }
  return merged;
}

function parseArgs(argv: string[]): AgentShellConfig {
  // Priority: CLI args > Environment variables > Config file > Defaults
  const defaultAgent = process.env.AGENT_SH_AGENT || "pi-acp";
  let agentCommand = defaultAgent;
  let agentArgs: string[] = [];
  let model: string | undefined;
  let extensions: string[] | undefined;
  const shell = process.env.SHELL || "/bin/bash";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent" && argv[i + 1]) {
      agentCommand = argv[++i]!;
    } else if (arg === "--agent-args" && argv[i + 1]) {
      const argsString = argv[++i]!;
      agentArgs = argsString.split(" ");
      // Extract model from agent args if provided
      const modelArgIndex = agentArgs.findIndex(a => a === "--model" || a === "-m");
      if (modelArgIndex !== -1 && agentArgs[modelArgIndex + 1]) {
        model = agentArgs[modelArgIndex + 1];
      }
    } else if (arg === "--shell" && argv[i + 1]) {
      return { agentCommand, agentArgs, shell: argv[++i]!, model, extensions };
    } else if ((arg === "--extensions" || arg === "-e") && argv[i + 1]) {
      const exts = argv[++i]!.split(",").map(s => s.trim());
      extensions = extensions ? [...extensions, ...exts] : exts;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`agent-sh — a shell-first terminal with ACP agent access

Usage: agent-sh [options]

Quick Start:
  npm start           Start with default agent (pi-acp)
  npm run pi          Start with pi-acp agent
  npm run claude      Start with Claude agent

Options:
  --agent <cmd>       Agent command to launch (default: $AGENT_SH_AGENT or "pi-acp")
  --agent-args <args> Arguments for the agent (space-separated, quoted)
  --shell <path>      Shell to use (default: $SHELL or /bin/bash)
  -e, --extensions    Extensions to load (comma-separated, repeatable)
  -h, --help          Show this help

Extensions:
  Extensions are loaded from (in order):
    1. -e flags:  npm packages or file paths
    2. settings:  ~/.agent-sh/settings.json → "extensions": [...]
    3. directory:  ~/.agent-sh/extensions/ (files or dirs with index.ts)

Environment Variables:
  AGENT_SH_AGENT   Default agent to use (e.g., "pi-acp", "claude")

Examples:
  npm start --agent pi-acp
  npm start -- -e my-extension-package
  npm start -- -e ./local-ext.ts -e another-package

Inside the shell:
  Type normally        Commands run in your real shell
  > <query>           Send query to the AI agent
  > /help             Show available slash commands
  Ctrl-C              Cancel agent response (or signal shell as usual)
`);
      process.exit(0);
    }
  }

  return { agentCommand, agentArgs, shell, model, extensions };
}

function formatAgentInfo(
  agentInfo: { name: string; version: string },
  model?: string,
  thoughtLevel?: string | null,
): string {
  const name = agentInfo.name.replace(/-acp$/, "").replace(/-/g, " ");
  let infoStr = `${p.dim}${name}${p.reset}`;
  if (model) {
    const cleanModel = model
      .replace(/^openai\//i, "")
      .replace(/^anthropic\//i, "")
      .replace(/^google\//i, "");
    infoStr += ` ${p.dim}(${cleanModel})${p.reset}`;
  }
  if (thoughtLevel) {
    // Clean up verbose mode names like "Thinking: medium" → "medium"
    const label = thoughtLevel.replace(/^Thinking:\s*/i, "");
    infoStr += ` ${p.dim}[${label}]${p.reset}`;
  }
  return `${infoStr} ${p.success}●${p.reset}`;
}

async function main(): Promise<void> {
  // Set up signal handlers before any terminal operations.
  // Ignore SIGTTOU to prevent suspension when modifying terminal settings.
  process.on("SIGTTOU", () => {});
  // Also ignore SIGTTIN which can occur when reading from terminal while backgrounded.
  process.on("SIGTTIN", () => {});

  const config = parseArgs(process.argv.slice(2));

  // Start with current process environment (fast, non-blocking)
  // We'll enrich it with shell env asynchronously in the background
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }
  config.shellEnv = baseEnv;

  // Asynchronously capture full shell environment without blocking startup
  const shellPath = config.shell || process.env.SHELL || "/bin/bash";
  captureShellEnvAsync(shellPath).then((shellEnv) => {
    if (Object.keys(shellEnv).length > 0) {
      const merged = mergeShellEnv(config.shellEnv!, shellEnv);
      config.shellEnv = merged;
      if (process.env.DEBUG) {
        console.error('[agent-sh] Shell environment enriched asynchronously');
      }
    }
  }).catch(() => {
    // Ignore errors, we already have process.env as fallback
  });

  if (process.env.DEBUG) {
    console.error('[agent-sh] Using current process environment (async enrichment pending)');
  }

  // ── Core (frontend-agnostic) ──────────────────────────────────
  const core = createCore(config);
  const { bus, client } = core;

  // ── Interactive frontend ──────────────────────────────────────
  if (process.env.DEBUG) {
    console.error('[agent-sh] Setting up interactive frontend...');
  }
  process.stdout.write(`\x1b]0;agent-sh\x07`);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const cleanup = () => {
    core.kill();
    shell.kill();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(0);
  };

  if (process.env.DEBUG) {
    console.error('[agent-sh] Creating Shell...');
  }

  // Small delay on macOS to ensure we're fully in the foreground process group
  // before spawning the PTY. This prevents SIGTTOU suspension.
  await new Promise(resolve => setTimeout(resolve, 100));

  const shell = new Shell({
    bus,
    cols,
    rows,
    shell: config.shell || process.env.SHELL || "/bin/bash",
    cwd: process.cwd(),
    onShowAgentInfo: () => {
      if (client.isConnected()) {
        const agentInfo = client.getAgentInfo();
        const model = client.getModel();
        if (agentInfo) {
          const mode = client.getCurrentMode();
          return { info: formatAgentInfo(agentInfo, model, mode?.name ?? null) };
        }
      }
      return { info: "" };
    },
  });
  if (process.env.DEBUG) {
    console.error('[agent-sh] Shell created');
  }

  // ── Extensions ────────────────────────────────────────────────
  if (process.env.DEBUG) {
    console.error('[agent-sh] Setting up extensions...');
  }
  const extCtx = core.extensionContext({ quit: cleanup });

  tuiRenderer(extCtx);
  slashCommands(extCtx);
  fileAutocomplete(extCtx);
  shellRecall(extCtx);

  // Shell-exec: start the Unix domain socket bridge so agent extensions
  // and MCP servers can route tool calls to the PTY via the EventBus.
  const tmpDir = shell.getTmpDir();
  if (tmpDir) {
    if (process.env.DEBUG) {
      console.error('[agent-sh] Starting shell-exec socket server...');
    }
    shellExec(extCtx, { socketPath: `${tmpDir}/shell.sock` });
  }

  // Load extensions with timeout to prevent blocking startup
  if (process.env.DEBUG) {
    console.error('[agent-sh] Loading extensions...');
  }
  const loadExtensionsTimeoutMs = 10000; // 10 seconds
  await Promise.race([
    loadExtensions(extCtx, config.extensions),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`Extension loading timeout after ${loadExtensionsTimeoutMs}ms`)), loadExtensionsTimeoutMs)
    ),
  ]).catch((err) => {
    console.error(`Warning: ${err.message}`);
  });
  if (process.env.DEBUG) {
    console.error('[agent-sh] Extensions loaded');
  }

  // ── Agent connection (async — don't block shell startup) ──────
  const agentStartTimeoutMs = 35000; // 35 seconds (slightly longer than internal timeouts)
  Promise.race([
    core.start(),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`Agent connection timeout`)), agentStartTimeoutMs)
    ),
  ]).catch((err) => {
    console.error(`Failed to connect to ${config.agentCommand}:`, err);
  });

  // ── Terminal lifecycle ────────────────────────────────────────
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  // Handle terminal stop/resume signals properly
  process.on("SIGTSTP", () => {
    // Handle Ctrl+Z - suspend the entire process group
    // Restore terminal state before suspending
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Ignore
      }
    }
    // Re-send SIGSTOP to actually suspend
    process.kill(process.pid!, "SIGSTOP");
  });

  process.on("SIGCONT", () => {
    // Re-acquire terminal when brought back to foreground
    if (process.stdin.isTTY) {
      try {
        // Ensure we reacquire controlling terminal
        process.stdin.setRawMode(true);
      } catch {
        // May fail if stdin is not a TTY
      }
    }
  });

  process.stdout.on("resize", () => {
    shell.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  });

  shell.onExit((e) => {
    core.kill();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(e.exitCode);
  });

  // Set up stdin - resume after all event listeners are in place
  if (process.env.DEBUG) {
    console.error('[agent-sh] Resuming stdin...');
  }
  process.stdin.resume();

  // Set raw mode after resume to avoid SIGTTOU issues
  if (process.stdin.isTTY) {
    if (process.env.DEBUG) {
      console.error('[agent-sh] Setting raw mode...');
    }
    // Use setImmediate to ensure we're in the next tick
    setImmediate(() => {
      try {
        process.stdin.setRawMode(true);
        if (process.env.DEBUG) {
          console.error('[agent-sh] Raw mode enabled');
        }
      } catch (err) {
        if (process.env.DEBUG) {
          console.error(`[agent-sh] Failed to set raw mode: ${err}`);
        }
        // May fail if process is in background; SIGTTOU handler prevents suspension
      }
    });
  }
  if (process.env.DEBUG) {
    console.error('[agent-sh] Startup complete');
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
