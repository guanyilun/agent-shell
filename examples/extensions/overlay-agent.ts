/**
 * Overlay agent extension.
 *
 * Provides a hotkey (Ctrl+]) to summon the agent from anywhere — even
 * inside vim, htop, or ssh. Renders a full-screen response view,
 * then returns to the previous program on dismiss.
 *
 * Flow:
 *   1. Ctrl+] → input bar at bottom of screen
 *   2. Type query, Enter → clear screen, hold PTY stdout, submit
 *   3. Agent response renders on the clear screen (TUI renderer)
 *   4. On completion → "Ctrl+] to dismiss" prompt
 *   5. Ctrl+] → release stdout, force program redraw (Ctrl+L to PTY)
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/overlay-agent.ts
 *
 *   # Or copy to ~/.agent-sh/extensions/ for permanent use:
 *   cp examples/extensions/overlay-agent.ts ~/.agent-sh/extensions/
 */
import type { ExtensionContext } from "agent-sh/types";

const TRIGGER = "\x1d"; // Ctrl+]

type Phase = "idle" | "input" | "responding" | "done";

export default function activate({ bus }: ExtensionContext): void {
  let phase: Phase = "idle";
  let buffer = "";
  let cursor = 0;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Input bar rendering ───────────────────────────────────

  function renderInputBar(): void {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    process.stdout.write("\x1b7"); // save cursor
    process.stdout.write(`\x1b[${rows};1H`); // move to bottom

    const label = "\x1b[7m agent \x1b[0m ";
    const maxInput = cols - 9;
    const displayBuf = buffer.length > maxInput
      ? buffer.slice(buffer.length - maxInput)
      : buffer;

    process.stdout.write("\x1b[2K" + label + displayBuf);

    const displayCursor = cursor - (buffer.length - displayBuf.length);
    process.stdout.write(`\x1b[${rows};${9 + displayCursor}H`);
  }

  function clearInputBar(): void {
    const rows = process.stdout.rows || 24;
    process.stdout.write(`\x1b[${rows};1H\x1b[2K`);
    process.stdout.write("\x1b8"); // restore cursor
  }

  function showDismissPrompt(): void {
    process.stdout.write(
      `\n\x1b[2m  Press Ctrl+] to return\x1b[0m\n`
    );
  }

  // ── Phase transitions ─────────────────────────────────────

  function activate(): void {
    phase = "input";
    buffer = "";
    cursor = 0;
    renderInputBar();
  }

  function submit(): void {
    const query = buffer.trim();
    if (!query) { dismiss(); return; }

    phase = "responding";
    clearInputBar();

    // Hold PTY stdout so vim doesn't redraw over the response
    bus.emit("shell:stdout-hold", {});

    // Clear screen for response
    process.stdout.write("\x1b[2J\x1b[H");

    bus.emit("agent:submit", { query });
  }

  function dismiss(): void {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }

    const wasResponding = phase === "responding" || phase === "done";
    phase = "idle";
    buffer = "";
    cursor = 0;

    if (wasResponding) {
      // Release PTY stdout
      bus.emit("shell:stdout-release", {});

      // Force the foreground program to redraw (Ctrl+L)
      bus.emit("shell:pty-write", { data: "\x0c" });
    } else {
      clearInputBar();
    }
  }

  // ── Input handling ────────────────────────────────────────

  function handleKey(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      const code = ch.charCodeAt(0);

      // Escape (bare) → cancel
      if (ch === "\x1b" && data[i + 1] == null) { dismiss(); return; }
      // Ctrl+] → cancel
      if (ch === TRIGGER) { dismiss(); return; }
      // Ctrl+C → cancel
      if (code === 0x03) { dismiss(); return; }

      // Escape sequence → arrows
      if (ch === "\x1b") {
        i++;
        const next = data[i];
        if (next === "[" || next === "O") {
          i++;
          while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) < 0x40) i++;
          const final = data[i]; i++;
          if (final === "C" && cursor < buffer.length) { cursor++; renderInputBar(); }
          if (final === "D" && cursor > 0) { cursor--; renderInputBar(); }
          if (final === "H") { cursor = 0; renderInputBar(); }
          if (final === "F") { cursor = buffer.length; renderInputBar(); }
        } else { i++; }
        continue;
      }

      // Enter → submit
      if (ch === "\r") { submit(); return; }

      // Backspace
      if (ch === "\x7f" || ch === "\b") {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
          renderInputBar();
        }
        i++; continue;
      }

      // Readline shortcuts
      if (code === 0x01) { cursor = 0; renderInputBar(); i++; continue; }
      if (code === 0x05) { cursor = buffer.length; renderInputBar(); i++; continue; }
      if (code === 0x15) { buffer = ""; cursor = 0; renderInputBar(); i++; continue; }
      if (code === 0x0b) { buffer = buffer.slice(0, cursor); renderInputBar(); i++; continue; }

      // Other control → ignore
      if (code < 0x20) { i++; continue; }

      // Printable
      buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
      cursor++;
      renderInputBar();
      i++;
    }
  }

  // ── Bus wiring ────────────────────────────────────────────

  // Re-render input bar after PTY output (vim redraws over it)
  bus.on("shell:pty-data", () => {
    if (phase !== "input") return;
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (phase === "input") renderInputBar();
    }, 16);
  });

  // When agent finishes, show dismiss prompt
  bus.on("agent:processing-done", () => {
    if (phase === "responding") {
      phase = "done";
      showDismissPrompt();
    }
  });

  // Intercept input: activate on trigger, capture while active
  bus.onPipe("input:intercept", (payload) => {
    // During "done" phase, any Ctrl+] or Escape dismisses
    if (phase === "done") {
      if (payload.data === TRIGGER || payload.data === "\x1b" || payload.data === "\x03") {
        dismiss();
      }
      return { ...payload, consumed: true };
    }

    // During input phase, handle editing
    if (phase === "input") {
      handleKey(payload.data);
      return { ...payload, consumed: true };
    }

    // During responding phase, only allow Ctrl+C to cancel
    if (phase === "responding") {
      if (payload.data === "\x03") {
        bus.emit("agent:cancel-request", {});
      }
      return { ...payload, consumed: true };
    }

    // Idle: check for trigger
    if (payload.data === TRIGGER) {
      activate();
      return { ...payload, consumed: true };
    }

    return payload;
  });
}
