/**
 * Slash commands extension.
 *
 * Registers built-in slash commands on the event bus:
 * - Responds to "autocomplete:request" pipe for /-prefixed completions
 * - Handles "command:execute" events and dispatches to matching handler
 * - Uses "ui:info"/"ui:error" for user feedback (no direct TUI dependency)
 */
import { execSync } from "node:child_process";
import type { ExtensionContext } from "../types.js";

interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string) => Promise<void> | void;
}

export default function activate({ bus, getAcpClient, quit }: ExtensionContext): void {
  const commands: SlashCommand[] = [
    {
      name: "/help",
      description: "Show available commands",
      handler: () => {
        const lines = commands.map(
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
          await getAcpClient().resetSession();
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
        const text = getAcpClient().getLastResponseText();
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
        await getAcpClient().sendPrompt(
          "Please provide a concise summary of our conversation so far and the current state of the work."
        );
      },
    },
    {
      name: "/quit",
      description: "Exit agent-shell",
      handler: () => {
        quit();
      },
    },
  ];

  // Provide command completions for /-prefixed input
  bus.onPipe("autocomplete:request", (payload) => {
    if (!payload.buffer.startsWith("/")) return payload;
    const prefix = payload.buffer.toLowerCase();
    const matching = commands
      .filter((c) => c.name.toLowerCase().startsWith(prefix))
      .map((c) => ({ name: c.name, description: c.description }));
    if (matching.length === 0) return payload;
    return { ...payload, items: [...payload.items, ...matching] };
  });

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
