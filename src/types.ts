import type { EventBus } from "./event-bus.js";
import type { ContextManager } from "./context-manager.js";
import type { AcpClient } from "./acp-client.js";
import type { ColorPalette } from "./utils/palette.js";

export interface AgentShellConfig {
  agentCommand: string;
  agentArgs: string[];
  shell?: string;
  model?: string;
  extensions?: string[];
  /** Full shell environment (from user's rc files) for agent subprocess. */
  shellEnv?: Record<string, string>;
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
  getAcpClient: () => AcpClient;
  quit: () => void;
  /** Override color palette slots for theming. */
  setPalette: (overrides: Partial<ColorPalette>) => void;
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
