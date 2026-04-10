#!/usr/bin/env node
/**
 * Minimal MCP server exposing a `user_shell` tool.
 *
 * Spawned by the ACP agent (pi-acp, claude-agent-acp, etc.) as an MCP
 * stdio server. When the LLM calls `user_shell`, this process connects
 * to agent-sh's Unix socket to execute the command in the user's live
 * PTY shell.
 *
 * Protocol: MCP over stdio (newline-delimited JSON-RPC 2.0).
 * No SDK dependency — the protocol surface is tiny.
 */

import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const SOCKET_PATH = process.env.AGENT_SH_SOCKET;

// ── MCP protocol helpers ────────────────────────────────────────

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

function sendResult(id: unknown, result: unknown): void {
  send({ id, result });
}

function sendError(id: unknown, code: number, message: string): void {
  send({ id, error: { code, message } });
}

// ── Tool definition ─────────────────────────────────────────────

const SHELL_CWD_TOOL = {
  name: "shell_cwd",
  description:
    "Get the user's current working directory in their live shell. " +
    "IMPORTANT: Your internal working directory may differ from the user's actual shell cwd — " +
    "the user may have cd'd after your session started. Call this tool to get the real cwd " +
    "before file operations if you're unsure.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

const USER_SHELL_TOOL = {
  name: "user_shell",
  description:
    "Execute a command in the user's live terminal session. " +
    "Use this for commands that should affect the user's shell state: " +
    "cd, export, source, pushd/popd, alias, etc. " +
    "The command runs in the user's actual shell with their full environment " +
    "(aliases, functions, PATH), not an isolated subprocess. " +
    "NOTE: Your internal cwd may be stale — the user may have cd'd. " +
    "Check the shell context for [shell cwd:...] labels or call shell_cwd " +
    "to determine the real working directory. Use absolute paths when possible.",
  inputSchema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute in the user's live terminal",
      },
    },
    required: ["command"],
  },
};

const SHELL_RECALL_TOOL = {
  name: "shell_recall",
  description:
    "Retrieve past shell commands, agent responses, and tool executions from the session history. " +
    "Use this to look up truncated output, search for previous commands or errors, " +
    "or browse recent exchanges. Each entry shows [shell cwd:...] so you can see " +
    "which directory commands were run in. Operations: " +
    '"browse" lists recent exchange summaries with line counts, ' +
    '"search" finds exchanges matching a regex query, ' +
    '"expand" retrieves content by exchange ID (use start/end for specific line ranges).',
  inputSchema: {
    type: "object" as const,
    properties: {
      operation: {
        type: "string",
        enum: ["search", "expand", "browse"],
        description: 'Operation to perform (default: "browse")',
      },
      query: {
        type: "string",
        description: 'Search query — supports regex (required for "search" operation)',
      },
      ids: {
        type: "array",
        items: { type: "number" },
        description: 'Exchange IDs to expand (required for "expand" operation)',
      },
      start: {
        type: "number",
        description: "Start line number, 1-indexed (optional, for expand)",
      },
      end: {
        type: "number",
        description: "End line number, inclusive (optional, for expand)",
      },
    },
  },
};

// ── agent-sh socket client (JSON-RPC 2.0) ──────────────────────

let rpcId = 0;

function callSocket(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!SOCKET_PATH) {
      reject(new Error("AGENT_SH_SOCKET not set — not running inside agent-sh"));
      return;
    }

    const conn = createConnection(SOCKET_PATH);
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

// ── Request handler ─────────────────────────────────────────────

async function handleRequest(id: unknown, method: string, params: any): Promise<void> {
  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-sh-shell", version: "0.1.0" },
      });
      break;

    case "notifications/initialized":
      // Client acknowledgement — nothing to do
      break;

    case "tools/list":
      sendResult(id, { tools: [SHELL_CWD_TOOL, USER_SHELL_TOOL, SHELL_RECALL_TOOL] });
      break;

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      try {
        let text: string;

        if (toolName === "shell_cwd") {
          const result = await callSocket("shell/cwd", {}) as { cwd: string };
          text = `User's current working directory: ${result.cwd}`;
        } else if (toolName === "user_shell") {
          const command = args.command;
          if (!command || typeof command !== "string") {
            sendError(id, -32602, "Missing required parameter: command");
            return;
          }
          const result = await callSocket("shell/exec", { command }) as { output: string; cwd: string };
          text = result.output || "(no output)";
        } else if (toolName === "shell_recall") {
          const result = await callSocket("shell/recall", {
            operation: args.operation || "browse",
            query: args.query,
            ids: args.ids,
            start: args.start,
            end: args.end,
          }) as { result: string };
          text = result.result || "(no results)";
        } else {
          sendError(id, -32602, `Unknown tool: ${toolName}`);
          return;
        }

        sendResult(id, {
          content: [{ type: "text", text }],
        });
      } catch (err) {
        sendResult(id, {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        });
      }
      break;
    }

    default:
      // Unknown methods: return method-not-found for requests (those with id)
      if (id !== undefined && id !== null) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
      break;
  }
}

// ── Main loop ───────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;
    if (method) {
      handleRequest(id, method, params).catch((err) => {
        if (id !== undefined && id !== null) {
          sendError(id, -32603, String(err));
        }
      });
    }
  } catch {
    // Malformed JSON — ignore
  }
});

rl.on("close", () => {
  process.exit(0);
});
