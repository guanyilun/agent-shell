/**
 * Overlay agent extension.
 *
 * Provides a hotkey (Ctrl+\) to summon the agent from anywhere — even
 * inside vim, htop, or ssh. Composites a floating response box on top
 * of the current terminal content.
 *
 * Uses createRemoteSession to route all agent output (rendered markdown,
 * tool calls, etc.) into the floating panel via the compositor.
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
import type { RenderSurface } from "agent-sh/utils/compositor.js";
import { formatScreenContext } from "agent-sh/utils/terminal-buffer.js";

export default function activate({ bus, advise, createFloatingPanel, createRemoteSession, terminalBuffer }: ExtensionContext): void {
  const panel = createFloatingPanel({
    trigger: "\x1c", // Ctrl+\
    dimBackground: true,
    autoDismissMs: 2000,
  });

  // ── Inject terminal buffer into agent context ──────────────
  if (terminalBuffer) {
    advise("context:build-extra", (next: () => string) =>
      formatScreenContext(terminalBuffer.readScreen({ includeScrollback: true }), 80, next()),
    );
  }

  // ── Surface backed by the floating panel ───────────────────
  const surface: RenderSurface = {
    write(text: string) { panel.appendText(text); },
    writeLine(line: string) { panel.appendLine(line); },
    get columns() { return panel.computeGeometry().contentW; },
  };

  // ── Panel lifecycle ────────────────────────────────────────
  type Session = ReturnType<typeof createRemoteSession>;
  let session: Session | null = null;

  panel.handlers.advise("panel:submit", (_next, query: string) => {
    if (session) session.close();
    session = createRemoteSession({
      surface,
      suppressQueryBox: true,
      interactive: true,
    });
    panel.setActive();
    panel.appendLine(`\x1b[36m\x1b[1m❯\x1b[0m ${query}`);
    panel.appendLine("");
    session.submit(query);
  });

  bus.on("agent:processing-done", () => {
    if (!session) return;
    panel.setDone();
  });

  panel.handlers.advise("panel:dismiss", (next) => {
    if (session) { session.close(); session = null; }
    return next();
  });
}
