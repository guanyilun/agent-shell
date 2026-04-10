/**
 * Pi extension: agent-sh tools (user_shell + shell_recall).
 *
 * When running inside agent-sh, registers tools that communicate with
 * the user's live terminal via a Unix domain socket (JSON-RPC 2.0).
 *
 * - user_shell:   execute commands in the user's live PTY
 * - shell_recall:  search/expand/browse session exchange history
 *
 * Socket path comes from the AGENT_SH_SOCKET env var.
 * When not running inside agent-sh, the extension silently does nothing.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createConnection } from "node:net";

const SOCKET_PATH = process.env.AGENT_SH_SOCKET;

export default function (pi: ExtensionAPI): void {
  if (!SOCKET_PATH) return; // Not running inside agent-sh

  pi.registerTool({
    name: "shell_cwd",
    label: "Shell CWD",
    description:
      "Get the user's current working directory in their live shell. " +
      "IMPORTANT: Your internal working directory may differ from the user's actual shell cwd — " +
      "the user may have cd'd after your session started. Call this tool to get the real cwd " +
      "before file operations if you're unsure.",
    promptSnippet:
      "Get the user's real shell cwd (may differ from your internal cwd).",
    parameters: Type.Object({}),

    async execute() {
      const result = (await callSocket("shell/cwd", {})) as { cwd: string };
      return {
        content: [{ type: "text", text: `User's current working directory: ${result.cwd}` }],
      };
    },
  });

  pi.registerTool({
    name: "user_shell",
    label: "User Shell",
    description:
      "Execute a command in the user's live terminal session. " +
      "Use this for commands that should affect the user's shell state: " +
      "cd, export, source, pushd/popd, alias, etc. " +
      "The command runs in the user's actual shell with their full environment " +
      "(aliases, functions, PATH), not an isolated subprocess. " +
      "NOTE: Your internal cwd may be stale — the user may have cd'd. " +
      "Check the shell context for [shell cwd:...] labels or call shell_cwd " +
      "to determine the real working directory. Use absolute paths when possible.",
    promptSnippet:
      "Run commands in the user's live shell (cd, export, source — affects their session). " +
      "Your internal cwd may be stale — check shell context or use shell_cwd for the real cwd.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute in the user's live terminal" }),
    }),

    async execute(_toolCallId, params) {
      const result = (await callSocket("shell/exec", { command: params.command })) as {
        output: string;
        cwd: string;
      };
      return {
        content: [{ type: "text", text: result.output || "(no output)" }],
      };
    },
  });

  pi.registerTool({
    name: "shell_recall",
    label: "Shell Recall",
    description:
      "Retrieve past shell commands, agent responses, and tool executions from the session history. " +
      "Use this to look up truncated output, search for previous commands or errors, " +
      "or browse recent exchanges. Each entry shows [shell cwd:...] so you can see " +
      "which directory commands were run in. Operations: " +
      '"browse" lists recent exchange summaries with line counts, ' +
      '"search" finds exchanges matching a regex query, ' +
      '"expand" retrieves content by exchange ID (use start/end for specific line ranges).',
    promptSnippet:
      "Look up session history — search past commands/output, expand truncated exchanges, or browse recent activity.",
    parameters: Type.Object({
      operation: Type.Optional(
        Type.Union([Type.Literal("search"), Type.Literal("expand"), Type.Literal("browse")], {
          description: 'Operation to perform (default: "browse")',
        }),
      ),
      query: Type.Optional(
        Type.String({ description: 'Search query — supports regex (required for "search")' }),
      ),
      ids: Type.Optional(
        Type.Array(Type.Number(), {
          description: 'Exchange IDs to expand (required for "expand")',
        }),
      ),
      start: Type.Optional(
        Type.Number({ description: "Start line number, 1-indexed (optional, for expand)" }),
      ),
      end: Type.Optional(
        Type.Number({ description: "End line number, inclusive (optional, for expand)" }),
      ),
    }),

    async execute(_toolCallId, params) {
      const result = (await callSocket("shell/recall", {
        operation: params.operation || "browse",
        query: params.query,
        ids: params.ids,
        start: params.start,
        end: params.end,
      })) as { result: string };
      return {
        content: [{ type: "text", text: result.result || "(no results)" }],
      };
    },
  });
}

// -- agent-sh socket client (JSON-RPC 2.0) --

let rpcId = 0;

function callSocket(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(SOCKET_PATH!);
    let buffer = "";

    conn.on("connect", () => {
      const msg = { jsonrpc: "2.0", id: ++rpcId, method, params: params ?? {} };
      conn.write(JSON.stringify(msg) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx).trim();
      conn.destroy();

      try {
        const response = JSON.parse(line);
        if (response.error) {
          reject(new Error(response.error.message || "RPC error"));
        } else {
          resolve(response.result);
        }
      } catch {
        reject(new Error(`Invalid response from agent-sh: ${line}`));
      }
    });

    conn.on("error", (err) => {
      reject(new Error(`Failed to connect to agent-sh: ${err.message}`));
    });

    conn.setTimeout(35_000, () => {
      conn.destroy();
      reject(new Error("Connection to agent-sh timed out"));
    });
  });
}
