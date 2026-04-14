/**
 * Built-in overlay agent.
 *
 * Provides a hotkey (Ctrl+\) to summon the agent from anywhere — even
 * inside vim, htop, or ssh. Composites a floating response box on top
 * of the current terminal content.
 *
 * Uses the compositor to redirect agent output into the floating panel.
 * The full tui-renderer pipeline (markdown, tool grouping, spinner, diffs)
 * applies — the overlay just changes *where* the output goes.
 *
 * Requires: npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 */
import type { ExtensionContext } from "../types.js";
import type { RenderSurface } from "../utils/compositor.js";
import type { FloatingPanel } from "../utils/floating-panel.js";

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
  const { bus, compositor, advise, registerInstruction, createFloatingPanel } = ctx;

  const panel = createFloatingPanel({
    trigger: "\x1c", // Ctrl+\
    dimBackground: true,
  });

  const panelSurface = createPanelSurface(panel);

  // ── Compositor routing ────────────────────────────────────────
  // When the panel is active, redirect all render streams to it.
  let restoreAgent: (() => void) | null = null;
  let restoreQuery: (() => void) | null = null;
  let restoreStatus: (() => void) | null = null;

  function redirectToPanel(): void {
    if (restoreAgent) return; // already redirected
    restoreAgent = compositor.redirect("agent", panelSurface);
    restoreQuery = compositor.redirect("query", panelSurface);
    restoreStatus = compositor.redirect("status", panelSurface);
  }

  function restoreRouting(): void {
    restoreAgent?.();
    restoreQuery?.();
    restoreStatus?.();
    restoreAgent = restoreQuery = restoreStatus = null;
  }

  // Suppress TUI renderer when overlay owns agent output.
  // TODO: Once tui-renderer fully uses compositor routing, remove this gate
  // and let the compositor redirect handle everything. The tui-renderer's
  // full pipeline (markdown, tool grouping, diffs) would then apply to the
  // overlay too — which is the desired end state.
  advise("tui:should-render-agent", (next) => {
    return panel.active ? false : next();
  });

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

  // Signal interactive overlay mode in dynamic context
  advise("dynamic-context:build", (next) => {
    const base = next() as string;
    if (!panel.active) return base;
    return base + "\ninteractive-session: true\n";
  });

  // ── Panel lifecycle ────────────────────────────────────────────

  panel.handlers.advise("panel:submit", (_next, query: string) => {
    redirectToPanel();
    panel.setActive();
    bus.emit("agent:submit", { query });
  });

  panel.handlers.advise("panel:show", (_next) => {
    if (panel.active) redirectToPanel();
  });

  // Restore routing on hide (panel:dismiss is the hide handler)
  panel.handlers.advise("panel:dismiss", (next) => {
    next();
    restoreRouting();
  });

  bus.on("agent:processing-done", () => {
    if (!panel.active) return;
    panel.setDone();
    // setDone() may trigger dismiss() which resets phase to idle.
    // If that happened, restore routing now (dismiss() doesn't call panel:dismiss).
    if (!panel.active) restoreRouting();
  });
}
