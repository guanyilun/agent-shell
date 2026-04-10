/**
 * Minimal line editor with readline-style keybindings.
 *
 * Pure logic — no I/O, no rendering, no event bus. Consumers feed raw
 * terminal input bytes and receive high-level actions back. Buffer and
 * cursor state are public for rendering.
 */

// ── Kitty protocol keycode → readable name ──────────────────────

const KITTY_KEY_NAMES: Record<number, string> = {
  9: "tab", 13: "enter", 27: "escape", 127: "backspace",
};

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
  private pendingSeq = ""; // buffered incomplete escape sequence

  /** Process raw terminal input, return actions for the consumer. */
  feed(data: string): LineEditAction[] {
    // If we had a pending incomplete escape sequence, prepend it
    if (this.pendingSeq) {
      data = this.pendingSeq + data;
      this.pendingSeq = "";
    }

    const actions: LineEditAction[] = [];
    let i = 0;

    while (i < data.length) {
      const ch = data[i]!;

      // ── Escape sequences ────────────────────────────────
      if (ch === "\x1b") {
        const next = data[i + 1];

        // Incomplete escape — buffer and wait for next feed()
        if (next == null) {
          this.pendingSeq = "\x1b";
          i++;
          continue;
        }

        // CSI sequence: \x1b[...
        if (next === "[") {
          const { consumed, incomplete } = this.handleCSI(data, i, actions);
          if (incomplete) {
            this.pendingSeq = data.slice(i, i + consumed);
            i += consumed;
          } else {
            i += consumed;
          }
          continue;
        }

        // SS3 sequence: \x1bO... (application cursor mode — arrow keys, Home, End)
        if (next === "O") {
          const ss3Final = data[i + 2];
          if (ss3Final == null) {
            // Incomplete — buffer for next feed()
            this.pendingSeq = data.slice(i, i + 2);
            i += 2;
            continue;
          }
          i += 3; // consume \x1b O <final>
          switch (ss3Final) {
            case "A": actions.push({ action: "arrow-up" }); break;
            case "B": actions.push({ action: "arrow-down" }); break;
            case "C":
              if (this.cursor < this.buffer.length) { this.cursor++; actions.push({ action: "changed" }); }
              break;
            case "D":
              if (this.cursor > 0) { this.cursor--; actions.push({ action: "changed" }); }
              break;
            case "H": // Home
              if (this.cursor > 0) { this.cursor = 0; actions.push({ action: "changed" }); }
              break;
            case "F": // End
              if (this.cursor < this.buffer.length) { this.cursor = this.buffer.length; actions.push({ action: "changed" }); }
              break;
          }
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
      if (ch.charCodeAt(0) < 0x20 || ch === "\x7f") {
        const action = this.handleControl(ch);
        if (action) actions.push(action);
        i++;
        continue;
      }

      // ── Printable character ─────────────────────────────
      this.buffer = this.buffer.slice(0, this.cursor) + ch + this.buffer.slice(this.cursor);
      this.cursor++;
      actions.push({ action: "changed" });
      i++;
    }

    return actions;
  }

  /** Check if there's a pending incomplete escape sequence. */
  hasPendingEscape(): boolean {
    return this.pendingSeq.length > 0;
  }

  /** Flush a pending sequence — treat bare \x1b as cancel, discard incomplete CSI. */
  flushPendingEscape(): LineEditAction[] {
    if (!this.pendingSeq) return [];
    const wasBarEscape = this.pendingSeq === "\x1b";
    this.pendingSeq = "";
    return wasBarEscape ? [{ action: "cancel" }] : [];
  }

  clear(): void {
    this.buffer = "";
    this.cursor = 0;
    this.pendingSeq = "";
  }

  // ── Key bindings ────────────────────────────────────────────
  //
  // Single source of truth for all keybindings. Both legacy control
  // characters and kitty protocol sequences resolve to a key name
  // and look it up here. To add a binding, add one entry.

  private readonly bindings: Record<string, () => LineEditAction | null> = {
    "enter":         () => ({ action: "submit", buffer: this.buffer }),
    "ctrl+c":        () => ({ action: "cancel" }),
    "tab":           () => ({ action: "tab" }),
    "backspace":     () => this.deleteBackward(),
    "ctrl+d":        () => this.buffer.length === 0 ? { action: "delete-empty" } : this.deleteForward(),
    "ctrl+a":        () => this.moveTo(0),
    "ctrl+e":        () => this.moveTo(this.buffer.length),
    "ctrl+b":        () => this.moveTo(this.cursor - 1),
    "ctrl+f":        () => this.moveTo(this.cursor + 1),
    "ctrl+u":        () => this.deleteRange(0, this.cursor),
    "ctrl+k":        () => this.deleteRange(this.cursor, this.buffer.length),
    "ctrl+w":        () => this.deleteWordBackward() ? { action: "changed" } : null,
    "shift+enter":   () => this.insertAt("\n"),
  };

  /** Resolve a key name from the bindings table and execute it. */
  private dispatch(key: string): LineEditAction | null {
    return this.bindings[key]?.() ?? null;
  }

  // ── Legacy control character mapping ───────────────────────

  /** Map a legacy control character to a key name. */
  private static readonly CTRL_MAP: Record<string, string> = {
    "\r": "enter", "\x03": "ctrl+c", "\t": "tab",
    "\x7f": "backspace", "\b": "backspace",
    "\x01": "ctrl+a", "\x02": "ctrl+b", "\x04": "ctrl+d",
    "\x05": "ctrl+e", "\x06": "ctrl+f", "\x0b": "ctrl+k",
    "\x15": "ctrl+u", "\x17": "ctrl+w",
  };

  private handleControl(ch: string): LineEditAction | null {
    const key = LineEditor.CTRL_MAP[ch];
    return key ? this.dispatch(key) : null;
  }

  // ── Kitty keyboard protocol ────────────────────────────────

  /** Handle a kitty protocol CSI u sequence. Params format: "keycode;modifier". */
  private handleKittyKey(params: string): LineEditAction | null {
    const [kc, mod] = params.split(";").map(Number);
    const keycode = kc!;
    const mods = (mod ?? 1) - 1; // kitty modifier bits

    // Build key name from modifier + keycode
    const modNames: string[] = [];
    if (mods & 4) modNames.push("ctrl");
    if (mods & 1) modNames.push("shift");
    if (mods & 2) modNames.push("alt");

    const keyName = KITTY_KEY_NAMES[keycode] ?? String.fromCharCode(keycode);
    const fullName = [...modNames, keyName].join("+");

    // Try exact binding first, then fall back to ctrl char mapping
    return this.dispatch(fullName)
      ?? ((mods & 4) && keycode >= 97 && keycode <= 122
          ? this.dispatch(`ctrl+${String.fromCharCode(keycode)}`)
          : null)
      ?? (mods === 0 ? this.handleControl(String.fromCharCode(keycode)) : null);
  }

  // ── Editing primitives ─────────────────────────────────────

  private insertAt(ch: string): LineEditAction {
    this.buffer = this.buffer.slice(0, this.cursor) + ch + this.buffer.slice(this.cursor);
    this.cursor++;
    return { action: "changed" };
  }

  private moveTo(pos: number): LineEditAction | null {
    const clamped = Math.max(0, Math.min(pos, this.buffer.length));
    if (clamped === this.cursor) return null;
    this.cursor = clamped;
    return { action: "changed" };
  }

  private deleteBackward(): LineEditAction | null {
    if (this.buffer.length === 0) return { action: "delete-empty" };
    if (this.cursor <= 0) return null;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor--;
    return { action: "changed" };
  }

  private deleteForward(): LineEditAction | null {
    if (this.cursor >= this.buffer.length) return null;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
    return { action: "changed" };
  }

  private deleteRange(start: number, end: number): LineEditAction | null {
    if (start >= end) return null;
    this.buffer = this.buffer.slice(0, start) + this.buffer.slice(end);
    this.cursor = start;
    return { action: "changed" };
  }

  // ── CSI sequence handling ───────────────────────────────────

  /**
   * Parse and handle a CSI sequence (\x1b[...) starting at `start`.
   * Returns the number of bytes consumed and whether the sequence was incomplete.
   */
  private handleCSI(
    data: string,
    start: number,
    actions: LineEditAction[],
  ): { consumed: number; incomplete?: boolean } {
    // Skip \x1b[
    let j = start + 2;
    // Accumulate parameter bytes (0x20-0x3F: digits, semicolons, etc.)
    let params = "";
    while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) < 0x40) {
      params += data[j];
      j++;
    }
    // If we ran out of data before the final byte, sequence is incomplete
    if (j >= data.length) {
      return { consumed: j - start, incomplete: true };
    }
    const final = data[j]!;
    const consumed = j - start + 1;

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
      case "u": { // Kitty keyboard protocol: \x1b[<keycode>;<modifier>u
        const action = this.handleKittyKey(params);
        if (action) actions.push(action);
        break;
      }
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
