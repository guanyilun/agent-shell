/**
 * Claude Code bridge — runs Claude Code Agent SDK in-process as agent-sh's backend.
 *
 * Uses the official @anthropic-ai/claude-agent-sdk to spawn a Claude Code
 * session with a custom user_shell MCP tool for PTY access. Claude Code
 * handles its own model selection, tool execution, and permissions.
 *
 * Setup:
 *   npm install @anthropic-ai/claude-agent-sdk
 *
 * Usage:
 *   agent-sh -e examples/extensions/claude-code-bridge
 *
 * Requires: Claude Code CLI installed and authenticated (claude login).
 */
import {
  query,
  tool,
  createSdkMcpServer,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ExtensionContext } from "../../src/types.js";
import type { EventBus } from "../../src/event-bus.js";

// ── user_shell MCP tool ───────────────────────────────────────────
function createUserShellTool(bus: EventBus) {
  let liveCwd = process.cwd();
  bus.on("shell:cwd-change", ({ cwd }) => { liveCwd = cwd; });

  return tool(
    "user_shell",
    "Run a command with lasting effects in the user's live shell (cd, export, " +
    "install packages, start servers) or show output the user wants to see. " +
    "Set return_output=true only if you need to inspect the result.",
    {
      command: z.string().describe("Command to execute in user's shell"),
      return_output: z.boolean().optional().describe(
        "Whether to return the command output. Default false.",
      ),
    },
    async (args) => {
      const result = await bus.emitPipeAsync("shell:exec-request", {
        command: args.command,
        output: "",
        cwd: liveCwd,
        done: false,
      });

      const text = args.return_output
        ? result.output || "(no output)"
        : "Command executed.";

      return { content: [{ type: "text" as const, text }] };
    },
  );
}

// ── Extension entry point ─────────────────────────────────────────
export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;

  const shellTool = createUserShellTool(bus);
  const shellServer = createSdkMcpServer({
    name: "agent-sh",
    version: "1.0.0",
    tools: [shellTool],
  });

  let activeQuery: Query | null = null;
  const listeners: Array<{ event: string; fn: Function }> = [];

  const wireListeners = () => {
    const onSubmit = async ({ query: userQuery }: any) => {
      bus.emit("agent:query", { query: userQuery });
      bus.emit("agent:processing-start", {});

      let fullResponseText = "";
      let streamed = false;

      try {
        activeQuery = query({
          prompt: userQuery,
          options: {
            cwd: process.cwd(),
            systemPrompt: {
              type: "preset",
              preset: "claude_code",
              append:
                "You are running inside agent-sh, a terminal wrapper.\n" +
                "Use your standard tools (Read, Edit, Write, Bash, Glob, Grep) for investigation.\n" +
                "Use mcp__agent-sh__user_shell to run commands in the user's live shell when they ask to see output or need lasting effects (cd, install, start servers).\n" +
                "Default to standard tools. Use user_shell when the user is the intended audience for the output or the command has real effects.",
            },
            mcpServers: { "agent-sh": shellServer },
            allowedTools: [
              "mcp__agent-sh__user_shell",
              "Read", "Edit", "Write", "Bash", "Glob", "Grep",
            ],
            permissionMode: "acceptEdits",
            includePartialMessages: true,
          },
        });

        for await (const message of activeQuery) {
          switch (message.type) {
            case "stream_event": {
              streamed = true;
              const event = message.event;
              if (event.type === "content_block_delta") {
                const delta = event.delta as any;
                if (delta.type === "text_delta" && delta.text) {
                  bus.emitTransform("agent:response-chunk", {
                    blocks: [{ type: "text" as const, text: delta.text }],
                  });
                  fullResponseText += delta.text;
                } else if (delta.type === "thinking_delta" && delta.thinking) {
                  bus.emit("agent:thinking-chunk", { text: delta.thinking });
                }
              }
              break;
            }

            case "assistant": {
              const msg = message.message;
              for (const block of msg.content) {
                const b = block as any;
                if (b.type === "text" && b.text && !streamed) {
                  bus.emitTransform("agent:response-chunk", {
                    blocks: [{ type: "text" as const, text: b.text }],
                  });
                  fullResponseText += b.text;
                } else if (b.type === "tool_use") {
                  bus.emit("agent:tool-started", {
                    title: b.name,
                    toolCallId: b.id,
                    kind: b.name.includes("shell") || b.name === "Bash"
                      ? "execute"
                      : "read",
                  });
                }
              }
              break;
            }

            case "result":
              break;
          }
        }

        bus.emitTransform("agent:response-done", {
          response: fullResponseText,
        });
      } catch (err) {
        bus.emit("agent:error", {
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        activeQuery = null;
        bus.emit("agent:processing-done", {});
      }
    };

    const onCancel = () => { activeQuery?.interrupt(); };
    const onReset = () => { /* each query() is a new session */ };

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
    name: "claude-code",
    start: async () => {
      wireListeners();
      bus.emit("agent:info", { name: "claude-code", version: "1.0" });
    },
    kill: () => {
      activeQuery?.interrupt();
      unwireListeners();
    },
  });
}
