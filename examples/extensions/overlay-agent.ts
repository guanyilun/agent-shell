/**
 * Overlay agent extension.
 *
 * Provides a hotkey (Ctrl+]) to summon the agent from anywhere — even
 * inside vim, htop, or ssh. Renders a minimal input bar at the bottom
 * of the terminal, captures keystrokes via `input:intercept`, and
 * dispatches the query via the bus.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/overlay-agent.ts
 *
 *   # Or copy to ~/.agent-sh/extensions/ for permanent use:
 *   cp examples/extensions/overlay-agent.ts ~/.agent-sh/extensions/
 */
import type { ExtensionContext } from "agent-sh/types";

const TRIGGER = "\x1d"; // Ctrl+]

export default function activate({ bus }: ExtensionContext): void {
  let active = false;
  let buffer = "";
  let cursor = 0;

  // ── Rendering ─────────────────────────────────────────────

  function render(): void {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    // Save cursor, move to bottom row
    process.stdout.write("\x1b7");
    process.stdout.write(`\x1b[${rows};1H`);

    // Clear the line and draw the input bar
    const label = "\x1b[7m agent \x1b[0m ";
    const maxInput = cols - 9; // " agent " + space + padding
    const displayBuf = buffer.length > maxInput
      ? buffer.slice(buffer.length - maxInput)
      : buffer;

    process.stdout.write("\x1b[2K"); // clear line
    process.stdout.write(label + displayBuf);

    // Position cursor within the input
    const displayCursor = cursor - (buffer.length - displayBuf.length);
    const col = 9 + displayCursor; // after " agent  "
    process.stdout.write(`\x1b[${rows};${col}H`);
  }

  function dismiss(): void {
    const rows = process.stdout.rows || 24;

    // Clear the bottom line, restore cursor
    process.stdout.write(`\x1b[${rows};1H\x1b[2K`);
    process.stdout.write("\x1b8");

    active = false;
    buffer = "";
    cursor = 0;
  }

  // ── Input handling ────────────────────────────────────────

  function handleKey(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      const code = ch.charCodeAt(0);

      // Escape → cancel (bare escape, not part of a sequence)
      if (ch === "\x1b" && data[i + 1] == null) {
        dismiss();
        return;
      }

      // Ctrl+G again → cancel
      if (ch === TRIGGER) {
        dismiss();
        return;
      }

      // Escape sequence → handle arrows, skip the rest
      if (ch === "\x1b") {
        i++; // skip \x1b
        const next = data[i];
        if (next === "[") {
          i++; // skip [
          // Read params
          while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) < 0x40) i++;
          const final = data[i];
          i++; // skip final byte
          if (final === "C" && cursor < buffer.length) { cursor++; render(); }
          if (final === "D" && cursor > 0) { cursor--; render(); }
          if (final === "H") { cursor = 0; render(); }
          if (final === "F") { cursor = buffer.length; render(); }
        } else if (next === "O") {
          i++; // skip O
          const final = data[i];
          i++;
          if (final === "C" && cursor < buffer.length) { cursor++; render(); }
          if (final === "D" && cursor > 0) { cursor--; render(); }
          if (final === "H") { cursor = 0; render(); }
          if (final === "F") { cursor = buffer.length; render(); }
        } else {
          i++; // skip alt+key
        }
        continue;
      }

      // Enter → submit
      if (ch === "\r") {
        const query = buffer.trim();
        dismiss();
        if (query) {
          bus.emit("agent:submit", { query });
        }
        return;
      }

      // Ctrl+C → cancel
      if (code === 0x03) {
        dismiss();
        return;
      }

      // Backspace
      if (ch === "\x7f" || ch === "\b") {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
          render();
        }
        i++;
        continue;
      }

      // Ctrl+A → beginning
      if (code === 0x01) { cursor = 0; render(); i++; continue; }
      // Ctrl+E → end
      if (code === 0x05) { cursor = buffer.length; render(); i++; continue; }
      // Ctrl+U → clear line
      if (code === 0x15) { buffer = ""; cursor = 0; render(); i++; continue; }
      // Ctrl+K → kill to end
      if (code === 0x0b) { buffer = buffer.slice(0, cursor); render(); i++; continue; }

      // Other control chars → ignore
      if (code < 0x20) { i++; continue; }

      // Printable character
      buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
      cursor++;
      render();
      i++;
    }
  }

  // ── Bus wiring ────────────────────────────────────────────

  // Single intercept point: activates on Ctrl+G, captures while active.
  // This runs before input-handler's own logic, so Ctrl+G never reaches
  // the PTY (no bell in vim) and typed characters don't leak through.
  bus.onPipe("input:intercept", (payload) => {
    if (active) {
      handleKey(payload.data);
      return { ...payload, consumed: true };
    }

    // Check if the input contains the trigger to activate
    if (payload.data === TRIGGER) {
      active = true;
      buffer = "";
      cursor = 0;
      render();
      return { ...payload, consumed: true };
    }

    return payload;
  });
}
