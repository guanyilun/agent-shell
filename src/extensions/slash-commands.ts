/**
 * Slash commands extension.
 *
 * Registers built-in slash commands on the event bus:
 * - Responds to "autocomplete:request" pipe for /-prefixed completions
 * - Handles "command:execute" events and dispatches to matching handler
 * - Uses "ui:info"/"ui:error" for user feedback (no direct TUI dependency)
 */
import { execSync } from "node:child_process";
import { palette as p } from "../utils/palette.js";
import type { ExtensionContext } from "../types.js";
import { discoverSkills, loadSkillContent, type Skill } from "../agent/skills.js";

interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string) => Promise<void> | void;
}

export default function activate({ bus, contextManager, quit }: ExtensionContext): void {
  // Track last response for /copy
  let lastResponseText = "";
  bus.on("agent:processing-start", () => { lastResponseText = ""; });
  bus.on("agent:response-chunk", ({ blocks }) => {
    for (const b of blocks) if (b.type === "text") lastResponseText += b.text;
  });

  const commands: SlashCommand[] = [
    {
      name: "/help",
      description: "Show available commands",
      handler: () => {
        const lines = commands.map(
          (c) => `  ${p.accent}${c.name.padEnd(12)}${p.reset} ${c.description}`
        );
        bus.emit("ui:info", { message: "Available commands:\n" + lines.join("\n") });
      },
    },
    {
      name: "/clear",
      description: "Start a new agent session",
      handler: () => {
        bus.emit("agent:reset-session", {});
        bus.emit("ui:info", { message: "Session cleared." });
      },
    },
    {
      name: "/copy",
      description: "Copy last agent response to clipboard",
      handler: () => {
        const text = lastResponseText;
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
        bus.emit("agent:submit", {
          query: "Please provide a concise summary of our conversation so far and the current state of the work.",
        });
      },
    },
    {
      name: "/model",
      description: "Cycle to next model",
      handler: () => {
        bus.emit("config:cycle", {});
      },
    },
    {
      name: "/backend",
      description: "List or switch agent backend",
      handler: (args) => {
        const name = args.trim();
        if (!name) {
          bus.emit("config:list-backends", {});
        } else {
          bus.emit("config:switch-backend", { name });
        }
      },
    },
{
      name: "/quit",
      description: "Exit agent-sh",
      handler: () => {
        quit();
      },
    },
  ];

  // ── Skill commands (/skill:<name>) ──────────────────────────────

  /** Get current skills (re-discovered on each call since cwd may change). */
  const getSkills = (): Skill[] => {
    const cwd = contextManager?.getCwd() ?? process.cwd();
    return discoverSkills(cwd);
  };

  const handleSkillCommand = (skillName: string, args: string) => {
    const skills = getSkills();
    const skill = skills.find(s => s.name === skillName);
    if (!skill) {
      bus.emit("ui:error", { message: `Unknown skill: ${skillName}` });
      return;
    }

    const content = loadSkillContent(skill);
    if (!content) {
      bus.emit("ui:error", { message: `Failed to load skill: ${skillName}` });
      return;
    }

    // Inject skill content as a query — agent sees the full instructions
    const query = args.trim()
      ? `${content}\n\n${args.trim()}`
      : content;
    bus.emit("agent:submit", { query });
  };

  // Provide command completions for /-prefixed input
  bus.onPipe("autocomplete:request", (payload) => {
    if (!payload.buffer.startsWith("/")) return payload;
    const prefix = payload.buffer.toLowerCase();

    // Built-in commands
    const matching = commands
      .filter((c) => c.name.toLowerCase().startsWith(prefix))
      .map((c) => ({ name: c.name, description: c.description }));

    // Skill commands
    if (prefix.startsWith("/skill:") || "/skill:".startsWith(prefix)) {
      const skills = getSkills();
      for (const skill of skills) {
        const name = `/skill:${skill.name}`;
        if (name.toLowerCase().startsWith(prefix)) {
          matching.push({ name, description: skill.description });
        }
      }
    }

    if (matching.length === 0) return payload;
    return { ...payload, items: [...payload.items, ...matching] };
  });

  // Handle command execution
  bus.on("command:execute", (e) => {
    // Check for /skill:<name> commands
    if (e.name.startsWith("/skill:")) {
      const skillName = e.name.slice("/skill:".length);
      handleSkillCommand(skillName, e.args);
      return;
    }

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
