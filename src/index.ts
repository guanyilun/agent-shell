#!/usr/bin/env node
import { Shell } from "./shell.js";
import { TUI } from "./tui.js";
import { AcpClient } from "./acp-client.js";
import { commands, executeSlashCommand, type CommandContext } from "./commands.js";
import type { AgentShellConfig } from "./types.js";

function parseArgs(argv: string[]): AgentShellConfig {
  // Priority: CLI args > Environment variables > Config file > Defaults
  const defaultAgent = process.env.AGENT_SHELL_AGENT || "pi-acp";
  let agentCommand = defaultAgent;
  let agentArgs: string[] = [];
  let model: string | undefined;
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
      return { agentCommand, agentArgs, shell: argv[++i]!, model };
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

  return { agentCommand, agentArgs, shell, model };
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const tui = new TUI(config.agentCommand);

  // Set terminal title
  process.stdout.write(`\x1b]0;agent-shell\x07`);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Placeholder for agent — we'll create it after shell but before starting input
  let acpClient: AcpClient | null = null;
  let agentConnected = false;

  // Signal handling
  const cleanup = () => {
    tui.teardownStatusBar();
    acpClient?.kill();
    shell.kill();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(0);
  };

  // Create shell first
  const shell = new Shell({
    cols,
    rows,
    shell: config.shell,
    cwd: process.cwd(),
    onAgentRequest: async (query: string) => {
      if (!acpClient) {
        tui.showError("Agent not initialized");
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
        tui.showError("Agent not connected. Please wait a moment and try again.");
        shell.resumeOutput();
        shell.setAgentActive(false);
        return;
      }

      try {
        await acpClient.sendPrompt(query);
      } catch (err: any) {
        tui.showError(err.message);
        shell.resumeOutput();
        shell.setAgentActive(false);
      }
    },
    onAgentCancel: () => {
      if (acpClient) {
        acpClient.cancel().catch(() => {});
      }
    },
    onSlashCommand: (input: string) => {
      if (acpClient) {
        executeSlashCommand(input, {
          tui,
          acpClient,
          shell,
          quit: cleanup,
        });
      }
      shell.printPrompt();
    },
    onShowAgentInfo: () => {
      // Return agent info string and model when entering agent input mode
      if (acpClient && acpClient.isConnected()) {
        const agentInfo = acpClient.getAgentInfo();
        const model = acpClient.getModel();
        if (agentInfo) {
          return {
            info: tui.getAgentInfoString(agentInfo, model),
            model: model
          };
        } else {
          // Debug: show why agent info is not available
          if (process.env.DEBUG) {
            process.stderr.write('[agent-shell] Agent info not available\n');
          }
        }
      } else {
        // Debug: show why we can't show agent info
        if (process.env.DEBUG) {
          if (!acpClient) {
            process.stderr.write('[agent-shell] acpClient is null\n');
          } else if (!acpClient.isConnected()) {
            process.stderr.write('[agent-shell] Agent not connected\n');
          }
        }
      }
      return { info: "" };
    },
    slashCommandDefs: commands.map((c) => ({ name: c.name, description: c.description })),
    onPtyOutput: () => {
      tui.scheduleRepaint();
    },
  });

  // Create agent client
  acpClient = new AcpClient(shell, tui, config);

  // Connect to agent asynchronously (don't block shell startup)
  const connectAgent = async () => {
    try {
      await acpClient!.start();
      agentConnected = true;
      // Note: We don't print success message here to avoid interfering with shell output
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
    tui.handleResize(newCols, newRows);
  });

  // Handle shell exit
  shell.onExit((e) => {
    tui.teardownStatusBar();
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

  // Set up status bar after shell has a moment to initialize
  setTimeout(() => tui.setupStatusBar(), 500);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
