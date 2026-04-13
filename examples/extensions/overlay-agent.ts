/**
 * Overlay agent extension.
 *
 * Provides a hotkey (Ctrl+\) to summon the agent from anywhere — even
 * inside vim, htop, or ssh. Composites a floating response box on top
 * of the current terminal content.
 *
 * Requires: npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/overlay-agent.ts
 *
 *   # Or copy to ~/.agent-sh/extensions/ for permanent use:
 *   cp examples/extensions/overlay-agent.ts ~/.agent-sh/extensions/
 */
import type { ExtensionContext } from "agent-sh/types";
import { formatScreenContext } from "agent-sh/utils/terminal-buffer.js";

const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

export default function activate({ bus, advise, createFloatingPanel, terminalBuffer }: ExtensionContext): void {
  const panel = createFloatingPanel({
    trigger: "\x1c", // Ctrl+\
    dimBackground: true,
    autoDismissMs: 2000,
  });

  // ── Inject terminal buffer into agent context ──────────────
  if (terminalBuffer) {
    advise("context:build-extra", (next: () => string) =>
      formatScreenContext(terminalBuffer.readScreen(), 80, next()),
    );
  }

  // ── Panel lifecycle ────────────────────────────────────────
  panel.handlers.advise("panel:submit", (_next, query: string) => {
    panel.setActive();
    panel.appendLine(`${CYAN}${BOLD}❯${RESET} ${query}`);
    panel.appendLine("");
    bus.emit("agent:submit", { query });
  });

  // ── Stream agent response into panel ───────────────────────
  bus.on("agent:response-chunk", (e) => {
    if (!panel.active) return;
    for (const block of e.blocks) {
      if (block.type === "text" && block.text) {
        panel.appendText(block.text);
      }
    }
  });

  bus.on("agent:tool-started", (e) => {
    if (!panel.active) return;
    panel.appendLine(`▶ ${e.title}${e.displayDetail ? " " + e.displayDetail : ""}`);
  });

  bus.on("agent:tool-completed", (e) => {
    if (!panel.active) return;
    const mark = e.exitCode === 0 ? " ✓" : ` ✗ exit ${e.exitCode}`;
    panel.updateLastLine((line) => line + mark);
  });

  bus.on("agent:processing-done", () => {
    if (!panel.active) return;
    panel.setDone();
  });
}
