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
import type { AgentBackend, ToolDefinition } from "./types.js";
import { ToolRegistry } from "./tool-registry.js";
import { ConversationState } from "./conversation-state.js";
import { buildSystemPrompt } from "./system-prompt.js";

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
        const msg = e instanceof Error ? e.message : String(e);
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

  /** Rough token estimate (~4 chars/token). */
  private estimateTokens(): number {
    const json = JSON.stringify(this.conversation.getMessages());
    return Math.ceil(json.length / 4);
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
      if (this.estimateTokens() > this.maxContextTokens) {
        this.conversation.compact(10);
        this.bus.emit("ui:info", { message: "(conversation compacted)" });
      }

      const systemPrompt = buildSystemPrompt(
        this.toolRegistry.all(),
        this.contextManager,
      );

      // Stream LLM response (retry once on context overflow)
      let result: Awaited<ReturnType<typeof this.streamResponse>>;
      try {
        result = await this.streamResponse(systemPrompt, signal);
      } catch (e) {
        if (this.isContextOverflow(e)) {
          this.conversation.compact(6);
          this.bus.emit("ui:info", { message: "(context overflow — compacted and retrying)" });
          result = await this.streamResponse(systemPrompt, signal);
        } else {
          throw e;
        }
      }

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

        // Permission gating
        if (tool.requiresPermission) {
          const result = await this.bus.emitPipeAsync(
            "permission:request",
            {
              kind: "tool-call",
              title: tc.name,
              metadata: { args },
              decision: { outcome: "approved" },
            },
          );
          if (
            (result.decision as { outcome: string }).outcome !==
            "approved"
          ) {
            this.conversation.addToolResult(
              tc.id,
              "Permission denied by user.",
            );
            continue;
          }
        }

        // Emit tool-started for TUI
        const display = tool.getDisplayInfo?.(args) ?? {
          kind: "execute",
        };
        this.bus.emit("agent:tool-started", {
          title: tc.name,
          toolCallId: tc.id,
          kind: display.kind,
          locations: display.locations,
          rawInput: args,
        });

        // Emit tool-call for ContextManager recording
        this.bus.emit("agent:tool-call", { tool: tc.name, args });

        // Execute tool
        const onChunk =
          tool.showOutput !== false
            ? (chunk: string) => {
                this.bus.emit("agent:tool-output-chunk", { chunk });
              }
            : undefined;

        const result = await tool.execute(args, onChunk);

        // Emit tool-completed for TUI
        this.bus.emit("agent:tool-completed", {
          toolCallId: tc.id,
          exitCode: result.exitCode,
          rawOutput: result.content,
          kind: display.kind,
        });

        // Emit tool-output for ContextManager
        this.bus.emit("agent:tool-output", {
          tool: tc.name,
          output: result.content,
          exitCode: result.exitCode,
        });

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

  /**
   * Stream a single LLM response. Returns accumulated text, parsed tool calls,
   * and the raw assistant message data for conversation recording.
   */
  private async streamResponse(
    systemPrompt: string,
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

    const messages = this.conversation.getMessages();

    const stream = await this.llmClient.stream({
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
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
