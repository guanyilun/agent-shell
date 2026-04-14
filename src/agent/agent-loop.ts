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
import { computeDiff } from "../utils/diff.js";
import type { AgentBackend, ToolDefinition } from "./types.js";
import { ToolRegistry } from "./tool-registry.js";
import { ConversationState } from "./conversation-state.js";
import { HistoryFile } from "./history-file.js";
import { STATIC_SYSTEM_PROMPT, buildDynamicContext } from "./system-prompt.js";
import type { Compositor } from "../utils/compositor.js";
import { createToolUI } from "../utils/tool-interactive.js";
import { TokenBudget } from "./token-budget.js";
import { getSettings } from "../settings.js";
import { createToolProtocol, type ToolProtocol, type PendingToolCall as ProtocolPendingToolCall, type ToolResult as ProtocolToolResult } from "./tool-protocol.js";

// Core tool factories
import { createBashTool } from "./tools/bash.js";
import { createReadFileTool, type FileReadCache } from "./tools/read-file.js";
import { createWriteFileTool } from "./tools/write-file.js";
import { createEditFileTool } from "./tools/edit-file.js";
import { createGrepTool } from "./tools/grep.js";
import { createGlobTool } from "./tools/glob.js";
import { createLsTool } from "./tools/ls.js";
import { createUserShellTool } from "./tools/user-shell.js";
import { createDisplayTool } from "./tools/display.js";
import { createListSkillsTool } from "./tools/list-skills.js";
import { discoverProjectSkills } from "./skills.js";

type PendingToolCall = ProtocolPendingToolCall;

export interface AgentLoopConfig {
  bus: EventBus;
  contextManager: ContextManager;
  llmClient: LlmClient;
  handlers: HandlerFunctions;
  modes?: AgentMode[];
  initialModeIndex?: number;
  compositor?: Compositor;
}

