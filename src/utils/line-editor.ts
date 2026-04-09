/**
 * Minimal line editor with readline-style keybindings.
 *
 * Pure logic — no I/O, no rendering, no event bus. Consumers feed raw
 * terminal input bytes and receive high-level actions back. Buffer and
 * cursor state are public for rendering.
 */

// ── Action types returned by feed() ─────────────────────────────

export type LineEditAction =
  | { action: "changed" }
  | { action: "submit"; buffer: string }
  | { action: "cancel" }
  | { action: "delete-empty" }
  | { action: "tab" }
  | { action: "arrow-up" }
  | { action: "arrow-down" };

// ── Line editor ─────────────────────────────────────────────────

export class LineEditor {
  buffer = "";
  cursor = 0;

  /** Process raw terminal input, return actions for the consumer. */
  feed(data: string): LineEditAction[] {
    const actions: LineEditAction[] = [];
    let i = 0;

    while (i < data.length) {
      const ch = data[i]!;

      // ── Escape sequences ────────────────────────────────
      if (ch === "\x1b") {
        const next = data[i + 1];

        // Bare Escape (nothing follows in this chunk)
        if (next == null) {
          actions.push({ action: "cancel" });
          i++;
          continue;
        }

        // CSI sequence: \x1b[...
        if (next === "[") {
          const { consumed } = this.handleCSI(data, i, actions);
          i += consumed;
          continue;
        }

        // Alt/Option + key: \x1b followed by char
        i += 2; // consume \x1b + next byte
        if (next === "\x7f") {
          // Option+Backspace: delete word backward
          if (this.deleteWordBackward()) actions.push({ action: "changed" });
        } else if (next === "b") {
          // Alt+B: word backward
          if (this.wordBackward()) actions.push({ action: "changed" });
        } else if (next === "f") {
          // Alt+F: word forward
          if (this.wordForward()) actions.push({ action: "changed" });
        } else if (next === "d") {
          // Alt+D: delete word forward
          if (this.deleteWordForward()) actions.push({ action: "changed" });
        }
        // Other Alt+key — ignore
        continue;
      }

      // ── Control characters ──────────────────────────────
      if (ch === "\r") {
        actions.push({ action: "submit", buffer: this.buffer });
        i++;
        continue;
      }
      if (ch === "\x03") {
        actions.push({ action: "cancel" });
        i++;
        continue;
      }
      if (ch === "\t") {
        actions.push({ action: "tab" });
        i++;
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        // Backspace
        if (this.buffer.length === 0) {
          actions.push({ action: "delete-empty" });
        } else if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor--;
          actions.push({ action: "changed" });
        }
        i++;
        continue;
      }
      // Ctrl-A: home
      if (ch === "\x01") {
        if (this.cursor > 0) { this.cursor = 0; actions.push({ action: "changed" }); }
        i++; continue;
      }
      // Ctrl-E: end
      if (ch === "\x05") {
        if (this.cursor < this.buffer.length) { this.cursor = this.buffer.length; actions.push({ action: "changed" }); }
        i++; continue;
      }
      // Ctrl-B: back one char
      if (ch === "\x02") {
        if (this.cursor > 0) { this.cursor--; actions.push({ action: "changed" }); }
        i++; continue;
      }
      // Ctrl-F: forward one char
      if (ch === "\x06") {
        if (this.cursor < this.buffer.length) { this.cursor++; actions.push({ action: "changed" }); }
        i++; continue;
      }
      // Ctrl-U: delete to start of line
      if (ch === "\x15") {
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(this.cursor);
          this.cursor = 0;
          actions.push({ action: "changed" });
        }
        i++; continue;
      }
      // Ctrl-K: delete to end of line
      if (ch === "\x0b") {
        if (this.cursor < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.cursor);
          actions.push({ action: "changed" });
        }
        i++; continue;
      }
      // Ctrl-W: delete word backward
      if (ch === "\x17") {
        if (this.deleteWordBackward()) actions.push({ action: "changed" });
        i++; continue;
      }
      // Other control chars — ignore
      if (ch.charCodeAt(0) < 0x20) {
        i++; continue;
      }

      // ── Printable character ─────────────────────────────
      this.buffer = this.buffer.slice(0, this.cursor) + ch + this.buffer.slice(this.cursor);
      this.cursor++;
      actions.push({ action: "changed" });
      i++;
    }

    return actions;
  }

  clear(): void {
    this.buffer = "";
    this.cursor = 0;
  }

  // ── CSI sequence handling ───────────────────────────────────

  /**
   * Parse and handle a CSI sequence (\x1b[...) starting at `start`.
   * Returns the number of bytes consumed.
   */
  private handleCSI(
    data: string,
    start: number,
    actions: LineEditAction[],
  ): { consumed: number } {
    // Skip \x1b[
    let j = start + 2;
    // Accumulate parameter bytes (0x20-0x3F: digits, semicolons, etc.)
    let params = "";
    while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) < 0x40) {
      params += data[j];
      j++;
    }
    const final = j < data.length ? data[j]! : "";
    const consumed = j - start + (final ? 1 : 0);

    // Dispatch on final byte
    switch (final) {
      case "A": // Up arrow
        actions.push({ action: "arrow-up" });
        break;
      case "B": // Down arrow
        actions.push({ action: "arrow-down" });
        break;
      case "C": // Right (or modified right: 1;3C, 1;5C = word right)
        if (params.includes(";")) {
          if (this.wordForward()) actions.push({ action: "changed" });
        } else {
          if (this.cursor < this.buffer.length) { this.cursor++; actions.push({ action: "changed" }); }
        }
        break;
      case "D": // Left (or modified left: 1;3D, 1;5D = word left)
        if (params.includes(";")) {
          if (this.wordBackward()) actions.push({ action: "changed" });
        } else {
          if (this.cursor > 0) { this.cursor--; actions.push({ action: "changed" }); }
        }
        break;
      case "H": // Home
        if (this.cursor > 0) { this.cursor = 0; actions.push({ action: "changed" }); }
        break;
      case "F": // End
        if (this.cursor < this.buffer.length) { this.cursor = this.buffer.length; actions.push({ action: "changed" }); }
        break;
      case "~": // Extended keys: Delete (3~), etc.
        if (params === "3") {
          // Delete key: delete char under cursor
          if (this.cursor < this.buffer.length) {
            this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
            actions.push({ action: "changed" });
          }
        }
        break;
      // All other CSI sequences — silently ignored
    }

    return { consumed };
  }

  // ── Word movement / deletion helpers ────────────────────────

  private wordBackward(): boolean {
    if (this.cursor === 0) return false;
    let pos = this.cursor;
    // Skip spaces
    while (pos > 0 && this.buffer[pos - 1] === " ") pos--;
    // Skip word chars
    while (pos > 0 && this.buffer[pos - 1] !== " ") pos--;
    if (pos === this.cursor) return false;
    this.cursor = pos;
    return true;
  }

  private wordForward(): boolean {
    if (this.cursor >= this.buffer.length) return false;
    let pos = this.cursor;
    // Skip word chars
    while (pos < this.buffer.length && this.buffer[pos] !== " ") pos++;
    // Skip spaces
    while (pos < this.buffer.length && this.buffer[pos] === " ") pos++;
    if (pos === this.cursor) return false;
    this.cursor = pos;
    return true;
  }

  private deleteWordBackward(): boolean {
    if (this.cursor === 0) return false;
    const start = this.cursor;
    this.wordBackward();
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(start);
    return true;
  }

  private deleteWordForward(): boolean {
    if (this.cursor >= this.buffer.length) return false;
    const start = this.cursor;
    this.wordForward();
    this.buffer = this.buffer.slice(0, start) + this.buffer.slice(this.cursor);
    this.cursor = start;
    return true;
  }
}
