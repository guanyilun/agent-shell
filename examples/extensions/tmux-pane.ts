/**
 * Tmux side-pane extension.
 *
 * Two modes:
 *   /split  — agent output renders in the side pane, queries typed
 *             in the main shell (> prompt).
 *   /rsplit — reverse split: the side pane has its own input prompt,
 *             the agent can see and control the main pane via
 *             terminal_read / terminal_keys.
 *
 * Both modes use createRemoteSession() which handles compositor
 * routing, shell lifecycle, and chrome suppression automatically.
 *
 * Usage:
 *   ash -e ./examples/extensions/tmux-pane.ts
 *
 *   # Or install permanently
 *   cp examples/extensions/tmux-pane.ts ~/.agent-sh/extensions/
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawn } from "node:child_process";
import type { ExtensionContext, RenderSurface, RemoteSession } from "agent-sh/types";

// ── Helpers ─────────────────────────────────────────────────────

function inTmux(): boolean {
  return !!process.env.TMUX;
}

function tmux(...args: string[]): string {
  return execSync(
    "tmux " + args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" "),
    { encoding: "utf-8" },
  ).trim();
}

function getPaneWidth(paneId: string): number {
  try {
    return parseInt(tmux("display-message", "-p", "-t", paneId, "#{pane_width}"), 10) || 80;
  } catch {
    return 80;
  }
}

function paneExists(paneId: string): boolean {
  try {
    tmux("display-message", "-p", "-t", paneId, "#{pane_id}");
    return true;
  } catch {
    return false;
  }
}

// ── Chat client script (runs in rsplit pane) ────────────────────

const CHAT_CLIENT_SCRIPT = `
const net = require("net");
const readline = require("readline");

const sockPath = process.argv[2];
if (!sockPath) { console.error("No socket path"); process.exit(1); }

const sock = net.createConnection(sockPath);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

sock.on("data", (data) => {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(data.toString());
  rl.prompt(true);
});

sock.on("end", () => process.exit(0));
sock.on("error", () => process.exit(1));

rl.setPrompt("\\x1b[36m❯\\x1b[0m ");
rl.prompt();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) { rl.prompt(); return; }
  sock.write(trimmed + "\\n");
});

rl.on("close", () => { sock.end(); process.exit(0); });
`;

// ── Surface factory ─────────────────────────────────────────────

function createSurface(
  paneId: string,
  ttyFd: fs.WriteStream,
  socketClient: () => net.Socket | undefined,
): RenderSurface {
  let cachedWidth = getPaneWidth(paneId);
  let lastWidthCheck = Date.now();

  return {
    write(text: string): void {
      // In rsplit mode, route through socket so client can manage prompt
      const c = socketClient();
      if (c && !c.destroyed) {
        try { c.write(text); } catch {}
        return;
      }
      // In split mode (or fallback), write directly to tty
      if (ttyFd.destroyed) return;
      try { ttyFd.write(text); } catch {}
    },
    writeLine(line: string): void {
      this.write(line + "\n");
    },
    get columns(): number {
      const now = Date.now();
      if (now - lastWidthCheck > 2000) {
        cachedWidth = getPaneWidth(paneId);
        lastWidthCheck = now;
      }
      return cachedWidth;
    },
  };
}

// ── Pane state ──────────────────────────────────────────────────

type PaneMode = "split" | "rsplit";

interface PaneState {
  mode: PaneMode;
  paneId: string;
  ttyFd: fs.WriteStream;
  session: RemoteSession;
  // rsplit-mode only
  server?: net.Server;
  client?: net.Socket;
  sockPath?: string;
  scriptPath?: string;
}

// ── Extension ───────────────────────────────────────────────────

export default function activate(ctx: ExtensionContext): void {
  const { bus, registerCommand, registerInstruction, createRemoteSession } = ctx;

  if (!inTmux()) return;

  let state: PaneState | null = null;

  registerInstruction("Tmux Interactive Session", [
    "When the dynamic context includes `interactive-session: true`, the user is chatting",
    "with you in a side pane next to their terminal. They may have a program running in",
    "the other pane (vim, htop, a REPL, etc.). In this mode:",
    "- Use terminal_read to see what's on their screen.",
    "- Use terminal_keys to interact with their running program.",
    "- Use user_shell only for standalone commands, not for interacting with what's on screen.",
    "- Keep responses concise.",
  ].join("\n"));

  // ── Open / close ──────────────────────────────────────────────

  function openSplit(): void {
    if (state) close();

    try {
      const paneId = tmux(
        "split-window", "-h", "-l", "45%",
        "-P", "-F", "#{pane_id}", "cat",
      ).trim();
      execSync("sleep 0.1");

      const tty = tmux("display-message", "-p", "-t", paneId, "#{pane_tty}");
      const ttyFd = fs.createWriteStream(tty, { flags: "w" });
      ttyFd.on("error", () => destroyStale());

      const surface = createSurface(paneId, ttyFd, () => undefined);
      const session = createRemoteSession({ surface });

      state = { mode: "split", paneId, ttyFd, session };
      surface.writeLine("\x1b[2m── agent output ──\x1b[0m\n");
      bus.emit("ui:info", { message: "Split pane opened (/split to close, /rsplit for interactive)." });
    } catch (e) {
      bus.emit("ui:error", {
        message: `Failed to open split: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  function openRsplit(): void {
    if (state) close();

    try {
      const sockPath = path.join(os.tmpdir(), `agent-sh-chat-${process.pid}.sock`);
      try { fs.unlinkSync(sockPath); } catch {}

      let client: net.Socket | undefined;

      const server = net.createServer((conn) => {
        client = conn;
        if (state) state.client = conn;
        conn.on("data", (data) => {
          for (const line of data.toString().split("\n")) {
            const trimmed = line.trim();
            if (trimmed) session.submit(trimmed);
          }
        });
        conn.on("end", () => { client = undefined; if (state) state.client = undefined; });
        conn.on("error", () => { client = undefined; if (state) state.client = undefined; });
      });
      server.listen(sockPath);

      const scriptPath = path.join(os.tmpdir(), `agent-sh-chat-${process.pid}.js`);
      fs.writeFileSync(scriptPath, CHAT_CLIENT_SCRIPT);

      const paneId = tmux(
        "split-window", "-h", "-l", "45%",
        "-P", "-F", "#{pane_id}",
        "node", scriptPath, sockPath,
      ).trim();
      execSync("sleep 0.2");

      const tty = tmux("display-message", "-p", "-t", paneId, "#{pane_tty}");
      const ttyFd = fs.createWriteStream(tty, { flags: "w" });
      ttyFd.on("error", () => destroyStale());

      const surface = createSurface(paneId, ttyFd, () => client);
      const session = createRemoteSession({
        surface,
        suppressQueryBox: true,
        interactive: true,
      });

      state = { mode: "rsplit", paneId, ttyFd, session, server, client, sockPath, scriptPath };
      bus.emit("ui:info", { message: "Reverse split opened (/rsplit to close, /split for output-only)." });
    } catch (e) {
      bus.emit("ui:error", {
        message: `Failed to open rsplit: ${e instanceof Error ? e.message : String(e)}`,
      });
      if (state) close();
    }
  }

  function close(): void {
    if (!state) return;
    const s = state;
    state = null;

    s.session.close();
    if (s.client) { try { s.client.end(); } catch {} }
    if (s.server) { try { s.server.close(); } catch {} }
    try { s.ttyFd.end(); } catch {}
    try { tmux("kill-pane", "-t", s.paneId); } catch {}
    if (s.sockPath) { try { fs.unlinkSync(s.sockPath); } catch {} }
    if (s.scriptPath) { try { fs.unlinkSync(s.scriptPath); } catch {} }
  }

  function destroyStale(): void {
    if (!state) return;
    const s = state;
    state = null;

    s.session.close();
    if (s.client) { try { s.client.end(); } catch {} }
    if (s.server) { try { s.server.close(); } catch {} }
    try { s.ttyFd.end(); } catch {}
    if (s.sockPath) { try { fs.unlinkSync(s.sockPath); } catch {} }
    if (s.scriptPath) { try { fs.unlinkSync(s.scriptPath); } catch {} }
  }

  // ── Commands ──────────────────────────────────────────────────

  registerCommand("split", "Toggle tmux side pane for agent output", (args) => {
    const cmd = args.trim().toLowerCase();
    if (cmd === "close") return close();
    if (cmd === "open") return openSplit();
    if (state?.mode === "split") close(); else openSplit();
  });

  registerCommand("rsplit", "Toggle interactive tmux side pane (reverse split)", (args) => {
    const cmd = args.trim().toLowerCase();
    if (cmd === "close") return close();
    if (cmd === "open") return openRsplit();
    if (state?.mode === "rsplit") close(); else openRsplit();
  });

  // ── Lifecycle events ──────────────────────────────────────────

  // In split mode, redraw prompt immediately after query submit.
  bus.on("agent:query", () => {
    if (state?.mode !== "split") return;
    setImmediate(() => bus.emit("shell:pty-write", { data: "\n" }));
  });

  // In rsplit mode, re-prompt the client after agent finishes.
  bus.on("agent:processing-done", () => {
    if (!state) return;
    if (!paneExists(state.paneId)) { destroyStale(); return; }
    if (state.mode === "rsplit" && state.client && !state.client.destroyed) {
      state.client.write("\n");
    }
    state.session.surface.writeLine("");
  });

  process.on("exit", () => { if (state) close(); });
}