export class AgentLoop implements AgentBackend {
  private abortController: AbortController | null = null;
  private toolRegistry = new ToolRegistry();
  private historyFile = new HistoryFile();
  private conversation = new ConversationState(this.historyFile);
  private fileReadCache: FileReadCache = new Map();
  private tokenBudget: TokenBudget;
  private modes: AgentMode[];
  private currentModeIndex = 0;
  private boundListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];
  private ctorListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];
  private ctorPipeListeners: Array<{ event: string; fn: (...args: any[]) => any }> = [];
  private lastProjectSkillNames = new Set<string>();
  private static readonly THINKING_LEVELS = ["off", "low", "medium", "high"];

  private bus: EventBus;
  private contextManager: ContextManager;
  private llmClient: LlmClient;
  private handlers: HandlerFunctions;
  private thinkingLevel = "off";
  private compositor: Compositor | null = null;
  private toolProtocol: ToolProtocol;

  constructor(config: AgentLoopConfig) {
    this.bus = config.bus;
    this.contextManager = config.contextManager;
    this.llmClient = config.llmClient;
    this.handlers = config.handlers;
    this.compositor = config.compositor ?? null;

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
    onCtor("agent:register-tool", ({ tool }) => this.registerTool(tool));
    onCtor("agent:unregister-tool", ({ name }) => this.unregisterTool(name));
    onCtor("agent:register-instruction", ({ name, text }) => this.registerInstruction(name, text));
    onCtor("agent:remove-instruction", ({ name }) => this.removeInstruction(name));
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
      // Force compaction: use target of 0 so every non-pinned turn is evicted
      const stats = this.conversation.compact(0, 10, true);
      this.conversation.flush().catch(() => {});
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
        nuclearEntries: this.conversation.getNuclearEntryCount(),
        recallArchiveSize: this.conversation.getRecallArchiveSize(),
        budgetTokens: this.tokenBudget.conversationBudgetTokens,
      };
    });

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

  // ── Extension instructions & tool tracking ──────────────────────

  private instructions = new Map<string, string>();

  /** Register a named instruction block for the system prompt. */
  registerInstruction(name: string, text: string): void {
    this.instructions.set(name, text);
  }

  /** Remove a named instruction block. */
  removeInstruction(name: string): void {
    this.instructions.delete(name);
  }

  /** Get instruction blocks registered by extensions. */
  getInstructionSections(): string[] {
    const sections: string[] = [];
    for (const [name, text] of this.instructions) {
      sections.push(`## ${name}\n${text}`);
    }
    return sections;
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
    this.toolRegistry.register(
      createUserShellTool({ getCwd, bus: this.bus }),
    );
    this.toolRegistry.register(
      createDisplayTool({ getCwd, bus: this.bus }),
    );
    this.toolRegistry.register(createListSkillsTool(getCwd));

    // conversation_recall — search/expand evicted conversation turns
    this.toolRegistry.register({
      name: "conversation_recall",
      displayName: "recall",
      description:
        "Browse, search, or expand evicted conversation turns. " +
        "Use when you need context from earlier in the conversation that was compacted away.",
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
      const instructions = this.getInstructionSections();
      if (instructions.length === 0) return STATIC_SYSTEM_PROMPT;
      return STATIC_SYSTEM_PROMPT + "\n\n# Extension Instructions\n\n" + instructions.join("\n\n");
    });

    // Extensions compose additional context (git info, project rules, etc.)
    h.define("dynamic-context:build", () =>
      buildDynamicContext(
        this.contextManager,
        this.tokenBudget.shellBudgetTokens,
      ),
    );

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
            let oldContent: string | null = null;
            try { oldContent = await fs.readFile(absPath, "utf-8"); } catch { /* new file */ }

            let newContent: string | undefined;
            if (typeof args.content === "string") {
              // write_file
              newContent = args.content;
            } else if (typeof args.old_text === "string" && typeof args.new_text === "string" && oldContent !== null) {
              // edit_file
              newContent = oldContent.replace(
                (args.old_text as string).replace(/\r\n/g, "\n"),
                (args.new_text as string).replace(/\r\n/g, "\n"),
              );
            }

            if (newContent !== undefined) {
              const diff = computeDiff(oldContent, newContent);
              if (!diff.isIdentical) {
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
  }

  /**
   * Core agent loop: stream LLM response → execute tools → repeat.
   * Returns the final accumulated response text.
   */
  private async executeLoop(signal: AbortSignal): Promise<string> {
    let fullResponseText = "";

    while (!signal.aborted) {
      // Auto-compact when conversation exceeds threshold fraction of budget
      const budgetTokens = this.tokenBudget.conversationBudgetTokens;
      const autoCompactThreshold = Math.floor(budgetTokens * getSettings().autoCompactThreshold);
      if (this.conversation.estimateTokens() > autoCompactThreshold) {
        const stats = this.conversation.compact(autoCompactThreshold);
        await this.conversation.flush();
        if (stats) {
          this.bus.emit("ui:info", {
            message: `(compacted: ~${stats.before.toLocaleString()} → ~${stats.after.toLocaleString()} tokens)`,
          });
        }
      }

      // System prompt uses handler so extensions can append instructions (cacheable);
      // dynamic context uses handler for per-query state via advise()
      const systemPrompt = this.handlers.call("system-prompt:build") as string;
      const dynamicContext = this.handlers.call("dynamic-context:build");

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
      if (toolCalls.length === 0) break;

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
        collectedResults.push({
          callId: tc.id, toolName: tc.name,
          content, isError: result.isError,
        });
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

      // Record all tool results via protocol
      this.toolProtocol.recordResults(this.conversation, collectedResults);

      // Loop back — LLM sees tool results
    }

    return fullResponseText;
  }

  private readonly maxRetries = 3;

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
          // Use 60% of the budget to leave headroom
          const aggressiveBudget = Math.floor(this.tokenBudget.conversationBudgetTokens * 0.6);
          const stats = this.conversation.compact(aggressiveBudget, 6);
          await this.conversation.flush();
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
        this.bus.emit("agent:usage", {
          prompt_tokens: u.prompt_tokens ?? 0,
          completion_tokens: u.completion_tokens ?? 0,
          total_tokens: u.total_tokens ?? 0,
        });
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
