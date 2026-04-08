import { execSync } from "node:child_process";
import type { TUI } from "./tui.js";
import type { AcpClient } from "./acp-client.js";
import type { Shell } from "./shell.js";

export interface CommandContext {
  tui: TUI;
  acpClient: AcpClient;
  shell: Shell;
  quit: () => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: CommandContext) => Promise<void> | void;
}

export const commands: SlashCommand[] = [
  {
    name: "/help",
    description: "Show available commands",
    handler: (_args, ctx) => {
      const lines = commands.map(
        (c) => `  \x1b[36m${c.name.padEnd(12)}\x1b[0m ${c.description}`
      );
      ctx.tui.showInfo("Available commands:\n" + lines.join("\n"));
    },
  },
  {
    name: "/clear",
    description: "Start a new agent session",
    handler: async (_args, ctx) => {
      try {
        await ctx.acpClient.resetSession();
        ctx.tui.showInfo("Session cleared.");
      } catch (err) {
        ctx.tui.showError(
          `Failed to reset session: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  },
  {
    name: "/copy",
    description: "Copy last agent response to clipboard",
    handler: (_args, ctx) => {
      const text = ctx.acpClient.getLastResponseText();
      if (!text) {
        ctx.tui.showInfo("No agent response to copy.");
        return;
      }
      try {
        if (process.platform === "darwin") {
          execSync("pbcopy", { input: text });
        } else {
          execSync("xclip -selection clipboard", { input: text });
        }
        ctx.tui.showInfo("Copied to clipboard.");
      } catch {
        ctx.tui.showError("Failed to copy to clipboard.");
      }
    },
  },
  {
    name: "/compact",
    description: "Ask agent to summarize the conversation",
    handler: async (_args, ctx) => {
      await ctx.acpClient.sendPrompt(
        "Please provide a concise summary of our conversation so far and the current state of the work."
      );
    },
  },
  {
    name: "/quit",
    description: "Exit agent-shell",
    handler: (_args, ctx) => {
      ctx.quit();
    },
  },
];

/**
 * Find and execute a slash command. Returns true if handled.
 */
export function executeSlashCommand(
  input: string,
  ctx: CommandContext
): boolean {
  const trimmed = input.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  const cmd = commands.find((c) => c.name === name);
  if (cmd) {
    const result = cmd.handler(args, ctx);
    if (result instanceof Promise) {
      result.catch((err) => {
        ctx.tui.showError(err instanceof Error ? err.message : String(err));
      });
    }
    return true;
  }

  ctx.tui.showInfo(`Unknown command: ${name}. Type /help for available commands.`);
  return false;
}
