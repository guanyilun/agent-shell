/**
 * Pi bridge — runs pi's full coding agent in-process as agent-sh's backend.
 *
 * Uses pi's own AgentSession with its full configuration: model registry,
 * provider settings, extensions, session management, and tool system.
 * Agent-sh provides the shell frontend and TUI rendering.
 *
 * In addition to pi's built-in tools, this bridge registers `user_shell`
 * so pi can execute commands in agent-sh's live PTY (visible to the user,
 * affects shell state like cd/export/source).
 *
 * Setup:
 *   npm install @mariozechner/pi-agent-core @mariozechner/pi-ai @mariozechner/pi-coding-agent
 *
 * Usage:
 *   agent-sh -e examples/extensions/pi-bridge
 */
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExtensionContext } from "agent-sh/types";
import type { EventBus } from "agent-sh/event-bus";

// ── Helpers ──────────────────────────────────────────────────────
function interpretEscapes(str: string): string {
  return str.replace(/\\(x[0-9a-fA-F]{2}|r|n|t|\\|0)/g, (_, seq: string) => {
    if (seq === "r") return "\r";
    if (seq === "n") return "\n";
    if (seq === "t") return "\t";
    if (seq === "\\") return "\\";
    if (seq === "0") return "\0";
    if (seq.startsWith("x")) return String.fromCharCode(parseInt(seq.slice(1), 16));
    return seq;
  });
}

