import type { EventBus, ContentBlock } from "./event-bus.js";
import type { ContextManager } from "./context-manager.js";
import type { LlmClient } from "./utils/llm-client.js";
import type { ColorPalette } from "./utils/palette.js";
import type { BlockTransformOptions, FencedBlockTransformOptions } from "./utils/stream-transform.js";
import type { ToolDefinition } from "./agent/types.js";

export type { ContentBlock } from "./event-bus.js";
export type { BlockTransformOptions, FencedBlockTransformOptions } from "./utils/stream-transform.js";

/** A model entry in the cycling list, optionally tied to a provider. */
export interface AgentMode {
  model: string;
  /** Provider id — when cycling changes provider, LlmClient is reconfigured. */
  provider?: string;
  /** Provider-specific config for reconfiguring LlmClient on switch. */
  providerConfig?: { apiKey: string; baseURL?: string };
  /** Context window size in tokens (for usage display). */
  contextWindow?: number;
}

export interface AgentShellConfig {
  shell?: string;
  model?: string;
  extensions?: string[];

  // ── LLM provider ─────────────────────────────────────────────
  /** API key for OpenAI-compatible provider. */
  apiKey?: string;
  /** Base URL for OpenAI-compatible API. */
  baseURL?: string;
  /** Named provider to use from settings.json. */
  provider?: string;
}

/**
 * Context passed to user/third-party extensions.
 * Extensions interact with the system through the event bus — no direct
 * frontend (Shell/TUI) dependencies. This enables headless, web, or
 * alternative frontends without changing extensions.
 */
export interface ExtensionContext {
  bus: EventBus;
  contextManager: ContextManager;
  /** LLM client for fast-path features (null in ACP mode). */
  llmClient: LlmClient | null;
  quit: () => void;
  /** Override color palette slots for theming. */
  setPalette: (overrides: Partial<ColorPalette>) => void;

  // ── Stream transform utilities ─────────────────────────────
  /** Register a delimiter-based content transform (e.g. $$...$$ → image). */
  createBlockTransform: (opts: BlockTransformOptions) => void;
  /** Register a fenced block transform (e.g. ```lang...``` → code-block). */
  createFencedBlockTransform: (opts: FencedBlockTransformOptions) => void;
  /** Read extension-namespaced settings from ~/.agent-sh/settings.json. */
  getExtensionSettings: <T extends Record<string, unknown>>(namespace: string, defaults: T) => T;

  // ── Tool registration (agent-sh backend only) ─────────────
  /** Register a tool for the built-in agent. No-op when using bridge backends. */
  registerTool: (tool: ToolDefinition) => void;
  /** Get all registered tools (for subagent tool subsets). Returns [] when using bridge backends. */
  getTools: () => ToolDefinition[];

  // ── Named handler registry (Emacs-style advice) ───────────
  /** Register a named handler. */
  define: (name: string, fn: (...args: any[]) => any) => void;
  /** Wrap a named handler. Receives `next` (original) + args. */
  advise: (name: string, wrapper: (next: (...args: any[]) => any, ...args: any[]) => any) => void;
  /** Call a named handler. */
  call: (name: string, ...args: any[]) => any;
}

/**
 * Configuration for a registered input mode.
 * Extensions emit "input-mode:register" with this shape to add new modes.
 */
export interface InputModeConfig {
  id: string;              // unique identifier, e.g. "agent", "translate"
  trigger: string;         // single char trigger at empty line start: "?", ">"
  label: string;           // human-readable label shown in prompt
  promptIcon: string;      // the chevron/icon character, e.g. "❯", "⟩"
  indicator: string;       // status indicator shown before the icon, e.g. "❓", "●"
  onSubmit(query: string, bus: EventBus): void;
  returnToSelf: boolean;   // re-enter this mode after agent processing?
}

export interface TerminalSession {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  done: boolean;
  resolve?: (value: void) => void;
}

// ── Exchange types (used by ContextManager) ──────────────────────

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  output: string;
  exitCode: number | null;
}

export type Exchange =
  | {
      type: "shell_command";
      id: number;
      timestamp: number;
      cwd: string;
      command: string;
      output: string;
      exitCode: number | null;
      outputLines: number;
      outputBytes: number;
      /** Who initiated this command: "user" (typed) or "agent" (via user_shell). */
      source: "user" | "agent";
    }
  | {
      type: "agent_query";
      id: number;
      timestamp: number;
      query: string;
    }
  | {
      type: "agent_response";
      id: number;
      timestamp: number;
      response: string;
      toolCalls: ToolCallRecord[];
    }
  | {
      type: "tool_execution";
      id: number;
      timestamp: number;
      tool: string;
      args: Record<string, unknown>;
      output: string;
      exitCode: number | null;
      outputLines: number;
      outputBytes: number;
    };
