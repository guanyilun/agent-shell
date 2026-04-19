/**
 * Pi bridge — runs pi's full coding agent in-process as agent-sh's backend.
 *
 * Uses pi's own AgentSession with its full configuration: model registry,
 * provider settings, extensions, session management, and tool system.
 * Agent-sh provides the shell frontend and TUI rendering.
 *
 * The bridge is a pure protocol translator between pi's event stream and
 * agent-sh's bus events. Pi brings its own tools for command execution,
 * file ops, etc. PTY-access tools (`terminal_read`, `terminal_keys`,
 * `user_shell`) are intentionally NOT bundled here — if you want pi to
 * observe or mutate the user's live terminal, load a companion extension
 * that registers those tools in pi's ToolDefinition format.
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
import type { ExtensionContext } from "agent-sh/types";

// ── Extension entry point ─────────────────────────────────────────
export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;
  const cwd = process.cwd();

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
              kind: (event as any).toolName === "bash" ? "execute" : "read",
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
              kind: (event as any).toolName === "bash" ? "execute" : "read",
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
