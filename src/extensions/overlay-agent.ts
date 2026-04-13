/**
 * Built-in overlay agent.
 *
 * Provides a hotkey (Ctrl+\) to summon the agent from anywhere — even
 * inside vim, htop, or ssh. Composites a floating response box on top
 * of the current terminal content.
 *
 * Requires: npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 */
import type { ExtensionContext } from "../types.js";
import { MarkdownRenderer } from "../utils/markdown.js";
import { palette as p } from "../utils/palette.js";
import {
  renderToolCall,
  createSpinner,
  renderSpinnerLine,
  formatElapsed,
  type SpinnerState,
} from "../utils/tool-display.js";

interface ChatMessage {
  role: "user" | "assistant";
  lines: string[];
}

export default function activate({ bus, createFloatingPanel }: ExtensionContext): void {
  const panel = createFloatingPanel({
    trigger: "\x1c", // Ctrl+\
    dimBackground: true,
  });

  // ── Conversation state (persists across hide/show) ─────────
  const messages: ChatMessage[] = [];
  let renderer: MarkdownRenderer | null = null;
  let currentAssistantMsg: ChatMessage | null = null;

  // ── Spinner state ──────────────────────────────────────────
  let spinner: SpinnerState | null = null;
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerStartTime = 0;

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
      panel.appendLine(""); // gap between messages
    }
  }

  /** Append a line to current assistant message and panel (if visible). */
  function appendLine(line: string): void {
    currentAssistantMsg?.lines.push(line);
    if (panel.visible) panel.appendLine(line);
  }

  /** Drain rendered markdown lines into message history and panel (if visible). */
  function drainRenderer(): void {
    if (!renderer) return;
    for (const line of renderer.drainLines()) {
      appendLine(line);
    }
  }

  /** Flush the markdown renderer and drain. */
  function flushRenderer(): void {
    if (!renderer) {
      return;
    }
    renderer.flush();
    drainRenderer();
  }

  /** Start a new assistant message in the conversation. */
  function startAssistantMessage(): void {
    flushRenderer();
    currentAssistantMsg = { role: "assistant", lines: [] };
    messages.push(currentAssistantMsg);
    renderer = new MarkdownRenderer(getContentWidth());
  }

  /** Finalize the current assistant message. */
  function finalizeAssistantMessage(): void {
    flushRenderer();
    renderer = null;
    currentAssistantMsg = null;
  }

  // ── Spinner helpers ────────────────────────────────────────

  function startSpinner(label: string): void {
    stopSpinner();
    spinnerStartTime = Date.now();
    spinner = createSpinner({ startTime: spinnerStartTime });
    spinnerInterval = setInterval(() => {
      if (!spinner || !panel.visible) return;
      const line = renderSpinnerLine(spinner, label, { startTime: spinnerStartTime });
      panel.setFooter(line);
    }, 80);
  }

  function stopSpinner(): void {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
    spinner = null;
    panel.setFooter("");
  }

  // ── Panel lifecycle ────────────────────────────────────────
  panel.handlers.advise("panel:submit", (_next, query: string) => {
    const userMsg: ChatMessage = {
      role: "user",
      lines: [`${p.accent}${p.bold}❯${p.reset} ${query}`],
    };
    messages.push(userMsg);

    panel.setActive();
    rebuildContent();

    startAssistantMessage();
    startSpinner("Thinking");

    bus.emit("agent:submit", { query });
  });

  panel.handlers.advise("panel:dismiss", (_next) => {
    stopSpinner();
  });

  panel.handlers.advise("panel:show", (_next) => {
    // Rebuild from message history to restore content that arrived while hidden
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
        // Render code block with language label
        const label = block.language ? `${p.dim}${block.language}${p.reset}` : "";
        if (label) {
          appendLine(label);
        }
        for (const codeLine of block.code.split("\n")) {
          appendLine(`  ${p.dim}${codeLine}${p.reset}`);
        }
      }
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

    for (const line of lines) {
      appendLine(line);
    }

    startSpinner(e.title);
  });

  bus.on("agent:tool-completed", (e) => {
    if (!panel.active) return;
    stopSpinner();

    const elapsed = toolStartTime ? formatElapsed(Date.now() - toolStartTime) : "";
    const timer = elapsed ? ` ${p.dim}${elapsed}${p.reset}` : "";
    const mark = e.exitCode === 0
      ? `${p.success}✓${p.reset}${timer}`
      : `${p.error}✗ exit ${e.exitCode}${p.reset}${timer}`;

    appendLine(`  ${mark}`);

    startSpinner("Thinking");
  });

  bus.on("agent:processing-done", () => {
    if (!panel.active) return;
    stopSpinner();
    finalizeAssistantMessage();
    panel.setDone();
  });
}
