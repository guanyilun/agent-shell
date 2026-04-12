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
import type { HandlerRegistry } from "../utils/handler-registry.js";
import { setMaxListeners } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { computeDiff } from "../utils/diff.js";
import type { AgentBackend, ToolDefinition } from "./types.js";
import { ToolRegistry } from "./tool-registry.js";
import { ConversationState } from "./conversation-state.js";
import { STATIC_SYSTEM_PROMPT, buildDynamicContext } from "./system-prompt.js";

// Core tool factories
import { createBashTool } from "./tools/bash.js";
import { createReadFileTool } from "./tools/read-file.js";
import { createWriteFileTool } from "./tools/write-file.js";
import { createEditFileTool } from "./tools/edit-file.js";
import { createGrepTool } from "./tools/grep.js";
import { createGlobTool } from "./tools/glob.js";
import { createLsTool } from "./tools/ls.js";
import { createUserShellTool } from "./tools/user-shell.js";
import { createListSkillsTool } from "./tools/list-skills.js";
import { discoverProjectSkills } from "./skills.js";

interface PendingToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export class AgentLoop implements AgentBackend {
  private abortController: AbortController | null = null;
  private toolRegistry = new ToolRegistry();
  private conversation = new ConversationState();
  private modes: AgentMode[];
  private currentModeIndex = 0;
  private boundListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];
  private lastProjectSkillNames = new Set<string>();

  constructor(
    private bus: EventBus,
    private contextManager: ContextManager,
    private llmClient: LlmClient,
    private handlers: HandlerRegistry,
    modeConfig?: AgentMode[],
    initialModeIndex?: number,
  ) {
    // Default modes: just the configured model
    this.modes = modeConfig ?? [
      { model: llmClient.model },
    ];
    this.currentModeIndex = initialModeIndex ?? 0;

    // Register core tools
    this.registerCoreTools();

    // Register handlers — extensions can advise these
    this.registerHandlers();
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

    on("agent:submit", ({ query, modeInstruction, modeLabel }) => {
      this.handleQuery(query, modeInstruction, modeLabel).catch(() => {});
    });
    on("agent:cancel-request", (e) => {
      this.abortController?.abort(e.silent ? "silent" : undefined);
    });
    on("config:cycle", () => this.cycleMode());
    on("config:set-modes", ({ modes: newModes }) => {
      this.modes = newModes;
      this.currentModeIndex = 0;
      const m = this.modes[0];
      if (m.providerConfig) {
        this.llmClient.reconfigure({ ...m.providerConfig, model: m.model });
      } else {
        this.llmClient.model = m.model;
      }
      this.bus.emit("config:changed", {});
    });
    on("agent:reset-session", () => {
      this.cancel();
      this.conversation = new ConversationState();
      this.lastProjectSkillNames.clear();
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

  /** Get all registered tools. */
  getTools(): ToolDefinition[] {
    return this.toolRegistry.all();
  }

  kill(): void {
    this.cancel();
  }

  private cancel(): void {
    this.abortController?.abort();
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

    const label = newMode.provider
      ? `${newMode.provider}: ${newMode.model}`
      : newMode.model;
    this.bus.emit("agent:info", { name: "agent-sh", version: "0.4", model: newMode.model, provider: newMode.provider, contextWindow: newMode.contextWindow });
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
    this.toolRegistry.register(createReadFileTool(getCwd));
    this.toolRegistry.register(createWriteFileTool(getCwd));
    this.toolRegistry.register(createEditFileTool(getCwd));
    this.toolRegistry.register(createGrepTool(getCwd));
    this.toolRegistry.register(createGlobTool(getCwd));
    this.toolRegistry.register(createLsTool(getCwd));
    this.toolRegistry.register(
      createUserShellTool({ getCwd, bus: this.bus }),
    );
    this.toolRegistry.register(createListSkillsTool(getCwd));
  }

  /**
   * Register named handlers that extensions can advise.
   * Only high-power use cases where multiple extensions compose.
   */
  private registerHandlers(): void {
    const h = this.handlers;

    // Extensions compose additional context (git info, project rules, etc.)
    h.define("dynamic-context:build", () =>
      buildDynamicContext(this.toolRegistry.all(), this.contextManager),
    );

    // Full control over what the LLM sees: takes messages[], returns messages[].
    // Default: pass through. Extensions can advise to compact, summarize,
    // filter, reorder, inject — whatever strategy fits.
    h.define("conversation:prepare", (messages: unknown[]) => messages);

    // Wraps each tool call: permission → execute → emit events.
    // Extensions advise to add safe-mode, logging, metrics, custom policies.
    h.define("tool:execute", async (ctx: {
      name: string; id: string;
      args: Record<string, unknown>;
      tool: ToolDefinition;
    }) => {
      const { name, id, args, tool } = ctx;
      const display = tool.getDisplayInfo?.(args) ?? { kind: "execute" as const };
      let diffShown = false;

      // Permission gating
      if (tool.requiresPermission) {
        let permKind = "tool-call";
        let permTitle = name;
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
            } else if (typeof args.old_text === "string" && typeof args.new_text === "string" && oldContent) {
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

        const perm = await this.bus.emitPipeAsync("permission:request", {
          kind: permKind,
          title: permTitle,
          metadata,
          decision: { outcome: "approved" },
        });
        if ((perm.decision as { outcome: string }).outcome !== "approved") {
          return { content: "Permission denied by user.", exitCode: 1, isError: true };
        }
      }

      // Emit tool-started for TUI
      this.bus.emit("agent:tool-started", {
        title: name, toolCallId: id,
        kind: display.kind, locations: display.locations, rawInput: args,
      });
      this.bus.emit("agent:tool-call", { tool: name, args });

      // Execute — suppress streaming output if diff was already shown
      const onChunk = (tool.showOutput !== false && !diffShown)
        ? (chunk: string) => { this.bus.emit("agent:tool-output-chunk", { chunk }); }
        : undefined;
      const result = await tool.execute(args, onChunk);

      // Emit completion events
      this.bus.emit("agent:tool-completed", {
        toolCallId: id, exitCode: result.exitCode,
        rawOutput: result.content, kind: display.kind,
      });
      this.bus.emit("agent:tool-output", {
        tool: name, output: result.content, exitCode: result.exitCode,
      });

      return result;
    });
  }

  private async handleQuery(
    query: string,
    modeInstruction?: string,
    modeLabel?: string,
  ): Promise<void> {
    // Cancel any in-flight loop (concurrent prompt handling)
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    // Each loop iteration adds an abort listener (via OpenAI SDK stream);
    // raise the limit to avoid spurious warnings on multi-tool queries.
    setMaxListeners(50, signal);

    this.bus.emit("agent:query", { query, modeLabel });
    this.bus.emit("agent:processing-start", {});
    let responseText = "";

    try {
      // Prepend mode instruction to the user message
      const userMessage = modeInstruction
        ? `${modeInstruction}\n${query}`
        : query;
      this.conversation.addUserMessage(userMessage);

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

  /** Max tokens before auto-compaction (conservative default). */
  private maxContextTokens = 60_000;

  /**
   * Core agent loop: stream LLM response → execute tools → repeat.
   * Returns the final accumulated response text.
   */
  private async executeLoop(signal: AbortSignal): Promise<string> {
    let fullResponseText = "";

    while (!signal.aborted) {
      // Auto-compact if conversation is getting large
      const estimatedTokens = Math.ceil(JSON.stringify(this.conversation.getMessages()).length / 4);
      if (estimatedTokens > this.maxContextTokens) {
        this.conversation.compact(10);
        this.bus.emit("ui:info", { message: "(conversation compacted)" });
      }

      // System prompt is static (cacheable); dynamic context uses handler
      // so extensions can compose additional context via advise()
      const systemPrompt = STATIC_SYSTEM_PROMPT;
      const dynamicContext = this.handlers.call("dynamic-context:build");

      // Stream LLM response with retry
      const result = await this.streamWithRetry(systemPrompt, dynamicContext, signal);

      const { text, toolCalls, assistantContent, assistantToolCalls } = result;

      fullResponseText += text;

      // Record the assistant message in conversation
      this.conversation.addAssistantMessage(
        assistantContent,
        assistantToolCalls,
      );

      // No tool calls → agent is done
      if (toolCalls.length === 0) break;

      // Execute each tool call
      for (const tc of toolCalls) {
        if (signal.aborted) break;

        const tool = this.toolRegistry.get(tc.name);
        if (!tool) {
          this.conversation.addToolResult(
            tc.id,
            `Error: Unknown tool "${tc.name}"`,
          );
          continue;
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.argumentsJson);
        } catch {
          this.conversation.addToolResult(
            tc.id,
            `Error: Invalid JSON arguments for ${tc.name}`,
          );
          continue;
        }

        // Execute via handler — extensions can advise to add safe-mode,
        // logging, metrics, custom permission policies, etc.
        const result = await this.handlers.call(
          "tool:execute",
          { name: tc.name, id: tc.id, args, tool },
        );

        // Add tool result to conversation
        const content = result.isError
          ? `Error: ${result.content}`
          : result.content;
        this.conversation.addToolResult(tc.id, content);
      }

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

        // Context overflow — compact and retry (no backoff needed)
        if (this.isContextOverflow(e)) {
          this.conversation.compact(6);
          this.bus.emit("ui:info", { message: "(context overflow — compacted, retrying)" });
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
    assistantContent: string | null;
    assistantToolCalls:
      | { id: string; function: { name: string; arguments: string } }[]
      | undefined;
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

    const stream = await this.llmClient.stream({
      messages,
      tools: this.toolRegistry.toAPITools(),
      model: this.currentModel,
      signal,
    });

    for await (const chunk of stream) {
      if (signal.aborted) break;

      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;

      // Text content
      if (delta?.content) {
        text += delta.content;
        this.bus.emitTransform("agent:response-chunk", {
          blocks: [{ type: "text", text: delta.content }],
        });
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

      // Token usage (final chunk from providers that support it)
      if ((chunk as any).usage) {
        const u = (chunk as any).usage;
        this.bus.emit("agent:usage", {
          prompt_tokens: u.prompt_tokens ?? 0,
          completion_tokens: u.completion_tokens ?? 0,
          total_tokens: u.total_tokens ?? 0,
        });
      }
    }

    // Build assistant tool calls for conversation recording
    const assistantToolCalls = pendingToolCalls.length
      ? pendingToolCalls.map((tc) => ({
          id: tc.id,
          function: { name: tc.name, arguments: tc.argumentsJson },
        }))
      : undefined;

    return {
      text,
      toolCalls: pendingToolCalls,
      assistantContent: text || null,
      assistantToolCalls,
    };
  }
}
