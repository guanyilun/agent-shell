#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as path from "node:path";
import { Shell } from "./shell.js";
import { createCore } from "./core.js";
import { palette as p } from "./utils/palette.js";
import tuiRenderer from "./extensions/tui-renderer.js";
import slashCommands from "./extensions/slash-commands.js";
import fileAutocomplete from "./extensions/file-autocomplete.js";
import shellRecall from "./extensions/shell-recall.js";
import shellExec from "./extensions/shell-exec.js";
import commandSuggest from "./extensions/command-suggest.js";
import { loadExtensions } from "./extension-loader.js";
import type { AgentShellConfig } from "./types.js";

/**
 * Capture the user's full shell environment.
 * This picks up env vars exported in .zshrc/.bashrc that the
 * Node.js process doesn't have (e.g. when launched from an IDE).
 *
 * Uses -l (login shell) to get .zprofile/.bash_profile vars, then
 * explicitly sources the interactive rc file (.zshrc/.bashrc) which
 * -l alone doesn't load (that requires -i, which blocks on TTY).
 */
async function captureShellEnvAsync(shell: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    try {
      const shellName = path.basename(shell);
      const isZsh = shellName.includes("zsh");
      const sourceRc = isZsh
        ? 'source ~/.zshrc 2>/dev/null;'
        : '[ -f ~/.bashrc ] && source ~/.bashrc 2>/dev/null;';

      const child = spawn(shell, ["-l", "-c", `${sourceRc} env -0`], {
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
  let provider: string | undefined;
  const shell = process.env.SHELL || "/bin/bash";

  // Internal agent mode
  let apiKey: string | undefined = process.env.OPENAI_API_KEY;
  let baseURL: string | undefined = process.env.OPENAI_BASE_URL;

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
    } else if (arg === "--model" && argv[i + 1]) {
      model = argv[++i]!;
    } else if (arg === "--api-key" && argv[i + 1]) {
      apiKey = argv[++i]!;
    } else if (arg === "--base-url" && argv[i + 1]) {
      baseURL = argv[++i]!;
    } else if (arg === "--provider" && argv[i + 1]) {
      provider = argv[++i]!;
    } else if (arg === "--shell" && argv[i + 1]) {
      return { agentCommand, agentArgs, shell: argv[++i]!, model, extensions, apiKey, baseURL, provider };
    } else if ((arg === "--extensions" || arg === "-e") && argv[i + 1]) {
      const exts = argv[++i]!.split(",").map(s => s.trim());
      extensions = extensions ? [...extensions, ...exts] : exts;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`agent-sh — a shell-first terminal with AI agent access

Usage: agent-sh [options]

Quick Start:
  npm start                         Start with default agent (pi-acp)
  npm run pi                        Start with pi-acp agent
  npm run claude                    Start with Claude agent

Provider Profiles:
  --provider <name>   Use a provider from ~/.agent-sh/settings.json
  --model <name>      Override default model (or select from provider's models list)

Internal Agent Mode (direct LLM API):
  --api-key <key>     API key for OpenAI-compatible provider (or set OPENAI_API_KEY)
  --base-url <url>    Base URL for API (default: https://api.openai.com/v1, or set OPENAI_BASE_URL)

ACP Agent Mode (subprocess):
  --agent <cmd>       Agent command to launch (default: $AGENT_SH_AGENT or "pi-acp")
  --agent-args <args> Arguments for the agent (space-separated, quoted)

General Options:
  --shell <path>      Shell to use (default: $SHELL or /bin/bash)
  -e, --extensions    Extensions to load (comma-separated, repeatable)
  -h, --help          Show this help

Environment Variables:
  OPENAI_API_KEY     API key for internal agent mode
  OPENAI_BASE_URL    Base URL override (e.g., http://localhost:11434/v1 for Ollama)
  AGENT_SH_AGENT     Default ACP agent to use (e.g., "pi-acp", "claude")

Examples:
  # Internal agent with OpenAI
  agent-sh --model gpt-4o

  # Internal agent with Ollama (local)
  agent-sh --base-url http://localhost:11434/v1 --model llama3

  # Internal agent with OpenRouter
  agent-sh --base-url https://openrouter.ai/api/v1 --model anthropic/claude-sonnet-4-20250514

  # ACP agent (existing behavior)
  agent-sh --agent pi-acp

Inside the shell:
  Type normally        Commands run in your real shell
  ? <query>           Ask the AI agent a question (query mode)
  > <command>         Have the agent run a command (execute mode)
  ? /help             Show available slash commands
  Ctrl-C              Cancel agent response (or signal shell as usual)
`);
      process.exit(0);
    }
  }

  return { agentCommand, agentArgs, shell, model, extensions, apiKey, baseURL, provider };
}

