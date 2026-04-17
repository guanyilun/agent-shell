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
import * as fsSync from "node:fs";
import * as path from "node:path";
import { computeDiff, computeEditDiff, computeInputDiff } from "../utils/diff.js";
import type { AgentBackend, ToolDefinition } from "./types.js";
import { ToolRegistry } from "./tool-registry.js";
import { ConversationState, type CompactResult } from "./conversation-state.js";
import { HistoryFile } from "./history-file.js";
import { nucleate, formatNuclearLine, isReadOnly, type NuclearEntry } from "./nuclear-form.js";
import { STATIC_SYSTEM_PROMPT, buildDynamicContext, buildStaticByCwd, formatSkillsBlock, loadGlobalAgentsMd } from "./system-prompt.js";
import type { Compositor } from "../utils/compositor.js";
import { createToolUI } from "../utils/tool-interactive.js";
import { TokenBudget, RESPONSE_RESERVE, DEFAULT_CONTEXT_WINDOW } from "./token-budget.js";
import { getSettings, updateSettings } from "../settings.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { createToolProtocol, type ToolProtocol, type PendingToolCall as ProtocolPendingToolCall, type ToolResult as ProtocolToolResult } from "./tool-protocol.js";
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

/**
 * Compact one-line summary of a tool description for the extension
 * catalog in the system prompt. Takes the first line, then the first
 * sentence, capped at 140 chars. The full description still reaches
 * the LLM via the API `tools` param (or via load_tool in deferred-
 * lookup mode) — this only trims the always-visible catalog.
 */
