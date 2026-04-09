#!/usr/bin/env node
import { EventBus } from "./event-bus.js";
import { ContextManager } from "./context-manager.js";
import { Shell } from "./shell.js";
import { AcpClient } from "./acp-client.js";
import { DIM, GREEN, RESET } from "./ansi.js";
import tuiRenderer from "./extensions/tui-renderer.js";
import interactivePrompts from "./extensions/interactive-prompts.js";
import slashCommands from "./extensions/slash-commands.js";
import fileAutocomplete from "./extensions/file-autocomplete.js";
import shellRecall from "./extensions/shell-recall.js";
import { loadExtensions } from "./extension-loader.js";
import type { AgentShellConfig, ExtensionContext } from "./types.js";

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

  // Create foundational infrastructure
  const bus = new EventBus();
  const contextManager = new ContextManager(bus);

  // Set terminal title
  process.stdout.write(`\x1b]0;agent-shell\x07`);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Placeholder for agent — we'll create it after shell but before starting input
  let acpClient: AcpClient | null = null;
  let agentConnected = false;

  // Signal handling
  const cleanup = () => {
    acpClient?.kill();
    shell.kill();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(0);
  };

  // Create shell — emits events to bus, ContextManager listens
  const shell = new Shell({
    bus,
    cols,
    rows,
    shell: config.shell,
    cwd: process.cwd(),
    onAgentRequest: async (query: string) => {
      if (!acpClient) {
        bus.emit("ui:error", { message: "Agent not initialized" });
        return;
      }

      // Wait for agent to be connected before sending prompt
      let attempts = 0;
      const maxAttempts = 30; // Wait up to 3 seconds (30 * 100ms)
      while (!agentConnected && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }

      if (!agentConnected) {
        bus.emit("ui:error", { message: "Agent not connected. Please wait a moment and try again." });
        shell.resumeOutput();
        shell.setAgentActive(false);
        return;
      }

      try {
        await acpClient.sendPrompt(query);
      } catch (err: any) {
        bus.emit("ui:error", { message: err.message });
        shell.resumeOutput();
        shell.setAgentActive(false);
      }
    },
    onAgentCancel: () => {
      if (acpClient) {
        acpClient.cancel().catch(() => {});
      }
    },
    onShowAgentInfo: () => {
      if (acpClient && acpClient.isConnected()) {
        const agentInfo = acpClient.getAgentInfo();
        const model = acpClient.getModel();
        if (agentInfo) {
          return { info: formatAgentInfo(agentInfo, model) };
        }
      }
      return { info: "" };
    },
  });

  // Create agent client — emits agent events, queries ContextManager for context
  acpClient = new AcpClient({ bus, contextManager, shell, config });

  // Build extension context — shared by all extensions (built-in and user)
  const extCtx: ExtensionContext = {
    bus, contextManager, shell,
    getAcpClient: () => acpClient!,
    quit: cleanup,
  };

  // Load built-in extensions
  tuiRenderer(extCtx);
  interactivePrompts(extCtx);
  slashCommands(extCtx);
  fileAutocomplete(extCtx);
  shellRecall(extCtx);

  // Load user/third-party extensions (from --extensions flag and ~/.agent-shell/extensions/)
  await loadExtensions(extCtx, config.extensions);

  // Connect to agent asynchronously (don't block shell startup)
  const connectAgent = async () => {
    try {
      await acpClient!.start();
      agentConnected = true;
    } catch (err) {
      console.error(`Failed to connect to ${config.agentCommand}:`, err);
    }
  };

  // Start agent connection in background
  connectAgent();

  // Set up event handlers
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  // Handle terminal resize
  process.stdout.on("resize", () => {
    const newCols = process.stdout.columns || 80;
    const newRows = process.stdout.rows || 24;
    shell.resize(newCols, newRows);
  });

  // Handle shell exit
  shell.onExit((e) => {
    acpClient?.kill();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(e.exitCode);
  });

  // Set stdin to raw mode for PTY passthrough
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
