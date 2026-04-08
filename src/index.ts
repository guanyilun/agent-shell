import { Shell } from "./shell.js";
import { TUI } from "./tui.js";
import { AcpClient } from "./acp-client.js";
import { commands, executeSlashCommand, type CommandContext } from "./commands.js";
import type { AgentShellConfig } from "./types.js";

function parseArgs(argv: string[]): AgentShellConfig {
  let agentCommand = "claude";
  let agentArgs: string[] = [];
  const shell = process.env.SHELL || "/bin/bash";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--agent" && argv[i + 1]) {
      agentCommand = argv[++i]!;
    } else if (arg === "--agent-args" && argv[i + 1]) {
      agentArgs = argv[++i]!.split(" ");
    } else if (arg === "--shell" && argv[i + 1]) {
      return { agentCommand, agentArgs, shell: argv[++i]! };
    } else if (arg === "--help" || arg === "-h") {
      console.log(`agent-shell — a shell-first terminal with ACP agent access

Usage: agent-shell [options]

Options:
  --agent <cmd>       Agent command to launch (default: "claude")
  --agent-args <args> Arguments for the agent (space-separated, quoted)
  --shell <path>      Shell to use (default: $SHELL or /bin/bash)
  -h, --help          Show this help

Inside the shell:
  Type normally        Commands run in your real shell
  > <query>           Send query to the AI agent
  > /help             Show available slash commands
  Ctrl-C              Cancel agent response (or signal shell as usual)
`);
      process.exit(0);
    }
  }

  return { agentCommand, agentArgs, shell };
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const tui = new TUI(config.agentCommand);

  // Set terminal title
  process.stdout.write(`\x1b]0;agent-shell\x07`);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Placeholder for agent — we wire it after creating shell
  let acpClient: AcpClient | null = null;

  const shell = new Shell({
    cols,
    rows,
    shell: config.shell,
    cwd: process.cwd(),
    onAgentRequest: (query: string) => {
      if (acpClient) {
        acpClient.sendPrompt(query).catch((err) => {
          tui.showError(err instanceof Error ? err.message : String(err));
          shell.resumeOutput();
          shell.setAgentActive(false);
        });
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
    slashCommandDefs: commands.map((c) => ({ name: c.name, description: c.description })),
    onPtyOutput: () => {
      tui.scheduleRepaint();
    },
  });

  acpClient = new AcpClient(shell, tui, config);

  // Set stdin to raw mode for PTY passthrough
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Set up status bar after shell has a moment to initialize
  setTimeout(() => tui.setupStatusBar(), 500);

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

  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  // Start the ACP agent connection
  try {
    await acpClient.start();
  } catch (err) {
    tui.showInfo(
      `Agent connection failed: ${err instanceof Error ? err.message : String(err)}` +
        "\nShell is running without agent. Use --agent to specify an ACP agent."
    );
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
