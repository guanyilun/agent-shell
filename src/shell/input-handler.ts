import * as fs from "node:fs";
import * as path from "node:path";
import { visibleLen } from "../utils/ansi.js";
import { palette as p } from "../utils/palette.js";
import { LineEditor } from "../utils/line-editor.js";
import { CONFIG_DIR, getSettings } from "../settings.js";
import type { EventBus } from "../event-bus.js";
import type { InputModeConfig } from "../types.js";

const HISTORY_FILE = path.join(CONFIG_DIR, "input-history");

/**
 * Narrow contract between InputHandler and its host (Shell).
 * InputHandler never touches the PTY or EventBus directly —
 * it goes through this interface for all cross-cutting concerns.
 */
export interface InputContext {
  isForegroundBusy(): boolean;
  getCwd(): string;
  isAgentActive(): boolean;
  writeToPty(data: string): void;
  onCommandEntered(command: string, cwd: string): void;
  redrawPrompt(): void;
  freshPrompt(): void;
}

export class InputHandler {
  private ctx: InputContext;
  private lineBuffer = "";
  private activeMode: InputModeConfig | null = null;
  private pendingReturnMode: string | null = null; // mode id to return to after processing
  private modes = new Map<string, InputModeConfig>(); // keyed by trigger char
  private modesById = new Map<string, InputModeConfig>(); // keyed by id
  private editor = new LineEditor();
  private autocompleteActive = false;
  private autocompleteIndex = 0;
  private autocompleteItems: { name: string; description: string }[] = [];
  private autocompleteLines = 0;
  private history: string[] = [];
  private historyIndex = -1; // -1 = not browsing history
  private savedBuffer = ""; // buffer saved when entering history
  private cursorRowsBelow = 0; // rows from prompt top to cursor row
  private cursorTermCol = 1;   // 1-indexed terminal column of cursor
  private escapeTimer: ReturnType<typeof setTimeout> | null = null;
  private bus: EventBus;
  private onShowAgentInfo: () => { info: string; model?: string };

  constructor(opts: {
    ctx: InputContext;
    bus: EventBus;
    onShowAgentInfo: () => { info: string; model?: string };
  }) {
    this.ctx = opts.ctx;
    this.bus = opts.bus;
    this.onShowAgentInfo = opts.onShowAgentInfo;
    this.loadHistory();

    // Re-render prompt when config changes (e.g. thinking level cycled)
    this.bus.on("config:changed", () => {
      if (this.activeMode) this.writeModePromptLine();
    });

    // Listen for mode registrations from extensions
    this.bus.on("input-mode:register", (config) => {
      this.registerMode(config);
    });
  }

  private registerMode(config: InputModeConfig): void {
    if (this.modes.has(config.trigger)) {
      this.bus.emit("ui:error", {
        message: `Input mode "${config.id}" cannot register trigger "${config.trigger}" — already taken by "${this.modes.get(config.trigger)!.id}"`,
      });
      return;
    }
    this.modes.set(config.trigger, config);
    this.modesById.set(config.id, config);
  }

  private loadHistory(): void {
    try {
      const data = fs.readFileSync(HISTORY_FILE, "utf-8");
      this.history = data.split("\n").filter(Boolean);
    } catch {
      // No history file yet
    }
  }

  private saveHistory(): void {
    try {
      const { historySize } = getSettings();
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      const lines = this.history.slice(-historySize);
      fs.writeFileSync(HISTORY_FILE, lines.join("\n") + "\n");
    } catch {
      // Non-critical — ignore write failures
    }
  }

