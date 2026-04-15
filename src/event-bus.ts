import { EventEmitter } from "node:events";
import type { AgentMode } from "./types.js";
import type { ToolResultDisplay } from "./agent/types.js";

/**
 * Typed event map — every event has a known payload shape.
 */
export interface ShellEvents {
  // Shell lifecycle
  "shell:command-start": { command: string; cwd: string };
  "shell:command-done": {
    command: string;
    output: string;
    cwd: string;
    exitCode: number | null;
  };
  "shell:cwd-change": { cwd: string };
  "shell:foreground-busy": { busy: boolean };
  "shell:agent-exec-start": Record<string, never>;
  "shell:agent-exec-done": Record<string, never>;

  // Raw PTY output stream (every byte from the shell process).
  // Extensions can use this to feed a virtual terminal, log, or replay.
  "shell:pty-data": { raw: string };

  // Write raw bytes to the PTY (keystroke injection).
  // Extensions use this to send keystrokes into the user's live shell.
  "shell:pty-write": { data: string };

  // Resize the PTY (triggers SIGWINCH in the child process).
  "shell:pty-resize": { cols: number; rows: number };

  // Terminal buffer snapshot (request/response pattern via bus)
  "shell:buffer-request": Record<string, never>;
  "shell:buffer-snapshot": {
    text: string;
    altScreen: boolean;
    cursor: { x: number; y: number };
  };

  // Agent input (frontend → core: user submitted a query or wants to cancel)
  "agent:submit": { query: string };
  "agent:cancel-request": { silent?: boolean };

  // Input mode registration (extensions → InputHandler)
  "input-mode:register": import("./types.js").InputModeConfig;

  // Agent interaction
  "agent:query": { query: string };
  "agent:thinking-chunk": { text: string };
  "agent:response-chunk": { blocks: ContentBlock[] };
  "agent:response-done": { response: string };

  // Token usage (emitted after each LLM call, when available)
  "agent:usage": { prompt_tokens: number; completion_tokens: number; total_tokens: number };

  // Agent lifecycle
  "agent:processing-start": Record<string, never>;
  "agent:processing-done": Record<string, never>;
  "agent:cancelled": Record<string, never>;
  "agent:error": { message: string };

  // Tool execution (agent-initiated — used by ContextManager for data recording)
  "agent:tool-call": { tool: string; args: Record<string, unknown> };
  "agent:tool-output": {
    tool: string;
    output: string;
    exitCode: number | null;
  };

  // Tool batch — emitted before execution with all tool calls grouped by kind
  "agent:tool-batch": {
    groups: Array<{
      kind: string;
      tools: Array<{ name: string; displayDetail?: string }>;
    }>;
  };

  // Tool rendering (used by TUI for display — distinct data shape from above)
  "agent:tool-started": {
    title: string;
    toolCallId?: string;
    kind?: string;
    icon?: string;
    locations?: { path: string; line?: number | null }[];
    rawInput?: unknown;
    /** Pre-formatted display detail from tool's formatCall(). */
    displayDetail?: string;
    batchIndex?: number;
    batchTotal?: number;
  };
  "agent:tool-completed": {
    toolCallId?: string;
    exitCode: number | null;
    rawOutput?: unknown;
    kind?: string;
    /** Structured result display — set by formatResult or defaults, overridable via onPipe. */
    resultDisplay?: ToolResultDisplay;
  };
  "agent:tool-output-chunk": { chunk: string };

  // Tool interactive UI (tool has taken over rendering + input)
  "tool:interactive-start": Record<string, never>;
  "tool:interactive-end": Record<string, never>;

  // Permission request (async pipe — core emits with safe default, extensions override)
  // Generic: `kind` discriminates the scenario, `metadata` carries context,
  // `decision` carries the response. Extensions check `kind` and handle accordingly.
  "permission:request": {
    kind: string;
    title: string;
    metadata: Record<string, unknown>;
    /** Interactive UI capability — available when the built-in agent is active. */
    ui?: unknown;
    decision: Record<string, unknown>;
  };

  // Slash command registration (extensions → slash-commands)
  "command:register": {
    name: string;
    description: string;
    handler: (args: string) => Promise<void> | void;
  };

  // Slash command execution
  "command:execute": {
    name: string;
    args: string;
  };

  // UI feedback (TUI subscribes to render; silently ignored without TUI)
  "ui:info": { message: string };
  "ui:error": { message: string };
  "ui:suggestion": { text: string };

  // Generic keypress forwarding (control chars not handled by input-handler)
  "input:keypress": { key: string };

  // Raw input intercept (sync pipe: fired before any input processing).
  // Extensions set `consumed: true` to swallow input before it reaches the
  // PTY or mode handler — enables overlay UIs during foreground programs.
  "input:intercept": { data: string; consumed: boolean };

