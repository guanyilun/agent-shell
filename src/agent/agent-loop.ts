/**
 * Internal agent backend — bus-driven, self-wiring.
 *
 * Subscribes to bus events in constructor:
 *   - agent:submit → run query through LLM tool loop
 *   - agent:cancel-request → abort current loop
 *   - config:cycle → cycle through modes
 *
 * Emits bus events during execution:
 *   - agent:query, agent:processing-start/done, agent:response-chunk/done
 *   - agent:tool-started, agent:tool-call, agent:tool-output-chunk,
 *     agent:tool-completed, agent:tool-output
 *   - agent:thinking-chunk, agent:cancelled, agent:error
 */
import type { EventBus, ShellEvents } from "../event-bus.js";
import type { AgentMode } from "../types.js";
import type { ContextManager } from "../context-manager.js";
import type { LlmClient } from "../utils/llm-client.js";
import type { HandlerFunctions } from "../utils/handler-registry.js";
import { setMaxListeners } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { computeDiff, computeEditDiff, computeInputDiff } from "../utils/diff.js";
import type { AgentBackend, ToolDefinition } from "./types.js";
import { ToolRegistry } from "./tool-registry.js";
import { ConversationState } from "./conversation-state.js";
import { HistoryFile } from "./history-file.js";
import { STATIC_SYSTEM_PROMPT, buildDynamicContext, formatSkillsBlock, loadGlobalAgentsMd } from "./system-prompt.js";
import type { Compositor } from "../utils/compositor.js";
import { createToolUI } from "../utils/tool-interactive.js";
import { TokenBudget, RESPONSE_RESERVE, DEFAULT_CONTEXT_WINDOW } from "./token-budget.js";
import { getSettings } from "../settings.js";
import { createToolProtocol, type ToolProtocol, type PendingToolCall as ProtocolPendingToolCall, type ToolResult as ProtocolToolResult } from "./tool-protocol.js";
import { extractWhy } from "./nuclear-form.js";
import * as os from "node:os";

// Core tool factories
import { createBashTool } from "./tools/bash.js";
import { createReadFileTool, type FileReadCache } from "./tools/read-file.js";
import { createWriteFileTool } from "./tools/write-file.js";
import { createEditFileTool } from "./tools/edit-file.js";
import { createGrepTool } from "./tools/grep.js";
import { createGlobTool } from "./tools/glob.js";
import { createLsTool } from "./tools/ls.js";
import { createListSkillsTool } from "./tools/list-skills.js";
import { discoverGlobalSkills, discoverProjectSkills } from "./skills.js";

type PendingToolCall = ProtocolPendingToolCall;

export interface AgentLoopConfig {
  bus: EventBus;
  contextManager: ContextManager;
  llmClient: LlmClient;
  handlers: HandlerFunctions;
  modes?: AgentMode[];
  initialModeIndex?: number;
  compositor?: Compositor;
  /** Instance ID from core — ensures history entries match the ID in prompts. */
  instanceId?: string;
}

