/**
 * Shell exec extension.
 *
 * Runs a Unix domain socket server speaking JSON-RPC 2.0 that external
 * tools (MCP server, pi extensions, etc.) connect to for interacting
 * with the user's live PTY shell.
 *
 * Also registers the MCP server via the `session:configure` pipe so
 * ACP agents discover the `user_shell` tool automatically.
 *
 * This extension has no direct PTY or Shell knowledge — it communicates
 * exclusively through the bus, following the headless-core philosophy.
 *
 * ## Socket protocol (JSON-RPC 2.0, newline-delimited)
 *
 *   shell/exec    { command: string }  → { output, cwd }
 *   shell/cwd     {}                   → { cwd }
 *   shell/info    {}                   → { busy, shell }
 *   shell/recall  { operation, ... }   → { result }
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default function activate(
  { bus, contextManager }: ExtensionContext,
  opts: { socketPath: string },
): void {
  const { socketPath } = opts;

  // Register MCP server so ACP agents discover the user_shell tool
  bus.onPipe("session:configure", (payload) => {
    return {
      ...payload,
      mcpServers: [
        ...payload.mcpServers,
        {
          name: "agent-sh",
          command: process.execPath,
          args: [path.join(__dirname, "..", "mcp-server.js")],
          env: [{ name: "AGENT_SH_SOCKET", value: socketPath }],
        },
      ],
    };
  });

  // Also set AGENT_SH_SOCKET for pi extensions that connect directly
  process.env.AGENT_SH_SOCKET = socketPath;

  // Serialize shell/exec requests — only one PTY command at a time
  let execPending: Promise<void> = Promise.resolve();

  // ── JSON-RPC handler ────────────────────────────────────────────

  async function handleRequest(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    switch (method) {
      case "shell/exec": {
        const command = params?.command;
        if (typeof command !== "string" || !command) {
          throw rpcError(-32602, "Missing required parameter: command");
        }

        // Serialize — one PTY command at a time
        return new Promise((resolve, reject) => {
          execPending = execPending.then(async () => {
            try {
              const result = await bus.emitPipeAsync("shell:exec-request", {
                command,
                output: "",
                cwd: "",
                done: false,
              });

              // Show the command output in the TUI
              if (result.output) {
                bus.emit("agent:tool-output-chunk", { chunk: result.output });
              }

              resolve({ output: result.output, cwd: result.cwd });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              bus.emit("agent:tool-output-chunk", { chunk: `Error: ${message}` });
              reject(rpcError(-32000, message));
            }
          });
        });
      }

      case "shell/cwd":
        return { cwd: contextManager.getCwd() };

      case "shell/info":
        return {
          shell: process.env.SHELL || "unknown",
          agentSh: true,
        };

      case "shell/recall": {
        const operation = (params?.operation as string) || "browse";
        switch (operation) {
          case "search": {
            const query = params?.query;
            if (typeof query !== "string" || !query) {
              throw rpcError(-32602, "Missing required parameter: query");
            }
            return { result: contextManager.search(query) };
          }
          case "expand": {
            const ids = params?.ids;
            if (!Array.isArray(ids) || ids.length === 0) {
              throw rpcError(-32602, "Missing required parameter: ids (array of numbers)");
            }
            return { result: contextManager.expand(ids.map(Number)) };
          }
          case "browse":
            return { result: contextManager.getRecentSummary() };
          default:
            throw rpcError(-32602, `Unknown recall operation: ${operation}`);
        }
      }

      default:
        throw rpcError(-32601, `Method not found: ${method}`);
    }
  }

  // ── Socket server ───────────────────────────────────────────────

  const server = net.createServer((conn) => {
    let buffer = "";

    conn.on("data", (chunk) => {
      buffer += chunk.toString();

      // Process complete lines (newline-delimited JSON-RPC)
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;

        processMessage(conn, line);
      }
    });
  });

  function processMessage(conn: net.Socket, line: string): void {
    let id: unknown = null;
    try {
      const msg = JSON.parse(line);
      id = msg.id ?? null;
      const method: string = msg.method;
      if (!method) {
        sendError(conn, id, -32600, "Invalid request: missing method");
        return;
      }

      handleRequest(method, msg.params)
        .then((result) => sendResult(conn, id, result))
        .catch((err) => {
          if (err && typeof err === "object" && "rpcCode" in err) {
            sendError(conn, id, (err as any).rpcCode, (err as any).message);
          } else {
            sendError(conn, id, -32603, String(err));
          }
        });
    } catch {
      sendError(conn, id, -32700, "Parse error");
    }
  }

  // Clean up stale socket file
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // Doesn't exist — fine
  }

  server.listen(socketPath);

  // Cleanup on exit
  const cleanup = () => {
    server.close();
    try {
      fs.unlinkSync(socketPath);
    } catch {}
  };
  process.on("exit", cleanup);
}

// ── JSON-RPC helpers ──────────────────────────────────────────────

function sendResult(conn: net.Socket, id: unknown, result: unknown): void {
  conn.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(conn: net.Socket, id: unknown, code: number, message: string): void {
  conn.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function rpcError(code: number, message: string): Error & { rpcCode: number } {
  const err = new Error(message) as Error & { rpcCode: number };
  err.rpcCode = code;
  return err;
}
