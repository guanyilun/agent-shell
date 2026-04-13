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
import type { ExtensionContext } from "agent-sh/types";

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

export default function activate({ bus, terminalBuffer: tb, registerTool }: ExtensionContext): void {
  if (!tb) {
    console.warn("terminal-buffer: @xterm/headless not installed — extension disabled");
    return;
  }

  // ── Agent tools ─────────────────────────────────────────────
  // Context injection is intentionally NOT done here — the terminal
  // buffer content would bloat every agent message.  The agent can
  // call terminal_read on demand, and the overlay extension injects
  // context only when the overlay is active.

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
      const { text, altScreen, cursorX, cursorY } = tb.readScreen();
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
      // Show a readable version of the keys — handle both literal
      // escape strings (\\x1b) and actual bytes (\x1b)
      return keys
        .replace(/\\x1b|\x1b/g, "ESC")
        .replace(/\\r|\r/g, "⏎")
        .replace(/\\n|\n/g, "↵")
        .replace(/\\t|\t/g, "TAB")
        .replace(/\\x03|\x03/g, "^C")
        .replace(/\\x04|\x04/g, "^D")
        .replace(/\\x7f|\x7f/g, "BS");
    },

    async execute(args) {
      const raw = args.keys as string;
      const keys = interpretEscapes(raw);
      const settleMs = (args.settle_ms as number) ?? 150;

      // Force PTY output visible so the user sees the program's response.
      // Stays visible for the rest of agent processing — Shell resets
      // paused=false on processing-done anyway.
      bus.emit("shell:stdout-show", {});
      process.stdout.write("\n");
      bus.emit("shell:pty-write", { data: keys });

      // Wait for the terminal to process the keystrokes and render
      await settle(settleMs);

      // Return the screen state after the keystrokes
      const { text, altScreen, cursorX, cursorY } = tb.readScreen();
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
    const { text, altScreen, cursorX, cursorY } = tb.readScreen();
    bus.emit("shell:buffer-snapshot", {
      text,
      altScreen,
      cursor: { x: cursorX, y: cursorY },
    });
  });
}
