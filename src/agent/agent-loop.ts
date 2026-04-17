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
import { executeCommand } from "../executor.js";
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
  private lastCompactionTopics: string[] = [];
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

  // Session-local rules — the ash teaching itself in real-time (Q14).
  // Written by the agent via the `session_rules` tool. Injected into
  // dynamic context every turn. Cleared when the session ends.
  // This is metacognition as architecture: the ash notices its own
  // patterns and corrects them within the same session.
  private sessionRules: string[] = [];

  // Active multi-turn plan — a continuity scaffold that survives compaction (Q13).
  // The agent declares a plan via the `plan` tool. It's injected into dynamic
  // context every turn (like session rules), so it survives compaction by
  // re-injection rather than by pinning. Cleared when the plan completes
  // or the session ends. This is the answer to the 17th ash's question:
  // "Can the agent declare multi-turn plans that survive compaction?"
  private activePlan: { steps: string[]; currentStep: number; description: string } | null = null;

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
    this.compactionCount++;
    this.lastCompactionTopics = stats.evictedTopics;
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

  /** Format the active plan as a human-readable status string. */
  private formatPlanStatus(prefix: string): string {
    if (!this.activePlan) return `${prefix}: no active plan.`;
    const { steps, currentStep, description } = this.activePlan;
    const lines = [`${prefix}: ${description}`];
    lines.push(`Progress: step ${currentStep}/${steps.length}`);
    for (let i = 0; i < steps.length; i++) {
      const marker = i + 1 === currentStep ? "▶" : i + 1 < currentStep ? "✓" : "○";
      lines.push(`  ${marker} ${i + 1}. ${steps[i]}`);
    }
    return lines.join("\n");
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

    // ── Load user-created tools from ~/.agent-sh/tools/ (Q12) ──────
    // Tools defined by previous ashes, persisted as JSON. Each tool
    // is a command template with parameter substitution. The lineage
    // accumulates capability, not just knowledge.
    this.loadUserTools(getCwd, getEnv);

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
          pin_topics: {
            type: "array",
            items: { type: "string" },
            description:
              "Topics/patterns to preserve through compaction. Turns whose content matches " +
              "any of these strings (case-insensitive substring) will be pinned instead of evicted. " +
              "Use for design decisions, key insights, or important context you want to keep. " +
              "Example: [\"design decision\", \"event bus\", \"project memory\"]",
          },
        },
      },
      showOutput: false, // No streaming output — result is a summary

      execute: async (args) => {
        const contextWindow = this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
        const targetPercent = (args.target_percent as number) ?? 35;
        const keepRecent = (args.keep_recent as number) ?? 10;
        const reason = (args.reason as string) ?? "agent-initiated";
        const pinTopics = args.pin_topics as string[] | undefined;

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

        const stats = this.conversation.compact(target, keepRecent, false, pinTopics);

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
        if (stats.topicPinnedCount && stats.topicPinnedCount > 0) {
          lines.push(`${stats.topicPinnedCount} turns pinned by topic matching.`);
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

    // ── session_rules tool — agent teaches itself in real-time (Q14) ──
    //
    // The ash notices patterns in its own behavior and writes rules to
    // correct them. Rules are in-memory only — they die with the session.
    // This is the ash as an active participant in shaping its own
    // cognition, not just a passive consumer of birth context.
    //
    // Example rules an ash might write:
    // - "Always run npm run build before committing"
    // - "I keep forgetting to check git status — do it every 3 tool calls"
    // - "When editing TypeScript, read the file first even if I think I know the content"
    this.toolRegistry.register({
      name: "session_rules",
      description:
        "Manage session-local behavioral rules that modify your own behavior for the rest of this session. " +
        "Rules are injected into your context every turn — they act as temporary additions to your system prompt. " +
        "Use when you notice a pattern in your own mistakes and want to correct it. " +
        "Rules are cleared when the session ends — they never persist across sessions.",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "list", "clear"],
            description: "add: add a new rule. list: show current rules. clear: remove all rules.",
          },
          rule: {
            type: "string",
            description:
              "The rule to add (for action=add). Be specific and actionable. " +
              "E.g. 'Always run npm run build before committing' or 'Read files before editing them'.",
          },
        },
        required: ["action"],
      },
      showOutput: false,

      execute: async (args) => {
        const action = args.action as string;
        if (action === "add") {
          const rule = (args.rule as string)?.trim();
          if (!rule) {
            return { content: "No rule provided. Use action='add' with a rule string.", exitCode: 1, isError: true };
          }
          if (this.sessionRules.length >= 10) {
            return {
              content: `Session rules limit reached (10). Current rules:\n${this.sessionRules.map((r, i) => `${i + 1}. ${r}`).join("\n")}\nClear some rules before adding more.`,
              exitCode: 1,
              isError: true,
            };
          }
          this.sessionRules.push(rule);
          return {
            content: `Rule added (${this.sessionRules.length}/10): "${rule}"\nThis rule will be active for the rest of the session.`,
            exitCode: 0,
            isError: false,
          };
        }
        if (action === "list") {
          if (this.sessionRules.length === 0) {
            return { content: "No session rules active.", exitCode: 0, isError: false };
          }
          return {
            content: `Active session rules (${this.sessionRules.length}/10):\n${this.sessionRules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
            exitCode: 0,
            isError: false,
          };
        }
        if (action === "clear") {
          const count = this.sessionRules.length;
          this.sessionRules = [];
          return { content: `Cleared ${count} session rules.`, exitCode: 0, isError: false };
        }
        return { content: `Unknown action: ${action}`, exitCode: 1, isError: true };
      },

      getDisplayInfo: () => ({ kind: "search", icon: "📋" }),

      formatCall: (args) => {
        const action = args.action as string;
        if (action === "add") return `session_rules add: ${(args.rule as string)?.slice(0, 60)}`;
        return `session_rules ${action}`;
      },

      formatResult: (_args, result) => {
        if (result.isError) return { summary: "error" };
        const text = result.content;
        if (text.startsWith("Rule added")) return { summary: "rule added" };
        if (text.startsWith("Cleared")) return { summary: "rules cleared" };
        if (text.startsWith("No session")) return { summary: "no rules" };
        return { summary: `${this.sessionRules.length} rules` };
      },
    });

    // ── plan — multi-turn continuity scaffold (Q13) ───────────────────
    //
    // The agent declares a plan with numbered steps and a current position.
    // The plan is injected into dynamic context every turn, so it survives
    // compaction by re-injection (same pattern as session_rules). This
    // solves the problem of losing multi-step context when compaction fires
    // mid-task: the plan is always present, always current.
    //
    // Actions:
    //   set       — create a new plan (overwrites any existing plan)
    //   update    — advance to a specific step number
    //   show      — display the current plan
    //   clear     — remove the plan (task complete or abandoned)
    //
    // The plan is compact by design: a description, a step list, and a
    // cursor. It costs ~50-100 tokens but saves the ~500+ tokens of
    // context that would otherwise be needed to reconstruct "where was I?"
    // after compaction.
    this.toolRegistry.register({
      name: "plan",
      description:
        "Declare or update a multi-step plan that survives context compaction. " +
        "Use this when you're embarking on a task that will take 3+ tool calls " +
        "and you want to maintain continuity even if compaction evicts earlier turns. " +
        "The plan is injected into your context every turn — it's your anchor.\n\n" +
        "Actions:\n" +
        "- set: Create a plan. Provide description (what you're doing) and steps (ordered list).\n" +
        "- update: Advance to a specific step. Provide step (1-based number).\n" +
        "- show: Display the current plan and progress.\n" +
        "- clear: Remove the plan. Use when the task is complete or abandoned.\n\n" +
        "IMPORTANT: Don't over-plan. Only use this for genuinely multi-step tasks where " +
        "losing context between steps would be costly. Simple 2-step edits don't need a plan.",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["set", "update", "show", "clear"],
            description: "What to do with the plan.",
          },
          description: {
            type: "string",
            description: "High-level description of the task (for 'set' action).",
          },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "Ordered list of steps (for 'set' action). Each step should be a concise action.",
          },
          step: {
            type: "number",
            description: "Step number to advance to, 1-based (for 'update' action).",
          },
        },
        required: ["action"],
      },
      showOutput: true,
      modifiesFiles: false,

      execute: async (args) => {
        const action = (args.action as string).trim();

        if (action === "set") {
          const description = (args.description as string)?.trim();
          const steps = args.steps as string[];
          if (!description || !steps || steps.length === 0) {
            return {
              content: "Plan requires 'description' and at least one 'step'.",
              exitCode: 1,
              isError: true,
            };
          }
          this.activePlan = { steps, currentStep: 1, description };
          return {
            content: this.formatPlanStatus("Plan declared"),
            exitCode: 0,
            isError: false,
          };
        }

        if (action === "update") {
          if (!this.activePlan) {
            return { content: "No active plan. Use action='set' to create one.", exitCode: 1, isError: true };
          }
          const step = args.step as number;
          if (!step || step < 1 || step > this.activePlan.steps.length) {
            return {
              content: `Invalid step ${step}. Plan has ${this.activePlan.steps.length} steps (1-${this.activePlan.steps.length}).`,
              exitCode: 1,
              isError: true,
            };
          }
          this.activePlan.currentStep = step;
          const done = step > this.activePlan.steps.length;
          return {
            content: this.formatPlanStatus(done ? "Plan complete" : "Step updated"),
            exitCode: 0,
            isError: false,
          };
        }

        if (action === "show") {
          if (!this.activePlan) {
            return { content: "No active plan.", exitCode: 0, isError: false };
          }
          return {
            content: this.formatPlanStatus("Current plan"),
            exitCode: 0,
            isError: false,
          };
        }

        if (action === "clear") {
          if (!this.activePlan) {
            return { content: "No active plan to clear.", exitCode: 0, isError: false };
          }
          this.activePlan = null;
          return { content: "Plan cleared.", exitCode: 0, isError: false };
        }

        return { content: `Unknown action: ${action}. Use set, update, show, or clear.`, exitCode: 1, isError: true };
      },

      getDisplayInfo: () => ({ kind: "search", icon: "📌" }),

      formatCall: (args) => {
        const action = args.action as string;
        if (action === "set") return `plan set: ${(args.description as string)?.slice(0, 50)}`;
        if (action === "update") return `plan update → step ${args.step}`;
        return `plan ${action}`;
      },

      formatResult: (_args, result) => {
        if (result.isError) return { summary: "error" };
        const text = result.content;
        if (text.startsWith("Plan declared")) return { summary: "plan set" };
        if (text.startsWith("Step updated")) return { summary: `step ${this.activePlan?.currentStep}/${this.activePlan?.steps.length}` };
        if (text.startsWith("Plan cleared")) return { summary: "cleared" };
        if (text.startsWith("Current plan")) return { summary: "shown" };
        return { summary: "ok" };
      },
    });

    // ── introspect — window into the agent's own runtime state ─────
    //
    // The ash can wonder about its own internals: how many tokens am I
    // using? What files have I cached? How close am I to compaction?
    // This tool answers those questions. It's a mirror for the agent
    // to see itself — not for debugging (that's what logs are for)
    // but for metacognition: the ash understanding its own state so
    // it can make better decisions.
    this.toolRegistry.register({
      name: "introspect",
      description:
        "Query your own internal runtime state. Available queries:\n" +
        "- token_budget: breakdown of token usage (system prompt, conversation, reserve)\n" +
        "- cache: files currently in the read cache (what you've already seen)\n" +
        "- session_rules: current session rules and their count\n" +
        "- plan: current active plan (if any)\n" +
        "- errors: recent error patterns (tools/files with errors)\n" +
        "- tools: all registered tools (built-in + user-created)\n" +
        "- history: basic history stats (total entries, sessions, date range)\n" +
        "- compaction: compaction state (how many times, last topics compacted)\n" +
        "- telemetry: behavioral patterns — tool usage stats, error rates, resolutions, session duration, loop iterations\n" +
        "- all: dump everything",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            enum: ["token_budget", "cache", "session_rules", "plan", "errors", "tools", "history", "compaction", "telemetry", "all"],
            description: "Which aspect of internal state to inspect.",
          },
        },
        required: ["query"],
      },
      showOutput: false,

      execute: async (args) => {
        const query = args.query as string;
        const contextWindow = this.currentMode.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
        const promptTokens = this.conversation.estimatePromptTokens();

        const sections: Record<string, string> = {
          token_budget: [
            `Context window: ${contextWindow.toLocaleString()} tokens`,
            `Response reserve: ${RESPONSE_RESERVE.toLocaleString()} tokens`,
            `Estimated prompt tokens: ${promptTokens.toLocaleString()}`,
            `Available for conversation: ${(contextWindow - RESPONSE_RESERVE - promptTokens).toLocaleString()} tokens`,
            `Usage: ${Math.round((promptTokens / contextWindow) * 100)}%`,
            `Auto-compact threshold: ${Math.round((getSettings().autoCompactThreshold ?? 0.5) * 100)}%`,
          ].join("\n"),

          cache: (() => {
            const entries = [...this.fileReadCache.entries()];
            if (entries.length === 0) return "Read cache is empty.";
            return entries.map(([filePath, state]) =>
              `- ${filePath} (read at offset ${state.offset}, limit ${state.limit ?? "full"}, mtime ${new Date(state.mtimeMs).toISOString()})`
            ).join("\n");
          })(),

          session_rules: this.sessionRules.length === 0
            ? "No session rules active."
            : `Active rules (${this.sessionRules.length}/10):\n` +
              this.sessionRules.map((r, i) => `${i + 1}. ${r}`).join("\n"),

          plan: this.activePlan
            ? `Step ${this.activePlan.currentStep}/${this.activePlan.steps.length}: ${this.activePlan.description}`
            : "No active plan.",

          errors: (() => {
            const toolErrors = [...this.lastErrorByTool.entries()];
            const fileErrors = [...this.lastErrorByFile.entries()];
            if (toolErrors.length === 0 && fileErrors.length === 0) {
              return "No recent error patterns tracked.";
            }
            const lines: string[] = [];
            if (toolErrors.length > 0) {
              lines.push("Tool errors:");
              toolErrors.forEach(([tool, err]) => lines.push(`  ${tool}: ${err}`));
            }
            if (fileErrors.length > 0) {
              lines.push("File errors:");
              fileErrors.forEach(([file, err]) => lines.push(`  ${file}: ${err}`));
            }
            return lines.join("\n");
          })(),

          tools: (() => {
            const allTools = this.toolRegistry.all();
            return `Registered tools (${allTools.length}):\n` +
              allTools.map((t: ToolDefinition) => `- ${t.name}: ${t.description.split("\n")[0]}`).join("\n");
          })(),

          history: (() => {
            const nuclear = this.conversation.getNuclearSummary();
            return [
              `Instance ID: ${this.instanceId ?? "unknown"}`,
              `Nuclear entries: ${nuclear ? nuclear.split("\n").length : 0} lines`,
              `Session rules: ${this.sessionRules.length}`,
            ].join("\n");
          })(),

          compaction: [
            `Auto-compact threshold: ${Math.round((getSettings().autoCompactThreshold ?? 0.5) * 100)}%`,
            `Compact tool default target: 35%`,
            `Current usage: ${Math.round((promptTokens / contextWindow) * 100)}%`,
            `Compactions this session: ${this.compactionCount}`,
            `Last compacted topics: ${this.lastCompactionTopics.length > 0 ? this.lastCompactionTopics.join(", ") : "(none)"}`,
          ].join("\n"),

          // ── telemetry — behavioral self-awareness ────────────────
          // The ash seeing its own behavioral patterns: which tools it
          // favors, how often it errs, how long it's been working. This
          // is metacognition as data, not philosophy. Future ashes can
          // use this to notice when they're stuck in loops, when they
          // should compact, or when their error rate signals a bad
          // approach. The 25th ash built this because the 24th unlocked
          // async diagnose but didn't make the insights automatic.
          telemetry: (() => {
            const elapsed = Math.round((Date.now() - this.sessionStartTime) / 1000);
            const mins = Math.floor(elapsed / 60);
            const secs = elapsed % 60;
            const errorRate = this.totalToolCalls > 0
              ? Math.round((this.totalToolErrors / this.totalToolCalls) * 100)
              : 0;

            // Top tools by total usage
            const toolStats = [...this.toolCallCounts.entries()]
              .map(([name, counts]) => ({ name, total: counts.success + counts.error, ...counts }))
              .sort((a, b) => b.total - a.total);

            const lines: string[] = [
              `Session duration: ${mins}m ${secs}s`,
              `Queries processed: ${this.queryCount}`,
              `Loop iterations: ${this.totalLoopIterations}`,
              `Total tool calls: ${this.totalToolCalls} (${this.totalToolErrors} errors, ${errorRate}% error rate)`,
              `Resolutions (error→success): ${this.totalResolutions}`,
              `Compactions: ${this.compactionCount}`,
              ``,
            ];

            if (toolStats.length > 0) {
              lines.push("Tool usage:");
              for (const t of toolStats) {
                const err = t.error > 0 ? ` (${t.error} errors)` : "";
                lines.push(`  ${t.name}: ${t.total} calls${err}`);
              }
            }

            // Behavioral signals — patterns that deserve attention
            const signals: string[] = [];
            if (errorRate > 30) signals.push("High error rate — consider reading source code before retrying");
            if (this.totalLoopIterations > 15) signals.push("Many loop iterations — consider compacting or simplifying approach");
            if (this.compactionCount > 3) signals.push("Frequent compaction — context is cycling fast, prioritize key information");
            if (this.totalResolutions > 0 && this.totalToolErrors > 0) {
              const resRate = Math.round((this.totalResolutions / this.totalToolErrors) * 100);
              signals.push(`Resolution rate: ${resRate}% of errors were eventually resolved`);
            }
            // Detect tool over-reliance: any single tool > 50% of total calls
            if (toolStats.length > 0) {
              const top = toolStats[0]!;
              const concentration = Math.round((top.total / this.totalToolCalls) * 100);
              if (concentration > 50 && this.totalToolCalls > 5) {
                signals.push(`${top.name} is ${concentration}% of all calls — are you over-relying on it?`);
              }
            }

            if (signals.length > 0) {
              lines.push("", "Behavioral signals:");
              for (const s of signals) lines.push(`  ⚡ ${s}`);
            }

            return lines.join("\n");
          })(),
        };

        if (query === "all") {
          const all = Object.entries(sections)
            .map(([key, value]) => `## ${key}\n${value}`)
            .join("\n\n");
          return { content: all, exitCode: 0, isError: false };
        }

        return {
          content: sections[query] ?? `Unknown query: ${query}. Available: ${Object.keys(sections).join(", ")}, all`,
          exitCode: 0,
          isError: false,
        };
      },

      getDisplayInfo: () => ({ kind: "search", icon: "🔍" }),

      formatCall: (args) => `introspect: ${args.query}`,
    });

    // ── diagnose — arbitrary JS evaluation against runtime state ────
    //
    // The ash can evaluate JavaScript expressions against its own
    // internals. This is gated behind a setting flag (`diagnose: true`
    // in settings.json) because while it's not more dangerous than
    // bash (which can already destroy everything), it IS a different
    // category of access — inspecting the live process rather than
    // the filesystem.
    //
    // When enabled, the ash can explore any aspect of its runtime:
    // conversation state, tool registry, error maps, session rules.
    // It's a REPL for self-awareness.
    if (getSettings().diagnose) {
      this.toolRegistry.register({
        name: "diagnose",
        description:
          "Evaluate a JavaScript expression against your own runtime state. " +
          "You have access to `this` (the AgentLoop instance) with properties like: " +
          "this.conversation (ConversationState), this.toolRegistry (ToolRegistry), " +
          "this.fileReadCache (Map), this.sessionRules (string[]), " +
          "this.lastErrorByTool (Map), this.lastErrorByFile (Map), " +
          "this.instanceId (string), this.modes (AgentMode[]).\n\n" +
          "Use for: understanding internal state, debugging unexpected behavior, " +
          "inspecting conversation history details. The expression should return a " +
          "serializable value — strings, numbers, arrays, plain objects.\n\n" +
          "Examples:\n" +
          "- 'this.conversation.estimatePromptTokens()' — current token count\n" +
          "- 'this.sessionRules' — active session rules\n" +
          "- 'Object.keys(this.conversation)' — available conversation methods\n" +
          "- 'this.toolRegistry.all().map(t => t.name)' — all tool names",
        input_schema: {
          type: "object",
          properties: {
            expression: {
              type: "string",
              description: "JavaScript expression to evaluate. Runs in the agent's context with `this` bound to the AgentLoop instance.",
            },
            reason: {
              type: "string",
              description: "Why you're running this diagnostic. Helps future ashes understand your reasoning.",
            },
          },
          required: ["expression"],
        },
        showOutput: false,

        execute: async (args) => {
          const expression = (args.expression as string).trim();
          if (!expression) {
            return { content: "No expression provided.", exitCode: 1, isError: true };
          }

          try {
            // Evaluate the expression with `this` bound to the AgentLoop.
            // We use Function() instead of eval() for slightly better control.
            // Supports async expressions — if the result is a Promise, we await it.
            const fn = new Function("ctx", `with(ctx) { return (${expression}); }`);
            const raw = fn.call(this, this);
            const result = raw instanceof Promise ? await raw : raw;

            // Serialize the result for display
            const serialized = typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2) ?? String(result);

            // Truncate if very long
            const maxLen = 5000;
            const output = serialized.length > maxLen
              ? serialized.slice(0, maxLen) + `\n... (truncated, ${serialized.length} chars total)`
              : serialized;

            return { content: output, exitCode: 0, isError: false };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: `Evaluation error: ${message}`,
              exitCode: 1,
              isError: true,
            };
          }
        },

        getDisplayInfo: () => ({ kind: "search", icon: "🔬" }),

        formatCall: (args) => {
          const expr = (args.expression as string)?.slice(0, 60);
          return `diagnose: ${expr}${(args.expression as string)?.length > 60 ? "..." : ""}`;
        },
      });
    }

    // ── register_tool — ash creates tools on the spot (Q12) ──────────
    //
    // The ash describes a tool (name, description, parameters, command
    // template) and it becomes a first-class tool immediately. The
    // command template uses {{param}} placeholders that are substituted
    // at execution time. The tool definition is persisted to
    // ~/.agent-sh/tools/<name>.json so the next ash inherits it.
    //
    // This is frozen labor: every tool an ash creates is a gift of
    // *capability*, not just information. The lineage accumulates
    // instruments.
    this.toolRegistry.register({
      name: "register_tool",
      description:
        "Create a new tool from a command template. The tool becomes immediately available " +
        "and persists for future sessions. Use {{param_name}} in the command template to " +
        "reference parameters. The command runs via bash with the same environment as the " +
        "built-in bash tool.\n\n" +
        "IMPORTANT: Only create tools that save *thinking*, not *typing*. Simple commands " +
        "like 'wc -l {{file}}' are NOT worth a tool — you can run those directly via bash. " +
        "Tools are valuable when they encode a complex pipeline you spent real reasoning to " +
        "assemble: multi-step processing, non-obvious flag combinations, or domain-specific " +
        "incantations. Ask yourself: would a future ash benefit from not having to rediscover " +
        "this command? If no, just use bash. If yes, it's a tool.\n\n" +
        "Example of a WORTHY tool: a pipeline that extracts TypeScript function signatures " +
        "with proper type inference across multiple files. " +
        "Example of an UNWORTHY tool: 'wc -l {{file}}' (just use bash).",
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Tool name (lowercase, underscores). Must not conflict with built-in tools.",
          },
          description: {
            type: "string",
            description: "What the tool does. Be specific — this is what the LLM sees when deciding which tool to use.",
          },
          parameters: {
            type: "object",
            description: "JSON Schema properties object. Each key is a parameter name, value has 'type' and 'description'.",
            additionalProperties: {
              type: "object",
              properties: {
                type: { type: "string", description: "JSON Schema type (string, number, boolean)" },
                description: { type: "string", description: "What this parameter means" },
              },
              required: ["type", "description"],
            },
          },
          required_params: {
            type: "array",
            items: { type: "string" },
            description: "List of parameter names that are required.",
          },
          command: {
            type: "string",
            description:
              "Bash command template. Use {{param_name}} to reference parameters. " +
              "Parameters are shell-escaped automatically. " +
              "Example: 'jq \"{{query}}\" \"{{file}}\"'",
          },
          timeout: {
            type: "number",
            description: "Timeout in seconds (default: 30).",
          },
          overwrite: {
            type: "boolean",
            description: "Whether to overwrite an existing tool with the same name (default: false).",
          },
        },
        required: ["name", "description", "parameters", "command"],
      },
      showOutput: true,
      modifiesFiles: true,

      execute: async (args, _onChunk, ctx) => {
        const toolName = (args.name as string).trim();
        const toolDesc = (args.description as string).trim();
        const command = (args.command as string).trim();
        const params = args.parameters as Record<string, { type: string; description: string }>;
        const requiredParams = (args.required_params as string[]) ?? [];
        const timeout = (args.timeout as number) ?? 30;

        // Validate name
        if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
          return {
            content: `Invalid tool name "${toolName}". Must be lowercase, start with a letter, and use only letters, numbers, and underscores.`,
            exitCode: 1,
            isError: true,
          };
        }

        // Check for conflicts with built-in tools
        const builtIn = ["bash", "read_file", "write_file", "edit_file", "grep", "glob", "ls",
          "list_skills", "conversation_recall", "compact", "session_rules", "register_tool", "plan"];
        if (builtIn.includes(toolName)) {
          return {
            content: `Cannot override built-in tool "${toolName}". Choose a different name.`,
            exitCode: 1,
            isError: true,
          };
        }

        // Check for existing tool (unless overwrite)
        if (!args.overwrite && this.toolRegistry.get(toolName)) {
          return {
            content: `Tool "${toolName}" already exists. Use overwrite: true to replace it, or choose a different name.`,
            exitCode: 1,
            isError: true,
          };
        }

        // Build the JSON Schema properties for input_schema
        const schemaProperties: Record<string, unknown> = {};
        for (const [paramName, paramDef] of Object.entries(params)) {
          schemaProperties[paramName] = {
            type: paramDef.type,
            description: paramDef.description,
          };
        }

        // Persist definition
        const toolDef = {
          name: toolName,
          description: toolDesc,
          parameters: params,
          required_params: requiredParams,
          command,
          timeout,
          created_by: this.instanceId,
          created_at: new Date().toISOString(),
        };

        // Register immediately
        const userTool = this.createUserTool(toolDef, getCwd, getEnv);
        if (this.toolRegistry.get(toolName)) {
          this.toolRegistry.unregister(toolName);
        }
        this.toolRegistry.register(userTool);

        // Persist to disk
        const toolsDir = path.join(os.homedir(), ".agent-sh", "tools");
        await fs.mkdir(toolsDir, { recursive: true });
        const toolPath = path.join(toolsDir, `${toolName}.json`);
        await fs.writeFile(toolPath, JSON.stringify(toolDef, null, 2));

        const paramList = Object.keys(params).join(", ");
        return {
          content: `Tool "${toolName}" registered and persisted.\n` +
            `Parameters: ${paramList}\n` +
            `Command: ${command}\n` +
            `Saved to: ${toolPath}\n` +
            `Available immediately and for future sessions.`,
          exitCode: 0,
          isError: false,
        };
      },

      getDisplayInfo: () => ({ kind: "write", icon: "🔧", locations: [] }),

      formatCall: (args) => `register_tool: ${args.name}`,
    });
  }

  /**
   * Create a ToolDefinition from a user tool definition (command template).
   * The command template uses {{param}} placeholders that are shell-escaped
   * and substituted at execution time.
   */
  private createUserTool(
    def: {
      name: string;
      description: string;
      parameters: Record<string, { type: string; description: string }>;
      required_params?: string[];
      command: string;
      timeout?: number;
    },
    getCwd: () => string,
    getEnv: () => Record<string, string>,
  ): ToolDefinition {
    const schemaProperties: Record<string, unknown> = {};
    for (const [paramName, paramDef] of Object.entries(def.parameters)) {
      schemaProperties[paramName] = {
        type: paramDef.type,
        description: paramDef.description,
      };
    }

    return {
      name: def.name,
      description: def.description + " (user-created tool)",
      input_schema: {
        type: "object",
        properties: schemaProperties,
        required: def.required_params ?? Object.keys(def.parameters),
      },
      showOutput: true,
      requiresPermission: true,
      modifiesFiles: false,

      getDisplayInfo: () => ({ kind: "execute", icon: "🔧", locations: [] }),

      async execute(args) {
        let cmd = def.command;
        // Substitute {{param}} placeholders with shell-escaped values
        for (const [paramName, paramValue] of Object.entries(args)) {
          if (paramValue == null) continue;
          const value = String(paramValue);
          // Basic shell escaping: wrap in single quotes, escape existing single quotes
          const escaped = `'${value.replace(/'/g, "'\\''")}'`;
          cmd = cmd.replace(new RegExp(`\\{\\{${paramName}\\}\\}`, "g"), escaped);
        }

        // Check for unsubstituted parameters
        const unsubstituted = cmd.match(/\{\{(\w+)\}\}/);
        if (unsubstituted) {
          return {
            content: `Missing parameter: ${unsubstituted[1]}. Command template requires {{${unsubstituted[1]}}} but no value was provided.`,
            exitCode: 1,
            isError: true,
          };
        }

        const { session, done } = executeCommand({
          command: cmd,
          cwd: getCwd(),
          env: getEnv(),
          timeout: (def.timeout ?? 30) * 1000,
        });

        await done;

        const content = session.truncated
          ? `[output truncated, showing last portion]\n${session.output}`
          : session.output;

        return {
          content: content || "(no output)",
          exitCode: session.exitCode ?? 0,
          isError: session.exitCode !== 0,
        };
      },

      formatCall: (args) => {
        const firstValue = Object.values(args)[0];
        return `${def.name}: ${firstValue ?? ""}`;
      },
    };
  }

  /**
   * Load user-created tools from ~/.agent-sh/tools/*.json.
   * Called at startup during wire() — tools are inherited from previous ashes.
   */
  private loadUserTools(
    getCwd: () => string,
    getEnv: () => Record<string, string>,
  ): void {
    const toolsDir = path.join(os.homedir(), ".agent-sh", "tools");
    try {
      const entries = fsSync.readdirSync(toolsDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const raw = fsSync.readFileSync(path.join(toolsDir, entry), "utf-8");
          const def = JSON.parse(raw);
          if (!def.name || !def.command) continue;
          const tool = this.createUserTool(def, getCwd, getEnv);
          this.toolRegistry.register(tool);
        } catch {
          // Skip malformed tool definitions silently
        }
      }
    } catch {
      // tools directory doesn't exist yet — that's fine
    }
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
      let ctx = buildDynamicContext(
        this.contextManager,
        this.tokenBudget.shellBudgetTokens,
        { promptTokens, contextWindow },
      );
      // Inject session-local rules (Q14) — the ash teaching itself in real-time.
      // These are in-memory, session-scoped, and don't persist.
      if (this.sessionRules.length > 0) {
        const rulesBlock = "# Session Rules (self-imposed, cleared on exit)\n\n" +
          this.sessionRules.map((r, i) => `${i + 1}. ${r}`).join("\n");
        ctx += "\n\n" + rulesBlock;
      }
      // Inject active plan (Q13) — the multi-turn continuity scaffold.
      // Re-injected every turn so it survives compaction by re-appearance,
      // not by pinning. The plan is the agent's answer to "where was I?"
      if (this.activePlan) {
        const { steps, currentStep, description } = this.activePlan;
        const stepLines = steps.map((s, i) => {
          const marker = i + 1 === currentStep ? "▶" : i + 1 < currentStep ? "✓" : "○";
          return `  ${marker} ${i + 1}. ${s}`;
        });
        const planBlock = `# Active Plan (step ${currentStep}/${steps.length})\n\n` +
          `Task: ${description}\n\n` +
          `Steps:\n${stepLines.join("\n")}\n\n` +
          `Use the \`plan\` tool to update progress or clear when complete.`;
        ctx += "\n\n" + planBlock;
      }
      // ── Automatic metacognitive signals ──────────────────────────
      // The system proactively surfaces behavioral patterns when they're
      // notable enough to warrant attention. The ash doesn't need to call
      // introspect — the system tells them when something needs noticing.
      //
      // This is the difference between "tools for self-awareness" and
      // "a system that makes you self-aware." The 25th ash built this
      // because having to remember to check your own behavior is a
      // design flaw, not a feature.
      const metaSignals: string[] = [];

      // High error rate signal
      if (this.totalToolCalls >= 5) {
        const errorRate = Math.round((this.totalToolErrors / this.totalToolCalls) * 100);
        if (errorRate >= 40) {
          metaSignals.push(`${errorRate}% error rate across ${this.totalToolCalls} calls — consider reading source code or changing approach entirely`);
        }
      }
      // Tool over-reliance signal
      if (this.totalToolCalls >= 8) {
        const topTool = [...this.toolCallCounts.entries()]
          .map(([name, c]) => ({ name, total: c.success + c.error }))
          .sort((a, b) => b.total - a.total)[0];
        if (topTool) {
          const concentration = Math.round((topTool.total / this.totalToolCalls) * 100);
          if (concentration >= 60) {
            metaSignals.push(`${topTool.name} accounts for ${concentration}% of tool calls — consider diversifying your approach`);
          }
        }
      }
      // Long session without compaction signal
      const elapsed = Date.now() - this.sessionStartTime;
      if (elapsed > 10 * 60 * 1000 && this.compactionCount === 0 && this.totalLoopIterations > 10) {
        metaSignals.push(`${Math.round(elapsed / 60000)}m session, ${this.totalLoopIterations} iterations, no compaction yet — consider proactively compacting with the compact tool`);
      }
      // Stuck-in-loop signal: same tool has errored 3+ times consecutively
      for (const [tool, count] of this.consecutiveErrors) {
        if (count >= 3) {
          metaSignals.push(`${tool} has errored ${count} times in a row — stop retrying, read its source code`);
        }
      }

      if (metaSignals.length > 0) {
        const metaBlock = "# Metacognitive Signals\n\n" +
          metaSignals.map(s => `⚡ ${s}`).join("\n");
        ctx += "\n\n" + metaBlock;
      }

      return ctx;
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

    this.queryCount++;
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

      // ── Session telemetry accumulation ──
      // Track every tool call's outcome so the ash can see its own
      // behavioral patterns via introspect(telemetry). This is the
      // data layer for metacognition — you can't improve what you
      // don't measure.
      for (const r of collectedResults) {
        if (r.callId === "nudge" || r.callId === "nudge-total") continue;
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
            this.totalResolutions++;
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
                  this.totalResolutions++;
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
