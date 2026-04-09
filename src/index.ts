#!/usr/bin/env node
import { Shell } from "./shell.js";
import { createCore } from "./core.js";
import { DIM, GREEN, RESET } from "./utils/ansi.js";
import tuiRenderer from "./extensions/tui-renderer.js";
import slashCommands from "./extensions/slash-commands.js";
import fileAutocomplete from "./extensions/file-autocomplete.js";
import shellRecall from "./extensions/shell-recall.js";
import { loadExtensions } from "./extension-loader.js";
import type { AgentShellConfig } from "./types.js";

function parseArgs(argv: string[]): AgentShellConfig {
  // Priority: CLI args > Environment variables > Config file > Defaults
  const defaultAgent = process.env.AGENT_SHELL_AGENT || "pi-acp";
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
    } else if (arg === "--extensions" && argv[i + 1]) {
      extensions = argv[++i]!.split(",").map(s => s.trim());
    } else if (arg === "--help" || arg === "-h") {
      console.log(`agent-shell — a shell-first terminal with ACP agent access

Usage: agent-shell [options]

Quick Start:
  npm start           Start with default agent (pi-acp)
  npm run pi          Start with pi-acp agent
  npm run claude      Start with Claude agent

Options:
  --agent <cmd>       Agent command to launch (default: $AGENT_SHELL_AGENT or "pi-acp")
  --agent-args <args> Arguments for the agent (space-separated, quoted)
  --shell <path>      Shell to use (default: $SHELL or /bin/bash)
  --extensions <paths> Comma-separated extension module paths to load
  -h, --help          Show this help

Environment Variables:
  AGENT_SHELL_AGENT   Default agent to use (e.g., "pi-acp", "claude")

Examples:
  npm start --agent pi-acp
  npm start -- --agent claude --agent-args "--model sonnet"
  AGENT_SHELL_AGENT=claude npm start

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

function formatAgentInfo(agentInfo: { name: string; version: string }, model?: string): string {
  const name = agentInfo.name.replace(/-acp$/, "").replace(/-/g, " ");
  let infoStr = `${DIM}${name}${RESET}`;
  if (model) {
    const cleanModel = model
      .replace(/^openai\//i, "")
      .replace(/^anthropic\//i, "")
      .replace(/^google\//i, "");
    infoStr += ` ${DIM}(${cleanModel})${RESET}`;
  }
  return `${infoStr} ${GREEN}●${RESET}`;
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));

  // ── Core (frontend-agnostic) ──────────────────────────────────
  const core = createCore(config);
  const { bus, client } = core;

  // ── Interactive frontend ──────────────────────────────────────
  process.stdout.write(`\x1b]0;agent-shell\x07`);

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
          return { info: formatAgentInfo(agentInfo, model) };
        }
      }
      return { info: "" };
    },
  });

  // ── Extensions ────────────────────────────────────────────────
  const extCtx = core.extensionContext({ quit: cleanup });

  tuiRenderer(extCtx);
  slashCommands(extCtx);
  fileAutocomplete(extCtx);
  shellRecall(extCtx);

  await loadExtensions(extCtx, config.extensions);

  // ── Agent connection (async — don't block shell startup) ──────
  core.start().catch((err) => {
    console.error(`Failed to connect to ${config.agentCommand}:`, err);
  });

  // ── Terminal lifecycle ────────────────────────────────────────
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

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

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
