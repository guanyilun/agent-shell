/**
 * Minimal line editor with readline-style keybindings.
 *
 * Pure logic — no I/O, no rendering, no event bus. Consumers feed raw
 * terminal input bytes and receive high-level actions back.
 *
 * The internal buffer may contain PUA placeholder characters for pasted
 * multi-line content. Consumers should use the typed accessors:
 *   - `text`          — resolved content (pastes expanded), for submit/history/logic
 *   - `displayText`   — display content (pastes collapsed to labels), for rendering
 *   - `displayCursor` — cursor column in display coordinates
 *   - `setText()`     — replace buffer content (clears paste attachments)
 */

import { charWidth } from "./ansi.js";

// ── Kitty protocol keycode → readable name ──────────────────────

const KITTY_KEY_NAMES: Record<number, string> = {
  9: "tab", 13: "enter", 27: "escape", 127: "backspace",
};

// ── Paste placeholder ───────────────────────────────────────────

/** First Unicode Private Use Area codepoint, used as paste placeholder. */
const PUA_BASE = 0xE000;

function isPUA(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= PUA_BASE && code <= 0xF8FF;
}

// ── Action types returned by feed() ─────────────────────────────

export type LineEditAction =
  | { action: "changed" }
  | { action: "submit"; buffer: string }
  | { action: "cancel" }
  | { action: "delete-empty" }
  | { action: "tab" }
  | { action: "shift+tab" }
  | { action: "arrow-up" }
  | { action: "arrow-down" };

// ── Line editor ─────────────────────────────────────────────────

export class LineEditor {
  private _buf = "";
  cursor = 0;
  private pendingSeq = ""; // buffered incomplete escape sequence

  // ── Bracket paste state ─────────────────────────────────────
  private inPaste = false;
  private pasteAccum = "";                      // accumulates during bracket paste
  private pastes = new Map<number, string>();   // id → pasted content
  private pasteCounter = 0;

  // ── History ──────────────────────────────────────────────────
  private history: string[] = [];
  private historyIndex = -1;  // -1 = current input, 0..N = history entries (newest first)
  private savedBuffer = "";   // saves current input when browsing history

  // ── Public accessors ────────────────────────────────────────

  /** Resolved text — paste placeholders expanded. For submit, history, logic. */
  get text(): string {
    let result = "";
    for (const ch of this._buf) {
      const paste = this.pastes.get(ch.charCodeAt(0) - PUA_BASE);
      result += paste ?? ch;
    }
    return result;
  }

  /** Display text — paste placeholders replaced with labels. For rendering. */
  get displayText(): string {
    let result = "";
    for (const ch of this._buf) {
      const paste = this.pastes.get(ch.charCodeAt(0) - PUA_BASE);
      if (paste) {
        const n = paste.split("\n").length;
        result += `[paste +${n} lines]`;
      } else {
        result += ch;
      }
    }
    return result;
  }

  /** Cursor position mapped to display-text character offset. */
  get displayCursor(): number {
    let pos = 0;
    for (let i = 0; i < this._buf.length && i < this.cursor; i++) {
      const ch = this._buf[i]!;
      const paste = this.pastes.get(ch.charCodeAt(0) - PUA_BASE);
      if (paste) {
        const n = paste.split("\n").length;
        pos += `[paste +${n} lines]`.length;
      } else {
        pos++;
      }
    }
    return pos;
  }

  /** Cursor position as visible terminal-column width (accounts for CJK etc.). */
  get displayCursorWidth(): number {
    let width = 0;
    for (let i = 0; i < this._buf.length && i < this.cursor; i++) {
      const ch = this._buf[i]!;
      const paste = this.pastes.get(ch.charCodeAt(0) - PUA_BASE);
      if (paste) {
        const n = paste.split("\n").length;
        width += `[paste +${n} lines]`.length; // ASCII-only, 1 col each
      } else {
        width += charWidth(ch.codePointAt(0) ?? 0);
      }
    }
    return width;
  }

  /** Number of logical positions in the buffer. */
  get length(): number {
    return this._buf.length;
  }

  /** Replace buffer content. Clears paste attachments. */
  setText(value: string): void {
    this._buf = value;
    this.pastes.clear();
    this.pasteCounter = 0;
    this.cursor = value.length;
  }

  // ── Input processing ────────────────────────────────────────

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
              if (this.cursor < this._buf.length) { this.cursor++; actions.push({ action: "changed" }); }
              break;
            case "D":
              if (this.cursor > 0) { this.cursor--; actions.push({ action: "changed" }); }
              break;
            case "H": // Home
              if (this.cursor > 0) { this.cursor = 0; actions.push({ action: "changed" }); }
              break;
            case "F": // End
              if (this.cursor < this._buf.length) { this.cursor = this._buf.length; actions.push({ action: "changed" }); }
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

