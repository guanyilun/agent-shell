/**
 * Overlay agent extension.
 *
 * Provides a hotkey (Ctrl+\) to summon the agent from anywhere — even
 * inside vim, htop, or ssh. Composites a floating response box on top
 * of the current terminal content.
 *
 * Uses createRemoteSession() to route the full tui-renderer pipeline
 * (markdown, tool grouping, spinner, diffs) into the floating panel.
 *
 * Install:
 *   cp examples/extensions/overlay-agent.ts ~/.agent-sh/extensions/
 *
 * Or load directly:
 *   agent-sh -e ./examples/extensions/overlay-agent.ts
 *
 * Requires: npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 */
import type { ExtensionContext, RemoteSession } from "agent-sh/types";
import type { RenderSurface } from "agent-sh/utils/compositor";
import { FloatingPanel } from "agent-sh/utils/floating-panel";

/** Adapt a FloatingPanel to the RenderSurface interface. */
function createPanelSurface(panel: FloatingPanel): RenderSurface {
  return {
    write(text: string): void {
      // Handle \r (carriage return) — overwrite the current line.
      // The spinner uses "\r  <content>\x1b[K" to update in-place.
      if (text.startsWith("\r")) {
        // Strip \r and any erase-line sequences
        const cleaned = text.replace(/^\r/, "").replace(/\x1b\[\d*K/g, "");
        if (cleaned.trim()) {
          panel.updateLastLine(() => cleaned);
        }
        return;
      }

      // Regular text — may contain newlines
      panel.appendText(text);
    },
    writeLine(line: string): void {
      panel.appendLine(line);
    },
    get columns(): number {
      return panel.computeGeometry().contentW;
    },
  };
}

export default function activate(ctx: ExtensionContext): void {
  const { bus, registerInstruction, createRemoteSession, terminalBuffer } = ctx;

  const panel = new FloatingPanel(bus, {
    trigger: "\x1c", // Ctrl+\
    dimBackground: true,
    terminalBuffer: terminalBuffer ?? undefined,
  });

  const panelSurface = createPanelSurface(panel);
  let session: RemoteSession | null = null;

  registerInstruction("Interactive Overlay Sessions", [
    "When the dynamic context includes `interactive-session: true`, the user has summoned you",
    "via a hotkey overlay from inside their live terminal. They may be in the middle of using",
    "a program (vim, ssh, a REPL, etc.) or at a shell prompt. In this mode:",
    "- Start with terminal_read if you need to understand what's on screen.",
    "- Prefer terminal_keys to interact with whatever is currently running.",
    "- Use user_shell only for running new, standalone commands — not for interacting with",
    "  what's already on screen.",
    "- Keep responses concise — the user is in the middle of a workflow.",
  ].join("\n"));

  // ── Panel lifecycle ────────────────────────────────────────────

  panel.handlers.advise("panel:submit", (_next, query: string) => {
    if (!session) {
      session = createRemoteSession({
        surface: panelSurface,
        suppressQueryBox: true,
        interactive: true,
      });
    }
    panel.setActive();
    session.submit(query);
  });

  panel.handlers.advise("panel:show", (_next) => {
    // Re-establish session if panel is shown while agent is still working
    if (panel.active && !session) {
      session = createRemoteSession({
        surface: panelSurface,
        suppressQueryBox: true,
        interactive: true,
      });
    }
  });

  // On dismiss: close session only if agent is not actively processing.
  // If agent is still working (phase="active"), keep session alive so
  // output buffers in the panel and agent can keep executing tools.
  panel.handlers.advise("panel:dismiss", (next) => {
    next();
    if (session && !panel.processing) {
      session.close();
      session = null;
    }
  });

  bus.on("agent:processing-done", () => {
    if (!panel.active) return;
    panel.setDone();
    // If panel was hidden while processing (passthrough), setDone()
    // triggers dismiss() which closes the session above.
    // If panel is still visible, session stays for the follow-up prompt.
  });
}