function formatAgentInfo(
  info: { name: string; version: string },
  model?: string,
): string {
  const name = info.name.replace(/-acp$/, "").replace(/-/g, " ");
  let infoStr = `${p.dim}${name}${p.reset}`;
  if (model) {
    const cleanModel = model
      .replace(/^openai\//i, "")
      .replace(/^anthropic\//i, "")
      .replace(/^google\//i, "");
    infoStr += ` ${p.dim}(${cleanModel})${p.reset}`;
  }
  return infoStr;
}

async function main(): Promise<void> {
  // Set up signal handlers before any terminal operations.
  // Ignore SIGTTOU to prevent suspension when modifying terminal settings.
  process.on("SIGTTOU", () => {});
  // Also ignore SIGTTIN which can occur when reading from terminal while backgrounded.
  process.on("SIGTTIN", () => {});

  const config = parseArgs(process.argv.slice(2));

  // Capture user's full shell environment (from .zshrc/.bashrc etc.)
  // This must complete before spawning the agent so it sees all env vars.
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }
  config.shellEnv = baseEnv;

  const shellPath = config.shell || process.env.SHELL || "/bin/bash";
  try {
    const shellEnv = await captureShellEnvAsync(shellPath);
    if (Object.keys(shellEnv).length > 0) {
      config.shellEnv = mergeShellEnv(config.shellEnv, shellEnv);
      if (process.env.DEBUG) {
        console.error('[agent-sh] Shell environment captured');
      }
    }
  } catch {
    // Ignore errors, we already have process.env as fallback
  }

  // ── Core (frontend-agnostic) ──────────────────────────────────
  const core = createCore(config);
  const { bus } = core;
  const useInternalAgent = !!core.llmClient;

  // Track agent info from bus events (populated when ACP agent connects)
  let agentInfo: { name: string; version: string; model?: string } | null = null;
  bus.on("agent:info", (info) => { agentInfo = info; });

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
      if (useInternalAgent) {
        const modelName = core.llmClient!.model;
        return { info: `${p.dim}agent-sh (${modelName})${p.reset}` };
      }
      if (agentInfo) {
        return { info: formatAgentInfo(agentInfo, agentInfo.model) };
      }
      return { info: "" };
    },
  });
  if (process.env.DEBUG) {
    console.error('[agent-sh] Shell created');
  }

  // ── Input modes ──────────────────────────────────────────────
  bus.emit("input-mode:register", {
    id: "query",
    trigger: "?",
    label: "query",
    promptIcon: "❯",
    indicator: "❓",
    onSubmit(query, b) {
      b.emit("agent:submit", { query, modeLabel: "Query", modeInstruction: "[mode: query]" });
    },
    returnToSelf: true,
  });

  bus.emit("input-mode:register", {
    id: "execute",
    trigger: ">",
    label: "execute",
    promptIcon: "⟩",
    indicator: "●",
    onSubmit(query, b) {
      b.emit("agent:submit", { query, modeLabel: "Execute", modeInstruction: "[mode: execute]" });
    },
    returnToSelf: false,
  });

  // ── Extensions ────────────────────────────────────────────────
  if (process.env.DEBUG) {
    console.error('[agent-sh] Setting up extensions...');
  }
  const extCtx = core.extensionContext({ quit: cleanup });

  tuiRenderer(extCtx);
  slashCommands(extCtx);
  fileAutocomplete(extCtx);
  shellRecall(extCtx);
  commandSuggest(extCtx);

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
  if (!useInternalAgent) {
    const agentStartTimeoutMs = 35000;
    Promise.race([
      core.start(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`Agent connection timeout`)), agentStartTimeoutMs)
      ),
    ]).catch((err) => {
      console.error(`Failed to connect to ${config.agentCommand}:`, err);
    });
  }
  // Internal agent: no startup needed — AgentLoop is already wired to bus.

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
