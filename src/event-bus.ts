import { EventEmitter } from "node:events";
import type { AgentMode } from "./types.js";

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

  // Agent input (frontend → core: user submitted a query or wants to cancel)
  "agent:submit": { query: string; modeInstruction?: string; modeLabel?: string };
  "agent:cancel-request": { silent?: boolean };

  // Input mode registration (extensions → InputHandler)
  "input-mode:register": import("./types.js").InputModeConfig;

  // Agent interaction
  "agent:query": { query: string; modeLabel?: string };
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

  // Tool rendering (used by TUI for display — distinct data shape from above)
  "agent:tool-started": {
    title: string;
    toolCallId?: string;
    kind?: string;
    locations?: { path: string; line?: number | null }[];
    rawInput?: unknown;
  };
  "agent:tool-completed": {
    toolCallId?: string;
    exitCode: number | null;
    rawOutput?: unknown;
    kind?: string;
  };
  "agent:tool-output-chunk": { chunk: string };

  // Permission request (async pipe — core emits with safe default, extensions override)
  // Generic: `kind` discriminates the scenario, `metadata` carries context,
  // `decision` carries the response. Extensions check `kind` and handle accordingly.
  "permission:request": {
    kind: string;
    title: string;
    metadata: Record<string, unknown>;
    decision: Record<string, unknown>;
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
    done: boolean;
  };

  // Agent info (backend → frontend: connection established, info available)
  "agent:info": { name: string; version: string; model?: string; provider?: string; contextWindow?: number };

  // Session reset (slash command → backend: clear conversation state)
  "agent:reset-session": Record<string, never>;

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

  // Session mode/config updated (from agent backend)
  "config:changed": Record<string, never>;

  // Cycle session mode (input-handler → backend: cycles models within provider)
  "config:cycle": Record<string, never>;

  // Switch provider at runtime (slash command → core)
  "config:switch-provider": { provider: string };

  // Set modes (core → agent loop: after provider switch)
  "config:set-modes": { modes: AgentMode[] };

  // Register a provider at runtime (extensions → core)
  "provider:register": {
    id: string;
    apiKey?: string;
    baseURL?: string;
    defaultModel: string;
    models?: string[];
  };

  // Autocomplete (sync pipe: extensions inspect buffer and append items)
  "autocomplete:request": {
    buffer: string;
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
    const transformed = this.emitPipe(event, payload);
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
      result = fn(result);
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
