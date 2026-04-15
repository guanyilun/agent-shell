#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as path from "node:path";
import { Shell } from "./shell/shell.js";
import { createCore } from "./core.js";
import { palette as p } from "./utils/palette.js";
import { loadBuiltinExtensions } from "./extensions/index.js";
import { loadExtensions } from "./extension-loader.js";
import { getSettings } from "./settings.js";
import { discoverSkills } from "./agent/skills.js";
import type { AgentShellConfig } from "./types.js";

/**
 * Capture the user's full shell environment.
 * This picks up env vars exported in .zshrc/.bashrc that the
 * Node.js process doesn't have (e.g. when launched from an IDE).
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
          resolve({});
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
        resolve({});
      });

      setTimeout(() => {
        child.kill("SIGTERM");
        resolve({});
      }, 5000);
    } catch {
      resolve({});
    }
  });
}

function mergeShellEnv(baseEnv: Record<string, string>, shellEnv: Record<string, string>): Record<string, string> {
  const merged = { ...baseEnv };
  for (const [key, value] of Object.entries(shellEnv)) {
    if (!(key in merged) || !merged[key]) {
      merged[key] = value;
    }
  }
  return merged;
}

function parseArgs(argv: string[]): AgentShellConfig {
  let model: string | undefined;
  let extensions: string[] | undefined;
  let provider: string | undefined;
  const shell = process.env.SHELL || "/bin/bash";

  let apiKey: string | undefined = process.env.OPENAI_API_KEY;
  let baseURL: string | undefined = process.env.OPENAI_BASE_URL;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model" && argv[i + 1]) {
      model = argv[++i]!;
    } else if (arg === "--api-key" && argv[i + 1]) {
      apiKey = argv[++i]!;
    } else if (arg === "--base-url" && argv[i + 1]) {
      baseURL = argv[++i]!;
    } else if (arg === "--provider" && argv[i + 1]) {
      provider = argv[++i]!;
    } else if (arg === "--shell" && argv[i + 1]) {
      return { shell: argv[++i]!, model, extensions, apiKey, baseURL, provider };
    } else if ((arg === "--extensions" || arg === "-e") && argv[i + 1]) {
      const exts = argv[++i]!.split(",").map(s => s.trim());
      extensions = extensions ? [...extensions, ...exts] : exts;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`agent-sh — a shell-first terminal where AI is one keystroke away

Usage: agent-sh [options]

Provider Profiles:
  --provider <name>   Use a provider from ~/.agent-sh/settings.json
  --model <name>      Override default model

Direct LLM API:
  --api-key <key>     API key for OpenAI-compatible provider (or set OPENAI_API_KEY)
  --base-url <url>    Base URL for API (or set OPENAI_BASE_URL)

General Options:
  --shell <path>      Shell to use (default: $SHELL or /bin/bash)
  -e, --extensions    Extensions to load (comma-separated, repeatable)
  -h, --help          Show this help

Environment Variables:
  OPENAI_API_KEY     API key for LLM provider
  OPENAI_BASE_URL    Base URL override (e.g., http://localhost:11434/v1 for Ollama)

Examples:
  # Use a configured provider
  agent-sh --provider openai

  # Direct API access
  agent-sh --api-key "$KEY" --model gpt-4o

  # Local model via Ollama
  agent-sh --base-url http://localhost:11434/v1 --model llama3

Inside the shell:
  Type normally        Commands run in your real shell
  > <query>           Ask the AI agent (it decides how to help)
  > /help             Show available slash commands
  Ctrl-C              Cancel agent response (or signal shell as usual)
`);
      process.exit(0);
    }
  }

  return { shell, model, extensions, apiKey, baseURL, provider };
}

async function main(): Promise<void> {
  if (process.env.AGENT_SH) {
    console.error("agent-sh: already running inside an agent-sh session (nested sessions are not supported).");
    process.exit(1);
  }

  process.on("SIGTTOU", () => {});
  process.on("SIGTTIN", () => {});

  const config = parseArgs(process.argv.slice(2));

  // Capture user's full shell environment
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }

  const shellPath = config.shell || process.env.SHELL || "/bin/bash";
  try {
    const shellEnv = await captureShellEnvAsync(shellPath);
    if (Object.keys(shellEnv).length > 0) {
      Object.assign(baseEnv, mergeShellEnv(baseEnv, shellEnv));
      // Expose captured env vars to process.env so extensions can read them.
      // Only add vars not already present to avoid clobbering runtime state.
      for (const [k, v] of Object.entries(baseEnv)) {
        if (process.env[k] === undefined) {
          process.env[k] = v;
        }
      }
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

  // Track agent info from bus events (populated by extension backends)
  let agentInfo: { name: string; version: string; model?: string; provider?: string } | null = null;
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

  await new Promise(resolve => setTimeout(resolve, 100));

  const shell = new Shell({
    bus,
    handlers: core.handlers,
    cols,
    rows,
    shell: config.shell || process.env.SHELL || "/bin/bash",
    cwd: process.cwd(),
    onShowAgentInfo: () => {
      if (agentInfo) {
        return { info: `${p.dim}${agentInfo.name}${agentInfo.model ? ` (${agentInfo.model})` : ""}${p.reset}` };
      }
      return { info: "" };
    },
  });
  if (process.env.DEBUG) {
    console.error('[agent-sh] Shell created');
  }

  // ── Input mode ───────────────────────────────────────────────
  bus.emit("input-mode:register", {
    id: "agent",
    trigger: ">",
    label: "agent",
    promptIcon: "❯",
    indicator: "●",
    onSubmit(query, b) {
      b.emit("agent:submit", { query });
    },
    returnToSelf: true,
  });

  // ── Extensions ────────────────────────────────────────────────
  if (process.env.DEBUG) {
    console.error('[agent-sh] Setting up extensions...');
  }
  const extCtx = core.extensionContext({ quit: cleanup });

  // Load built-in extensions (individually disableable via settings.disabledBuiltins)
  await loadBuiltinExtensions(extCtx, getSettings().disabledBuiltins);

  // Load user extensions (may register alternative agent backends)
  if (process.env.DEBUG) {
    console.error('[agent-sh] Loading extensions...');
  }
  const loadExtensionsTimeoutMs = 10000;
  let loadedExtensions: string[] = [];
  await Promise.race([
    loadExtensions(extCtx, config.extensions).then((names) => { loadedExtensions = names; }),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`Extension loading timeout after ${loadExtensionsTimeoutMs}ms`)), loadExtensionsTimeoutMs)
    ),
  ]).catch((err) => {
    console.error(`Warning: ${err.message}`);
  });
  if (process.env.DEBUG) {
    console.error('[agent-sh] Extensions loaded');
  }

  // ── Discover skills ───────────────────────────────────────────
  const skills = discoverSkills(process.cwd());

  // ── Activate agent backend ────────────────────────────────────
  // Extensions had their chance to register via agent:register-backend.
  // If none did, the built-in AgentLoop gets wired to bus events.
  core.activateBackend();

  // ── Startup banner ───────────────────────────────────────────
  const settings = getSettings();
  if (settings.startupBanner !== false) {
    const termW = process.stdout.columns || 80;
    const bannerW = Math.min(termW, 60);

    const productName = `${p.accent}${p.bold}agent-sh${p.reset}`;

    const info = agentInfo as { name: string; version: string; model?: string; provider?: string } | null;
    const backendName = info?.name ?? "ash";
    const model = info?.model;
    const provider = info?.provider;
    const modelValue = model
      ? provider ? `${model} [${provider}]` : model
      : null;

    let sections = "";
    sections += `\n\n  ${p.muted}Backend:${p.reset} ${p.dim}${backendName}${p.reset}`;
    if (modelValue) {
      sections += `\n  ${p.muted}Model:${p.reset} ${p.dim}${modelValue}${p.reset}`;
    }
    if (loadedExtensions.length > 0) {
      sections += `\n\n  ${p.muted}Extensions:${p.reset}`;
      for (const name of loadedExtensions) {
        sections += `\n    ${p.dim}${name}${p.reset}`;
      }
    }
    if (skills.length > 0) {
      sections += `\n\n  ${p.muted}Skills:${p.reset}`;
      for (const s of skills) {
        sections += `\n    ${p.dim}${s.name}${p.reset}`;
      }
    }

    const extSections = bus.emitPipe("banner:collect", { sections: [] }).sections;
    for (const sec of extSections) {
      sections += `\n\n  ${p.muted}${sec.label}:${p.reset}`;
      for (const item of sec.items) {
        sections += `\n    ${p.dim}${item}${p.reset}`;
      }
    }

    const hint = `${p.muted}Type ${p.warning}>${p.muted} to ask AI · ${p.warning}>/help${p.muted} for commands${p.reset}`;
    const borderLine = `${p.muted}${"─".repeat(bannerW)}${p.reset}`;

    process.stdout.write(
      "\n" + borderLine + "\n" +
      "  " + productName +
      sections + "\n" +
      "\n  " + hint + "\n" +
      borderLine + "\n\n",
    );
  }

  // ── Terminal lifecycle ────────────────────────────────────────
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  process.on("SIGTSTP", () => {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Ignore
      }
    }
    process.kill(process.pid!, "SIGSTOP");
  });

  process.on("SIGCONT", () => {
    if (process.stdin.isTTY) {
      try {
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

  if (process.env.DEBUG) {
    console.error('[agent-sh] Resuming stdin...');
  }
  process.stdin.resume();

  if (process.stdin.isTTY) {
    if (process.env.DEBUG) {
      console.error('[agent-sh] Setting raw mode...');
    }
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
