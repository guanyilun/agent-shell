/**
 * Claude Code bridge — runs Claude Code Agent SDK in-process as agent-sh's backend.
 *
 * Uses the official @anthropic-ai/claude-agent-sdk to spawn a Claude Code
 * session with custom MCP tools for PTY access. Claude Code
 * handles its own model selection, tool execution, and permissions.
 *
 * Setup (from repo root):
 *   npm run build && npm link                    # register local agent-sh globally
 *   cd examples/extensions/claude-code-bridge
 *   npm install && npm link agent-sh             # link local dev copy
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
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionContext } from "agent-sh/types";
import type { EventBus } from "agent-sh/event-bus";
import { computeDiff, type DiffResult } from "agent-sh/utils/diff";

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

// ── terminal_read MCP tool ────────────────────────────────────────
function createTerminalReadTool(ctx: ExtensionContext) {
  return tool(
    "terminal_read",
    "Read the current terminal screen contents. Returns clean text (ANSI stripped) " +
    "with cursor position and whether an alternate-screen program (vim, htop, less) is active. " +
    "Use this to see what the user sees before sending keystrokes with terminal_keys.",
    {},
    async () => {
      const tb = ctx.terminalBuffer;
      if (!tb) return { content: [{ type: "text" as const, text: "terminal buffer not available" }] };
      const { text, altScreen, cursorX, cursorY } = tb.readScreen();
      const info = [
        altScreen ? "mode: alternate screen" : "mode: normal",
        `cursor: row=${cursorY} col=${cursorX}`,
      ].join(", ");
      return { content: [{ type: "text" as const, text: `[${info}]\n\n${text}` }] };
    },
  );
}

// ── terminal_keys MCP tool ───────────────────────────────────────
function createTerminalKeysTool(bus: EventBus, ctx: ExtensionContext) {
  return tool(
    "terminal_keys",
    "Send keystrokes to the user's live terminal. The keys are written directly to the PTY " +
    "as if the user typed them. Use escape sequences for special keys:\n" +
    "  - Escape: \\x1b  - Enter: \\r  - Tab: \\t\n" +
    "  - Ctrl+C: \\x03  - Arrow keys: \\x1b[A/B/C/D  - Backspace: \\x7f\n" +
    "Example: to quit vim without saving, send keys=\"\\x1b:q!\\r\".\n" +
    "Always call terminal_read after sending keys to verify the result.",
    {
      keys: z.string().describe("Keystrokes to send (use \\x1b for Escape, \\r for Enter, etc.)"),
      settle_ms: z.number().optional().describe("Wait time in ms after sending keys (default: 150)"),
    },
    async (args) => {
      const keys = interpretEscapes(args.keys);
      const settleMs = args.settle_ms ?? 150;
      bus.emit("shell:stdout-show", {});
      process.stdout.write("\n");
      bus.emit("shell:pty-write", { data: keys });
      await settle(settleMs);

      const tb = ctx.terminalBuffer;
      if (!tb) return { content: [{ type: "text" as const, text: "Keys sent." }] };
      const { text, altScreen, cursorX, cursorY } = tb.readScreen();
      const info = [
        altScreen ? "mode: alternate screen" : "mode: normal",
        `cursor: row=${cursorY} col=${cursorX}`,
      ].join(", ");
      return { content: [{ type: "text" as const, text: `Keys sent. Screen after:\n[${info}]\n\n${text}` }] };
    },
  );
}

// ── Extension entry point ─────────────────────────────────────────
export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;

  const termReadTool = createTerminalReadTool(ctx);
  const termKeysTool = createTerminalKeysTool(bus, ctx);
  const shellServer = createSdkMcpServer({
    name: "agent-sh",
    version: "1.0.0",
    tools: [termReadTool, termKeysTool],
  });

  let activeQuery: Query | null = null;
  const listeners: Array<{ event: string; fn: Function }> = [];

  // ── Tool display helpers ────────────────────────────────────────

  /** Map Claude Code tool names to agent-sh display kinds. */
  function toolKind(name: string): string {
    if (name === "Read" || name.includes("terminal_read")) return "read";
    if (name === "Edit") return "edit";
    if (name === "Write") return "write";
    if (name === "Glob" || name === "Grep") return "search";
    if (name === "Bash" || name.includes("terminal_keys")) return "execute";
    return "execute";
  }

  /** Map Claude Code tool names to agent-sh display icons. */
  function toolIcon(name: string): string | undefined {
    if (name === "Read") return "◆";
    if (name === "Edit") return "✎";
    if (name === "Write") return "✎";
    if (name === "Glob" || name === "Grep") return "⌕";
    return undefined;
  }

  /** Extract file locations from tool input args. */
  function toolLocations(input: Record<string, unknown>): { path: string; line?: number | null }[] | undefined {
    const raw = input.file_path ?? input.path;
    if (typeof raw !== "string") return undefined;
    const line = (input.line_number ?? input.line ?? input.offset) as number | undefined;
    return [{ path: raw, line: line ?? null }];
  }

  /** Format a compact display string for a tool call. */
  function formatToolCall(name: string, input: Record<string, unknown>): string {
    const str = (v: unknown) => typeof v === "string" ? v : "";
    if (name === "Bash") return `$ ${str(input.command)}`;
    if (name === "Read" || name === "Edit" || name === "Write") return str(input.file_path ?? input.path);
    if (name === "Grep" || name === "Glob") return `${str(input.pattern)} ${str(input.path)}`.trim();
    if (name.includes("terminal_keys")) return str(input.keys);
    return name;
  }

  const wireListeners = () => {
    const onSubmit = async ({ query: userQuery }: any) => {
      bus.emit("agent:query", { query: userQuery });
      bus.emit("agent:processing-start", {});

      let fullResponseText = "";
      let streamed = false;
      /** Track in-flight tool calls so we can emit tool-completed when results arrive. */
      const pendingTools = new Map<string, { name: string; kind: string; input?: Record<string, unknown> }>();
      /** Tool input JSON being streamed via input_json_delta events. */
      const inputBuffers = new Map<number, string>();
      /** Tool metadata per content block index (for correlating deltas). */
      const blockMeta = new Map<number, { name: string; id: string }>();
      /** Pre-edit file snapshots for diff display (Edit/Write tools). */
      const fileSnapshots = new Map<string, string | null>();

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
                "Use mcp__agent-sh__terminal_read and mcp__agent-sh__terminal_keys to observe and interact with the user's live terminal.",
            },
            mcpServers: { "agent-sh": shellServer },
            allowedTools: [
              "mcp__agent-sh__terminal_read",
              "mcp__agent-sh__terminal_keys",
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
              if (event.type === "content_block_start") {
                const cb = (event as any).content_block;
                if (cb?.type === "tool_use") {
                  blockMeta.set(event.index, { name: cb.name, id: cb.id });
                  inputBuffers.set(event.index, "");
                }
              } else if (event.type === "content_block_delta") {
                const delta = (event as any).delta;
                if (delta?.type === "text_delta" && delta.text) {
                  bus.emitTransform("agent:response-chunk", {
                    blocks: [{ type: "text" as const, text: delta.text }],
                  });
                  fullResponseText += delta.text;
                } else if (delta?.type === "thinking_delta" && delta.thinking) {
                  bus.emit("agent:thinking-chunk", { text: delta.thinking });
                } else if (delta?.type === "input_json_delta" && delta.partial_json != null) {
                  // Accumulate tool input JSON as it streams in
                  const buf = inputBuffers.get(event.index) ?? "";
                  inputBuffers.set(event.index, buf + delta.partial_json);
                }
              } else if (event.type === "content_block_stop") {
                const meta = blockMeta.get(event.index);
                const inputJson = inputBuffers.get(event.index);
                if (meta && inputJson != null) {
                  blockMeta.delete(event.index);
                  inputBuffers.delete(event.index);

                  let input: Record<string, unknown> = {};
                  try { input = JSON.parse(inputJson || "{}"); } catch {}

                  const kind = toolKind(meta.name);
                  bus.emit("agent:tool-started", {
                    title: meta.name,
                    toolCallId: meta.id,
                    kind,
                    icon: toolIcon(meta.name),
                    locations: toolLocations(input),
                    rawInput: input,
                    displayDetail: formatToolCall(meta.name, input),
                  });
                  pendingTools.set(meta.id, { name: meta.name, kind, input });

                  // Snapshot file content before Edit/Write modifies it
                  if ((meta.name === "Edit" || meta.name === "Write") && typeof (input as any).file_path === "string") {
                    const absPath = resolve(process.cwd(), (input as any).file_path);
                    readFile(absPath, "utf-8")
                      .then(content => fileSnapshots.set(meta.id, content))
                      .catch(() => fileSnapshots.set(meta.id, null)); // file doesn't exist yet
                  }
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
                } else if (b.type === "tool_use" && !streamed) {
                  // Non-streamed fallback: emit tool-started from full message
                  const input = (b.input ?? {}) as Record<string, unknown>;
                  const kind = toolKind(b.name);
                  bus.emit("agent:tool-started", {
                    title: b.name,
                    toolCallId: b.id,
                    kind,
                    icon: toolIcon(b.name),
                    locations: toolLocations(input),
                    rawInput: input,
                    displayDetail: formatToolCall(b.name, input),
                  });
                  pendingTools.set(b.id, { name: b.name, kind, input });

                  // Snapshot file content before Edit/Write modifies it
                  if ((b.name === "Edit" || b.name === "Write") && typeof (input as any).file_path === "string") {
                    const absPath = resolve(process.cwd(), (input as any).file_path);
                    readFile(absPath, "utf-8")
                      .then(content => fileSnapshots.set(b.id, content))
                      .catch(() => fileSnapshots.set(b.id, null));
                  }
                }
              }
              break;
            }

            case "user": {
              // Tool results come back as user messages with tool_result content blocks
              const msg = message.message as any;
              if (msg?.content && Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  if (block.type === "tool_result") {
                    const toolUseId = block.tool_use_id as string;
                    const pending = pendingTools.get(toolUseId);
                    if (!pending) continue;
                    pendingTools.delete(toolUseId);

                    const isError = !!block.is_error;
                    const content = typeof block.content === "string"
                      ? block.content
                      : Array.isArray(block.content)
                        ? block.content.map((c: any) => c.text ?? JSON.stringify(c)).join("\n")
                        : "";

                    // Compute diff for Edit/Write tools
                    let resultDisplay: { summary?: string; body?: { kind: "diff"; diff: DiffResult; filePath: string } } | undefined;
                    if (!isError && (pending.name === "Edit" || pending.name === "Write")) {
                      const oldContent = fileSnapshots.get(toolUseId);
                      fileSnapshots.delete(toolUseId);
                      const filePath = (pending.input as any)?.file_path as string | undefined;
                      if (filePath) {
                        const absPath = resolve(process.cwd(), filePath);
                        try {
                          const newContent = await readFile(absPath, "utf-8");
                          const diff = computeDiff(oldContent, newContent);
                          if (!diff.isIdentical) {
                            const summary = diff.isNewFile
                              ? `+${diff.added}`
                              : `+${diff.added} -${diff.removed}`;
                            resultDisplay = {
                              summary,
                              body: { kind: "diff", diff, filePath: absPath },
                            };
                          }
                        } catch { /* file may not exist after failed edit */ }
                      }
                    } else {
                      fileSnapshots.delete(toolUseId);
                    }

                    const exitCode = isError ? 1 : 0;
                    bus.emitTransform("agent:tool-completed", {
                      toolCallId: toolUseId,
                      exitCode,
                      rawOutput: content,
                      kind: pending.kind,
                      resultDisplay,
                    });
                    bus.emit("agent:tool-output", {
                      tool: pending.name,
                      output: content,
                      exitCode,
                    });
                  }
                }
              }
              break;
            }

            case "tool_progress":
              // Tool still running — nothing to do, TUI spinner already active
              break;

            case "result":
              break;
          }
        }

        // Emit completion for any tools still pending (edge case: interrupted query)
        for (const [id, pending] of pendingTools) {
          bus.emitTransform("agent:tool-completed", {
            toolCallId: id,
            exitCode: 0,
            rawOutput: "",
            kind: pending.kind,
          });
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
