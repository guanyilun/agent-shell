import { EventEmitter } from "node:events";

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

  // Agent interaction
  "agent:query": { query: string };
  "agent:response-chunk": { text: string };
  "agent:response-done": { response: string };

  // Agent lifecycle
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
  "agent:tool-started": { title: string; toolCallId?: string };
  "agent:tool-completed": { toolCallId?: string; exitCode: number | null };
  "agent:tool-output-chunk": { chunk: string };
}

type Listener<T> = (payload: T) => void;
type PipeListener<T> = (payload: T) => T;

/**
 * Typed event bus with two modes:
 * - emit/on/off: fire-and-forget notifications
 * - emitPipe/onPipe: synchronous transform chain where each listener
 *   can modify the payload before passing to the next
 */
export class EventBus {
  private emitter = new EventEmitter();
  private pipeListeners = new Map<string, PipeListener<any>[]>();

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
}