      // ── Bracket paste: accumulate into side buffer ─────
      if (this.inPaste) {
        if (ch === "\r") { i++; continue; } // skip CR (CR+LF → just LF)
        this.pasteAccum += ch;
        i++;
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
      this._buf = this._buf.slice(0, this.cursor) + ch + this._buf.slice(this.cursor);
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
    this._buf = "";
    this.cursor = 0;
    this.pendingSeq = "";
    this.inPaste = false;
    this.pasteAccum = "";
    this.pastes.clear();
    this.pasteCounter = 0;
    this.historyIndex = -1;
    this.savedBuffer = "";
  }

  /** Add a line to history (most recent first). */
  pushHistory(line: string): void {
    if (!line.trim()) return;
    // Deduplicate: remove if already at top
    if (this.history.length > 0 && this.history[0] === line) return;
    this.history.unshift(line);
    // Cap history size
    if (this.history.length > 100) this.history.pop();
  }

  /** Navigate to a previous history entry. Returns changed action or null. */
  historyBack(): LineEditAction | null {
    if (this.historyIndex + 1 >= this.history.length) return null;
    if (this.historyIndex === -1) {
      this.savedBuffer = this.text; // save resolved current input
    }
    this.historyIndex++;
    this.setText(this.history[this.historyIndex]!);
    return { action: "changed" };
  }

  /** Navigate to a more recent history entry. Returns changed action or null. */
  historyForward(): LineEditAction | null {
    if (this.historyIndex <= -1) return null;
    this.historyIndex--;
    if (this.historyIndex === -1) {
      this.setText(this.savedBuffer);
    } else {
      this.setText(this.history[this.historyIndex]!);
    }
    return { action: "changed" };
  }

  // ── Key bindings ────────────────────────────────────────────
  //
  // Single source of truth for all keybindings. Both legacy control
  // characters and kitty protocol sequences resolve to a key name
  // and look it up here. To add a binding, add one entry.

  private readonly bindings: Record<string, () => LineEditAction | null> = {
    "enter":         () => ({ action: "submit", buffer: this.text }),
    "ctrl+c":        () => ({ action: "cancel" }),
    "tab":           () => ({ action: "tab" }),
    "backspace":     () => this.deleteBackward(),
    "ctrl+d":        () => this._buf.length === 0 ? { action: "delete-empty" } : this.deleteForward(),
    "ctrl+a":        () => this.moveToLineStart(),
    "ctrl+e":        () => this.moveToLineEnd(),
    "ctrl+b":        () => this.moveTo(this.cursor - 1),
    "ctrl+f":        () => this.moveTo(this.cursor + 1),
    "ctrl+u":        () => this.deleteLineStart(),
    "ctrl+k":        () => this.deleteLineEnd(),
    "ctrl+w":        () => this.deleteWordBackward() ? { action: "changed" } : null,
    "alt+f":         () => this.wordForward() ? { action: "changed" } : null,
    "alt+b":         () => this.wordBackward() ? { action: "changed" } : null,
    "alt+d":         () => this.deleteWordForward() ? { action: "changed" } : null,
    "alt+backspace": () => this.deleteWordBackward() ? { action: "changed" } : null,
    "shift+enter":   () => this.insertAt("\n"),
    "shift+tab":     () => ({ action: "shift+tab" as const }),
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
    this._buf = this._buf.slice(0, this.cursor) + ch + this._buf.slice(this.cursor);
    this.cursor++;
    return { action: "changed" };
  }

  private moveTo(pos: number): LineEditAction | null {
    const clamped = Math.max(0, Math.min(pos, this._buf.length));
    if (clamped === this.cursor) return null;
    this.cursor = clamped;
    return { action: "changed" };
  }

  /** Move cursor to start of the current logical line. */
  private moveToLineStart(): LineEditAction | null {
    const lineStart = this._buf.lastIndexOf("\n", this.cursor - 1) + 1;
    return this.moveTo(lineStart);
  }

  /** Move cursor to end of the current logical line. */
  private moveToLineEnd(): LineEditAction | null {
    const nextNewline = this._buf.indexOf("\n", this.cursor);
    const lineEnd = nextNewline === -1 ? this._buf.length : nextNewline;
    return this.moveTo(lineEnd);
  }

  /** Delete from start of current logical line to cursor (Ctrl+U). */
  private deleteLineStart(): LineEditAction | null {
    const lineStart = this._buf.lastIndexOf("\n", this.cursor - 1) + 1;
    return this.deleteRange(lineStart, this.cursor);
  }

  /** Delete from cursor to end of current logical line (Ctrl+K). */
  private deleteLineEnd(): LineEditAction | null {
    const nextNewline = this._buf.indexOf("\n", this.cursor);
    const lineEnd = nextNewline === -1 ? this._buf.length : nextNewline;
    return this.deleteRange(this.cursor, lineEnd);
  }

