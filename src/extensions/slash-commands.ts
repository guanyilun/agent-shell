/**
 * Slash commands extension.
 *
 * Registers built-in slash commands on the event bus:
 * - Responds to "command:list" pipe with command definitions (for autocomplete)
 * - Handles "command:execute" events and dispatches to matching handler
 * - Uses "ui:info"/"ui:error" for user feedback (no direct TUI dependency)
 */
import { execSync } from "node:child_process";
import type { EventBus } from "../event-bus.js";
import type { AcpClient } from "../acp-client.js";

interface SlashCommandServices {
  getAcpClient: () => AcpClient;
  quit: () => void;
}

interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string) => Promise<void> | void;
}

export function slashCommands(bus: EventBus, services: SlashCommandServices): void {
  const commands: SlashCommand[] = [
    {
      name: "/help",
      description: "Show available commands",
      handler: () => {
        const { commands: all } = bus.emitPipe("command:list", { commands: [] });
        const lines = all.map(
          (c) => `  \x1b[36m${c.name.padEnd(12)}\x1b[0m ${c.description}`
        );
        bus.emit("ui:info", { message: "Available commands:\n" + lines.join("\n") });
      },
    },
    {
      name: "/clear",
      description: "Start a new agent session",
      handler: async () => {
        try {
          await services.getAcpClient().resetSession();
          bus.emit("ui:info", { message: "Session cleared." });
        } catch (err) {
          bus.emit("ui:error", {
            message: `Failed to reset session: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      },
    },
    {
      name: "/copy",
      description: "Copy last agent response to clipboard",
      handler: () => {
        const text = services.getAcpClient().getLastResponseText();
        if (!text) {
          bus.emit("ui:info", { message: "No agent response to copy." });
          return;
        }
        try {
          if (process.platform === "darwin") {
            execSync("pbcopy", { input: text });
          } else {
            execSync("xclip -selection clipboard", { input: text });
          }
          bus.emit("ui:info", { message: "Copied to clipboard." });
        } catch {
          bus.emit("ui:error", { message: "Failed to copy to clipboard." });
        }
      },
    },
    {
      name: "/compact",
      description: "Ask agent to summarize the conversation",
      handler: async () => {
        await services.getAcpClient().sendPrompt(
          "Please provide a concise summary of our conversation so far and the current state of the work."
        );
      },
    },
    {
      name: "/quit",
      description: "Exit agent-shell",
      handler: () => {
        services.quit();
      },
    },
  ];

  // Provide command definitions for autocomplete
  bus.onPipe("command:list", (payload) => ({
    ...payload,
    commands: [
      ...payload.commands,
      ...commands.map((c) => ({ name: c.name, description: c.description })),
    ],
  }));

  // Handle command execution
  bus.on("command:execute", (e) => {
    const cmd = commands.find((c) => c.name === e.name);
    if (cmd) {
      const result = cmd.handler(e.args);
      if (result instanceof Promise) {
        result.catch((err) => {
          bus.emit("ui:error", {
            message: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } else {
      bus.emit("ui:info", {
        message: `Unknown command: ${e.name}. Type /help for available commands.`,
      });
    }
  });
}
