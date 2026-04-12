/**
 * Terminal buffer extension.
 *
 * Maintains a headless xterm.js terminal fed from raw PTY data.
 * Provides an accurate, clean-text snapshot of the terminal screen
 * that the agent can use for context — handling ANSI codes, cursor
 * movement, alternate screen (vim/htop), and line wrapping correctly.
 *
 * Registers two agent tools:
 *   - terminal_read: get the current screen contents + cursor position
 *   - terminal_keys: send raw keystrokes into the user's live PTY
 *
 * Together these let the agent operate inside interactive programs
 * (vim, htop, less, etc.) by reading the screen and typing keys.
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

/** Wait for PTY output to settle after sending keystrokes. */
function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Interpret C-style escape sequences in a string (e.g. \r → CR, \x1b → ESC). */
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

export default function activate({ bus, advise, registerTool }: ExtensionContext): void {
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

  // ── Helper: read clean screen text ──────────────────────────

  function readScreen(): { text: string; altScreen: boolean; cursorX: number; cursorY: number } {
    const raw = serialize.serialize();
    return {
      text: stripAnsi(raw),
      altScreen: term.buffer.active.type === "alternate",
      cursorX: term.buffer.active.cursorX,
      cursorY: term.buffer.active.cursorY,
    };
  }

  // ── Context injection ───────────────────────────────────────

  advise("context:build-extra", (next: () => string) => {
    const base = next();
    const { text, altScreen } = readScreen();
    const trimmed = text.trim();
    if (!trimmed) return base;

    const lines = trimmed.split("\n");
    const capped = lines.length > MAX_CONTEXT_LINES
      ? lines.slice(-MAX_CONTEXT_LINES).join("\n")
      : trimmed;

    const header = altScreen ? "<terminal_buffer mode=\"alternate\">" : "<terminal_buffer>";
    const section = `${header}\n${capped}\n</terminal_buffer>`;
    return base ? base + "\n" + section : section;
  });

  // ── Agent tools ─────────────────────────────────────────────

  registerTool({
    name: "terminal_read",
    description:
      "Read the current terminal screen contents. Returns clean text (ANSI stripped) " +
      "with cursor position and whether an alternate-screen program (vim, htop, less) is active. " +
      "Use this to see what the user sees before sending keystrokes with terminal_keys.",
    input_schema: {
      type: "object",
      properties: {},
    },
    showOutput: true,

    getDisplayInfo: () => ({
      kind: "read" as const,
      icon: "⊞",
      locations: [],
    }),

    async execute() {
      const { text, altScreen, cursorX, cursorY } = readScreen();
      const info = [
        altScreen ? "mode: alternate screen" : "mode: normal",
        `cursor: row=${cursorY} col=${cursorX}`,
      ].join(", ");

      return {
        content: `[${info}]\n\n${text}`,
        exitCode: 0,
        isError: false,
      };
    },
  });

  registerTool({
    name: "terminal_keys",
    description:
      "Send keystrokes to the user's live terminal. The keys are written directly to the PTY " +
      "as if the user typed them. Use escape sequences for special keys:\n" +
      "  - Escape: \\x1b\n" +
      "  - Enter/Return: \\r\n" +
      "  - Tab: \\t\n" +
      "  - Ctrl+C: \\x03\n" +
      "  - Ctrl+D: \\x04\n" +
      "  - Ctrl+Z: \\x1a\n" +
      "  - Arrow keys: \\x1b[A (up), \\x1b[B (down), \\x1b[C (right), \\x1b[D (left)\n" +
      "  - Backspace: \\x7f\n\n" +
      "Example: to quit vim without saving, send keys=\"\\x1b:q!\\r\" (Escape, :q!, Enter).\n" +
      "Always call terminal_read after sending keys to verify the result.",
    input_schema: {
      type: "object",
      properties: {
        keys: {
          type: "string",
          description:
            "The keystrokes to send. Use \\x1b for Escape, \\r for Enter, \\t for Tab, " +
            "\\x03 for Ctrl+C, etc. Regular characters are sent as-is.",
        },
        settle_ms: {
          type: "number",
          description:
            "Milliseconds to wait after sending keys for the terminal to settle before " +
            "returning (default: 150). Increase for slow programs.",
        },
      },
      required: ["keys"],
    },
    showOutput: false,

    getDisplayInfo: (args) => ({
      kind: "execute" as const,
      icon: "⌨",
      locations: [],
    }),

    formatCall: (args) => {
      const keys = args.keys as string;
      // Show a readable version of the keys
      return keys
        .replace(/\x1b/g, "ESC")
        .replace(/\r/g, "⏎")
        .replace(/\t/g, "TAB")
        .replace(/\x03/g, "^C")
        .replace(/\x7f/g, "BS");
    },

    async execute(args) {
      const raw = args.keys as string;
      const keys = interpretEscapes(raw);
      const settleMs = (args.settle_ms as number) ?? 150;

      bus.emit("shell:pty-write", { data: keys });

      // Wait for the terminal to process the keystrokes and render
      await settle(settleMs);

      // Return the screen state after the keystrokes
      const { text, altScreen, cursorX, cursorY } = readScreen();
      const info = [
        altScreen ? "mode: alternate screen" : "mode: normal",
        `cursor: row=${cursorY} col=${cursorX}`,
      ].join(", ");

      return {
        content: `Keys sent. Screen after:\n[${info}]\n\n${text}`,
        exitCode: 0,
        isError: false,
      };
    },
  });

  // ── Bus snapshot for other extensions ───────────────────────

  bus.on("shell:buffer-request", () => {
    const { text, altScreen, cursorX, cursorY } = readScreen();
    bus.emit("shell:buffer-snapshot", {
      text,
      altScreen,
      cursor: { x: cursorX, y: cursorY },
    });
  });
}