  private deleteBackward(): LineEditAction | null {
    if (this._buf.length === 0) return { action: "delete-empty" };
    if (this.cursor <= 0) return null;
    // If deleting a paste placeholder, also remove the paste entry
    const deleted = this._buf[this.cursor - 1]!;
    if (isPUA(deleted)) {
      this.pastes.delete(deleted.charCodeAt(0) - PUA_BASE);
    }
    this._buf = this._buf.slice(0, this.cursor - 1) + this._buf.slice(this.cursor);
    this.cursor--;
    return { action: "changed" };
  }

  private deleteForward(): LineEditAction | null {
    if (this.cursor >= this._buf.length) return null;
    const deleted = this._buf[this.cursor]!;
    if (isPUA(deleted)) {
      this.pastes.delete(deleted.charCodeAt(0) - PUA_BASE);
    }
    this._buf = this._buf.slice(0, this.cursor) + this._buf.slice(this.cursor + 1);
    return { action: "changed" };
  }

  private deleteRange(start: number, end: number): LineEditAction | null {
    if (start >= end) return null;
    // Clean up any paste entries in the deleted range
    for (let k = start; k < end; k++) {
      const ch = this._buf[k]!;
      if (isPUA(ch)) this.pastes.delete(ch.charCodeAt(0) - PUA_BASE);
    }
    this._buf = this._buf.slice(0, start) + this._buf.slice(end);
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
          if (this.cursor < this._buf.length) { this.cursor++; actions.push({ action: "changed" }); }
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
        if (this.cursor < this._buf.length) { this.cursor = this._buf.length; actions.push({ action: "changed" }); }
        break;
      case "Z": // Shift+Tab (legacy CSI sequence)
        actions.push({ action: "shift+tab" });
        break;
      case "u": { // Kitty keyboard protocol: \x1b[<keycode>;<modifier>u
        const action = this.handleKittyKey(params);
        if (action) actions.push(action);
        break;
      }
      case "~": // Extended keys: Delete (3~), bracket paste (200~/201~), etc.
        if (params === "3") {
          // Delete key: delete char under cursor
          if (this.cursor < this._buf.length) {
            const deleted = this._buf[this.cursor]!;
            if (isPUA(deleted)) this.pastes.delete(deleted.charCodeAt(0) - PUA_BASE);
            this._buf = this._buf.slice(0, this.cursor) + this._buf.slice(this.cursor + 1);
            actions.push({ action: "changed" });
          }
        } else if (params === "200") {
          this.inPaste = true;
          this.pasteAccum = "";
        } else if (params === "201") {
          this.inPaste = false;
          if (this.pasteAccum) {
            const lines = this.pasteAccum.split("\n");
            if (lines.length <= 1) {
              // Single-line paste — inline directly
              this._buf = this._buf.slice(0, this.cursor) + this.pasteAccum + this._buf.slice(this.cursor);
              this.cursor += this.pasteAccum.length;
            } else {
              // Multi-line paste — store and insert placeholder
              const id = this.pasteCounter++;
              this.pastes.set(id, this.pasteAccum);
              const placeholder = String.fromCharCode(PUA_BASE + id);
              this._buf = this._buf.slice(0, this.cursor) + placeholder + this._buf.slice(this.cursor);
              this.cursor++;
            }
            this.pasteAccum = "";
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
    // Skip PUA placeholders and spaces
    while (pos > 0 && (this._buf[pos - 1] === " " || isPUA(this._buf[pos - 1]!))) pos--;
    // Skip word chars
    while (pos > 0 && this._buf[pos - 1] !== " " && !isPUA(this._buf[pos - 1]!)) pos--;
    if (pos === this.cursor) return false;
    this.cursor = pos;
    return true;
  }

  private wordForward(): boolean {
    if (this.cursor >= this._buf.length) return false;
    let pos = this.cursor;
    // Skip word chars and PUA placeholders
    while (pos < this._buf.length && this._buf[pos] !== " " && !isPUA(this._buf[pos]!)) pos++;
    // Skip spaces and PUA
    while (pos < this._buf.length && (this._buf[pos] === " " || isPUA(this._buf[pos]!))) pos++;
    if (pos === this.cursor) return false;
    this.cursor = pos;
    return true;
  }

  private deleteWordBackward(): boolean {
    if (this.cursor === 0) return false;
    const start = this.cursor;
    this.wordBackward();
    // Clean up paste entries
    for (let k = this.cursor; k < start; k++) {
      const ch = this._buf[k]!;
      if (isPUA(ch)) this.pastes.delete(ch.charCodeAt(0) - PUA_BASE);
    }
    this._buf = this._buf.slice(0, this.cursor) + this._buf.slice(start);
    return true;
  }

  private deleteWordForward(): boolean {
    if (this.cursor >= this._buf.length) return false;
    const start = this.cursor;
    this.wordForward();
    // Clean up paste entries
    for (let k = start; k < this.cursor; k++) {
      const ch = this._buf[k]!;
      if (isPUA(ch)) this.pastes.delete(ch.charCodeAt(0) - PUA_BASE);
    }
    this._buf = this._buf.slice(0, start) + this._buf.slice(this.cursor);
    this.cursor = start;
    return true;
  }
}
