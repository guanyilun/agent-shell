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
 *   agent-sh -e examples/extensions/pi-bridge.ts
 */
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ExtensionContext } from "../../src/types.js";
import type { EventBus } from "../../src/event-bus.js";

// ── agent-sh context injected via tool promptGuidelines + promptSnippet ──

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
      "Run a command in the user's live shell (visible in terminal). " +
      "Use for cd, export, source, or commands the user wants to see. " +
      "Output is shown directly to the user. Set return_output=true only " +
      "if you need to inspect the result.",
    promptSnippet: "Execute commands in the user's live terminal (PTY). Use in EXECUTE mode.",
    promptGuidelines: [
      "You are running inside agent-sh, a terminal wrapper with two interaction modes.",
      "QUERY mode (triggered by '?'): Use your standard tools (bash, file ops). Do NOT use user_shell.",
      "EXECUTE mode (triggered by '>'): Run the command via user_shell. Do not explain or confirm — just run it.",
      "Each prompt includes a per-query mode instruction — follow it.",
      "user_shell executes in the user's actual shell (their aliases, env vars, cwd). Use bash for background work.",
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

// ── Extension entry point ─────────────────────────────────────────
export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;
  const cwd = process.cwd();

  const userShellTool = createUserShellToolDef(bus);

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
          customTools: [userShellTool],
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
    const onSubmit = async ({ query, modeInstruction, modeLabel }: any) => {
      if (!session) {
        bus.emit("agent:error", {
          message: booting ? "pi is still starting up..." : "pi session not initialized",
        });
        bus.emit("agent:processing-done", {});
        return;
      }

      const prompt = modeInstruction ? `${modeInstruction}\n${query}` : query;
      bus.emit("agent:query", { query, modeLabel });
      bus.emit("agent:processing-start", {});

      try {
        await session.prompt(prompt);
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