  /** Write the mode prompt line with cursor at the correct position. */
  private writeModePromptLine(showBuffer = true): void {
    const termW = process.stdout.columns || 80;

    // Move cursor to the start of the prompt area.
    // We know exactly how many rows below the top the cursor currently sits.
    if (this.cursorRowsBelow > 0) {
      process.stdout.write(`\x1b[${this.cursorRowsBelow}A`);
    }
    // Clear from here to end of screen — removes current + all wrapped lines below
    process.stdout.write("\r\x1b[J");

    const agentInfo = this.onShowAgentInfo();
    const indicator = this.activeMode?.indicator ?? "●";
    const infoPrefix = agentInfo.info
      ? `${agentInfo.info} ${p.success}${indicator}${p.reset} `
      : `${p.success}${indicator}${p.reset} `;
    const icon = this.activeMode?.promptIcon ?? "❯";
    const promptPrefix = infoPrefix + p.warning + p.bold + icon + " " + p.reset;
    const promptVisLen = visibleLen(infoPrefix) + visibleLen(icon) + 1; // icon + space

    const display = showBuffer ? this.editor.displayText : "";
    const dCursor = showBuffer ? this.editor.displayCursor : 0;

    if (!showBuffer) {
      // No buffer — just write the prompt prefix, cursor stays at end
      process.stdout.write(promptPrefix);
      const N = promptVisLen;
      this.cursorRowsBelow = N > 0 ? Math.ceil(N / termW) - 1 : 0;
      this.cursorTermCol = N === 0 ? 1 : (N % termW === 0 ? termW : (N % termW) + 1);
    } else if (!display.includes("\n")) {
      // Single-line: write up to cursor, save, write rest, restore.
      // The terminal handles all wrapping — no manual row/col math needed.
      const before = display.slice(0, dCursor);
      const after = display.slice(dCursor);
      process.stdout.write(
        promptPrefix + p.accent + before + p.reset +
        "\x1b7" +                           // DECSC — save cursor position
        p.accent + after + p.reset +
        "\x1b8"                             // DECRC — restore cursor position
      );
      // cursorRowsBelow tracks total rows the prompt occupies so we can
      // reliably clear the entire area on next redraw.  Must account for
      // the *full* content visible width (cursor + after), not just up to cursor.
      const totalVisLen = promptVisLen + visibleLen(display);
      this.cursorRowsBelow = totalVisLen > 0 ? Math.ceil(totalVisLen / termW) - 1 : 0;
      const cursorVisCol = promptVisLen + visibleLen(before);
      this.cursorTermCol = cursorVisCol === 0 ? 1 : (cursorVisCol % termW === 0 ? termW : (cursorVisCol % termW) + 1);
    } else {
      // Multi-line: render each line with continuation indent.
      // Same save/restore strategy — cursor position is never computed.
      const lines = display.split("\n");
      const indent = " ".repeat(promptVisLen);

      // Locate cursor: which logical line and offset within it (character offset)
      let charsRemaining = dCursor;
      let cursorLine = 0;
      for (let li = 0; li < lines.length; li++) {
        if (charsRemaining <= lines[li]!.length) {
          cursorLine = li;
          break;
        }
        charsRemaining -= lines[li]!.length + 1; // +1 for \n
        cursorLine = li + 1;
      }

      let output = "";
      let cursorRowFromTop = 0;
      let rowsSoFar = 0;

      for (let li = 0; li < lines.length; li++) {
        const prefix = li === 0 ? promptPrefix : indent;
        const lineText = lines[li]!;
        const lineVisLen = promptVisLen + visibleLen(lineText);
        const lineTermRows = lineVisLen > 0 ? Math.ceil(lineVisLen / termW) : 1;

        if (li === cursorLine) {
          // Split this line at the cursor (character offset)
          const before = lineText.slice(0, charsRemaining);
          const after = lineText.slice(charsRemaining);
          output += prefix + p.accent + before + p.reset;
          output += "\x1b7";                // DECSC — save cursor position
          output += p.accent + after + p.reset;

          const beforeVisCol = promptVisLen + visibleLen(before);
          cursorRowFromTop = rowsSoFar + (beforeVisCol > 0 ? Math.ceil(beforeVisCol / termW) - 1 : 0);
          this.cursorTermCol = beforeVisCol === 0 ? 1 : (beforeVisCol % termW === 0 ? termW : (beforeVisCol % termW) + 1);
        } else {
          output += prefix + p.accent + lineText + p.reset;
        }

        if (li < lines.length - 1) output += "\n";
        rowsSoFar += lineTermRows;
      }

      process.stdout.write(output + "\x1b8"); // DECRC — restore cursor position
      // Use total rows (rowsSoFar) so next redraw clears the entire area,
      // not just up to the cursor line.
      this.cursorRowsBelow = rowsSoFar - 1 > 0 ? rowsSoFar - 1 : 0;
    }
  }