  // Stdout hold/release (ref-counted). While held, PTY output is not written
  // to stdout — enables overlay extensions to render without interference.
  "shell:stdout-hold": Record<string, never>;
  "shell:stdout-release": Record<string, never>;


  // Temporarily force PTY output visible even while agent is processing
  // (ref-counted). Used by tools like terminal_keys that need the user
  // to see the foreground program's response to injected keystrokes.
  "shell:stdout-show": Record<string, never>;
  "shell:stdout-hide": Record<string, never>;

  // Terminal interception (sync pipe: extensions can intercept before execution)
  "agent:terminal-intercept": {
    command: string;
    cwd: string;
    intercepted: boolean;
    output: string;
  };

  // Prompt redraw (sync pipe: core sends \n to PTY as default fallback;
  // extensions can set `handled: true` and write their own prompt to stdout)
  "shell:redraw-prompt": {
    cwd: string;
    handled: boolean;
  };

  // Shell exec (async pipe: extension requests command execution in user's PTY)
  "shell:exec-request": {
    command: string;
    output: string;
    cwd: string;
    exitCode: number | null;
    done: boolean;
  };

  // Agent info (backend → frontend: connection established, info available)
  "agent:info": { name: string; version: string; model?: string; provider?: string; contextWindow?: number };

  // Session reset (slash command → backend: clear conversation state)
  "agent:reset-session": Record<string, never>;

  // Manual compaction request (slash command → backend)
  "agent:compact-request": Record<string, never>;

  // Context stats query (sync pipe: slash command → backend)
  "context:get-stats": {
    activeTokens: number;
    nuclearEntries: number;
    recallArchiveSize: number;
    budgetTokens: number;
  };

  // Extension registers itself as agent backend (extension → core)
  "agent:register-backend": {
    name: string;
    kill: () => void;
    start?: () => Promise<void>;
  };

  // Switch agent backend at runtime (slash command → core)
  "config:switch-backend": { name: string };

  // List registered backends (slash command → core, returns via ui:info)
  "config:list-backends": Record<string, never>;
  // Query backend names (sync pipe — for autocomplete)
  "config:get-backends": { names: string[]; active: string | null };

  // Session mode/config updated (from agent backend)
  "config:changed": Record<string, never>;

  // Cycle session mode (input-handler → backend: cycles models within provider)
  "config:cycle": Record<string, never>;
  // Switch to a specific model by name (slash command → backend)
  "config:switch-model": { model: string };
  // Query available models (sync pipe — for autocomplete)
  "config:get-models": { models: { model: string; provider: string }[]; active: string | null };
  // Set thinking/reasoning effort level (slash command → backend)
  "config:set-thinking": { level: string };
  // Query current thinking level (sync pipe — for autocomplete)
  "config:get-thinking": { level: string; levels: string[]; supported: boolean };

  // Switch provider at runtime (slash command → core)
  "config:switch-provider": { provider: string };

  // Query initial modes (sync pipe: agent backend extension → core)
  "config:get-initial-modes": { modes: AgentMode[]; initialModeIndex: number };
  // Set modes (core → agent loop: after provider switch)
  "config:set-modes": { modes: AgentMode[] };
  // Append modes (core → agent loop: after provider register)
  "config:add-modes": { modes: AgentMode[] };

  // Register a provider at runtime (extensions → core)
  "provider:register": {
    id: string;
    apiKey?: string;
    baseURL?: string;
    defaultModel: string;
    models?: (string | { id: string; reasoning?: boolean; contextWindow?: number })[];
    /** Provider supports the reasoning_effort parameter. Default: true. */
    supportsReasoningEffort?: boolean;
  };

  // Tool/instruction registration (extension → active agent backend)
  "agent:register-tool": { tool: import("./agent/types.js").ToolDefinition };
  "agent:unregister-tool": { name: string };
  "agent:get-tools": { tools: import("./agent/types.js").ToolDefinition[] };
  "agent:register-instruction": { name: string; text: string };
  "agent:remove-instruction": { name: string };

  // Banner section collection (sync pipe: extensions contribute labeled items to startup banner)
  "banner:collect": {
    sections: Array<{ label: string; items: string[] }>;
  };

  // Autocomplete (sync pipe: extensions inspect buffer and append items)
  "autocomplete:request": {
    buffer: string;
    /** Parsed slash command name (e.g. "/backend"), or null if not a command. */
    command: string | null;
    /** Text after the command name (e.g. "clau" for "/backend clau"), or null. */
    commandArgs: string | null;
    items: { name: string; description: string }[];
  };
}

// ── Content block types (used by transform pipeline) ────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "code-block"; language: string; code: string }
  | { type: "image"; data: Buffer }
  | { type: "raw"; escape: string };

type Listener<T> = (payload: T) => void;
type PipeListener<T> = (payload: T) => T;
type AsyncPipeListener<T> = (payload: T) => T | Promise<T>;

