/**
 * Overlay agent extension.
 *
 * Provides a hotkey (Ctrl+]) to summon the agent from anywhere — even
 * inside vim, htop, or ssh. Composites a floating response box on top
 * of the current terminal content using a headless xterm.js buffer.
 *
 * Requires: npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/overlay-agent.ts
 *
 *   # Or copy to ~/.agent-sh/extensions/ for permanent use:
 *   cp examples/extensions/overlay-agent.ts ~/.agent-sh/extensions/
 */
import { createRequire } from "module";
import type { ExtensionContext } from "agent-sh/types";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

const TRIGGER = "\x1d"; // Ctrl+]
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const INVERSE = "\x1b[7m";

// Synchronized output (prevents flicker)
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

type Phase = "idle" | "input" | "responding" | "done";

/** Strip all ANSI escape sequences. */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[^m]*m/g, "")
    .replace(/\x1b\[\?[^a-zA-Z]*[a-zA-Z]/g, "")
    .replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "")
    .replace(/\r/g, "");
}

export default function activate({ bus, advise }: ExtensionContext): void {
  // ── Headless terminal (shared with terminal-buffer context) ──
  const term = new Terminal({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    allowProposedApi: true,
    scrollback: 200,
  });
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);

  bus.on("shell:pty-data", ({ raw }) => { term.write(raw); });

  // Also inject clean buffer into agent context (like terminal-buffer.ts)
  advise("context:build-extra", (next: () => string) => {
    const base = next();
    const raw = serialize.serialize().trim();
    if (!raw) return base;
    const clean = stripAnsi(raw).trim();
    if (!clean) return base;
    const lines = clean.split("\n");
    const capped = lines.length > 80 ? lines.slice(-80).join("\n") : clean;
    const isAlt = term.buffer.active.type === "alternate";
    const header = isAlt ? "<terminal_buffer mode=\"alternate\">" : "<terminal_buffer>";
    const section = `${header}\n${capped}\n</terminal_buffer>`;
    return base ? base + "\n" + section : section;
  });

  // ── Overlay state ─────────────────────────────────────────
  let phase: Phase = "idle";
  let inputBuffer = "";
  let inputCursor = 0;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let responseLines: string[] = [];
  let currentResponseLine = "";
  let scrollOffset = 0;

  // ── Screen snapshot & compositing ─────────────────────────

  function getScreenLines(): string[] {
    const raw = serialize.serialize();
    const lines = stripAnsi(raw).split("\n");
    const rows = process.stdout.rows || 24;
    // Pad or trim to exactly terminal height
    while (lines.length < rows) lines.push("");
    return lines.slice(0, rows);
  }

  function compositeAndRender(): void {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const bgLines = getScreenLines();

    // Box dimensions
    const boxW = Math.min(cols - 4, 100);
    const boxH = Math.min(rows - 4, Math.max(8, Math.floor(rows * 0.6)));
    const boxTop = Math.floor((rows - boxH) / 2);
    const boxLeft = Math.floor((cols - boxW) / 2);

    // Box content: response lines with scroll
    const contentH = boxH - 2; // minus top/bottom border
    const totalContent = responseLines.length;
    // Auto-scroll to bottom
    if (totalContent > contentH) {
      scrollOffset = totalContent - contentH;
    }
    const visibleContent = responseLines.slice(scrollOffset, scrollOffset + contentH);

    // Build the composited frame — use absolute cursor positioning per row
    const out: string[] = [SYNC_START];

    for (let row = 0; row < rows; row++) {
      out.push(`\x1b[${row + 1};1H`); // move to row (1-indexed)
      const bgLine = (bgLines[row] || "").padEnd(cols).slice(0, cols);
      const relRow = row - boxTop;

      if (relRow < 0 || relRow >= boxH) {
        // Background row — render dimmed
        out.push(`${DIM}${bgLine}${RESET}\x1b[K`);
      } else if (relRow === 0) {
        // Top border
        const title = phase === "input" ? " agent " : phase === "done" ? " done " : " ... ";
        const titleStr = `${INVERSE}${title}${RESET}`;
        const borderAfter = boxW - title.length - 1;
        const border = "─" + "─".repeat(title.length > 0 ? 0 : boxW - 2) + "─";
        // Compose: dim bg left, box border, dim bg right
        const left = `${DIM}${bgLine.slice(0, boxLeft)}${RESET}`;
        const boxBorder = `╭${"─".repeat(boxW - 2)}╮`;
        // Overlay title in the border
        const titleInBorder = `╭─${titleStr}${"─".repeat(Math.max(0, boxW - title.length - 3))}╮`;
        const right = `${DIM}${bgLine.slice(boxLeft + boxW)}${RESET}`;
        out.push(left + titleInBorder + right);
      } else if (relRow === boxH - 1) {
        // Bottom border
        const left = `${DIM}${bgLine.slice(0, boxLeft)}${RESET}`;
        let footer = "";
        if (phase === "done") {
          footer = ` Ctrl+] to return `;
        } else if (phase === "responding") {
          footer = ` streaming... `;
        } else if (phase === "input") {
          footer = ` Enter to send, Esc to cancel `;
        }
        const footerPad = Math.max(0, boxW - footer.length - 3);
        const boxBorder = `╰${"─".repeat(footerPad)}${DIM}${footer}${RESET}${"─"}╯`;
        const right = `${DIM}${bgLine.slice(boxLeft + boxW)}${RESET}`;
        out.push(left + boxBorder + right);
      } else {
        // Content row
        const contentIdx = relRow - 1;
        let content = "";
        if (phase === "input") {
          if (contentIdx === 0) {
            content = `${CYAN}❯${RESET} ${inputBuffer}`;
          }
        } else {
          content = visibleContent[contentIdx] || "";
        }
        // Truncate content to box width
        const plainContent = stripAnsi(content);
        const contentW = boxW - 4; // 2 border + 2 padding
        const displayContent = plainContent.length > contentW
          ? content.slice(0, contentW - 1) + "…"
          : content;
        const pad = Math.max(0, contentW - stripAnsi(displayContent).length);

        const left = `${DIM}${bgLine.slice(0, boxLeft)}${RESET}`;
        const boxLine = `│ ${displayContent}${" ".repeat(pad)} │`;
        const right = `${DIM}${bgLine.slice(boxLeft + boxW)}${RESET}`;
        out.push(left + boxLine + right);
      }
    }

    // Position cursor for input
    if (phase === "input") {
      const cursorRow = boxTop + 1;
      const cursorCol = boxLeft + 4 + inputCursor; // "│ ❯ " = 4 chars
      out.push(`\x1b[${cursorRow + 1};${cursorCol + 1}H`);
    }

    out.push(SYNC_END);

    // Write using absolute cursor positioning per row — no \n to avoid scrollback pollution
    process.stdout.write(out.join(""));
  }

  function restoreScreen(): void {
    // Leave alternate screen buffer — terminal automatically restores
    // the original screen content (vim, shell, whatever was running)
    process.stdout.write("\x1b[?1049l");
  }

  // ── Phase transitions ─────────────────────────────────────

  function activateOverlay(): void {
    phase = "input";
    inputBuffer = "";
    inputCursor = 0;
    responseLines = [];
    currentResponseLine = "";
    scrollOffset = 0;

    // Hold stdout — suppresses PTY and TUI
    bus.emit("shell:stdout-hold", {});

    // Switch to alternate screen buffer — nothing we draw here
    // affects the main terminal or scrollback. On dismiss, the
    // terminal automatically restores the original screen.
    process.stdout.write("\x1b[?1049h");

    compositeAndRender();
  }

  function submit(): void {
    const query = inputBuffer.trim();
    if (!query) { dismiss(); return; }

    phase = "responding";
    responseLines = [`${CYAN}${BOLD}❯${RESET} ${query}`, ""];
    currentResponseLine = "";
    scrollOffset = 0;

    compositeAndRender();
    bus.emit("agent:submit", { query });
  }

  function dismiss(): void {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    phase = "idle";
    inputBuffer = "";
    inputCursor = 0;

    // Leave alternate screen — terminal restores the original screen
    restoreScreen();
    bus.emit("shell:stdout-release", {});
  }

  // ── Input handling ────────────────────────────────────────

  function handleKey(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      const code = ch.charCodeAt(0);

      if (ch === "\x1b" && data[i + 1] == null) { dismiss(); return; }
      if (ch === TRIGGER) { dismiss(); return; }
      if (code === 0x03) { dismiss(); return; }

      if (ch === "\x1b") {
        i++;
        const next = data[i];
        if (next === "[" || next === "O") {
          i++;
          while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) < 0x40) i++;
          const final = data[i]; i++;
          if (final === "C" && inputCursor < inputBuffer.length) { inputCursor++; compositeAndRender(); }
          if (final === "D" && inputCursor > 0) { inputCursor--; compositeAndRender(); }
        } else { i++; }
        continue;
      }

      if (ch === "\r") { submit(); return; }

      if (ch === "\x7f" || ch === "\b") {
        if (inputCursor > 0) {
          inputBuffer = inputBuffer.slice(0, inputCursor - 1) + inputBuffer.slice(inputCursor);
          inputCursor--;
          compositeAndRender();
        }
        i++; continue;
      }

      if (code === 0x01) { inputCursor = 0; compositeAndRender(); i++; continue; }
      if (code === 0x05) { inputCursor = inputBuffer.length; compositeAndRender(); i++; continue; }
      if (code === 0x15) { inputBuffer = ""; inputCursor = 0; compositeAndRender(); i++; continue; }
      if (code < 0x20) { i++; continue; }

      inputBuffer = inputBuffer.slice(0, inputCursor) + ch + inputBuffer.slice(inputCursor);
      inputCursor++;
      compositeAndRender();
      i++;
    }
  }

  // ── Bus wiring ────────────────────────────────────────────

  bus.on("agent:response-chunk", (e) => {
    if (phase !== "responding") return;
    for (const block of e.blocks) {
      if (block.type === "text" && block.text) {
        for (const ch of block.text) {
          if (ch === "\n") {
            responseLines.push(currentResponseLine);
            currentResponseLine = "";
          } else {
            currentResponseLine += ch;
          }
        }
      }
    }
    // Debounce re-render for streaming
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      // Include current partial line for display
      const displayLines = [...responseLines, currentResponseLine];
      const savedLines = responseLines;
      responseLines = displayLines;
      compositeAndRender();
      responseLines = savedLines;
    }, 32);
  });

  bus.on("agent:tool-started", (e) => {
    if (phase !== "responding") return;
    if (currentResponseLine) { responseLines.push(currentResponseLine); currentResponseLine = ""; }
    responseLines.push(`▶ ${e.title}${e.displayDetail ? " " + e.displayDetail : ""}`);
    compositeAndRender();
  });

  bus.on("agent:tool-completed", (e) => {
    if (phase !== "responding") return;
    const mark = e.exitCode === 0 ? " ✓" : ` ✗ exit ${e.exitCode}`;
    if (responseLines.length > 0) {
      responseLines[responseLines.length - 1] += mark;
    }
    compositeAndRender();
  });

  bus.on("agent:processing-done", () => {
    if (phase === "responding") {
      if (currentResponseLine) { responseLines.push(currentResponseLine); currentResponseLine = ""; }
      phase = "done";
      compositeAndRender();
    }
  });

  bus.onPipe("input:intercept", (payload) => {
    if (phase === "done") {
      if (payload.data === TRIGGER || payload.data === "\x1b" || payload.data === "\x03") {
        dismiss();
      }
      return { ...payload, consumed: true };
    }
    if (phase === "input") {
      handleKey(payload.data);
      return { ...payload, consumed: true };
    }
    if (phase === "responding") {
      if (payload.data === "\x03") bus.emit("agent:cancel-request", {});
      return { ...payload, consumed: true };
    }
    if (payload.data === TRIGGER) {
      activateOverlay();
      return { ...payload, consumed: true };
    }
    return payload;
  });
}
