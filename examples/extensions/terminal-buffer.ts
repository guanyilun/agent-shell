/**
 * Terminal buffer extension.
 *
 * Maintains a headless xterm.js terminal fed from raw PTY data.
 * Provides an accurate, clean-text snapshot of the terminal screen
 * that the agent can use for context — handling ANSI codes, cursor
 * movement, alternate screen (vim/htop), and line wrapping correctly.
 *
 * Requires: npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/terminal-buffer.ts
 *
 *   # Or copy to ~/.agent-sh/extensions/ for permanent use:
 *   cp examples/extensions/terminal-buffer.ts ~/.agent-sh/extensions/
 */
import { createRequire } from "module";
import type { ExtensionContext } from "agent-sh/types";

// xterm packages are CJS-only; use createRequire in ESM context
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

const DEFAULT_COLS = 220;
const DEFAULT_ROWS = 50;
const MAX_CONTEXT_LINES = 80;

/** Strip all ANSI escape sequences and carriage returns. */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\][^\x07]*\x07/g, "")        // OSC sequences
    .replace(/\x1b\[[^m]*m/g, "")                // SGR (color) sequences
    .replace(/\x1b\[\?[^a-zA-Z]*[a-zA-Z]/g, "") // private mode sequences
    .replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "")   // CSI sequences
    .replace(/\r/g, "");                          // carriage returns
}

export default function activate({ bus, advise }: ExtensionContext): void {
  const term = new Terminal({
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    allowProposedApi: true,
    scrollback: 200,
  });
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);

  // Feed raw PTY output into the virtual terminal
  bus.on("shell:pty-data", ({ raw }) => {
    term.write(raw);
  });

  // Inject terminal buffer into agent context
  advise("context:build-extra", (next: () => string) => {
    const base = next();
    const raw = serialize.serialize().trim();
    if (!raw) return base;

    // Strip ANSI codes for clean agent-readable text
    const buffer = stripAnsi(raw);
    if (!buffer.trim()) return base;

    // Limit to last N lines to keep context budget reasonable
    const lines = buffer.split("\n");
    const trimmed = lines.length > MAX_CONTEXT_LINES
      ? lines.slice(-MAX_CONTEXT_LINES).join("\n")
      : buffer;

    const isAlt = term.buffer.active.type === "alternate";
    const header = isAlt ? "<terminal_buffer mode=\"alternate\">" : "<terminal_buffer>";

    const section = `${header}\n${trimmed}\n</terminal_buffer>`;
    return base ? base + "\n" + section : section;
  });

  // On-demand snapshot for extensions (e.g. keystroke injection feedback loop)
  bus.on("shell:buffer-request", () => {
    bus.emit("shell:buffer-snapshot", {
      text: serialize.serialize(),
      altScreen: term.buffer.active.type === "alternate",
      cursor: {
        x: term.buffer.active.cursorX,
        y: term.buffer.active.cursorY,
      },
    });
  });
}
