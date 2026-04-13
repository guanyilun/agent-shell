/**
 * Built-in overlay agent.
 *
 * Provides a hotkey (Ctrl+\) to summon the agent from anywhere — even
 * inside vim, htop, or ssh. Composites a floating response box on top
 * of the current terminal content.
 *
 * Rendering reuses the shared tui:render-* handlers so that extensions
 * advising those handlers affect both the main TUI and the overlay.
 *
 * Requires: npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 */
import type { ExtensionContext } from "../types.js";
import { MarkdownRenderer } from "../utils/markdown.js";
import { palette as p } from "../utils/palette.js";
import {
  renderToolCall,
  formatElapsed,
} from "../utils/tool-display.js";

interface ChatMessage {
  role: "user" | "assistant";
  lines: string[];
}

export default function activate(ctx: ExtensionContext): void {
  const { bus, advise, call, createFloatingPanel } = ctx;

  const panel = createFloatingPanel({
    trigger: "\x1c", // Ctrl+\
    dimBackground: true,
  });

  // Suppress TUI renderer when overlay owns agent output
  advise("tui:should-render-agent", (next) => {
    return panel.active ? false : next();
  });

  // Signal interactive overlay mode in dynamic context
  advise("dynamic-context:build", (next) => {
    const base = next() as string;
    if (!panel.active) return base;
    return base + "\ninteractive-session: true\n";
  });

  // ── Conversation state (persists across hide/show) ─────────
  const messages: ChatMessage[] = [];
  let renderer: MarkdownRenderer | null = null;
  let currentAssistantMsg: ChatMessage | null = null;

  // ── Tool state ─────────────────────────────────────────────
  let toolStartTime = 0;

  function getContentWidth(): number {
    return panel.computeGeometry().contentW;
  }

  /** Rebuild panel content from full message history. */
  function rebuildContent(): void {
    panel.clearContent();
    for (const msg of messages) {
      for (const line of msg.lines) {
        panel.appendLine(line);
      }
      panel.appendLine("");
    }
  }

  /** Append a line to current assistant message and panel (if visible). */
  function appendLine(line: string): void {
    currentAssistantMsg?.lines.push(line);
    if (panel.visible) panel.appendLine(line);
  }

  function drainRenderer(): void {
    if (!renderer) return;
    for (const line of renderer.drainLines()) {
      appendLine(line);
    }
  }

  function flushRenderer(): void {
    if (!renderer) return;
    renderer.flush();
    drainRenderer();
  }

  function startAssistantMessage(): void {
    flushRenderer();
    currentAssistantMsg = { role: "assistant", lines: [] };
    messages.push(currentAssistantMsg);
    renderer = new MarkdownRenderer(getContentWidth());
  }

  function finalizeAssistantMessage(): void {
    flushRenderer();
    renderer = null;
    currentAssistantMsg = null;
  }

  // ── Panel lifecycle ────────────────────────────────────────

  panel.handlers.advise("panel:submit", (_next, query: string) => {
    messages.push({
      role: "user",
      lines: [`${p.accent}${p.bold}❯${p.reset} ${query}`],
    });

    panel.setActive();
    rebuildContent();
    startAssistantMessage();
    bus.emit("agent:submit", { query });
  });

  panel.handlers.advise("panel:show", (_next) => {
    rebuildContent();
    if (renderer) drainRenderer();
  });

  // ── Stream agent response into panel ───────────────────────

  bus.on("agent:response-chunk", (e) => {
    if (!panel.active) return;
    if (!currentAssistantMsg) startAssistantMessage();

    for (const block of e.blocks) {
      if (block.type === "text" && block.text) {
        renderer!.push(block.text);
        drainRenderer();
      } else if (block.type === "code-block") {
        flushRenderer();
        // Reuse the shared code-block handler
        call("render:code-block", block.language, block.code, getContentWidth());
      }
    }
  });

  // Capture lines emitted by render:code-block into the overlay
  advise("render:code-block", (next, language: string, code: string, width: number) => {
    if (!panel.active) return next(language, code, width);
    // Render code block as indented dim lines for the overlay
    const label = language ? `${p.dim}${language}${p.reset}` : "";
    if (label) appendLine(label);
    for (const codeLine of code.split("\n")) {
      appendLine(`  ${p.dim}${codeLine}${p.reset}`);
    }
  });

  bus.on("agent:tool-started", (e) => {
    if (!panel.active) return;
    if (!currentAssistantMsg) startAssistantMessage();
    flushRenderer();
    toolStartTime = Date.now();

    const lines = renderToolCall({
      title: e.title,
      kind: e.kind,
      icon: e.icon,
      locations: e.locations,
      rawInput: e.rawInput,
      displayDetail: e.displayDetail,
    }, getContentWidth());

    for (const line of lines) appendLine(line);
  });

  bus.on("agent:tool-completed", (e) => {
    if (!panel.active) return;

    const elapsed = toolStartTime ? formatElapsed(Date.now() - toolStartTime) : "";
    const mark: string = call("tui:render-tool-complete", e.exitCode, elapsed, undefined);
    appendLine(`  ${mark}`);
  });

  bus.on("agent:processing-done", () => {
    if (!panel.active) return;
    finalizeAssistantMessage();
    panel.setDone();
  });
}
