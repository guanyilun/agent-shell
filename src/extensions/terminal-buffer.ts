/**
 * Built-in terminal buffer extension.
 *
 * Registers two agent tools:
 *   - terminal_read: get the current screen contents + cursor position
 *   - terminal_keys: send raw keystrokes into the user's live PTY
 *
 * Together these let the agent operate inside interactive programs
 * (vim, htop, less, etc.) by reading the screen and typing keys.
 *
 * Requires: npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 */
import type { ExtensionContext } from "../types.js";

/** Interpret C-style escape sequences (e.g. \r → CR, \x1b → ESC). */
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

export default function activate(ctx: ExtensionContext): void {
  const { bus, terminalBuffer: tb, registerTool, registerInstruction } = ctx;
  if (!tb) return; // @xterm/headless not installed

  registerTool({
    name: "terminal_read",
    description:
      "Read what is currently visible on the user's terminal screen. Returns clean text (ANSI stripped) " +
      "with cursor position and whether an alternate-screen program (vim, htop, less) is active. " +
      "Use this to observe what the user sees — helpful for answering questions about terminal output, " +
      "diagnosing errors on screen, or checking state before/after sending keystrokes with terminal_keys.",
    input_schema: {
      type: "object",
      properties: {
        include_scrollback: {
          type: "boolean",
          description:
            "If true, include scrollback buffer (content that scrolled off screen) " +
            "in addition to the visible viewport. Useful for capturing output from " +
            "long-running or streaming commands. Default: false.",
        },
      },
    },
    showOutput: true,

    getDisplayInfo: () => ({
      kind: "read" as const,
      icon: "⊞",
      locations: [],
    }),

    async execute(args) {
      const includeScrollback = (args.include_scrollback as boolean) ?? false;
      const { text, altScreen, cursorX, cursorY } = tb.readScreen({ includeScrollback });
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
      "Send keystrokes directly into the user's live terminal PTY, as if the user typed them. " +
      "Use this to interact with programs already running in the terminal (vim, htop, less, ssh, REPLs, etc.) " +
      "or to type commands at the shell prompt. This types directly into whatever is currently on screen.\n\n" +
      "Escape sequences for special keys:\n" +
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

    getDisplayInfo: () => ({
      kind: "execute" as const,
      icon: "⌨",
      locations: [],
    }),

    formatCall: (args) => {
      const keys = args.keys as string;
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

      bus.emit("shell:stdout-show", {});
      process.stdout.write("\n");
      bus.emit("shell:pty-write", { data: keys });

      await settle(settleMs);
      bus.emit("shell:stdout-hide", {});

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
}
