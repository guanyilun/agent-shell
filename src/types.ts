import type { EventBus, ContentBlock } from "./event-bus.js";
import type { ContextManager } from "./context-manager.js";
import type { ColorPalette } from "./utils/palette.js";
import type { BlockTransformOptions, FencedBlockTransformOptions } from "./utils/stream-transform.js";
import type { ToolDefinition } from "./agent/types.js";
import type { TerminalBuffer } from "./utils/terminal-buffer.js";
import type { Compositor } from "./utils/compositor.js";

export type { ContentBlock } from "./event-bus.js";
export type { BlockTransformOptions, FencedBlockTransformOptions } from "./utils/stream-transform.js";
export type { RenderSurface } from "./utils/compositor.js";

// ── Remote sessions ──────────────────────────────────────────────

export interface RemoteSessionOptions {
  /** The surface to render agent output to. */
  surface: import("./utils/compositor.js").RenderSurface;
  /** Suppress response borders (default: true). */
  suppressBorders?: boolean;
  /** Suppress user query box (default: false).
   *  True for sessions with their own input (rsplit, overlay).
   *  False for sessions where input comes from the main shell (split). */
  suppressQueryBox?: boolean;
  /** Suppress usage stats line (default: true). */
  suppressUsage?: boolean;
  /** Set interactive-session dynamic context (default: false). */
  interactive?: boolean;
}

export interface RemoteSession {
  /** Submit a query to the agent from this session. */
  submit(query: string): void;
  /** The surface this session renders to. */
  readonly surface: import("./utils/compositor.js").RenderSurface;
  /** Whether this session is currently active. */
  readonly active: boolean;
  /** Tear down — restores all routing and advisors. */
  close(): void;
}

/** A model entry in the cycling list, optionally tied to a provider. */
export interface AgentMode {
  model: string;
  /** Provider id — when cycling changes provider, LlmClient is reconfigured. */
  provider?: string;
  /** Provider-specific config for reconfiguring LlmClient on switch. */
  providerConfig?: { apiKey: string; baseURL?: string };
  /** Context window size in tokens (for usage display). */
  contextWindow?: number;
  /** Model supports reasoning/thinking tokens. */
  reasoning?: boolean;
  /** Provider supports the reasoning_effort parameter. */
  supportsReasoningEffort?: boolean;
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
  /** Stable per-instance identifier (4-char hex). */
  readonly instanceId: string;
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

  /**
   * Get (and lazily create) a per-extension storage directory under
   * ~/.agent-sh/<namespace>/. Returns the absolute path. Lets extensions
   * persist state without each one re-deriving the location.
   */
  getStoragePath: (namespace: string) => string;

  // ── Slash command registration ─────────────────────────────
  /** Register a slash command available in any input mode. */
  registerCommand: (name: string, description: string, handler: (args: string) => Promise<void> | void) => void;

  // ── Tool registration (agent-sh backend only) ─────────────
  /** Register a tool for the built-in agent. No-op when using bridge backends. */
  registerTool: (tool: ToolDefinition) => void;
  /** Unregister a tool by name. */
  unregisterTool: (name: string) => void;
  /** Get all registered tools (for subagent tool subsets). Returns [] when using bridge backends. */
  getTools: () => ToolDefinition[];

  // ── System prompt instructions ────────────────────────────
  /** Register a named instruction block for the agent's system prompt. */
  registerInstruction: (name: string, text: string) => void;
  /** Remove a named instruction block from the system prompt. */
  removeInstruction: (name: string) => void;

  // ── Skill registration ────────────────────────────────────
  /** Register a skill (on-demand reference material) for the agent. */
  registerSkill: (name: string, description: string, filePath: string) => void;
  /** Remove a registered skill by name. */
  removeSkill: (name: string) => void;

  // ── Named handler registry (Emacs-style advice) ───────────
  /** Register a named handler. */
  define: (name: string, fn: (...args: any[]) => any) => void;
  /** Wrap a named handler. Receives `next` (original) + args. Returns an unadvise function. */
  advise: (name: string, wrapper: (next: (...args: any[]) => any, ...args: any[]) => any) => () => void;
  /** Call a named handler. */
  call: (name: string, ...args: any[]) => any;
  /** Names of all registered handlers — for diagnostic / introspection use. */
  list: () => string[];

  // ── Terminal utilities ────────────────────────────────────────
  /**
   * Shared headless terminal buffer mirroring PTY output.
   * Lazily created on first access. Returns null if @xterm/headless is not installed.
   */
  terminalBuffer: TerminalBuffer | null;

  // ── Compositor ─────────────────────────────────────────────────
  /**
   * Routes named render streams ("agent", "query", "status") to surfaces.
   * Extensions use `compositor.redirect()` to capture output (e.g. overlay panels).
   */
  compositor: Compositor;

  // ── Remote sessions ────────────────────────────────────────────
  /**
   * Create a remote session that routes agent output to a surface and
   * optionally accepts queries. Handles all compositor routing, shell
   * lifecycle advisors, and chrome suppression.
   *
   *   const session = ctx.createRemoteSession({ surface, interactive: true });
   *   session.submit("what's on screen?");
   *   session.close();  // restores everything
   */
  createRemoteSession: (opts: RemoteSessionOptions) => RemoteSession;
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
//
// Shell context tracks only user-initiated activity (shell commands and
// agent queries). Agent tool outputs and responses live exclusively in
// the ConversationState messages array to avoid duplication.

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
    };