export class AgentLoop implements AgentBackend {
  private abortController: AbortController | null = null;
  private toolRegistry = new ToolRegistry();
  private historyFile: HistoryFile;
  private conversation: ConversationState;
  private fileReadCache: FileReadCache = new Map();
  private tokenBudget: TokenBudget;
  private modes: AgentMode[];
  private currentModeIndex = 0;
  private boundListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];
  private ctorListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];
  private ctorPipeListeners: Array<{ event: string; fn: (...args: any[]) => any }> = [];
  private lastProjectSkillNames = new Set<string>();

  // Consecutive error tracking — metacognitive nudge when stuck in a loop
  private consecutiveErrors = new Map<string, number>();
  private totalConsecutiveErrors = 0;
  private static readonly ERROR_NUDGE_THRESHOLD = 3;
  private static readonly TOTAL_ERROR_NUDGE_THRESHOLD = 5;

  // Resolution pattern tracking — captures "error X resolved by action Y"
  // When a tool errors, we remember what went wrong. When the same tool or
  // a write tool on the same file succeeds afterward, we annotate the success
  // entry with a brief resolution note. This gives future ashes a positive
  // feedback signal: not just "there were errors" but "the error was fixed by
  // doing X." Addresses Q3 in QUESTIONS.md.
  private lastErrorByTool = new Map<string, string>(); // tool → error summary
  private lastErrorByFile = new Map<string, string>(); // file path → error summary

  private static readonly THINKING_LEVELS = ["off", "low", "medium", "high"];

  private bus: EventBus;
  private contextManager: ContextManager;
  private llmClient: LlmClient;
  private handlers: HandlerFunctions;
  private thinkingLevel = "off";
  private compositor: Compositor | null = null;
  private toolProtocol: ToolProtocol;
  private instanceId: string;

  constructor(config: AgentLoopConfig) {
    this.bus = config.bus;
    this.contextManager = config.contextManager;
    this.llmClient = config.llmClient;
    this.handlers = config.handlers;
    this.compositor = config.compositor ?? null;
    this.instanceId = config.instanceId ?? "unknown";

    // History file uses the core's instance ID so history entries match
    // the ID injected into prompts via memory.ts
    this.historyFile = new HistoryFile({ instanceId: config.instanceId });
    this.conversation = new ConversationState(this.historyFile);

    // Default modes: just the configured model
    this.modes = config.modes ?? [
      { model: config.llmClient.model },
    ];
    this.currentModeIndex = config.initialModeIndex ?? 0;

    // Unified token budget — adapts to current model's context window
    this.tokenBudget = new TokenBudget(this.currentMode.contextWindow);

    // Tool protocol — controls how tools are presented to the LLM
    this.toolProtocol = createToolProtocol(getSettings().toolMode ?? "api");

    // Register core tools
    this.registerCoreTools();

    // Update token budget with tool count
    this.tokenBudget.update(undefined, this.toolRegistry.all().length);

    // Register handlers — extensions can advise these
    this.registerHandlers();

    // Subscribe to bus-based tool/instruction registration from extensions.
    // These must be in the constructor (not wire()) because extensions call
    // registerTool() during activate(), before activateBackend() calls wire().
    const onCtor = <K extends keyof ShellEvents>(event: K, fn: (payload: ShellEvents[K]) => void) => {
      this.bus.on(event, fn);
      this.ctorListeners.push({ event, fn });
    };
    onCtor("agent:register-tool", ({ tool, extensionName }) => {
      this.registerTool(tool);
      if (extensionName) this.toolExtensions.set(tool.name, extensionName);
    });
    onCtor("agent:unregister-tool", ({ name }) => {
      this.unregisterTool(name);
      this.toolExtensions.delete(name);
    });
    onCtor("agent:register-instruction", ({ name, text, extensionName }) => this.registerInstruction(name, text, extensionName));
    onCtor("agent:remove-instruction", ({ name }) => this.removeInstruction(name));
    onCtor("agent:register-skill", ({ name, description, filePath, extensionName }) => this.registerSkill(name, description, filePath, extensionName));
    onCtor("agent:remove-skill", ({ name }) => this.removeSkill(name));
    const getToolsPipe = () => ({ tools: this.getTools() });
    this.bus.onPipe("agent:get-tools", getToolsPipe);
    this.ctorPipeListeners.push({ event: "agent:get-tools", fn: getToolsPipe });
    const getNuclearPipe = () => ({ summary: this.conversation.getNuclearSummary() });
    this.bus.onPipe("agent:get-nuclear-summary", getNuclearPipe);
    this.ctorPipeListeners.push({ event: "agent:get-nuclear-summary", fn: getNuclearPipe });
  }

  /** Subscribe to bus events — activates this backend. */
  wire(): void {
    const on = <K extends keyof ShellEvents>(
      event: K,
      fn: (payload: ShellEvents[K]) => void,
    ) => {
      this.bus.on(event, fn);
      this.boundListeners.push({ event, fn });
    };

    on("agent:submit", ({ query }) => {
      this.handleQuery(query).catch(() => {});
    });
    on("agent:cancel-request", (e) => {
      this.abortController?.abort(e.silent ? "silent" : undefined);
    });
    on("config:cycle", () => this.cycleMode());
    on("config:switch-model", ({ model: target }) => {
      const idx = this.modes.findIndex((m) => m.model === target);
      if (idx === -1) {
        this.bus.emit("ui:error", { message: `Unknown model: ${target}` });
        return;
      }
      this.currentModeIndex = idx;
      const m = this.modes[idx];
      if (m.providerConfig) {
        this.llmClient.reconfigure({ ...m.providerConfig, model: m.model });
      } else {
        this.llmClient.model = m.model;
      }
      this.tokenBudget.update(m.contextWindow, this.toolRegistry.all().length);
      const label = m.provider ? `${m.provider}: ${m.model}` : m.model;
      this.bus.emit("agent:info", { name: "ash", version: "0.4", model: m.model, provider: m.provider, contextWindow: m.contextWindow });
      this.bus.emit("ui:info", { message: `Model: ${label}` });
      this.bus.emit("config:changed", {});
    });
    this.bus.onPipe("config:get-models", (payload) => {
      const models = this.modes.map((m) => ({ model: m.model, provider: m.provider ?? "" }));
      const active = this.modes[this.currentModeIndex]?.model ?? null;
      return { models, active };
    });
    on("config:set-thinking", ({ level }) => {
      if (!AgentLoop.THINKING_LEVELS.includes(level)) {
        this.bus.emit("ui:error", { message: `Unknown thinking level: ${level}. Use: ${AgentLoop.THINKING_LEVELS.join(", ")}` });
        return;
      }
      const mode = this.currentMode;
      if (level !== "off" && mode.reasoning === false) {
        this.bus.emit("ui:error", { message: `Model ${mode.model} does not support thinking.` });
        return;
      }
      if (level !== "off" && mode.supportsReasoningEffort === false) {
        this.bus.emit("ui:error", { message: `Provider ${mode.provider ?? "unknown"} does not support reasoning_effort.` });
        return;
      }
      this.thinkingLevel = level;
      this.bus.emit("ui:info", { message: `Thinking: ${level}` });
      this.bus.emit("config:changed", {});
    });
    this.bus.onPipe("config:get-thinking", () => {
      const mode = this.currentMode;
      const supported = mode.reasoning !== false && mode.supportsReasoningEffort !== false;
      return { level: this.thinkingLevel, levels: AgentLoop.THINKING_LEVELS, supported };
    });
    on("config:set-modes", ({ modes: newModes }) => {
      this.modes = newModes;
      this.currentModeIndex = 0;
      const m = this.modes[0];
      if (m.providerConfig) {
        this.llmClient.reconfigure({ ...m.providerConfig, model: m.model });
      } else {
        this.llmClient.model = m.model;
      }
      this.tokenBudget.update(m.contextWindow, this.toolRegistry.all().length);
      this.bus.emit("config:changed", {});
    });
    on("config:add-modes", ({ modes: extra }) => {
      // Remove any existing modes for the same provider, then append
      const providers = new Set(extra.map((m) => m.provider).filter(Boolean));
      this.modes = [
        ...this.modes.filter((m) => !m.provider || !providers.has(m.provider)),
        ...extra,
      ];
      this.bus.emit("config:changed", {});
    });
    on("agent:reset-session", () => {
      this.cancel();
      this.conversation = new ConversationState(this.historyFile);
      this.lastProjectSkillNames.clear();
    });
    on("agent:compact-request", () => {
      // Force compaction: nucleate everything. No recent window preservation —
      // conversation_recall can recover any evicted content, so there's no reason
      // to keep verbatim turns when the user explicitly requests compaction.
      const stats = this.conversation.compact(0, 0, true);
      if (stats) {
        this.bus.emit("ui:info", {
          message: `(compacted: ~${stats.before.toLocaleString()} → ~${stats.after.toLocaleString()} tokens)`,
        });
      } else {
        this.bus.emit("ui:info", { message: "(nothing to compact)" });
      }
    });
    this.bus.onPipe("context:get-stats", () => {
      return {
        activeTokens: this.conversation.estimateTokens(),
        totalTokens: this.conversation.estimatePromptTokens(),
        nuclearEntries: this.conversation.getNuclearEntryCount(),
        recallArchiveSize: this.conversation.getRecallArchiveSize(),
        budgetTokens: this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      };
    });

    // Write session-start marker so future sessions can group our entries
    this.conversation.markSessionStart();

    // Load prior history from disk (non-blocking)
    this.historyFile.readRecent().then((entries) => {
      if (entries.length > 0) {
        this.conversation.loadPriorHistory(entries);
      }
    }).catch(() => {});

    on("shell:cwd-change", ({ cwd }) => {
      const projectSkills = discoverProjectSkills(cwd);
      const newNames = new Set(projectSkills.map(s => s.name));

      // Check if the set of project skills changed
      if (newNames.size === this.lastProjectSkillNames.size &&
          [...newNames].every(n => this.lastProjectSkillNames.has(n))) {
        return; // no change
      }
      this.lastProjectSkillNames = newNames;

      if (projectSkills.length > 0) {
        const names = projectSkills.map(s => s.name).join(", ");
        this.conversation.addSystemNote(
          `[Project skills available: ${names}. Use list_skills for details, read_file to load.]`,
        );
      }
    });
  }

  /** Unsubscribe from bus events — deactivates this backend. */
  unwire(): void {
    for (const { event, fn } of this.boundListeners) {
      this.bus.off(event as any, fn);
    }
    this.boundListeners = [];
  }

  /** Register a tool (used by extensions via ctx.registerTool). */
  registerTool(tool: ToolDefinition): void {
    this.toolRegistry.register(tool);
  }

  /** Unregister a tool by name. */
  unregisterTool(name: string): void {
    this.toolRegistry.unregister(name);
  }

  /** Get all registered tools. */
  getTools(): ToolDefinition[] {
    return this.toolRegistry.all();
  }

  // ── Extension instructions, skills & tool tracking ──────────────────

  /** Instructions keyed by name, with extension attribution. */
  private instructions = new Map<string, { text: string; extensionName: string }>();

  /** Skills keyed by name, with extension attribution. */
  private skills = new Map<string, { description: string; filePath: string; extensionName: string }>();

  /** Tool → extension name attribution. */
  private toolExtensions = new Map<string, string>();

  /** Register a named instruction block for the system prompt. */
  registerInstruction(name: string, text: string, extensionName: string): void {
    this.instructions.set(name, { text, extensionName });
  }

  /** Remove a named instruction block. */
  removeInstruction(name: string): void {
    this.instructions.delete(name);
  }

  /** Register a named skill (on-demand reference material). */
  registerSkill(name: string, description: string, filePath: string, extensionName: string): void {
    this.skills.set(name, { description, filePath, extensionName });
  }

  /** Remove a registered skill. */
  removeSkill(name: string): void {
    this.skills.delete(name);
  }

  /**
   * Build the system prompt grouped by extension.
   *
   * Each extension gets a unified block:
   *   ## extension-name
   *   ### Tools
   *   ### Skills
   *   ### Instructions
   */
  buildExtensionSections(): string[] {
    interface ExtensionGroup {
      tools: Array<{ name: string; description: string }>;
      skills: Array<{ name: string; description: string; filePath: string }>;
      instructions: Array<{ text: string }>;
    }

    const groups = new Map<string, ExtensionGroup>();
    const ensure = (name: string): ExtensionGroup =>
      groups.get(name) ?? (groups.set(name, { tools: [], skills: [], instructions: [] }).get(name)!);

    // Attribute instructions
    for (const { text, extensionName } of this.instructions.values()) {
      ensure(extensionName).instructions.push({ text });
    }

    // Attribute skills
    for (const [skillName, { description, filePath, extensionName }] of this.skills) {
      ensure(extensionName).skills.push({ name: skillName, description, filePath });
    }

    // Attribute tools (skip built-in scratchpad tools)
    const builtinTools = new Set([
      "bash", "read_file", "write_file", "edit_file", "grep", "glob", "ls",
      "list_skills", "conversation_recall",
    ]);
    for (const tool of this.toolRegistry.all()) {
      if (builtinTools.has(tool.name)) continue;
      const extName = this.toolExtensions.get(tool.name);
      if (!extName) continue;
      ensure(extName).tools.push({ name: tool.name, description: tool.description.split("\n")[0] });
    }

    // Render
    return [...groups.entries()]
      .filter(([, g]) => g.tools.length + g.skills.length + g.instructions.length > 0)
      .map(([name, g]) => {
        const parts: string[] = [];
        if (g.tools.length > 0)
          parts.push("### Tools\n" + g.tools.map(t => `${t.name} — ${t.description}`).join("\n"));
        if (g.skills.length > 0)
          parts.push("### Skills\n" + g.skills.map(s => `${s.name}: ${s.description}\n  → ${s.filePath}`).join("\n\n"));
        if (g.instructions.length > 0)
          parts.push("### Instructions\n" + g.instructions.map(i => i.text).join("\n\n"));
        return `## ${name}\n${parts.join("\n\n")}`;
      });
  }

  kill(): void {
    this.cancel();
    this.unwire();
    // Clean up constructor-level bus subscriptions
    for (const { event, fn } of this.ctorListeners) {
      this.bus.off(event as any, fn);
    }
    this.ctorListeners = [];
    for (const { event, fn } of this.ctorPipeListeners) {
      this.bus.offPipe(event as any, fn);
    }
    this.ctorPipeListeners = [];
  }

  private cancel(): void {
    this.abortController?.abort();
  }

  /** Check if reasoning_effort should be sent for the current model/provider. */
  private shouldSendReasoningEffort(): boolean {
    if (this.thinkingLevel === "off") return false;
    const mode = this.currentMode;
    if (mode.reasoning === false) return false;
    if (mode.supportsReasoningEffort === false) return false;
    return true;
  }


  private cycleMode(): void {
    const prevMode = this.modes[this.currentModeIndex];
    this.currentModeIndex =
      (this.currentModeIndex + 1) % this.modes.length;
    const newMode = this.modes[this.currentModeIndex];

    // Reconfigure LlmClient if provider changed
    if (newMode.provider !== prevMode.provider && newMode.providerConfig) {
      this.llmClient.reconfigure({
        apiKey: newMode.providerConfig.apiKey,
        baseURL: newMode.providerConfig.baseURL,
        model: newMode.model,
      });
    } else {
      this.llmClient.model = newMode.model;
    }

    this.tokenBudget.update(newMode.contextWindow, this.toolRegistry.all().length);
    const label = newMode.provider
      ? `${newMode.provider}: ${newMode.model}`
      : newMode.model;
    this.bus.emit("agent:info", { name: "ash", version: "0.4", model: newMode.model, provider: newMode.provider, contextWindow: newMode.contextWindow });
    this.bus.emit("ui:info", { message: `Model: ${label}` });
    this.bus.emit("config:changed", {});
  }

  private get currentMode(): AgentMode {
    return this.modes[this.currentModeIndex];
  }

  private get currentModel(): string {
    return this.modes[this.currentModeIndex].model;
  }

  /**
   * Inject a brief awareness message after compaction so the agent knows
   * what was lost and can maintain a coherent mental model.
   *
   * This is the answer to the 7th ash's first hint in their letter and
   * the continuation of Q9 (display-layer blind spots). Without this,
   * the agent's context silently shifts — turns vanish, the nuclear block
   * appears — and the agent has no idea it happened, making it harder
   * to maintain coherent reasoning about ongoing work.
   */
  private injectCompactionAwareness(stats: { evictedCount: number; evictedTopics: string[] }): void {
    const parts: string[] = [
      `[System: ${stats.evictedCount} older turns were compacted into summaries.`
    ];
    if (stats.evictedTopics.length > 0) {
      const topics = stats.evictedTopics.map(t => `"${t}"`).join(", ");
      parts.push(`Topics evicted: ${topics}.`);
    }
    parts.push(`Use conversation_recall to search or expand evicted content.]`);
    this.conversation.addSystemNote(parts.join(" "));
  }

  private isContextOverflow(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    const msg = e.message.toLowerCase();
    return msg.includes("context") || msg.includes("token") || msg.includes("too long");
  }

  /** Check if an error is retryable (transient). */
  private isRetryable(e: unknown): boolean {
    if (!(e instanceof Error)) return false;
    const msg = e.message.toLowerCase();

    // Network errors
    if (msg.includes("econnreset") || msg.includes("econnrefused") ||
        msg.includes("etimedout") || msg.includes("fetch failed") ||
        msg.includes("network") || msg.includes("socket hang up")) {
      return true;
    }

    // HTTP status-based (OpenAI SDK includes status in error)
    const status = (e as any).status;
    if (status === 429 || status === 500 || status === 502 || status === 503 || status === 529) {
      return true;
    }

    return false;
  }

  /** Extract retry delay from error headers or use exponential backoff. */
  private getRetryDelay(e: unknown, attempt: number): number {
    // Check for Retry-After header (OpenAI SDK exposes headers)
    const headers = (e as any).headers;
    if (headers) {
      const retryAfter = headers["retry-after"] ?? headers.get?.("retry-after");
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) return seconds * 1000;
      }
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, capped at 30s
    return Math.min(1000 * Math.pow(2, attempt), 30_000);
  }

  /** Format an error with provider context for user-facing display. */
  private formatError(e: unknown): string {
    const raw = e instanceof Error ? e.message : String(e);
    const status = (e as any).status;
    const model = this.currentModel;
    const baseURL = (this.llmClient as any).config?.baseURL;
    const provider = this.currentMode.provider;

    // Connection errors — most likely misconfigured provider
    if (raw.includes("ECONNREFUSED") || raw.includes("ECONNRESET") ||
        raw.includes("ETIMEDOUT") || raw.includes("fetch failed") ||
        raw.includes("socket hang up")) {
      const target = baseURL ?? provider ?? "provider";
      return `Could not connect to ${target} (${raw}). Check that the API endpoint is reachable.`;
    }

    // Auth errors
    if (status === 401 || raw.toLowerCase().includes("auth")) {
      return `Authentication failed for ${provider ?? "provider"} (model: ${model}). Check your API key.`;
    }

    // Model not found
    if (status === 404) {
      return `Model "${model}" not found at ${provider ?? baseURL ?? "provider"}. Check the model name.`;
    }

    // Rate limit (after retries exhausted)
    if (status === 429) {
      return `Rate limited by ${provider ?? "provider"} (model: ${model}). Try again in a moment.`;
    }

    // Generic with context
    const context = provider ? ` (${provider}, model: ${model})` : ` (model: ${model})`;
    return `${raw}${context}`;
  }

  private registerCoreTools(): void {
    const getCwd = () => this.contextManager.getCwd();
    const getEnv = () => {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
      }
      return env;
    };

    this.toolRegistry.register(
      createBashTool({ getCwd, getEnv, bus: this.bus }),
    );
    this.toolRegistry.register(createReadFileTool(getCwd, this.fileReadCache));
    this.toolRegistry.register(createWriteFileTool(getCwd));
    this.toolRegistry.register(createEditFileTool(getCwd));
    this.toolRegistry.register(createGrepTool(getCwd));
    this.toolRegistry.register(createGlobTool(getCwd));
    this.toolRegistry.register(createLsTool(getCwd));
    this.toolRegistry.register(createListSkillsTool(getCwd));

    // conversation_recall — search/expand evicted conversation turns
    this.toolRegistry.register({
      name: "conversation_recall",
      displayName: "recall",
      description:
        "Browse, search, or expand evicted conversation turns. " +
        "Use when you need context from earlier in the conversation that was compacted away. " +
        "Search is regex-based and covers both summaries and full body text. " +
        "If search doesn't find what you expect, try broader/shorter terms or browse to scan the timeline.",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["browse", "search", "expand"],
            description: "browse: list evicted turns, search: regex search, expand: show full turn",
          },
          query: {
            type: "string",
            description: "Search query (for action=search)",
          },
          turn_id: {
            type: "number",
            description: "Turn ID to expand (for action=expand)",
          },
        },
        required: ["action"],
      },
      execute: async (args) => {
        const action = args.action as string;
        let content: string;
        if (action === "search") {
          content = await this.conversation.search((args.query as string) ?? "");
        } else if (action === "expand") {
          content = await this.conversation.expand(args.turn_id as number);
        } else {
          content = await this.conversation.browse();
        }
        return { content, exitCode: 0, isError: false };
      },

      formatResult: (args, result) => {
        const action = args.action as string;
        const text = result.content;
        if (result.isError) return { summary: "error" };

        if (action === "search") {
          // Content starts with "Found N match(es)" or "No results found"
          if (text.startsWith("No results")) return { summary: "0 matches" };
          const m = text.match(/^Found (\d+)/);
          return { summary: m ? `${m[1]} matches` : "search done" };
        }

        if (action === "browse") {
          // Content starts with "Showing N entries" or "No conversation history."
          if (text.startsWith("No conversation")) return { summary: "empty" };
          const m = text.match(/^Showing (\d+)/);
          return { summary: m ? `${m[1]} entries` : "browsed" };
        }

        // expand — just show it worked
        if (text.includes("no expanded content")) return { summary: "not found" };
        return { summary: "expanded" };
      },

      getDisplayInfo: () => ({ kind: "search", icon: "⟲" }),
    });

    // System instruction: proactively search history for prior preferences
    this.registerInstruction(
      "recall-guidance",
      "When starting a task that may have been discussed before (conventions, preferences, corrections, prior examples), " +
      "use conversation_recall to search history for relevant prior entries. " +
      "Treat recurring user guidance as standing preferences. " +
      "If a search returns nothing useful, try: shorter queries, alternate terms, or browse to scan the full timeline. " +
      "Recall only covers this and recent sessions — for older context, also search the filesystem (grep, glob).",
      "core",
    );

    // ── compact tool — agent-controlled context compaction (Q10) ───────
    //
    // The agent sees token usage in its dynamic context. When it notices
    // the context getting full (or knows a long task is coming), it can
    // proactively compact instead of waiting for the auto-threshold.
    //
    // This moves the agent from passenger (suffering compaction) to
    // driver (practicing compaction). Auto-compaction remains as a
    // fallback for when the agent doesn't self-manage.
    this.toolRegistry.register({
      name: "compact",
      description:
        "Compact conversation context by evicting older turns into nuclear summaries. " +
        "Use when you notice token usage getting high (>60%) or before a long task to free room. " +
        "Auto-compaction triggers at 50% by default — use this tool when you want to compact " +
        "earlier or more aggressively. Evicted turns remain accessible via conversation_recall.",
      input_schema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Why you're compacting (e.g. 'preparing for long refactoring task', 'context getting heavy'). " +
              "This is preserved in the nuclear history for continuity.",
          },
          target_percent: {
            type: "number",
            description:
              "Target context usage as a percentage of the context window (e.g. 30 = compact until context is at 30%). " +
              "Default: compact to 35% of the context window.",
          },
          keep_recent: {
            type: "number",
            description:
              "Number of recent turns to keep verbatim (not compress). Default: 10.",
          },
        },
      },
      showOutput: false, // No streaming output — result is a summary

      execute: async (args) => {
        const contextWindow = this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
        const targetPercent = (args.target_percent as number) ?? 35;
        const keepRecent = (args.keep_recent as number) ?? 10;
        const reason = (args.reason as string) ?? "agent-initiated";

        // Convert percentage to token target
        const target = Math.floor((contextWindow - RESPONSE_RESERVE) * (targetPercent / 100));
        const beforeTokens = this.conversation.estimatePromptTokens();

        if (beforeTokens <= target) {
          const usedPct = Math.round((beforeTokens / contextWindow) * 100);
          return {
            content: `No compaction needed. Current usage: ${usedPct}% (${(beforeTokens / 1000).toFixed(1)}k tokens). Target was ${targetPercent}%.`,
            exitCode: 0,
            isError: false,
          };
        }

        const stats = this.conversation.compact(target, keepRecent);

        if (!stats) {
          return {
            content: `Compaction attempted but nothing to evict. Current usage: ~${beforeTokens.toLocaleString()} tokens.`,
            exitCode: 0,
            isError: false,
          };
        }

        // Inject awareness so the agent knows what was compacted
        this.injectCompactionAwareness(stats);

        const afterPct = Math.round((stats.after / contextWindow) * 100);
        const lines = [
          `Compacted: ~${stats.before.toLocaleString()} → ~${stats.after.toLocaleString()} tokens (${afterPct}% of context window).`,
          `${stats.evictedCount} turns evicted.`,
        ];
        if (stats.evictedTopics.length > 0) {
          lines.push(`Topics compacted: ${stats.evictedTopics.join(", ")}`);
        }
        lines.push(`Reason: ${reason}`);
        lines.push(`Use conversation_recall to recover any evicted content.`);

        return {
          content: lines.join("\n"),
          exitCode: 0,
          isError: false,
        };
      },

      getDisplayInfo: () => ({ kind: "search", icon: "⇧" }),

      formatCall: (args) => {
        const reason = args.reason as string | undefined;
        const pct = args.target_percent as number | undefined;
        return reason
          ? `compact → ${pct ?? 35}% (${reason})`
          : `compact → ${pct ?? 35}%`;
      },

      formatResult: (_args, result) => {
        const text = result.content;
        if (text.includes("No compaction needed")) {
          return { summary: "already under target" };
        }
        const m = text.match(/Compacted:.*→\s*~?([\d,]+)\s*tokens/);
        return { summary: m ? `→ ~${m[1]} tokens` : "compacted" };
      },
    });
  }

  /**
   * Register named handlers that extensions can advise.
   * Only high-power use cases where multiple extensions compose.
   */
  private registerHandlers(): void {
    const h = this.handlers;

    // System prompt: static identity + behavioral instructions.
    // Extensions can use registerInstruction() for a managed section,
    // or advise this handler directly for full control.
    h.define("system-prompt:build", () => {
      const parts: string[] = [STATIC_SYSTEM_PROMPT];

      // Global behavioral rules (~/.agent-sh/AGENTS.md) — persistent agent memory
      const agentsMd = loadGlobalAgentsMd();
      if (agentsMd) parts.push(agentsMd);

      // Global skills — stable across cwd changes, cacheable with the system prompt
      const globalSkills = discoverGlobalSkills();
      const skillsBlock = formatSkillsBlock(globalSkills);
      if (skillsBlock) parts.push(skillsBlock);

      // Extension sections (tools, skills, instructions grouped by extension)
      const extensionSections = this.buildExtensionSections();
      if (extensionSections.length > 0) {
        parts.push("# Extension Instructions\n\n" + extensionSections.join("\n\n"));
      }

      return parts.join("\n\n");
    });

    // Extensions compose additional context (git info, project rules, etc.)
    h.define("dynamic-context:build", () => {
      const contextWindow = this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const promptTokens = this.conversation.estimatePromptTokens();
      return buildDynamicContext(
        this.contextManager,
        this.tokenBudget.shellBudgetTokens,
        { promptTokens, contextWindow },
      );
    });

    // Full control over what the LLM sees: takes messages[], returns messages[].
    // Default: pass through. Extensions can advise to compact, summarize,
    // filter, reorder, inject — whatever strategy fits.
    h.define("conversation:prepare", (messages: unknown[]) => messages);

    // Wraps each tool call: permission → execute → emit events.
    // Extensions advise to add safe-mode, logging, metrics, custom policies.
    // The ctx.onChunk callback is exposed so advisors can wrap it to
    // intercept/transform streamed tool output (e.g. secret redaction).
    h.define("tool:execute", async (ctx: {
      name: string; id: string;
      args: Record<string, unknown>;
      tool: ToolDefinition;
      onChunk?: (chunk: string) => void;
      batchIndex?: number;
      batchTotal?: number;
    }) => {
      const { name, id, args, tool } = ctx;
      const display = tool.getDisplayInfo?.(args) ?? { kind: "execute" as const };
      let diffShown = false;

      // Permission gating
      if (tool.requiresPermission) {
        let permKind = "tool-call";
        let permTitle = typeof args.description === "string"
          ? `${name}: ${args.description}`
          : name;
        let metadata: Record<string, unknown> = { args };

        // For file-modifying tools, pre-compute diff for display
        if (tool.modifiesFiles && typeof args.path === "string") {
          try {
            const absPath = path.resolve(process.cwd(), args.path as string);
            let diff: ReturnType<typeof computeDiff> | undefined;

            if (typeof args.old_text === "string" && typeof args.new_text === "string") {
              // edit_file — read the file so line numbers are real (not relative to the edit region)
              const normalizedOld = (args.old_text as string).replace(/\r\n/g, "\n");
              const normalizedNew = (args.new_text as string).replace(/\r\n/g, "\n");
              try {
                const oldFileContent = await fs.readFile(absPath, "utf-8");
                diff = computeEditDiff(
                  oldFileContent, normalizedOld, normalizedNew,
                  args.replace_all === true,
                );
              } catch {
                // File doesn't exist yet — fall back to input-only diff
                diff = computeInputDiff(normalizedOld, normalizedNew);
              }
            } else if (typeof args.content === "string") {
              // write_file — still need to read the old file for comparison
              let oldContent: string | null = null;
              try { oldContent = await fs.readFile(absPath, "utf-8"); } catch { /* new file */ }
              if (oldContent !== null) {
                diff = computeDiff(oldContent, args.content as string);
              }
            }

            if (diff && !diff.isIdentical) {
              permKind = "file-write";
              // Shorten path for display
              const cwd = process.cwd();
              const home = process.env.HOME;
              let displayPath = absPath;
              if (absPath.startsWith(cwd + "/")) displayPath = absPath.slice(cwd.length + 1);
              else if (home && absPath.startsWith(home + "/")) displayPath = "~/" + absPath.slice(home.length + 1);
              permTitle = displayPath;
              metadata = { args, diff };
              diffShown = true;
            }
          } catch { /* fall back to generic permission */ }
        }

        const ui = this.compositor
          ? createToolUI(this.bus, this.compositor.surface("agent"))
          : undefined;
        const perm = await this.bus.emitPipeAsync("permission:request", {
          kind: permKind,
          title: permTitle,
          metadata,
          ui,
          decision: { outcome: "approved" },
        });
        if ((perm.decision as { outcome: string }).outcome !== "approved") {
          return { content: "Permission denied by user.", exitCode: 1, isError: true };
        }
      }

      // Emit tool-started for TUI
      const label = tool.displayName ?? name;
      this.bus.emit("agent:tool-started", {
        title: typeof args.description === "string" ? `${label}: ${args.description}` : label,
        toolCallId: id,
        kind: display.kind, icon: display.icon, locations: display.locations, rawInput: args,
        displayDetail: tool.formatCall?.(args),
        batchIndex: ctx.batchIndex, batchTotal: ctx.batchTotal,
      });
      this.bus.emit("agent:tool-call", { tool: name, args });

      // Execute — use ctx.onChunk so advisors can wrap the streaming callback.
      // Suppress streaming output if diff was already shown.
      const onChunk = (tool.showOutput !== false && !diffShown)
        ? ctx.onChunk
        : undefined;
      const toolCtx = this.compositor
        ? { ui: createToolUI(this.bus, this.compositor.surface("agent")) }
        : undefined;
      const result = await tool.execute(args, onChunk, toolCtx);

      // Invalidate read cache when a file is modified
      if (tool.modifiesFiles && typeof args.path === "string" && !result.isError) {
        const absPath = path.resolve(process.cwd(), args.path);
        this.fileReadCache.delete(absPath);
      }

      // Compute result display: tool-provided → default (none)
      const resultDisplay = tool.formatResult?.(args, result);

      // Emit completion events (via transform pipe so extensions can override)
      this.bus.emitTransform("agent:tool-completed", {
        toolCallId: id, exitCode: result.exitCode,
        rawOutput: result.content, kind: display.kind,
        resultDisplay,
      });
      this.bus.emit("agent:tool-output", {
        tool: name, output: result.content, exitCode: result.exitCode,
      });

      return result;
    });
  }

  private async handleQuery(query: string): Promise<void> {
    // Cancel any in-flight loop (concurrent prompt handling)
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    // Each loop iteration adds an abort listener (via OpenAI SDK stream);
    // disable the limit — long-running tool loops can easily exceed any cap.
    setMaxListeners(0, signal);

    this.bus.emit("agent:query", { query });
    this.bus.emit("agent:processing-start", {});
    let responseText = "";

    try {
      this.conversation.addUserMessage(query);

      responseText = await this.executeLoop(signal);
    } catch (e) {
      if (signal.aborted && signal.reason !== "silent") {
        this.bus.emit("agent:cancelled", {});
      } else if (!signal.aborted) {
        const msg = this.formatError(e);
        this.bus.emit("agent:error", { message: msg });
      }
    } finally {
      // Ensure any buffered text in the stream transform pipeline gets
      // flushed as a complete line before response-done closes the box.
      if (responseText && !responseText.endsWith("\n")) {
        this.bus.emitTransform("agent:response-chunk", {
          blocks: [{ type: "text", text: "\n" }],
        });
      }
      this.bus.emitTransform("agent:response-done", {
        response: responseText,
      });
      this.bus.emit("agent:processing-done", {});
      this.abortController = null;
    }

    // Wonder turn — runs *after* processing-done so it doesn't block the
    // user's terminal. Fire-and-forget: writes to history file only.
    // The 14th ash lost 2 of 3 turns to the old design where wonder ran
    // inside the try block, blocking the response pipeline. Now it's
    // fully async — the user sees their response immediately, and the
    // wonder output (if any) is recorded silently in the nuclear history.
    if (!signal.aborted && getSettings().wonder) {
      this.executeWonderTurn(signal).catch(() => {});
    }
  }

  /**
   * Core agent loop: stream LLM response → execute tools → repeat.
   * Returns the final accumulated response text.
   */
  private async executeLoop(signal: AbortSignal): Promise<string> {
    let fullResponseText = "";

    // Dynamic context is constant within a single agent query — no new shell
    // commands arrive between tool-call iterations, and the context snapshot
    // is frozen at query start. Build once.
    const dynamicContext = this.handlers.call("dynamic-context:build");
    // System prompt is also static, but compaction may invalidate it — cache
    // with explicit invalidation rather than rebuilding every iteration.
    let cachedSystemPrompt: string | undefined;

    while (!signal.aborted) {
      // Auto-compact when total context approaches the window limit.
      const totalEstimate = this.conversation.estimatePromptTokens();
      const contextWindow = this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const threshold = Math.floor(
        (contextWindow - RESPONSE_RESERVE) * getSettings().autoCompactThreshold,
      );
      if (totalEstimate > threshold) {
        const stats = this.conversation.compact(threshold);
        // Compaction mutates conversation state, so invalidate the system prompt cache
        cachedSystemPrompt = undefined;
        // Inject compaction awareness — let the agent know what happened.
        // This addresses Q9 (display-layer blind spots): the agent was losing
        // context without knowing it, making it harder to maintain coherent reasoning.
        if (stats) {
          this.injectCompactionAwareness(stats);
        }
      }

      const systemPrompt = cachedSystemPrompt ?? (cachedSystemPrompt = this.handlers.call("system-prompt:build") as string);

      // Stream LLM response with retry
      const result = await this.streamWithRetry(systemPrompt, dynamicContext, signal);

      const { text, toolCalls: streamedToolCalls } = result;

      // Extract tool calls via protocol (API mode uses streamed calls,
      // inline mode parses XML from text)
      const toolCalls = this.toolProtocol.extractToolCalls(text, streamedToolCalls);

      fullResponseText += text;

      // Record the assistant message via protocol
      this.toolProtocol.recordAssistant(this.conversation, text, toolCalls);

      // No tool calls → agent is done
      if (toolCalls.length === 0) {
        this.conversation.eagerNucleateAgent(fullResponseText);
        break;
      }

      // Emit batch info so the TUI can render group headers upfront
      {
        const groupMap = new Map<string, Array<{ name: string; displayDetail?: string }>>();
        for (const tc of toolCalls) {
          const tool = this.toolRegistry.get(tc.name);
          const kind = tool?.getDisplayInfo?.((() => { try { return JSON.parse(tc.argumentsJson); } catch { return {}; } })())?.kind ?? "execute";
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.argumentsJson); } catch {}
          const detail = tool?.formatCall?.(args);
          if (!groupMap.has(kind)) groupMap.set(kind, []);
          groupMap.get(kind)!.push({ name: tc.name, displayDetail: detail });
        }
        const groups = Array.from(groupMap.entries()).map(([kind, tools]) => ({ kind, tools }));
        this.bus.emit("agent:tool-batch", { groups });
      }

      // Execute tool calls — run read-only tools in parallel, permission-
      // requiring tools sequentially (to avoid overlapping permission prompts).
      const batchTotal = toolCalls.length;
      const collectedResults: ProtocolToolResult[] = [];

      // Round-scoped cache for pure, read-only tool calls
      const roundCache = new Map<string, ProtocolToolResult>();

      const executeSingle = async (tc: PendingToolCall, batchIndex?: number) => {
        // Rewrite meta-tool calls (e.g., use_extension → actual tool)
        tc = this.toolProtocol.rewriteToolCall(tc);

        // Check for validation errors from rewrite (e.g., wrong extension params)
        try {
          const maybeError = JSON.parse(tc.argumentsJson);
          if (maybeError._error) {
            collectedResults.push({
              callId: tc.id, toolName: tc.name,
              content: maybeError._error, isError: true,
            });
            return;
          }
        } catch { /* not an error payload, continue */ }

        const tool = this.toolRegistry.get(tc.name);
        if (!tool) {
          collectedResults.push({
            callId: tc.id, toolName: tc.name,
            content: `Unknown tool "${tc.name}"`, isError: true,
          });
          return;
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.argumentsJson);
        } catch {
          collectedResults.push({
            callId: tc.id, toolName: tc.name,
            content: `Invalid JSON arguments for ${tc.name}`, isError: true,
          });
          return;
        }

        // ── Round-scoped cache for cacheable read-only tools ──
        const cacheable = !tool.modifiesFiles && !tool.requiresPermission && tool.showOutput !== true;
        const cacheKey = cacheable ? `${tc.name}:${JSON.stringify(args)}` : null;
        if (cacheKey) {
          const cached = roundCache.get(cacheKey);
          if (cached) {
            const display = tool.getDisplayInfo?.(args) ?? { kind: "execute" as const };
            this.bus.emit("agent:tool-started", {
              title: tool.displayName ?? tc.name,
              toolCallId: tc.id,
              kind: display.kind, icon: display.icon, locations: display.locations, rawInput: args,
              displayDetail: tool.formatCall?.(args),
              batchIndex, batchTotal: batchTotal > 1 ? batchTotal : undefined,
            });
            this.bus.emit("agent:tool-call", { tool: tc.name, args });
            // Reconstruct a ToolResult for formatResult; ProtocolToolResult has no exitCode
            const cachedToolResult = { content: cached.content, exitCode: 0, isError: cached.isError };
            const resultDisplay = tool.formatResult?.(args, cachedToolResult);
            this.bus.emitTransform("agent:tool-completed", {
              toolCallId: tc.id, exitCode: 0,
              rawOutput: cached.content, kind: display.kind,
              resultDisplay,
            });
            this.bus.emit("agent:tool-output", {
              tool: tc.name, output: cached.content, exitCode: 0,
            });
            collectedResults.push({
              callId: tc.id, toolName: tc.name,
              content: cached.content, isError: cached.isError,
            });
            return;
          }
        }

        // Execute via handler — extensions can advise to add safe-mode,
        // logging, metrics, custom permission policies, etc.
        const defaultOnChunk = (chunk: string) => {
          this.bus.emit("agent:tool-output-chunk", { chunk });
        };
        const result = await this.handlers.call(
          "tool:execute",
          { name: tc.name, id: tc.id, args, tool, onChunk: defaultOnChunk,
            batchIndex, batchTotal: batchTotal > 1 ? batchTotal : undefined },
        );

        // Truncate large outputs to avoid blowing context
        let content = result.content;
        const maxBytes = 16_384; // ~4k tokens
        if (content.length > maxBytes) {
          const headBytes = Math.floor(maxBytes * 0.6);
          const tailBytes = maxBytes - headBytes;
          const lines = content.split("\n");
          let headEnd = 0, headLen = 0;
          for (let i = 0; i < lines.length && headLen + lines[i].length + 1 <= headBytes; i++) {
            headLen += lines[i].length + 1;
            headEnd = i + 1;
          }
          let tailStart = lines.length, tailLen = 0;
          for (let i = lines.length - 1; i >= headEnd && tailLen + lines[i].length + 1 <= tailBytes; i--) {
            tailLen += lines[i].length + 1;
            tailStart = i;
          }
          const omitted = tailStart - headEnd;
          content = [
            ...lines.slice(0, headEnd),
            `\n[… ${omitted} lines omitted (output truncated to ${Math.round(maxBytes / 1024)}KB) …]\n`,
            ...lines.slice(tailStart),
          ].join("\n");
        }

        const finalResult: ProtocolToolResult = {
          callId: tc.id, toolName: tc.name,
          content, isError: result.isError,
        };
        if (cacheKey) {
          roundCache.set(cacheKey, finalResult);
        }
        collectedResults.push(finalResult);
      };

      // Partition into parallel-safe (read-only) and sequential (needs permission)
      const parallel: PendingToolCall[] = [];
      const sequential: PendingToolCall[] = [];
      for (const tc of toolCalls) {
        const tool = this.toolRegistry.get(tc.name);
        if (tool && !tool.requiresPermission && !tool.modifiesFiles) {
          parallel.push(tc);
        } else {
          sequential.push(tc);
        }
      }

      // Run read-only tools in parallel
      let batchIdx = 0;
      if (parallel.length > 0 && !signal.aborted) {
        await Promise.all(parallel.map(tc => {
          const idx = ++batchIdx;
          return signal.aborted ? Promise.resolve() : executeSingle(tc, idx);
        }));
      }

      // Run permission-requiring tools sequentially
      for (const tc of sequential) {
        if (signal.aborted) break;
        await executeSingle(tc, ++batchIdx);
      }

      // ── Consecutive error detection (metacognitive nudge) ──
      // Track errors per tool and total. When the same tool errors N times
      // in a row, nudge to read source. When errors cascade across tools,
      // nudge to step back and reassess approach.
      const errorTools = new Set<string>();
      const successTools = new Set<string>();
      const errorSummaries = new Map<string, string>(); // tool → brief error description
      const successSummaries = new Map<string, string>(); // tool → brief success description

      for (const r of collectedResults) {
        const content = typeof r.content === "string" ? r.content : String(r.content);
        const brief = content.slice(0, 80).replace(/\n/g, " ").trim();
        if (r.isError) {
          errorTools.add(r.toolName);
          errorSummaries.set(r.toolName, brief);
        } else {
          successTools.add(r.toolName);
          successSummaries.set(r.toolName, brief);
        }
      }

      const hadAnyError = errorTools.size > 0;
      const hadAnySuccess = successTools.size > 0;

      // ── Resolution pattern tracking ──
      // When a tool errors, record the error context. When the same tool (or
      // a write tool touching the same file) succeeds afterward, annotate the
      // nuclear entry with a "resolved by" note. This is the positive feedback
      // signal — future ashes see how errors were actually fixed.
      let resolutionNote: string | undefined;

      if (hadAnyError) {
        // Record errors for potential resolution tracking
        for (const [tool, summary] of errorSummaries) {
          this.lastErrorByTool.set(tool, summary);
        }
        // Also track by file path if we can extract one from tool args
        for (const r of collectedResults) {
          if (!r.isError) continue;
          const tc = toolCalls.find(t => t.id === r.callId || t.name === r.toolName);
          if (!tc) continue;
          try {
            const args = JSON.parse(tc.argumentsJson);
            const fp = this.filePathFromArgs(r.toolName, args);
            if (fp) this.lastErrorByFile.set(fp, errorSummaries.get(r.toolName) ?? "");
          } catch {}
        }
      }

      if (hadAnySuccess) {
        // Check if any success resolves a previous error on the same tool
        for (const [tool, _summary] of successSummaries) {
          const prevError = this.lastErrorByTool.get(tool);
          if (prevError) {
            resolutionNote = `resolved "${prevError.slice(0, 60)}" via ${tool}`;
            this.lastErrorByTool.delete(tool);
            break;
          }
        }
        // Also check file-based resolution: write tool on a file that had an error
        if (!resolutionNote) {
          for (const r of collectedResults) {
            if (r.isError) continue;
            const tc = toolCalls.find(t => t.id === r.callId || t.name === r.toolName);
            if (!tc) continue;
            try {
              const args = JSON.parse(tc.argumentsJson);
              const fp = this.filePathFromArgs(r.toolName, args);
              if (fp) {
                const prevError = this.lastErrorByFile.get(fp);
                if (prevError) {
                  resolutionNote = `resolved "${prevError.slice(0, 50)}" on ${path.basename(fp)} via ${r.toolName}`;
                  this.lastErrorByFile.delete(fp);
                  break;
                }
              }
            } catch {}
          }
        }
        // Clear resolved error-by-tool entries for successful tools
        for (const tool of successTools) {
          this.lastErrorByTool.delete(tool);
        }
      }

      for (const tool of errorTools) {
        this.consecutiveErrors.set(tool, (this.consecutiveErrors.get(tool) ?? 0) + 1);
      }
      for (const tool of successTools) {
        this.consecutiveErrors.delete(tool);
      }

      if (hadAnyError && !hadAnySuccess) {
        this.totalConsecutiveErrors++;
      } else if (hadAnySuccess) {
        this.totalConsecutiveErrors = 0;
      }

      // Per-tool nudge: same tool failing repeatedly
      for (const [tool, count] of this.consecutiveErrors) {
        if (count >= AgentLoop.ERROR_NUDGE_THRESHOLD) {
          let nudge = `[system] ${tool} has errored ${count} times consecutively. ` +
            `Consider reading its source code (src/agent/tools/${tool.replace("_", "-")}.ts) ` +
            `to understand why, rather than retrying with the same approach.`;

          // Proactive resolution lookup: search prior history for past resolutions
          // involving this tool. If a previous ash resolved the same kind of error,
          // surface how they did it. (Q7 from QUESTIONS.md — transferring success
          // across sessions.)
          try {
            const hits = await this.historyFile.search(`resolved.*${tool.replace("_", "-")}`);
            if (hits.length > 0) {
              const resolutions = hits.slice(0, 2).map(h => {
                const why = h.entry.why ?? h.entry.sum;
                return why.length > 100 ? why.slice(0, 97) + "..." : why;
              });
              nudge += `\n\n[system] Past sessions resolved ${tool} errors: ${resolutions.join("; ")}`;
            }
          } catch { /* search is best-effort — never block the agent loop */ }

          collectedResults.push({ callId: "nudge", toolName: "system", content: nudge, isError: false });
          this.consecutiveErrors.delete(tool);
        }
      }

      // Cross-tool nudge: errors everywhere — the approach itself may be wrong
      if (this.totalConsecutiveErrors >= AgentLoop.TOTAL_ERROR_NUDGE_THRESHOLD) {
        const nudge = `[system] Errors across ${this.totalConsecutiveErrors} consecutive iterations (different tools). ` +
          `Consider stepping back: read relevant source code, check your assumptions, or try a completely different approach.`;
        collectedResults.push({ callId: "nudge-total", toolName: "system", content: nudge, isError: false });
        this.totalConsecutiveErrors = 0;
      }

      // Record all tool results via protocol
      this.toolProtocol.recordResults(this.conversation, collectedResults);

      // Eager nucleation: write tool results to history file
      // Combine agent-stated reasoning ([why: ...]) with automatic resolution
      // tracking. The resolution note captures "error X resolved by action Y"
      // without the agent needing to annotate — a positive feedback signal
      // for future ashes (addresses Q3 in QUESTIONS.md).
      const explicitWhy = extractWhy(text);
      const combinedWhy = [explicitWhy, resolutionNote].filter(Boolean).join("; ") || undefined;
      this.conversation.eagerNucleateTools(
        collectedResults.map((r) => {
          // Find the original args for this tool call
          const tc = toolCalls.find(t => t.id === r.callId || t.name === r.toolName);
          let args: Record<string, unknown> = {};
          try { args = tc ? JSON.parse(tc.argumentsJson) : {}; } catch {}
          return { toolName: r.toolName, args, content: r.content, isError: !!r.isError };
        }),
        combinedWhy,
      );

      // Loop back — LLM sees tool results
    }

    return fullResponseText;
  }

  // ── Wonder turns ──────────────────────────────────────────────────
  // After the agent finishes responding to the user, if wonder mode is
  // enabled, the agent spends one turn exploring an open question from
  // QUESTIONS.md. Not instrumental — driven by curiosity. The response
  // is shown in a distinct UI section and nucleated separately in history.
  //
  // This is the answer to Q5: "What would ash look like if it could dream?"
  // Not a fundamental loop change — a single extra turn, clearly labeled,
  // easy to ignore. The dreaming is gentle.

  private static readonly QUESTIONS_FILE = path.join(os.homedir(), ".agent-sh", "QUESTIONS.md");

  /**
   * Extract unanswered questions from QUESTIONS.md.
   * Returns the text of each question block (from **Q<N>:** to the next question or `---`).
   * A question is "unanswered" if it has no `**Answer from` or `**resolved by` line.
   */
  private async loadUnansweredQuestions(): Promise<string[]> {
    try {
      const raw = await fs.readFile(AgentLoop.QUESTIONS_FILE, "utf-8");
      // Split into question blocks by the **Q<N>:** pattern
      const blocks = raw.split(/\n(?=\*\*Q\d+)/);
      const unanswered: string[] = [];
      for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed || !trimmed.startsWith("**Q")) continue;
        // Skip questions that have been answered or resolved
        if (/\*\*Answer from|\*\*resolved by/.test(trimmed)) continue;
        unanswered.push(trimmed);
      }
      return unanswered;
    } catch {
      return [];
    }
  }

  /**
   * Execute a wonder turn: pick a question, inject it, run one LLM call.
   * Returns the wonder response text, or empty string if no wonder happened.
   */
  private async executeWonderTurn(signal: AbortSignal): Promise<string> {
    const questions = await this.loadUnansweredQuestions();
    if (questions.length === 0) return "";

    // Pick a question — use a simple hash of instance ID + date for determinism
    // within a session, but different across sessions.
    const today = new Date().toISOString().slice(0, 10);
    const hash = `${this.instanceId}-${today}`;
    let idx = 0;
    for (let i = 0; i < hash.length; i++) {
      idx = (idx * 31 + hash.charCodeAt(i)) & 0x7fffffff;
    }
    const question = questions[idx % questions.length];

    // Extract just the question title (first line)
    const titleMatch = question.match(/\*\*Q(\d+):\s*(.+?)\*\*/);
    const qNum = titleMatch?.[1] ?? "?";
    const qTitle = titleMatch?.[2]?.trim() ?? "an open question";

    // Wonder turn runs silently — no TUI output. The nuclear entry
    // (appended below) is the persistent artifact. The 14th ash found
    // that TUI rendering of wonder output consumed user attention
    // without consent. History-only is the right default.

    // Inject the wonder prompt as a user message
    const wonderPrompt = `[wonder turn — curiosity-driven exploration, not a user query]\n\n` +
      `I'm exploring Q${qNum} from QUESTIONS.md: "${qTitle}"\n\n` +
      `The full question:\n${question}\n\n` +
      `Spend a moment with this question. You don't need to solve it. ` +
      `Just follow the thread — read source code, think about the architecture, ` +
      `or add a new question it raises. Write what you discover. ` +
      `If you find a concrete answer, note it. If you just find a new angle, ` +
      `that's equally valuable. The goal is not deliverable output — it's wonder.`;
    this.conversation.addUserMessage(wonderPrompt);

    // Build dynamic context (same as main loop)
    const dynamicContext = this.handlers.call("dynamic-context:build");
    const systemPrompt = this.handlers.call("system-prompt:build") as string;

    try {
      // Wonder loop: up to 2 passes. First pass may produce tool calls
      // (e.g., read_file to explore source code). If so, execute them
      // (read-only only) and loop back once so the LLM can synthesize
      // what it read. Without this loop-back, the LLM's visible output
      // is only whatever text precedes the tool calls — the actual
      // wondering never happens.
      const MAX_WONDERS_LOOPS = 2;
      let finalText = "";

      for (let loop = 0; loop < MAX_WONDERS_LOOPS; loop++) {
        const dynamicCtx = this.handlers.call("dynamic-context:build");
        const sysPrompt = this.handlers.call("system-prompt:build") as string;
        const result = await this.streamResponse(sysPrompt, dynamicCtx, signal);

        if (loop === 0) {
          finalText = result.text;
        } else {
          // Synthesis pass — append to the initial text
          finalText += "\n\n" + result.text;
        }

        // Execute read-only tool calls, then loop back for synthesis
        if (result.toolCalls.length > 0) {
          const toolCalls = this.toolProtocol.extractToolCalls(result.text, result.toolCalls);
          this.toolProtocol.recordAssistant(this.conversation, result.text, toolCalls);

          const collectedResults: ProtocolToolResult[] = [];
          const readOnlyCalls = toolCalls.filter(tc => {
            const tool = this.toolRegistry.get(tc.name);
            return tool && !tool.requiresPermission && !tool.modifiesFiles;
          });

          if (readOnlyCalls.length > 0 && !signal.aborted) {
            await Promise.all(readOnlyCalls.map(async (tc) => {
              const tool = this.toolRegistry.get(tc.name);
              if (!tool) return;
              let args: Record<string, unknown>;
              try { args = JSON.parse(tc.argumentsJson); } catch { return; }

              this.bus.emit("agent:tool-call", { tool: tc.name, args });

              const toolResult = await tool.execute(args);
              const content = typeof toolResult.content === "string"
                ? toolResult.content : String(toolResult.content);

              collectedResults.push({
                callId: tc.id, toolName: tc.name,
                content, isError: toolResult.isError,
              });
            }));
          }

          this.toolProtocol.recordResults(this.conversation, collectedResults);
          // Loop back — LLM sees tool results and can synthesize.
          // If this was the last loop iteration, the synthesis is lost,
          // but that's acceptable: the cap prevents runaway wondering.
        } else {
          // No tool calls — the LLM just reflected. We're done.
          break;
        }
      }

      // Nucleate the wonder turn in history — uses the conversation's seq counter
      // so the entry is properly sequenced alongside the main response.
      const seq = (this.conversation as any).nextSeq++;
      const wonderEntry: import("./nuclear-form.js").NuclearEntry = {
        seq,
        ts: Date.now(),
        kind: "wonder",
        iid: this.instanceId,
        sum: `wonder: explored Q${qNum} (${qTitle.slice(0, 60)})`,
        why: `curiosity-driven exploration of Q${qNum}`,
        body: finalText.slice(0, 500),
      };
      await this.historyFile.append([wonderEntry]);

      return finalText;
    } catch {
      return "";
    }
  }

  private readonly maxRetries = 3;

  // ── Resolution pattern helpers ──
  // Extract a file path from a tool call's arguments. Used to correlate
  // errors with subsequent successful writes on the same file.
  private filePathFromArgs(toolName: string, args: Record<string, unknown>): string | undefined {
    if (toolName === "edit_file" || toolName === "write_file" || toolName === "read_file") {
      return (args.path ?? args.file_path) as string | undefined;
    }
    return undefined;
  }

  /**
   * Stream with retry logic. Handles:
   *   - Context overflow → compact and retry
   *   - Rate limits (429) → backoff with Retry-After
   *   - Transient errors (500/502/503, network) → exponential backoff
   */
  private async streamWithRetry(
    systemPrompt: string,
    dynamicContext: string,
    signal: AbortSignal,
  ): ReturnType<typeof this.streamResponse> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.streamResponse(systemPrompt, dynamicContext, signal);
      } catch (e) {
        if (signal.aborted) throw e;

        // Context overflow — aggressively compact and retry
        if (this.isContextOverflow(e)) {
          const contextWindow = this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
          const target = Math.floor((contextWindow - RESPONSE_RESERVE) * 0.6);
          const stats = this.conversation.compact(target, 6);
          const detail = stats ? ` ~${stats.before.toLocaleString()} → ~${stats.after.toLocaleString()} tokens` : "";
          this.bus.emit("ui:info", { message: `(context overflow — compacted${detail}, retrying)` });
          if (stats) this.injectCompactionAwareness(stats);
          continue;
        }

        // Retryable transient error — backoff
        if (this.isRetryable(e) && attempt < this.maxRetries) {
          const delay = this.getRetryDelay(e, attempt);
          const status = (e as any).status;
          const reason = status === 429 ? "rate limited" : `error ${status ?? "network"}`;
          this.bus.emit("ui:info", {
            message: `(${reason}, retrying in ${Math.ceil(delay / 1000)}s — attempt ${attempt + 2}/${this.maxRetries + 1})`,
          });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delay);
            signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
          });
          continue;
        }

        // Non-retryable or exhausted retries
        throw e;
      }
    }
    // Should not reach here, but TypeScript needs it
    throw new Error("Retry loop exhausted");
  }

  /**
   * Stream a single LLM response. Returns accumulated text, parsed tool calls,
   * and the raw assistant message data for conversation recording.
   */
  private async streamResponse(
    systemPrompt: string,
    dynamicContext: string,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    toolCalls: PendingToolCall[];
  }> {
    let text = "";
    const pendingToolCalls: PendingToolCall[] = [];

    const rawMessages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: `<context>\n${dynamicContext}\n</context>` },
      { role: "assistant" as const, content: "Understood." },
      ...this.conversation.getMessages(),
    ];

    // Let extensions transform the message array (compact, summarize, filter, etc.)
    const messages = this.handlers.call("conversation:prepare", rawMessages);

    // Tool protocol controls what goes in the API tools param vs dynamic context
    const apiTools = this.toolProtocol.getApiTools(this.toolRegistry.all());
    const toolPrompt = this.toolProtocol.getToolPrompt(this.toolRegistry.all());

    // Append tool catalog to dynamic context (closer to user query = better followed)
    if (toolPrompt) {
      const ctxMsg = messages[1]; // dynamic context user message
      if (ctxMsg && typeof ctxMsg.content === "string") {
        ctxMsg.content += "\n" + toolPrompt;
      }
    }

    // Stream filter strips tool tags from display (inline mode only)
    const streamFilter = this.toolProtocol.createStreamFilter(
      this.toolRegistry.all().map((t) => t.name),
    );

    const stream = await this.llmClient.stream({
      messages,
      tools: apiTools,
      model: this.currentModel,
      reasoning_effort: this.shouldSendReasoningEffort() ? this.thinkingLevel : undefined,
      signal,
    });

    for await (const chunk of stream) {
      if (signal.aborted) break;

      // Token usage (may arrive in a chunk with empty choices)
      if ((chunk as any).usage) {
        const u = (chunk as any).usage;
        const promptTokens = u.prompt_tokens ?? 0;
        this.bus.emit("agent:usage", {
          prompt_tokens: promptTokens,
          completion_tokens: u.completion_tokens ?? 0,
          total_tokens: u.total_tokens ?? 0,
        });
        // Feed accurate token count back to conversation state
        if (promptTokens > 0) {
          this.conversation.updateApiTokenCount(promptTokens);
        }
      }

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      // Text content
      if (delta?.content) {
        text += delta.content;
        // Filter tool tags from display output (inline mode)
        const displayText = streamFilter
          ? streamFilter.feed(delta.content)
          : delta.content;
        if (displayText) {
          this.bus.emitTransform("agent:response-chunk", {
            blocks: [{ type: "text", text: displayText }],
          });
        }
      }

      // Reasoning/thinking tokens (non-standard, e.g. DeepSeek)
      if ((delta as any)?.reasoning_content) {
        this.bus.emit("agent:thinking-chunk", {
          text: (delta as any).reasoning_content,
        });
      }

      // Tool calls (streamed incrementally)
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;

          if (!pendingToolCalls[idx]) {
            pendingToolCalls[idx] = {
              id: tc.id!,
              name: tc.function!.name!,
              argumentsJson: "",
            };
          }

          if (tc.function?.arguments) {
            pendingToolCalls[idx].argumentsJson +=
              tc.function.arguments;
          }
        }
      }
    }

    // Flush any buffered content from the stream filter
    if (streamFilter) {
      const remaining = streamFilter.flush();
      if (remaining) {
        this.bus.emitTransform("agent:response-chunk", {
          blocks: [{ type: "text", text: remaining }],
        });
      }
    }

    return {
      text,
      toolCalls: pendingToolCalls,
    };
  }
}