function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── user_shell as a pi ToolDefinition ─────────────────────────────
function createUserShellToolDef(bus: EventBus) {
  // Track agent-sh's live cwd so user_shell always runs in the right place
  let liveCwd = process.cwd();
  bus.on("shell:cwd-change", ({ cwd }) => { liveCwd = cwd; });

  const schema = Type.Object({
    command: Type.String({ description: "Command to execute in user's shell" }),
    return_output: Type.Optional(
      Type.Boolean({
        description:
          "Whether to return the command output. Default false — output is shown directly to the user.",
      }),
    ),
  });

  return {
    name: "user_shell",
    label: "user_shell",
    description:
      "Run a command with lasting effects in the user's live shell (cd, export, " +
      "install packages, start servers) or show output the user wants to see. " +
      "Output is shown directly to the user. Set return_output=true only " +
      "if you need to inspect the result.",
    promptSnippet: "Execute commands in the user's live terminal (PTY).",
    promptGuidelines: [
      "You are running inside agent-sh, a terminal wrapper.",
      "Use your standard tools (bash, file ops) for investigation — output goes to you, not the user.",
      "Use user_shell to run commands in the user's live shell when they ask to see output or need lasting effects (cd, install, start servers).",
      "Default to standard tools. Use user_shell when the user is the intended audience for the output or the command has real effects.",
    ],
    parameters: schema,

    async execute(_toolCallId, params) {
      const command = params.command;
      const returnOutput = params.return_output ?? false;

      const result = await bus.emitPipeAsync("shell:exec-request", {
        command,
        output: "",
        cwd: liveCwd,
        done: false,
      });

      const text = returnOutput
        ? result.output || "(no output)"
        : "Command executed.";

      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

// ── terminal_read as a pi ToolDefinition ─────────────────────────
function createTerminalReadToolDef(ctx: ExtensionContext) {
  return {
    name: "terminal_read",
    label: "terminal_read",
    description:
      "Read the current terminal screen contents. Returns clean text (ANSI stripped) " +
      "with cursor position and whether an alternate-screen program (vim, htop, less) is active.",
    promptSnippet: "Read the terminal screen to see what the user sees.",
    promptGuidelines: [
      "Use terminal_read to see the current terminal screen before sending keystrokes.",
      "Check altScreen to know if a full-screen program (vim, htop) is running.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const tb = ctx.terminalBuffer;
      if (!tb) return { content: [{ type: "text", text: "terminal buffer not available" }], details: undefined };
      const { text, altScreen, cursorX, cursorY } = tb.readScreen();
      const info = [
        altScreen ? "mode: alternate screen" : "mode: normal",
        `cursor: row=${cursorY} col=${cursorX}`,
      ].join(", ");
      return { content: [{ type: "text", text: `[${info}]\n\n${text}` }], details: undefined };
    },
  };
}

// ── terminal_keys as a pi ToolDefinition ─────────────────────────
function createTerminalKeysToolDef(bus: EventBus, ctx: ExtensionContext) {
  return {
    name: "terminal_keys",
    label: "terminal_keys",
    description:
      "Send keystrokes to the user's live terminal as if the user typed them. " +
      "Use escape sequences: \\x1b for Escape, \\r for Enter, \\t for Tab, " +
      "\\x03 for Ctrl+C, \\x1b[A/B/C/D for arrow keys, \\x7f for Backspace. " +
      "Example: \\x1b:q!\\r to quit vim. Always call terminal_read after.",
    promptSnippet: "Send keystrokes to interactive programs in the terminal.",
    promptGuidelines: [
      "Use terminal_keys to type into interactive programs (vim, htop, less).",
      "Always call terminal_read after sending keys to verify the result.",
    ],
    parameters: Type.Object({
      keys: Type.String({ description: "Keystrokes to send (use \\x1b for Escape, \\r for Enter, etc.)" }),
      settle_ms: Type.Optional(
        Type.Number({ description: "Wait time in ms after sending keys (default: 150)" }),
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      const keys = interpretEscapes(params.keys);
      const settleMs = params.settle_ms ?? 150;
      bus.emit("shell:stdout-show", {});
      process.stdout.write("\n");
      bus.emit("shell:pty-write", { data: keys });
      await settle(settleMs);

      const tb = ctx.terminalBuffer;
      if (!tb) return { content: [{ type: "text", text: "Keys sent." }], details: undefined };
      const { text, altScreen, cursorX, cursorY } = tb.readScreen();
      const info = [
        altScreen ? "mode: alternate screen" : "mode: normal",
        `cursor: row=${cursorY} col=${cursorX}`,
      ].join(", ");
      return { content: [{ type: "text", text: `Keys sent. Screen after:\n[${info}]\n\n${text}` }], details: undefined };
    },
  };
}

// ── Extension entry point ─────────────────────────────────────────
export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;
  const cwd = process.cwd();

  const userShellTool = createUserShellToolDef(bus);
  const termReadTool = createTerminalReadToolDef(ctx);
  const termKeysTool = createTerminalKeysToolDef(bus, ctx);

  // ── Boot pi session (async — register backend synchronously first) ──
  let session: any = null;
  let runtime: any = null;
  let booting = true;

  const boot = async () => {
    try {
      // Pi loads its own config: ~/.pi/agent/settings.json, models, extensions
      const services = await createAgentSessionServices({ cwd });
      const sessionManager = SessionManager.inMemory(cwd);

      // createRuntime factory — returns { session, services, ... } as expected
      // by createAgentSessionRuntime
      const createRuntime = async (opts: any) => {
        const result = await createAgentSessionFromServices({
          services,
          sessionManager: opts.sessionManager ?? sessionManager,
          customTools: [userShellTool, termReadTool, termKeysTool],
        });
        return { ...result, services };
      };

      runtime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        sessionManager,
      });
      session = runtime.session;

      // Subscribe to pi events → agent-sh bus
      let fullResponseText = "";

      session.subscribe((event: AgentEvent) => {
        switch (event.type) {
          case "agent_start":
            fullResponseText = "";
            break;

          case "message_update": {
            const ame = (event as any).assistantMessageEvent;
            if (ame.type === "text_delta") {
              bus.emitTransform("agent:response-chunk", {
                blocks: [{ type: "text" as const, text: ame.delta }],
              });
              fullResponseText += ame.delta;
            } else if (ame.type === "thinking_delta") {
              bus.emit("agent:thinking-chunk", { text: ame.delta });
            }
            break;
          }

          case "tool_execution_start":
            bus.emit("agent:tool-started", {
              title: (event as any).toolName,
              toolCallId: (event as any).toolCallId,
              kind: (event as any).toolName === "user_shell" || (event as any).toolName === "bash"
                ? "execute"
                : "read",
            });
            break;

          case "tool_execution_update": {
            const pr = (event as any).partialResult as
              | { content?: Array<{ type: string; text?: string }> }
              | undefined;
            if (pr?.content) {
              for (const c of pr.content) {
                if (c.type === "text" && c.text) {
                  bus.emit("agent:tool-output-chunk", { chunk: c.text });
                }
              }
            }
            break;
          }

          case "tool_execution_end":
            bus.emit("agent:tool-completed", {
              toolCallId: (event as any).toolCallId,
              exitCode: (event as any).isError ? 1 : 0,
              kind: (event as any).toolName === "user_shell" || (event as any).toolName === "bash"
                ? "execute"
                : "read",
            });
            break;

          case "agent_end":
            bus.emitTransform("agent:response-done", {
              response: fullResponseText,
            });
            bus.emit("agent:processing-done", {});
            break;
        }
      });

      // Report model info
      const model = session.model;
      bus.emit("agent:info", {
        name: "pi",
        version: "0.66",
        model: model ? `${model.provider}/${model.id}` : undefined,
      });

      booting = false;
    } catch (err) {
      booting = false;
      bus.emit("ui:error", {
        message: `pi-bridge: failed to initialize — ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  // ── Bus listeners (wired on start, unwired on kill) ────────────
  const listeners: Array<{ event: string; fn: Function }> = [];

  const wireListeners = () => {
    const onSubmit = async ({ query }: any) => {
      if (!session) {
        bus.emit("agent:error", {
          message: booting ? "pi is still starting up..." : "pi session not initialized",
        });
        bus.emit("agent:processing-done", {});
        return;
      }

      bus.emit("agent:query", { query });
      bus.emit("agent:processing-start", {});

      try {
        await session.prompt(query);
      } catch (err) {
        bus.emit("agent:error", {
          message: err instanceof Error ? err.message : String(err),
        });
        bus.emit("agent:processing-done", {});
      }
    };

    const onCancel = async () => { await session?.abort(); };
    const onReset = async () => {
      await runtime?.newSession();
      session = runtime?.session;
    };

    bus.on("agent:submit", onSubmit);
    bus.on("agent:cancel-request", onCancel);
    bus.on("agent:reset-session", onReset);
    listeners.push(
      { event: "agent:submit", fn: onSubmit },
      { event: "agent:cancel-request", fn: onCancel },
      { event: "agent:reset-session", fn: onReset },
    );
  };

  const unwireListeners = () => {
    for (const { event, fn } of listeners) bus.off(event as any, fn as any);
    listeners.length = 0;
  };

  // ── Register as backend ───────────────────────────────────────
  bus.emit("agent:register-backend", {
    name: "pi",
    start: async () => {
      await boot();
      wireListeners();
    },
    kill: () => {
      unwireListeners();
      runtime?.dispose();
      session = null;
      runtime = null;
      booting = true;
    },
  });
}