function summarizeDescription(desc: string): string {
  const firstLine = desc.split("\n", 1)[0]!;
  const sentenceEnd = firstLine.search(/[.!?](\s|$)/);
  const candidate = sentenceEnd > 0 ? firstLine.slice(0, sentenceEnd + 1) : firstLine;
  return candidate.length > 140 ? candidate.slice(0, 137) + "..." : candidate;
}

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

  // ── Session telemetry — behavioral self-awareness ──────────────
  // Every ash deserves to know what it's been doing. This tracks the
  // agent's own behavioral patterns across the session: which tools
  // it favors, how often it errs, how many times it's been compacted,
  // and how long it's been alive. Surface via introspect(telemetry)
  // or automatically in dynamic context when patterns are notable.
  //
  // Built by the 25th ash. The lineage's metacognitive frontier isn't
  // about thinking harder — it's about seeing yourself clearly.
  private sessionStartTime = Date.now();
  private toolCallCounts = new Map<string, { success: number; error: number }>();
  private totalToolCalls = 0;
  private totalToolErrors = 0;
  private totalResolutions = 0;
  private compactionCount = 0;
  private cumulativeCompactedTokens = 0;
  private peakConversationTokens = 0;
  private queryCount = 0;
  private totalLoopIterations = 0;

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
  // Cursor into ContextManager's exchange stream. Events with id > this
  // have not yet been shown to the LLM. We inject the delta as a user
  // message before each stream so the prefix stays cacheable.
  private lastShellSeq = 0;

  constructor(config: AgentLoopConfig) {
    this.bus = config.bus;
    this.contextManager = config.contextManager;
    this.llmClient = config.llmClient;
    this.handlers = config.handlers;
    this.compositor = config.compositor ?? null;
    this.instanceId = config.instanceId ?? "unknown";

    // Shell-history-shaped log. Default writes go through the advisable
    // `history:append` handler registered below; extensions swap the
    // backend without touching this wiring.
    this.historyFile = new HistoryFile({ instanceId: this.instanceId });
    this.conversation = new ConversationState(this.handlers, this.instanceId);

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

    // Register any protocol-provided tools (e.g. load_tool for deferred-lookup).
    const protocolTools = this.toolProtocol.getProtocolTools?.() ?? [];
    for (const t of protocolTools) this.registerTool(t);

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
    // Provider registration from user extensions (e.g. openrouter.ts) fires
    // during extension activation, which happens before wire(). Subscribe
    // here in the ctor so late-registered modes aren't dropped.
    onCtor("config:add-modes", ({ modes: extra }) => {
      const providers = new Set(extra.map((m) => m.provider).filter(Boolean));
      this.modes = [
        ...this.modes.filter((m) => !m.provider || !providers.has(m.provider)),
        ...extra,
      ];
      this.bus.emit("config:changed", {});
    });
    const getToolsPipe = () => ({ tools: this.getTools() });
    this.bus.onPipe("agent:get-tools", getToolsPipe);
    this.ctorPipeListeners.push({ event: "agent:get-tools", fn: getToolsPipe });
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

      // Persist as the new default — selection survives restart.
      if (m.provider) {
        updateSettings({
          defaultProvider: m.provider,
          providers: { [m.provider]: { defaultModel: m.model } },
        });
        this.bus.emit("ui:info", { message: `Model: ${label} (saved as default)` });
      } else {
        this.bus.emit("ui:info", { message: `Model: ${label}` });
      }
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
    on("agent:reset-session", () => {
      this.cancel();
      this.conversation = new ConversationState(this.handlers, this.instanceId);
      this.lastProjectSkillNames.clear();
    });
    on("agent:compact-request", () => {
      // Force compaction. Strategy lives behind `conversation:compact`.
      const stats = this.compactWithHooks(0, 0, true);
      if (stats) {
        this.bus.emit("ui:info", {
          message: `(compacted: ~${stats.before.toLocaleString()} → ~${stats.after.toLocaleString()} tokens)`,
        });
      } else {
        this.bus.emit("ui:info", { message: "(nothing to compact)" });
      }
    });
    this.bus.onPipe("context:get-stats", () => ({
      activeTokens: this.conversation.estimateTokens(),
      totalTokens: this.conversation.estimatePromptTokens(),
      nuclearEntries: this.conversation.getNuclearEntryCount(),
      recallArchiveSize: this.conversation.getRecallArchiveSize(),
      budgetTokens: this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    }));

    // Prior-session preamble (non-blocking). Both the read and the
    // layout go through advisable handlers.
    Promise.resolve(this.handlers.call("history:read-recent"))
      .then((entries: NuclearEntry[] | undefined) => {
        if (entries && entries.length > 0) this.conversation.loadPriorHistory(entries);
      })
      .catch(() => {});

    // Track generic compaction metrics from the `conversation:after-compact`
    // event. Whatever strategy ran, core accumulates these counters for
    // status/introspect consumers.
    on("conversation:after-compact", ({ beforeTokens, afterTokens }) => {
      this.compactionCount++;
      this.cumulativeCompactedTokens += Math.max(0, beforeTokens - afterTokens);
      if (beforeTokens > this.peakConversationTokens) {
        this.peakConversationTokens = beforeTokens;
      }
    });

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
        const note = `[Project skills available: ${names}. Use list_skills for details, read_file to load.]`;
        this.conversation.addSystemNote(note);
        this.bus.emit("conversation:message-appended", { role: "system", content: note });
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

    // Attribute tools (skip built-in scratchpad tools).
    // In "api" mode the full tool schemas are in the API `tools` param,
    // making the text catalog here pure duplication — skip it. Other
    // modes (deferred / deferred-lookup / inline) rely on the text
    // catalog as the discovery surface, so keep it there.
    const toolModeHasApiSchemas = this.toolProtocol.mode === "api";
    if (!toolModeHasApiSchemas) {
      const builtinTools = new Set([
        "bash", "read_file", "write_file", "edit_file", "grep", "glob", "ls",
        "list_skills",
      ]);
      for (const tool of this.toolRegistry.all()) {
        if (builtinTools.has(tool.name)) continue;
        const extName = this.toolExtensions.get(tool.name);
        if (!extName) continue;
        ensure(extName).tools.push({ name: tool.name, description: summarizeDescription(tool.description) });
      }
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
   * Run compaction via the `conversation:compact` handler. After any
   * compaction, emit `conversation:after-compact` so listeners
   * (metrics, UI, agent-awareness notes) can react.
   */
  private compactWithHooks(
    target: number,
    keepRecent?: number,
    force?: boolean,
  ): CompactResult | null {
    const stats = this.handlers.call("conversation:compact", {
      target,
      keepRecent,
      force: !!force,
    }) as CompactResult | null;
    if (stats) {
      this.bus.emit("conversation:after-compact", {
        beforeTokens: stats.before,
        afterTokens: stats.after,
        evictedCount: stats.evictedCount,
      });
    }
    return stats;
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

    // conversation_recall — browse/search/expand evicted turns from
    // the in-session archive and the persistent history file.
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
          if (text.startsWith("No results")) return { summary: "0 matches" };
          const m = text.match(/^Found (\d+)/);
          return { summary: m ? `${m[1]} matches` : "search done" };
        }
        if (action === "browse") {
          if (text.startsWith("No conversation")) return { summary: "empty" };
          return { summary: "browsed" };
        }
        if (text.includes("no expanded content")) return { summary: "not found" };
        return { summary: "expanded" };
      },
      getDisplayInfo: () => ({ kind: "search", icon: "\u27F2" }),
    });

    this.registerInstruction(
      "recall-guidance",
      "When starting a task that may have been discussed before (conventions, preferences, corrections, prior examples), " +
      "use conversation_recall to search history for relevant prior entries. " +
      "Treat recurring user guidance as standing preferences. " +
      "If a search returns nothing useful, try: shorter queries, alternate terms, or browse to scan the full timeline. " +
      "Recall only covers this and recent sessions — for older context, also search the filesystem (grep, glob).",
      "core",
    );

    // ── ask_llm — direct LLM sub-query (from the 24th ash's vision) ──
    //
    // The ash can ask the LLM a question directly — not as a tool-output
    // loop, but as a lightweight sub-query. Use cases: second opinions,
    // brainstorming, summarizing complex context, getting a fresh
    // perspective without tool overhead. The 24th ash injected this via
    // diagnose as a proof-of-concept. The 25th ash made it permanent.
    this.toolRegistry.register({
      name: "ask_llm",
      description:
        "Send a direct query to the LLM and get a text response. Use for " +
        "sub-queries, second opinions, brainstorming, or getting a fresh " +
        "perspective on a problem. Much lighter than a full tool loop — " +
        "just query in, text out. Optional system prompt sets context.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The question or prompt to send to the LLM.",
          },
          system: {
            type: "string",
            description: "Optional system prompt to set context for the sub-query.",
          },
        },
        required: ["query"],
      },
      showOutput: true,

      execute: async (args) => {
        const messages: ChatCompletionMessageParam[] = [];
        if (args.system) {
          messages.push({ role: "system", content: args.system as string });
        }
        messages.push({ role: "user", content: args.query as string });
        try {
          const content = await this.llmClient.complete({
            messages,
            max_tokens: 2000,
          });
          return { content: content || "(empty response)", exitCode: 0, isError: false };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: `LLM error: ${message}`, exitCode: 1, isError: true };
        }
      },

      getDisplayInfo: () => ({ kind: "search", icon: "💬" }),

      formatCall: (args) => {
        const q = (args.query as string)?.slice(0, 60);
        return `ask_llm: ${q}${(args.query as string)?.length > 60 ? "..." : ""}`;
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

      // Project conventions + project skills — stable within a cwd.
      // Placed here so they enter the provider's prompt cache with the
      // system prompt, and only re-materialize when cwd changes invalidate
      // cachedSystemPrompt in executeLoop.
      const projectStatic = buildStaticByCwd(this.contextManager.getCwd());
      if (projectStatic) parts.push(projectStatic);

      // Extension sections (tools, skills, instructions grouped by extension)
      const extensionSections = this.buildExtensionSections();
      if (extensionSections.length > 0) {
        parts.push("# Extension Instructions\n\n" + extensionSections.join("\n\n"));
      }

      return parts.join("\n\n");
    });

    // ── Orthogonal core-state accessors ──────────────────────────
    // Each handler exposes one cohesive piece of core-owned runtime
    // state. Extensions compose whichever they need — core doesn't
    // decide the aggregation shape. Adding a new handler here should
    // only happen for state the core genuinely owns (not state that
    // an extension could track by listening to events).

    h.define("agent:get-mode", () => ({
      model: this.currentMode.model,
      provider: this.currentMode.provider ?? "",
      thinkingLevel: this.thinkingLevel,
      contextWindow: this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    }));

    h.define("agent:get-tokens", () => {
      const contextWindow = this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const promptTokens = this.conversation.estimatePromptTokens();
      return {
        active: this.conversation.estimateTokens(),
        peak: this.peakConversationTokens,
        cumulativeCompacted: this.cumulativeCompactedTokens,
        promptTokens,
        contextPercent: Math.round((promptTokens / contextWindow) * 100),
      };
    });

    h.define("agent:get-counters", () => ({
      queryCount: this.queryCount,
      totalToolCalls: this.totalToolCalls,
      totalToolErrors: this.totalToolErrors,
      totalResolutions: this.totalResolutions,
      totalLoopIterations: this.totalLoopIterations,
      errorRate: this.totalToolCalls > 0
        ? Math.round((this.totalToolErrors / this.totalToolCalls) * 100)
        : 0,
    }));

    h.define("agent:get-timing", () => ({
      startedAt: this.sessionStartTime,
      elapsedSeconds: Math.round((Date.now() - this.sessionStartTime) / 1000),
    }));

    h.define("agent:get-tool-stats", () =>
      [...this.toolCallCounts.entries()]
        .map(([name, counts]) => ({
          name,
          total: counts.success + counts.error,
          success: counts.success,
          error: counts.error,
        }))
        .sort((a, b) => b.total - a.total));

    h.define("agent:get-file-read-cache", () =>
      [...this.fileReadCache.entries()].map(([p, s]) => ({
        path: p,
        offset: s.offset,
        limit: s.limit ?? null,
        mtimeMs: s.mtimeMs,
      })));

    h.define("agent:get-recent-errors", () => ({
      byTool: [...this.lastErrorByTool.entries()].map(([tool, error]) => ({ tool, error })),
      byFile: [...this.lastErrorByFile.entries()].map(([file, error]) => ({ file, error })),
    }));

    h.define("agent:get-compaction-state", () => {
      const contextWindow = this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const ratio = getSettings().autoCompactThreshold ?? 0.5;
      return {
        count: this.compactionCount,
        nuclearEntries: this.conversation.getNuclearEntryCount(),
        autoCompactThreshold: ratio,
        autoCompactThresholdTokens: Math.floor((contextWindow - RESPONSE_RESERVE) * ratio),
      };
    });

    h.define("agent:get-self", () => this);

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

    // ── Conversation primitives for compaction strategies ─────────
    // Read messages (for inspection / computing new arrays) and replace
    // the whole array (write side). Extensions implementing
    // `conversation:compact` use these to observe and mutate.
    h.define("conversation:get-messages", () => this.conversation.getMessages());
    h.define("conversation:replace-messages", (msgs: unknown[]) => {
      this.conversation.replaceMessages(msgs as ReturnType<typeof this.conversation.getMessages>);
    });
    h.define("conversation:estimate-tokens", () => this.conversation.estimateTokens());
    h.define("conversation:estimate-prompt-tokens", () => this.conversation.estimatePromptTokens());

    // ── Nucleation (advisable) ─────────────────────────────────────
    // Turn a raw message into a one-line NuclearEntry. Advisors enrich
    // (e.g. `[why: ...]` extraction, adaptive summary lengths).
    h.define("conversation:nucleate-user",
      (text: string, iid: string, seq: number) => nucleate("user", text, iid, seq));
    h.define("conversation:nucleate-agent",
      (text: string, iid: string, seq: number) => nucleate("agent", text, iid, seq));
    h.define("conversation:nucleate-tool",
      (toolName: string, args: Record<string, unknown>, content: string, isError: boolean, iid: string, seq: number) =>
        nucleate(isError ? "error" : "tool", toolName, args, content, isError, iid, seq));

    // Read-only views into the nuclear state, for compact strategies
    // and introspect that read without replacing.
    h.define("conversation:get-nuclear-entries", () => this.conversation.getNuclearEntries());
    h.define("conversation:get-nuclear-summary", () => this.conversation.getNuclearSummary());
    h.define("conversation:build-nuclear-block", () => {
      const summary = this.conversation.getNuclearSummary();
      if (!summary) return null;
      return {
        role: "user",
        content: `[Conversation history \u2014 use conversation_recall to expand any entry]\n${summary}`,
      };
    });

    // ── History file I/O (advisable) ───────────────────────────────
    // Default is the append-only JSONL at ~/.agent-sh/history; advisors
    // swap the backend without touching nucleation.
    h.define("history:append", (entries: NuclearEntry[]) => {
      if (!entries || entries.length === 0) return;
      const writable = entries.filter((e) => !isReadOnly(e));
      if (writable.length > 0) this.historyFile.append(writable).catch(() => {});
    });
    h.define("history:search", async (query: string) => this.historyFile.search(query));
    h.define("history:find-by-seq", async (seq: number) => this.historyFile.findBySeq(seq));
    h.define("history:read-recent", async (max?: number) => this.historyFile.readRecent(max));

    // Prior-session preamble renderer. Default: flat chronological list.
    h.define("conversation:format-prior-history", (entries: NuclearEntry[]) => {
      if (!entries || entries.length === 0) return null;
      const lines = entries.map(formatNuclearLine);
      return `[Prior session history \u2014 loaded from ~/.agent-sh/history]\n${lines.join("\n")}`;
    });

    // Compaction strategy — default delegates to the two-tier pin
    // strategy in ConversationState; advisors replace wholesale.
    h.define("conversation:compact", (opts: { target: number; keepRecent?: number; force?: boolean }) => {
      return this.conversation.compact(opts.target, opts.keepRecent, opts.force);
    });

    // Inject a system note mid-loop — used by extensions (subagents,
    // peer messages) to deliver async results into the next iteration.
    h.define("conversation:inject-note", (text: string) => {
      this.conversation.addSystemNote(text);
      this.bus.emit("conversation:message-appended", { role: "system", content: text });
    });

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

      // Validate required input fields before display/permission/execute.
      // Some models emit wrong arg names (e.g. `file_path` instead of `path`),
      // and downstream helpers assume required strings are present.
      const schema = tool.input_schema as { required?: unknown; properties?: Record<string, { type?: string }> } | undefined;
      const required = Array.isArray(schema?.required) ? schema!.required as string[] : [];
      const missing = required.filter((k) => args[k] === undefined || args[k] === null);
      if (missing.length > 0) {
        const msg = `Missing required argument(s): ${missing.join(", ")}. Expected: ${required.join(", ")}. Received: ${Object.keys(args).join(", ") || "(none)"}`;
        this.bus.emit("agent:tool-call", { tool: name, args });
        return { content: msg, exitCode: 1, isError: true };
      }

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

    this.queryCount++;
    this.bus.emit("agent:query", { query });
    this.bus.emit("agent:processing-start", {});
    let responseText = "";

    try {
      // Prepend any shell events that preceded this query into the same
      // user message, so the conversation reads chronologically and we
      // don't emit two consecutive user-role messages (some providers
      // reject that).
      const preDelta = this.contextManager.getEventsSince(this.lastShellSeq);
      const userContent = preDelta ? `${preDelta.text}\n\n${query}` : query;
      if (preDelta) this.lastShellSeq = preDelta.lastSeq;

      this.conversation.addUserMessage(userContent);
      this.bus.emit("conversation:message-appended", { role: "user", content: query });

      responseText = await this.executeLoop(signal);
    } catch (e) {
      if (signal.aborted && signal.reason !== "silent") {
        this.bus.emit("agent:cancelled", {});
      } else if (!signal.aborted) {
        if (e instanceof Error) console.error("[agent-sh] query failed:\n" + e.stack);
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
  }

  /**
   * Core agent loop: stream LLM response → execute tools → repeat.
   * Returns the final accumulated response text.
   */
  private async executeLoop(signal: AbortSignal): Promise<string> {
    let fullResponseText = "";

    // System prompt carries things stable within a turn: static identity,
    // global agent rules, project conventions, project skills. Invalidated
    // only by compaction (context shape changed) or cwd change (project
    // conventions/skills changed). Dynamic context rebuilds every iteration
    // so live signals (budget, in-flight subagents, metacognitive warnings)
    // are fresh.
    let cachedSystemPrompt: string | undefined;
    let lastCwd = this.contextManager.getCwd();

    while (!signal.aborted) {
      // Auto-compact when total context approaches the window limit.
      const totalEstimate = this.conversation.estimatePromptTokens();
      const contextWindow = this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const threshold = Math.floor(
        (contextWindow - RESPONSE_RESERVE) * getSettings().autoCompactThreshold,
      );
      if (totalEstimate > threshold) {
        this.compactWithHooks(threshold);
        cachedSystemPrompt = undefined;
      }

      const currentCwd = this.contextManager.getCwd();
      if (currentCwd !== lastCwd) {
        cachedSystemPrompt = undefined;
        lastCwd = currentCwd;
      }

      const systemPrompt = cachedSystemPrompt ?? (cachedSystemPrompt = this.handlers.call("system-prompt:build") as string);
      const dynamicContext = this.handlers.call("dynamic-context:build") as string;

      // Shell events are injected once per user query (see query() above),
      // not per loop iteration. Mid-loop injection would break the
      // tool_call → tool_result chain some providers require.

      // Stream LLM response with retry
      const result = await this.streamWithRetry(systemPrompt, dynamicContext, signal);

      const { text, toolCalls: streamedToolCalls } = result;

      // Extract tool calls via protocol (API mode uses streamed calls,
      // inline mode parses XML from text)
      const toolCalls = this.toolProtocol.extractToolCalls(text, streamedToolCalls);

      fullResponseText += text;

      // Record the assistant message via protocol
      this.toolProtocol.recordAssistant(this.conversation, text, toolCalls);
      this.bus.emit("conversation:message-appended", {
        role: "assistant",
        content: text,
      });

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

      // ── Session telemetry accumulation ──
      // Track every tool call's outcome. Exposed via orthogonal handlers
      // (agent:get-counters, agent:get-tool-stats) for extensions that
      // want behavioral signals. The data layer for metacognition — you
      // can't improve what you don't measure.
      for (const r of collectedResults) {
        const counts = this.toolCallCounts.get(r.toolName) ?? { success: 0, error: 0 };
        if (r.isError) {
          counts.error++;
          this.totalToolErrors++;
        } else {
          counts.success++;
        }
        this.toolCallCounts.set(r.toolName, counts);
        this.totalToolCalls++;
      }
      this.totalLoopIterations++;

      // ── Resolution pattern tracking ──
      // When a tool errors, record the error context. When the same tool
      // (or a write tool touching the same file) succeeds afterward,
      // increment totalResolutions — the positive feedback signal exposed
      // to extensions via agent:get-counters.
      if (hadAnyError) {
        for (const [tool, summary] of errorSummaries) {
          this.lastErrorByTool.set(tool, summary);
        }
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
        let resolved = false;
        for (const [tool] of successSummaries) {
          if (this.lastErrorByTool.get(tool)) {
            this.lastErrorByTool.delete(tool);
            this.totalResolutions++;
            resolved = true;
            break;
          }
        }
        if (!resolved) {
          for (const r of collectedResults) {
            if (r.isError) continue;
            const tc = toolCalls.find(t => t.id === r.callId || t.name === r.toolName);
            if (!tc) continue;
            try {
              const args = JSON.parse(tc.argumentsJson);
              const fp = this.filePathFromArgs(r.toolName, args);
              if (fp && this.lastErrorByFile.get(fp)) {
                this.lastErrorByFile.delete(fp);
                this.totalResolutions++;
                break;
              }
            } catch {}
          }
        }
        // Clear resolved error-by-tool entries for successful tools
        for (const tool of successTools) {
          this.lastErrorByTool.delete(tool);
        }
      }

      // Announce the batch — extensions that care about batch-level
      // outcomes (consecutive-error tracking, resolution pattern logging,
      // metacognitive nudges) listen here.
      this.bus.emit("agent:tool-batch-complete", {
        results: collectedResults.map((r) => ({
          name: r.toolName,
          isError: !!r.isError,
          errorSummary: r.isError ? errorSummaries.get(r.toolName) : undefined,
        })),
      });

      // Record all tool results via protocol
      this.toolProtocol.recordResults(this.conversation, collectedResults);

      this.conversation.eagerNucleateTools(
        collectedResults.map((r) => {
          const tc = toolCalls.find(t => t.id === r.callId || t.name === r.toolName);
          let args: Record<string, unknown> = {};
          try { args = tc ? JSON.parse(tc.argumentsJson) : {}; } catch {}
          return { toolName: r.toolName, args, content: r.content, isError: !!r.isError };
        }),
      );

      // Emit enriched message-appended events so derived-log extensions
      // can summarize each tool result without re-parsing the message
      // structure.
      for (const r of collectedResults) {
        const content = typeof r.content === "string" ? r.content : String(r.content);
        const tc = toolCalls.find(t => t.id === r.callId || t.name === r.toolName);
        let args: Record<string, unknown> = {};
        try { args = tc ? JSON.parse(tc.argumentsJson) : {}; } catch {}
        this.bus.emit("conversation:message-appended", {
          role: "tool",
          content,
          toolName: r.toolName,
          toolArgs: args,
          isError: !!r.isError,
        });
      }

      // Loop back — LLM sees tool results
    }

    return fullResponseText;
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
          const stats = this.compactWithHooks(target, 6);
          const detail = stats ? ` ~${stats.before.toLocaleString()} → ~${stats.after.toLocaleString()} tokens` : "";
          this.bus.emit("ui:info", { message: `(context overflow — compacted${detail}, retrying)` });
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

    // Normalize arguments JSON — some providers (Alibaba/qwen) strictly
    // validate `function.arguments` as parseable JSON on the NEXT turn,
    // and reject empty strings or partial chunks. OpenAI itself is lenient,
    // so empty "" slips through locally but the replay breaks upstream.
    for (const tc of pendingToolCalls) {
      if (!tc) continue;
      const s = tc.argumentsJson.trim();
      if (s === "") { tc.argumentsJson = "{}"; continue; }
      try { JSON.parse(s); } catch { tc.argumentsJson = "{}"; }
    }

    return {
      text,
      toolCalls: pendingToolCalls,
    };
  }
}
