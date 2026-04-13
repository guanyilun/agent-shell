/**
 * Slash commands extension.
 *
 * Registers built-in slash commands on the event bus:
 * - Listens for "command:register" to accept commands from extensions
 * - Responds to "autocomplete:request" pipe for /-prefixed completions
 * - Handles "command:execute" events and dispatches to matching handler
 * - Uses "ui:info"/"ui:error" for user feedback (no direct TUI dependency)
 *
 * Argument completion is composable: any extension can onPipe("autocomplete:request")
 * and check payload.command / payload.commandArgs to add completions for any command.
 */
import { palette as p } from "../utils/palette.js";
import type { ExtensionContext } from "../types.js";
import { discoverSkills, loadSkillContent, type Skill } from "../agent/skills.js";

interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string) => Promise<void> | void;
}

export default function activate({ bus, contextManager }: ExtensionContext): void {
  const commands = new Map<string, SlashCommand>();

  const register = (cmd: SlashCommand) => {
    const name = cmd.name.startsWith("/") ? cmd.name : `/${cmd.name}`;
    commands.set(name, { ...cmd, name });
  };

  // ── Built-in commands ─────────────────────────────────────────

  register({
    name: "/help",
    description: "Show available commands",
    handler: () => {
      const maxLen = Math.max(...[...commands.values()].map(c => c.name.length));
      const pad = maxLen + 2;
      const lines = [...commands.values()].map(
        (c) => `  ${p.accent}${c.name.padEnd(pad)}${p.reset} ${c.description}`
      );
      bus.emit("ui:info", { message: "Available commands:\n" + lines.join("\n") });
    },
  });

  register({
    name: "/model",
    description: "Cycle to next model, or switch to a specific one",
    handler: (args) => {
      const name = args.trim();
      if (!name) {
        const { models, active } = bus.emitPipe("config:get-models", { models: [], active: null });
        const current = models.find((m) => m.model === active);
        const label = current
          ? `${current.model}${current.provider ? ` [${current.provider}]` : ""}`
          : active ?? "none";
        bus.emit("ui:info", { message: `Model: ${label}` });
      } else {
        bus.emit("config:switch-model", { model: name });
      }
    },
  });

  register({
    name: "/thinking",
    description: "Set thinking/reasoning effort level",
    handler: (args) => {
      const level = args.trim();
      if (!level) {
        const { level: current, levels, supported } = bus.emitPipe("config:get-thinking", { level: "off", levels: [], supported: true });
        const status = supported ? current : `${current} (not supported by current model)`;
        bus.emit("ui:info", { message: `Thinking: ${status} (options: ${levels.join(", ")})` });
      } else {
        bus.emit("config:set-thinking", { level });
      }
    },
  });

  register({
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
  });

  register({
    name: "/compact",
    description: "Compact conversation (move full content to nuclear summaries)",
    handler: () => {
      bus.emit("agent:compact-request", {});
    },
  });

  register({
    name: "/context",
    description: "Show context budget usage",
    handler: () => {
      const stats = bus.emitPipe("context:get-stats", {
        activeTokens: 0,
        nuclearEntries: 0,
        recallArchiveSize: 0,
        budgetTokens: 0,
      });
      const pct = stats.budgetTokens > 0
        ? Math.round((stats.activeTokens / stats.budgetTokens) * 100)
        : 0;
      const lines = [
        `Active context: ~${stats.activeTokens.toLocaleString()} tokens / ${stats.budgetTokens.toLocaleString()} budget (${pct}%)`,
        `Nuclear entries: ${stats.nuclearEntries} in-context`,
        `Recall archive: ${stats.recallArchiveSize} entries`,
      ];
      bus.emit("ui:info", { message: lines.join("\n") });
    },
  });

  // ── Extension registration ────────────────────────────────────

  bus.on("command:register", (cmd) => {
    register(cmd);
  });

  // ── Skill commands (/skill:<name>) ────────────────────────────

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

    const query = args.trim()
      ? `${content}\n\n${args.trim()}`
      : content;
    bus.emit("agent:submit", { query });
  };

  // ── Autocomplete: command names ───────────────────────────────

  bus.onPipe("autocomplete:request", (payload) => {
    if (!payload.buffer.startsWith("/")) return payload;
    // Argument completion is handled by separate pipe handlers below
    if (payload.command) return payload;

    const prefix = payload.buffer.toLowerCase();
    const matching = [...commands.values()]
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

  // ── Autocomplete: /model arguments ─────────────────────────────

  bus.onPipe("autocomplete:request", (payload) => {
    if (payload.command !== "/model") return payload;
    const partial = (payload.commandArgs ?? "").toLowerCase();
    const { models, active } = bus.emitPipe("config:get-models", { models: [], active: null });
    const items = models
      .filter((m) => m.model.toLowerCase().includes(partial))
      .slice(0, 15)
      .map((m) => ({
        name: `/model ${m.model}`,
        description: `${m.provider ? `[${m.provider}]` : ""}${m.model === active ? " (active)" : ""}`,
      }));
    if (items.length === 0) return payload;
    return { ...payload, items: [...payload.items, ...items] };
  });

  // ── Autocomplete: /thinking arguments ─────────────────────────

  bus.onPipe("autocomplete:request", (payload) => {
    if (payload.command !== "/thinking") return payload;
    const partial = (payload.commandArgs ?? "").toLowerCase();
    const { level: current, levels } = bus.emitPipe("config:get-thinking", { level: "off", levels: [], supported: true });
    const items = levels
      .filter((l) => l.startsWith(partial))
      .map((l) => ({
        name: `/thinking ${l}`,
        description: l === current ? "(active)" : "",
      }));
    if (items.length === 0) return payload;
    return { ...payload, items: [...payload.items, ...items] };
  });

  // ── Autocomplete: /backend arguments ──────────────────────────

  bus.onPipe("autocomplete:request", (payload) => {
    if (payload.command !== "/backend") return payload;
    const partial = (payload.commandArgs ?? "").toLowerCase();
    const { names, active } = bus.emitPipe("config:get-backends", { names: [], active: null });
    const items = names
      .filter((n) => n.toLowerCase().startsWith(partial))
      .map((n) => ({
        name: `/backend ${n}`,
        description: n === active ? "(active)" : "",
      }));
    if (items.length === 0) return payload;
    return { ...payload, items: [...payload.items, ...items] };
  });

  // ── Dispatch ──────────────────────────────────────────────────

  bus.on("command:execute", (e) => {
    if (e.name.startsWith("/skill:")) {
      const skillName = e.name.slice("/skill:".length);
      handleSkillCommand(skillName, e.args);
      return;
    }

    const cmd = commands.get(e.name);
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
