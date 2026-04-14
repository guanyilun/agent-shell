/**
 * Peer mesh — cross-instance communication for agent-sh.
 *
 * Lets all running ash instances discover each other and communicate.
 * Inspired by Ray's @ray.remote: opt-in exposure of named handlers,
 * transparent network calls, automatic discovery.
 *
 * What this extension provides:
 *   1. PeerServer — Unix socket server + peer file registry + client
 *   2. Standard exposed handlers — terminal read, context, search
 *   3. Agent tools — peers, peer_terminal, peer_history, peer_search
 *   4. Handler registry API — peer:call, peer:discover, peer:expose
 *      for other extensions to use
 *
 * Usage:
 *   ash -e ./examples/extensions/peer-mesh.ts
 *
 *   # Or install permanently
 *   cp examples/extensions/peer-mesh.ts ~/.agent-sh/extensions/
 *
 * Other extensions can depend on this via the handler registry:
 *   ctx.define("my:data", () => computeData());
 *   ctx.call("peer:expose", "my:data");
 *   const result = await ctx.call("peer:call", peerId, "my:data");
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "agent-sh/types";

// ── Types ──────────────────────────────────────────────────────

interface PeerInfo {
  id: string;
  pid: number;
  cwd: string;
  socketPath: string;
  startTime: number;
}

interface RpcRequest {
  method: string;
  args: unknown[];
}

interface RpcResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ── Paths ──────────────────────────────────────────────────────

const PEERS_DIR = path.join(os.homedir(), ".agent-sh", "peers");

function peerFilePath(id: string): string {
  return path.join(PEERS_DIR, `${id}.json`);
}

function socketPath(pid: number): string {
  return path.join(os.tmpdir(), `agent-sh-peer-${pid}.sock`);
}

// ── PeerServer ─────────────────────────────────────────────────

class PeerServer {
  private server: net.Server | null = null;
  private exposed = new Set<string>();
  private readonly info: PeerInfo;
  private readonly callHandler: (name: string, ...args: unknown[]) => unknown;

  constructor(
    instanceId: string,
    cwd: string,
    callHandler: (name: string, ...args: unknown[]) => unknown,
  ) {
    this.callHandler = callHandler;
    this.info = {
      id: instanceId,
      pid: process.pid,
      cwd,
      socketPath: socketPath(process.pid),
      startTime: Date.now(),
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────

  start(): void {
    // Ensure peers directory exists
    fs.mkdirSync(PEERS_DIR, { recursive: true });

    // Clean up stale socket
    try { fs.unlinkSync(this.info.socketPath); } catch {}

    // Start Unix socket server
    this.server = net.createServer((conn) => this.handleConnection(conn));
    this.server.on("error", () => {}); // swallow server errors
    this.server.listen(this.info.socketPath);

    // Register peer file
    fs.writeFileSync(peerFilePath(this.info.id), JSON.stringify(this.info));

    // Cleanup on exit
    const cleanup = () => this.stop();
    process.on("exit", cleanup);
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
  }

  stop(): void {
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }
    try { fs.unlinkSync(this.info.socketPath); } catch {}
    try { fs.unlinkSync(peerFilePath(this.info.id)); } catch {}
  }

  // ── Expose / discover / call ───────────────────────────────

  expose(name: string): void {
    this.exposed.add(name);
  }

  discover(): PeerInfo[] {
    const peers: PeerInfo[] = [];
    let entries: string[];
    try { entries = fs.readdirSync(PEERS_DIR); } catch { return []; }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(PEERS_DIR, entry), "utf-8");
        const info: PeerInfo = JSON.parse(raw);
        // Skip self
        if (info.id === this.info.id) continue;
        // Check if process is alive
        try { process.kill(info.pid, 0); } catch {
          // Stale — prune
          try { fs.unlinkSync(path.join(PEERS_DIR, entry)); } catch {}
          continue;
        }
        peers.push(info);
      } catch {
        // Malformed file — skip
      }
    }
    return peers;
  }

  async call(peerId: string, method: string, ...args: unknown[]): Promise<unknown> {
    // Find peer socket path
    const peers = this.discover();
    const peer = peers.find((p) => p.id === peerId);
    if (!peer) throw new Error(`Peer "${peerId}" not found`);

    return this.callSocket(peer.socketPath, method, args);
  }

  // ── Private ────────────────────────────────────────────────

  private handleConnection(conn: net.Socket): void {
    let buffer = "";
    conn.on("data", (data) => {
      buffer += data.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);

      let response: RpcResponse;
      try {
        const req: RpcRequest = JSON.parse(line);
        if (!this.exposed.has(req.method)) {
          response = { ok: false, error: `Handler "${req.method}" is not exposed` };
        } else {
          const result = this.callHandler(req.method, ...(req.args ?? []));
          response = { ok: true, result };
        }
      } catch (e) {
        response = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }

      try {
        conn.write(JSON.stringify(response) + "\n");
      } catch {}
      conn.end();
    });

    conn.on("error", () => {});
    // Timeout in case client hangs
    conn.setTimeout(5000, () => conn.destroy());
  }

  private callSocket(sockPath: string, method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const conn = net.createConnection(sockPath);
      let buffer = "";
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      conn.on("connect", () => {
        const req: RpcRequest = { method, args };
        conn.write(JSON.stringify(req) + "\n");
      });

      conn.on("data", (data) => {
        buffer += data.toString();
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) return;

        const line = buffer.slice(0, newlineIdx);
        try {
          const resp: RpcResponse = JSON.parse(line);
          settle(() => resp.ok ? resolve(resp.result) : reject(new Error(resp.error)));
        } catch (e) {
          settle(() => reject(e));
        }
        conn.end();
      });

      conn.on("error", (e) => settle(() => reject(e)));
      conn.setTimeout(5000, () => settle(() => {
        reject(new Error("Peer call timed out"));
        conn.destroy();
      }));
    });
  }
}

// ── Extension ──────────────────────────────────────────────────

export default function activate(ctx: ExtensionContext): void {
  const { bus, contextManager, registerCommand, registerTool, registerInstruction, define } = ctx;
  const startTime = Date.now();

  const server = new PeerServer(ctx.instanceId, contextManager.getCwd(), (...args) => ctx.call(...args));
  server.start();

  // ── Standard handlers (define + expose) ────────────────────

  define("peer:info", () => ({
    id: ctx.instanceId,
    pid: process.pid,
    cwd: contextManager.getCwd(),
    uptime: Math.round((Date.now() - startTime) / 1000),
  }));
  server.expose("peer:info");

  define("peer:terminal-read", () => {
    const tb = ctx.terminalBuffer;
    if (!tb) return { text: "(terminal buffer not available)", altScreen: false };
    return tb.readScreen({ includeScrollback: true });
  });
  server.expose("peer:terminal-read");

  define("peer:context-recent", (n: number = 15) => contextManager.getRecentSummary(n));
  server.expose("peer:context-recent");

  define("peer:context-search", (query: string) => contextManager.search(query));
  server.expose("peer:context-search");

  // ── Handler registry API (for other extensions) ────────────

  define("peer:discover", () => server.discover());
  define("peer:call", (peerId: string, method: string, ...args: unknown[]) =>
    server.call(peerId, method, ...args));
  define("peer:expose", (name: string) => server.expose(name));

  // ── Agent tools ────────────────────────────────────────────

  registerTool({
    name: "peers",
    description: "List all running agent-sh instances that can be communicated with.",
    input_schema: { type: "object", properties: {}, required: [] },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "search" as const }),
    formatCall: () => "discovering peers",

    async execute() {
      const peers = server.discover();
      if (peers.length === 0) {
        return { content: "No other agent-sh instances found.", exitCode: 0, isError: false };
      }
      const lines = peers.map((p) =>
        `- id: ${p.id}, pid: ${p.pid}, cwd: ${p.cwd}, uptime: ${Math.round((Date.now() - p.startTime) / 1000)}s`
      );
      return {
        content: `Found ${peers.length} peer(s):\n${lines.join("\n")}`,
        exitCode: 0,
        isError: false,
      };
    },

    formatResult: (_args, result) => ({
      summary: result.content.startsWith("No") ? "none found" : result.content.split("\n")[0],
    }),
  });

  registerTool({
    name: "peer_terminal",
    description: "Read the terminal screen content of another running agent-sh instance. Shows what is currently visible on their terminal.",
    input_schema: {
      type: "object",
      properties: {
        peer_id: { type: "string", description: "The instance ID of the peer (from the peers tool)." },
      },
      required: ["peer_id"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "read" as const }),
    formatCall: (args) => `peer ${args.peer_id}`,

    async execute(args) {
      try {
        const screen = await server.call(args.peer_id as string, "peer:terminal-read") as any;
        const text = screen?.text?.trim() || "(empty screen)";
        const alt = screen?.altScreen ? " [alternate screen active]" : "";
        return {
          content: `Terminal content from peer ${args.peer_id}${alt}:\n\n${text}`,
          exitCode: 0,
          isError: false,
        };
      } catch (e) {
        return {
          content: `Failed to read peer terminal: ${e instanceof Error ? e.message : String(e)}`,
          exitCode: 1,
          isError: true,
        };
      }
    },

    formatResult: (_args, result) => ({
      summary: result.isError ? "failed" : `${result.content.split("\n").length - 2} lines`,
    }),
  });

  registerTool({
    name: "peer_history",
    description: "Get the recent shell command history from another running agent-sh instance.",
    input_schema: {
      type: "object",
      properties: {
        peer_id: { type: "string", description: "The instance ID of the peer." },
        count: { type: "number", description: "Number of recent exchanges to return (default: 15)." },
      },
      required: ["peer_id"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "read" as const }),
    formatCall: (args) => `peer ${args.peer_id}`,

    async execute(args) {
      try {
        const n = (args.count as number) || 15;
        const summary = await server.call(args.peer_id as string, "peer:context-recent", n) as string;
        return { content: summary || "(no history)", exitCode: 0, isError: false };
      } catch (e) {
        return {
          content: `Failed to read peer history: ${e instanceof Error ? e.message : String(e)}`,
          exitCode: 1,
          isError: true,
        };
      }
    },

    formatResult: (_args, result) => ({
      summary: result.isError ? "failed" : `${result.content.split("\n").length} lines`,
    }),
  });

  registerTool({
    name: "peer_search",
    description: "Search another agent-sh instance's shell context by keyword or regex.",
    input_schema: {
      type: "object",
      properties: {
        peer_id: { type: "string", description: "The instance ID of the peer." },
        query: { type: "string", description: "Search query (keyword or regex)." },
      },
      required: ["peer_id", "query"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "search" as const }),
    formatCall: (args) => `peer ${args.peer_id}: "${args.query}"`,

    async execute(args) {
      try {
        const results = await server.call(
          args.peer_id as string, "peer:context-search", args.query as string,
        ) as string;
        return { content: results || "(no matches)", exitCode: 0, isError: false };
      } catch (e) {
        return {
          content: `Failed to search peer context: ${e instanceof Error ? e.message : String(e)}`,
          exitCode: 1,
          isError: true,
        };
      }
    },

    formatResult: (_args, result) => ({
      summary: result.isError ? "failed" : `${result.content.split("\n").length} lines`,
    }),
  });

  // ── Slash command ──────────────────────────────────────────

  registerCommand("peers", "List running agent-sh peer instances", () => {
    const peers = server.discover();
    if (peers.length === 0) {
      bus.emit("ui:info", { message: "No peers found." });
      return;
    }
    const lines = peers.map((p) => {
      const uptime = Math.round((Date.now() - p.startTime) / 1000);
      return `  ${p.id}  pid=${p.pid}  cwd=${p.cwd}  ${uptime}s`;
    });
    bus.emit("ui:info", { message: `Peers:\n${lines.join("\n")}` });
  });

  // ── System prompt instruction ──────────────────────────────

  registerInstruction("Peer Mesh", [
    "You have access to a peer mesh — other running agent-sh instances on this machine.",
    "Use the `peers` tool to discover them, then:",
    "- `peer_terminal` to see what's on another terminal's screen",
    "- `peer_history` to see what commands they ran recently",
    "- `peer_search` to search their shell context by keyword",
    "When the user references 'the other terminal' or 'my other shell', use these tools.",
  ].join("\n"));

  // ── Update CWD in peer file on directory change ────────────

  bus.on("shell:cwd-change", ({ cwd }) => {
    try {
      const info: PeerInfo = JSON.parse(fs.readFileSync(peerFilePath(ctx.instanceId), "utf-8"));
      info.cwd = cwd;
      fs.writeFileSync(peerFilePath(ctx.instanceId), JSON.stringify(info));
    } catch {}
  });
}