/**
 * Typed event bus with two modes:
 * - emit/on/off: fire-and-forget notifications
 * - emitPipe/onPipe: synchronous transform chain where each listener
 *   can modify the payload before passing to the next
 */
export class EventBus {
  private emitter = new EventEmitter();
  private pipeListeners = new Map<string, PipeListener<any>[]>();
  private asyncPipeListeners = new Map<string, AsyncPipeListener<any>[]>();

  /** Subscribe to a fire-and-forget event. */
  on<K extends keyof ShellEvents>(
    event: K,
    fn: Listener<ShellEvents[K]>,
  ): void {
    this.emitter.on(event, fn);
  }

  /** Unsubscribe from a fire-and-forget event. */
  off<K extends keyof ShellEvents>(
    event: K,
    fn: Listener<ShellEvents[K]>,
  ): void {
    this.emitter.off(event, fn);
  }

  /** Emit a fire-and-forget event. */
  emit<K extends keyof ShellEvents>(
    event: K,
    payload: ShellEvents[K],
  ): void {
    this.emitter.emit(event, payload);
  }

  /**
   * Transform-then-notify: run the payload through any registered pipe
   * listeners (transforms), then emit the final result to regular `on`
   * listeners (renderers). This enables content pipelines where extensions
   * modify data (e.g. render LaTeX → terminal image) before renderers see it.
   */
  emitTransform<K extends keyof ShellEvents>(
    event: K,
    payload: ShellEvents[K],
  ): void {
    let transformed: ShellEvents[K];
    try {
      transformed = this.emitPipe(event, payload);
    } catch (err) {
      if (process.env.DEBUG) {
        process.stderr.write(`[event-bus] pipe error on ${String(event)}: ${err}\n`);
      }
      transformed = payload; // fall back to untransformed
    }
    this.emitter.emit(event, transformed);
  }

  /** Register a transform listener for a pipeline event. */
  onPipe<K extends keyof ShellEvents>(
    event: K,
    fn: PipeListener<ShellEvents[K]>,
  ): void {
    let listeners = this.pipeListeners.get(event);
    if (!listeners) {
      listeners = [];
      this.pipeListeners.set(event, listeners);
    }
    listeners.push(fn);
  }

  /** Remove a transform listener from a pipeline event. */
  offPipe<K extends keyof ShellEvents>(
    event: K,
    fn: PipeListener<ShellEvents[K]>,
  ): void {
    const listeners = this.pipeListeners.get(event);
    if (!listeners) return;
    const idx = listeners.indexOf(fn);
    if (idx !== -1) listeners.splice(idx, 1);
  }

  /**
   * Emit a pipeline event — each registered pipe listener receives the
   * output of the previous one. Returns the final transformed payload.
   * If no listeners are registered, returns the original payload unchanged.
   */
  emitPipe<K extends keyof ShellEvents>(
    event: K,
    payload: ShellEvents[K],
  ): ShellEvents[K] {
    const listeners = this.pipeListeners.get(event);
    if (!listeners) return payload;
    let result = payload;
    for (const fn of listeners) {
      try {
        const out = fn(result);
        if (out && typeof (out as any).then === "function") {
          console.error(`[event-bus] Warning: async handler in sync pipe "${String(event)}" — use onPipeAsync instead`);
          continue;
        }
        result = out;
      } catch (err) {
        console.error(`[event-bus] Pipe handler error in "${String(event)}":`, err instanceof Error ? err.message : err);
      }
    }
    return result;
  }

  /** Register an async transform listener for a pipeline event. */
  onPipeAsync<K extends keyof ShellEvents>(
    event: K,
    fn: AsyncPipeListener<ShellEvents[K]>,
  ): void {
    let listeners = this.asyncPipeListeners.get(event);
    if (!listeners) {
      listeners = [];
      this.asyncPipeListeners.set(event, listeners);
    }
    listeners.push(fn);
  }

  /**
   * Emit an async pipeline event. Two phases:
   * 1. Notify — fire regular `on` listeners synchronously (e.g., TUI flushes state)
   * 2. Transform — run async pipe listeners in series, each receiving the
   *    output of the previous (e.g., extension provides a permission decision)
   *
   * Returns the final transformed payload. If no pipe listeners are registered,
   * returns the original payload unchanged (with safe defaults).
   */
  async emitPipeAsync<K extends keyof ShellEvents>(
    event: K,
    payload: ShellEvents[K],
  ): Promise<ShellEvents[K]> {
    // Phase 1: notify (lets renderers prepare for interactive I/O)
    this.emitter.emit(event, payload);

    // Phase 2: transform (extensions provide decisions)
    const listeners = this.asyncPipeListeners.get(event);
    if (!listeners) return payload;
    let result = payload;
    for (const fn of listeners) {
      result = await fn(result);
    }
    return result;
  }
}