  handleInput(data: string): void {
    // Allow extensions to capture raw input (e.g. overlay prompt during vim)
    const intercepted = this.bus.emitPipe("input:intercept", { data, consumed: false });
    if (intercepted.consumed) return;

    // If agent is running (processing a query), only Ctrl-C and control keys
    if (this.ctx.isAgentActive()) {
      if (data === "\x03") {
        this.bus.emit("agent:cancel-request", {});
      } else if (data.length === 1 && data.charCodeAt(0) < 32) {
        this.bus.emit("input:keypress", { key: data });
      }
      return;
    }

    // Intercept control chars for TUI (Ctrl+T, Ctrl+O) — don't pass to PTY
    if (data.length === 1 && data.charCodeAt(0) < 32 && !this.activeMode) {
      const code = data.charCodeAt(0);
      // Keys consumed by TUI extensions
      if (code === 0x14 || code === 0x0f) { // Ctrl+T, Ctrl+O
        this.bus.emit("input:keypress", { key: data });
        return;
      }
      // Forward other control chars that shell mode doesn't handle
      if (code !== 0x0d && code !== 0x03 && code !== 0x04 && code !== 0x09) {
        this.bus.emit("input:keypress", { key: data });
      }
    }

    // If in an input mode (typing a query)
    if (this.activeMode) {
      this.handleModeInput(data);
      return;
    }

    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;

      if (ch === "\r") {
        // Record the command — output will be captured until next prompt marker
        if (this.lineBuffer.trim()) {
          this.ctx.onCommandEntered(this.lineBuffer.trim(), this.ctx.getCwd());
        }
        this.lineBuffer = "";
        this.ctx.writeToPty(ch);
      } else if (ch === "\x7f" || ch === "\b") {
        this.lineBuffer = this.lineBuffer.slice(0, -1);
        this.ctx.writeToPty(ch);
      } else if (ch === "\x03") {
        this.lineBuffer = "";
        this.ctx.writeToPty(ch);
      } else if (ch === "\x04") {
        this.lineBuffer = "";
        this.ctx.writeToPty(ch);
      } else if (ch === "\x1b") {
        // Escape sequence — forward the entire sequence to the PTY but
        // don't let it corrupt lineBuffer.  Skip CSI (ESC [ ... final)
        // and SS3 (ESC O <char>) sequences; anything else: just ESC.
        let seq = ch;
        if (i + 1 < data.length) {
          const next = data[i + 1]!;
          if (next === "[") {
            // CSI: ESC [ (params) (intermediates) final_byte
            seq += next; i++;
            while (i + 1 < data.length && data[i + 1]!.charCodeAt(0) < 0x40) {
              i++; seq += data[i]!;
            }
            if (i + 1 < data.length) { i++; seq += data[i]!; } // final byte
          } else if (next === "O") {
            // SS3: ESC O <char>
            seq += next; i++;
            if (i + 1 < data.length) { i++; seq += data[i]!; }
          } else {
            // ESC + single char (alt-key, etc.)
            seq += next; i++;
          }
        }
        this.ctx.writeToPty(seq);
      } else if (ch.charCodeAt(0) < 32 && ch !== "\t") {
        this.ctx.writeToPty(ch);
      } else {
        // Check if trigger char at start of empty line → enter that mode
        // But not if a foreground process (ssh, vim, etc.) is running
        const mode = this.modes.get(ch);
        if (this.lineBuffer === "" && mode && !this.ctx.isForegroundBusy()) {
          this.enterMode(mode);
          return; // don't process remaining chars
        }
        if (!this.ctx.isForegroundBusy()) this.lineBuffer += ch;
        this.ctx.writeToPty(ch);
      }
    }
  }

  private enterMode(mode: InputModeConfig): void {
    this.activeMode = mode;
    this.editor.clear();
    // Enable kitty keyboard protocol (progressive enhancement flag 1)
    // so Shift+Enter sends \x1b[13;2u instead of plain \r.
    // Enable bracket paste mode so pasted text doesn't trigger submit.
    process.stdout.write("\x1b[>1u\x1b[?2004h");
    this.writeModePromptLine(false);
  }

  private exitMode(): void {
    this.dismissAutocomplete();
    this.activeMode = null;
    this.editor.clear();
    // Disable kitty keyboard protocol and bracket paste mode
    process.stdout.write("\x1b[<u\x1b[?2004l");
    this.clearPromptArea();
    // Reset tracking state after clearing — back to raw shell mode
    this.cursorRowsBelow = 0;
    this.cursorTermCol = 1;
    this.printPrompt();
  }

  /** Move to the start of the prompt area and clear everything below. */
  private clearPromptArea(): void {
    if (this.cursorRowsBelow > 0) {
      process.stdout.write(`\x1b[${this.cursorRowsBelow}A`);
    }
    process.stdout.write("\r\x1b[J");
    this.cursorRowsBelow = 0;
  }

  printPrompt(): void {
    this.ctx.redrawPrompt();
  }

  /**
   * Called when agent processing completes. Returns true if the input
   * handler re-entered a mode (so caller should skip shell prompt).
   */
  handleProcessingDone(): boolean {
    if (this.pendingReturnMode) {
      const mode = this.modesById.get(this.pendingReturnMode);
      this.pendingReturnMode = null;
      if (mode) {
        this.enterMode(mode);
        return true;
      }
    }
    return false;
  }

  private renderModeInput(): void {
    this.clearAutocompleteLines();
    this.writeModePromptLine();
    this.updateAutocomplete();
  }

  private updateAutocomplete(): void {
    const buf = this.editor.text;
    let command: string | null = null;
    let commandArgs: string | null = null;
    if (buf.startsWith("/")) {
      const spaceIdx = buf.indexOf(" ");
      if (spaceIdx !== -1) {
        command = buf.slice(0, spaceIdx);
        commandArgs = buf.slice(spaceIdx + 1);
      }
    }
    const { items } = this.bus.emitPipe("autocomplete:request", {
      buffer: buf,
      command,
      commandArgs,
      items: [],
    });
    if (items.length > 0) {
      this.autocompleteItems = items;
      this.autocompleteActive = true;
      if (this.autocompleteIndex >= items.length) this.autocompleteIndex = 0;
      this.renderAutocomplete();
    } else {
      this.autocompleteActive = false;
      this.autocompleteItems = [];
      this.autocompleteLines = 0;
    }
  }

  private renderAutocomplete(): void {
    if (!this.autocompleteActive || this.autocompleteItems.length === 0) return;

    const lines: string[] = [];
    for (let i = 0; i < this.autocompleteItems.length; i++) {
      const item = this.autocompleteItems[i]!;
      const selected = i === this.autocompleteIndex;
      if (selected) {
        lines.push(
          `  \x1b[7m ${p.accent}${item.name.padEnd(12)}${p.reset}\x1b[7m ${item.description} ${p.reset}`
        );
      } else {
        lines.push(
          `   ${p.muted}${item.name.padEnd(12)} ${item.description}${p.reset}`
        );
      }
    }

    process.stdout.write("\n" + lines.join("\n"));
    this.autocompleteLines = lines.length;

    if (this.autocompleteLines > 0) {
      process.stdout.write(`\x1b[${this.autocompleteLines}A`);
    }
    // Restore cursor column — use explicit column set instead of DECRC
    // because writing \n above may have scrolled the terminal, which
    // invalidates the absolute position saved by DECSC.
    process.stdout.write(`\x1b[${this.cursorTermCol}G`);
  }

  private applyAutocomplete(): void {
    if (!this.autocompleteActive || this.autocompleteItems.length === 0) return;
    const selected = this.autocompleteItems[this.autocompleteIndex];
    if (!selected) return;

    const atPos = this.editor.text.lastIndexOf("@");
    const isFileAc =
      atPos >= 0 &&
      (atPos === 0 || this.editor.text[atPos - 1] === " ") &&
      !this.editor.text.slice(atPos + 1).includes(" ");

    if (isFileAc) {
      this.editor.setText(
        this.editor.text.slice(0, atPos) + "@" + selected.name);
    } else {
      this.editor.setText(selected.name);
    }

    this.clearAutocompleteLines();
    this.autocompleteActive = false;
    this.autocompleteItems = [];
    this.autocompleteIndex = 0;

    this.writeModePromptLine();
    if (isFileAc) this.updateAutocomplete();
  }

  private dismissAutocomplete(): void {
    this.clearAutocompleteLines();
    this.autocompleteActive = false;
    this.autocompleteItems = [];
    this.autocompleteIndex = 0;
  }

  private clearAutocompleteLines(): void {
    if (this.autocompleteLines <= 0) return;

    // Use CSI B (cursor down, bounded) instead of \n to avoid scroll
    for (let i = 0; i < this.autocompleteLines; i++) {
      process.stdout.write("\x1b[B\x1b[2K"); // move down, clear line
    }
    // Move back up and restore column with relative movement (scroll-safe)
    process.stdout.write(`\x1b[${this.autocompleteLines}A\x1b[${this.cursorTermCol}G`);
    this.autocompleteLines = 0;
  }

  private handleModeInput(data: string): void {
    // Clear any pending escape timer — new data arrived
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }

    const actions = this.editor.feed(data);

    // If the editor is waiting for more escape sequence data, set a short
    // timer — if nothing arrives, treat it as a bare Escape keypress
    if (this.editor.hasPendingEscape()) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = null;
        const flushed = this.editor.flushPendingEscape();
        if (flushed.length > 0) this.processModeActions(flushed);
      }, 50);
    }

    this.processModeActions(actions);
  }

  private processModeActions(actions: ReturnType<typeof this.editor.feed>): void {

    for (const act of actions) {
      switch (act.action) {
        case "changed": {
          // If the buffer is exactly a trigger char for a different mode, switch to it
          const switchMode = this.modes.get(this.editor.text);
          if (this.editor.text.length === 1 && switchMode && switchMode !== this.activeMode) {
            this.dismissAutocomplete();
            this.clearPromptArea();
            this.activeMode = switchMode;
            this.editor.clear();
            this.writeModePromptLine(false);
            break;
          }
          this.historyIndex = -1;
          this.autocompleteIndex = 0;
          this.renderModeInput();
          break;
        }

        case "submit": {
          if (this.autocompleteActive) {
            this.applyAutocomplete();
          }
          // Use editor.text (not act.buffer) so autocomplete selections
          // take effect — act.buffer is a stale snapshot from before
          // applyAutocomplete() updated the editor.
          const query = this.editor.text.trim();
          if (query) {
            // Add to history (avoid consecutive duplicates)
            if (this.history.length === 0 || this.history[this.history.length - 1] !== query) {
              this.history.push(query);
              this.saveHistory();
            }
          }
          this.historyIndex = -1;
          this.savedBuffer = "";
          this.clearAutocompleteLines();
          this.clearPromptArea();
          process.stdout.write("\x1b[<u\x1b[?2004l"); // disable kitty + bracket paste
          const currentMode = this.activeMode!;
          this.activeMode = null;
          this.editor.clear();
          this.cursorRowsBelow = 0;
          this.cursorTermCol = 1;
          this.dismissAutocomplete();
          if (query && query.startsWith("/")) {
            const spaceIdx = query.indexOf(" ");
            const name = spaceIdx === -1 ? query : query.slice(0, spaceIdx);
            const args = spaceIdx === -1 ? "" : query.slice(spaceIdx + 1).trim();
            this.bus.emit("command:execute", { name, args });
            if (currentMode.returnToSelf) {
              this.enterMode(currentMode);
            } else {
              this.ctx.freshPrompt();
            }
          } else if (query) {
            this.pendingReturnMode = currentMode.returnToSelf ? currentMode.id : null;
            currentMode.onSubmit(query, this.bus);
          } else {
            this.exitMode();
          }
          return;
        }

        case "cancel":
          if (this.autocompleteActive) {
            this.dismissAutocomplete();
            this.writeModePromptLine();
          } else {
            this.exitMode();
          }
          return;

        case "delete-empty":
          this.dismissAutocomplete();
          this.exitMode();
          return;

        case "tab":
          if (this.autocompleteActive) {
            this.applyAutocomplete();
          }
          break;

        case "shift+tab":
          this.bus.emit("config:cycle", {});
          break;

        case "arrow-up":
          if (this.autocompleteActive) {
            this.autocompleteIndex =
              this.autocompleteIndex === 0
                ? this.autocompleteItems.length - 1
                : this.autocompleteIndex - 1;
            this.clearAutocompleteLines();
            this.writeModePromptLine();
            this.renderAutocomplete();
          } else if (this.history.length > 0) {
            if (this.historyIndex === -1) {
              this.savedBuffer = this.editor.text;
              this.historyIndex = this.history.length - 1;
            } else if (this.historyIndex > 0) {
              this.historyIndex--;
            }
            this.editor.setText(this.history[this.historyIndex]!);
            this.clearAutocompleteLines();
            this.writeModePromptLine();
          }
          break;

        case "arrow-down":
          if (this.autocompleteActive) {
            this.autocompleteIndex =
              this.autocompleteIndex === this.autocompleteItems.length - 1
                ? 0
                : this.autocompleteIndex + 1;
            this.clearAutocompleteLines();
            this.writeModePromptLine();
            this.renderAutocomplete();
          } else if (this.historyIndex !== -1) {
            if (this.historyIndex < this.history.length - 1) {
              this.historyIndex++;
              this.editor.setText(this.history[this.historyIndex]!);
            } else {
              this.historyIndex = -1;
              this.editor.setText(this.savedBuffer);
            }
            this.clearAutocompleteLines();
            this.writeModePromptLine();
          }
          break;
      }
    }
  }
}
