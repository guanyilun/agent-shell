import * as fs from "node:fs";
import * as path from "node:path";
import { visibleLen } from "./utils/ansi.js";
import { palette as p } from "./utils/palette.js";
import { LineEditor } from "./utils/line-editor.js";
import { CONFIG_DIR, getSettings } from "./settings.js";
import type { EventBus } from "./event-bus.js";

const HISTORY_FILE = path.join(CONFIG_DIR, "history");

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
  private agentInputMode = false;
  private editor = new LineEditor();
  private autocompleteActive = false;
  private autocompleteIndex = 0;
  private autocompleteItems: { name: string; description: string }[] = [];
  private autocompleteLines = 0;
  private history: string[] = [];
  private historyIndex = -1; // -1 = not browsing history
  private savedBuffer = ""; // buffer saved when entering history
  private promptWrappedLines = 0; // extra lines from terminal wrapping
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

  /** Write the agent prompt line with cursor at the correct position. */
  private writeAgentPromptLine(showBuffer = true): void {
    const termW = process.stdout.columns || 80;

    // Move cursor to the start of the prompt area (first line of wrapped content)
    if (this.promptWrappedLines > 0) {
      process.stdout.write(`\x1b[${this.promptWrappedLines}A`);
    }
    // Clear from here to end of screen — removes current + all wrapped lines below
    process.stdout.write("\r\x1b[J");

    const agentInfo = this.onShowAgentInfo();
    const infoPrefix = agentInfo.info ? `${agentInfo.info} ` : "";
    const promptPrefix = infoPrefix + p.warning + p.bold + "❯ " + p.reset;
    const promptVisLen = visibleLen(infoPrefix) + 2; // "❯ "

    if (!showBuffer || !this.editor.buffer.includes("\n")) {
      // Single-line: simple rendering
      const bufferText = showBuffer ? p.accent + this.editor.buffer + p.reset : "";
      process.stdout.write(promptPrefix + bufferText);

      const bufferVisLen = showBuffer ? this.editor.buffer.length : 0;
      const totalVisLen = promptVisLen + bufferVisLen;
      this.promptWrappedLines = totalVisLen > 0 ? Math.floor((totalVisLen - 1) / termW) : 0;

      // Position cursor within the buffer
      if (showBuffer && this.editor.cursor < this.editor.buffer.length) {
        const charsAfterCursor = this.editor.buffer.length - this.editor.cursor;
        process.stdout.write(`\x1b[${charsAfterCursor}D`);
      }
    } else {
      // Multi-line: render each line with continuation indent
      const lines = this.editor.buffer.split("\n");
      const indent = " ".repeat(promptVisLen);
      let totalTermLines = 0;

      for (let li = 0; li < lines.length; li++) {
        const prefix = li === 0 ? promptPrefix : indent;
        const prefixVisLen = li === 0 ? promptVisLen : promptVisLen;
        const lineText = lines[li]!;
        process.stdout.write(prefix + p.accent + lineText + p.reset);
        if (li < lines.length - 1) process.stdout.write("\n");

        // Count terminal lines this logical line occupies
        const lineVisLen = prefixVisLen + lineText.length;
        totalTermLines += lineVisLen > 0 ? Math.ceil(lineVisLen / termW) : 1;
      }
      this.promptWrappedLines = totalTermLines - 1;

      // Position cursor: find which line and column the cursor is on
      let charsRemaining = this.editor.cursor;
      let cursorLine = 0;
      for (let li = 0; li < lines.length; li++) {
        if (charsRemaining <= lines[li]!.length) {
          cursorLine = li;
          break;
        }
        charsRemaining -= lines[li]!.length + 1; // +1 for \n
        cursorLine = li + 1;
      }

      // Move from end position to cursor position
      const linesFromEnd = lines.length - 1 - cursorLine;
      if (linesFromEnd > 0) {
        process.stdout.write(`\x1b[${linesFromEnd}A`);
      }
      const cursorCol = (cursorLine === 0 ? promptVisLen : promptVisLen) + charsRemaining;
      process.stdout.write(`\r\x1b[${cursorCol}C`);
    }
  }

  handleInput(data: string): void {
    // If agent is running (processing a query), only Ctrl-C and control keys
    if (this.ctx.isAgentActive()) {
      if (data === "\x03") {
        this.bus.emit("agent:cancel-request", {});
      } else if (data.length === 1 && data.charCodeAt(0) < 32) {
        this.bus.emit("input:keypress", { key: data });
      }
      return;
    }

    // Forward control chars that normal shell mode doesn't handle
    if (data.length === 1 && data.charCodeAt(0) < 32 && !this.agentInputMode) {
      const code = data.charCodeAt(0);
      // Don't intercept keys that shell mode handles: CR, Ctrl-C, Ctrl-D, Tab
      if (code !== 0x0d && code !== 0x03 && code !== 0x04 && code !== 0x09) {
        this.bus.emit("input:keypress", { key: data });
      }
    }

    // If in agent input mode (typing a query after ">")
    if (this.agentInputMode) {
      this.handleAgentInput(data);
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
      } else if (ch.charCodeAt(0) < 32 && ch !== "\t") {
        this.lineBuffer = "";
        this.ctx.writeToPty(ch);
      } else {
        // Check if ">" at start of empty line → enter agent input mode
        // But not if a foreground process (ssh, vim, etc.) is running
        if (this.lineBuffer === "" && ch === ">" && !this.ctx.isForegroundBusy()) {
          this.enterAgentInputMode();
          return; // don't process remaining chars
        }
        this.lineBuffer += ch;
        this.ctx.writeToPty(ch);
      }
    }
  }

  private enterAgentInputMode(): void {
    this.agentInputMode = true;
    this.editor.clear();
    // Enable kitty keyboard protocol (progressive enhancement flag 1)
    // so Shift+Enter sends \x1b[13;2u instead of plain \r
    process.stdout.write("\x1b[>1u");
    this.writeAgentPromptLine(false);
  }

  private exitAgentInputMode(): void {
    this.dismissAutocomplete();
    this.agentInputMode = false;
    this.editor.clear();
    // Disable kitty keyboard protocol
    process.stdout.write("\x1b[<u");
    this.clearPromptArea();
    this.printPrompt();
  }

  /** Move to the start of the prompt area and clear everything below. */
  private clearPromptArea(): void {
    if (this.promptWrappedLines > 0) {
      process.stdout.write(`\x1b[${this.promptWrappedLines}A`);
    }
    process.stdout.write("\r\x1b[J");
    this.promptWrappedLines = 0;
  }

  printPrompt(): void {
    this.ctx.redrawPrompt();
  }

  private renderAgentInput(): void {
    this.clearAutocompleteLines();
    this.writeAgentPromptLine();
    this.updateAutocomplete();
  }

  private updateAutocomplete(): void {
    const { items } = this.bus.emitPipe("autocomplete:request", {
      buffer: this.editor.buffer,
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
    const agentInfo = this.onShowAgentInfo();
    const infoLength = visibleLen(agentInfo.info);
    const col = infoLength + 2 + this.editor.cursor;
    process.stdout.write(`\r\x1b[${col}C`);
  }

  private applyAutocomplete(): void {
    if (!this.autocompleteActive || this.autocompleteItems.length === 0) return;
    const selected = this.autocompleteItems[this.autocompleteIndex];
    if (!selected) return;

    const atPos = this.editor.buffer.lastIndexOf("@");
    const isFileAc =
      atPos >= 0 &&
      (atPos === 0 || this.editor.buffer[atPos - 1] === " ") &&
      !this.editor.buffer.slice(atPos + 1).includes(" ");

    if (isFileAc) {
      this.editor.buffer =
        this.editor.buffer.slice(0, atPos) + "@" + selected.name;
    } else {
      this.editor.buffer = selected.name;
    }
    this.editor.cursor = this.editor.buffer.length;

    this.clearAutocompleteLines();
    this.autocompleteActive = false;
    this.autocompleteItems = [];
    this.autocompleteIndex = 0;

    this.writeAgentPromptLine();
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

    process.stdout.write("\x1b7"); // save cursor
    for (let i = 0; i < this.autocompleteLines; i++) {
      process.stdout.write("\n\x1b[2K"); // move down, clear line
    }
    process.stdout.write("\x1b8"); // restore cursor
    this.autocompleteLines = 0;
  }

  private handleAgentInput(data: string): void {
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
        if (flushed.length > 0) this.processAgentActions(flushed);
      }, 50);
    }

    this.processAgentActions(actions);
  }

  private processAgentActions(actions: ReturnType<typeof this.editor.feed>): void {

    for (const act of actions) {
      switch (act.action) {
        case "changed":
          this.historyIndex = -1;
          this.autocompleteIndex = 0;
          this.renderAgentInput();
          break;

        case "submit": {
          if (this.autocompleteActive) {
            this.applyAutocomplete();
          }
          const query = act.buffer.trim();
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
          process.stdout.write("\x1b[<u"); // disable kitty keyboard protocol
          this.agentInputMode = false;
          this.editor.clear();
          this.dismissAutocomplete();
          if (query && query.startsWith("/")) {
            const spaceIdx = query.indexOf(" ");
            const name = spaceIdx === -1 ? query : query.slice(0, spaceIdx);
            const args = spaceIdx === -1 ? "" : query.slice(spaceIdx + 1).trim();
            this.bus.emit("command:execute", { name, args });
            this.ctx.redrawPrompt();
          } else if (query) {
            this.bus.emit("agent:submit", { query });
          } else {
            this.exitAgentInputMode();
          }
          return;
        }

        case "cancel":
          if (this.autocompleteActive) {
            this.dismissAutocomplete();
            this.writeAgentPromptLine();
          } else {
            this.exitAgentInputMode();
          }
          return;

        case "delete-empty":
          this.dismissAutocomplete();
          this.exitAgentInputMode();
          return;

        case "tab":
          if (this.autocompleteActive) {
            this.applyAutocomplete();
          }
          break;

        case "arrow-up":
          if (this.autocompleteActive) {
            this.autocompleteIndex =
              this.autocompleteIndex === 0
                ? this.autocompleteItems.length - 1
                : this.autocompleteIndex - 1;
            this.clearAutocompleteLines();
            this.writeAgentPromptLine();
            this.renderAutocomplete();
          } else if (this.history.length > 0) {
            if (this.historyIndex === -1) {
              this.savedBuffer = this.editor.buffer;
              this.historyIndex = this.history.length - 1;
            } else if (this.historyIndex > 0) {
              this.historyIndex--;
            }
            this.editor.buffer = this.history[this.historyIndex]!;
            this.editor.cursor = this.editor.buffer.length;
            this.renderAgentInput();
          }
          break;

        case "arrow-down":
          if (this.autocompleteActive) {
            this.autocompleteIndex =
              this.autocompleteIndex === this.autocompleteItems.length - 1
                ? 0
                : this.autocompleteIndex + 1;
            this.clearAutocompleteLines();
            this.writeAgentPromptLine();
            this.renderAutocomplete();
          } else if (this.historyIndex !== -1) {
            if (this.historyIndex < this.history.length - 1) {
              this.historyIndex++;
              this.editor.buffer = this.history[this.historyIndex]!;
            } else {
              this.historyIndex = -1;
              this.editor.buffer = this.savedBuffer;
            }
            this.editor.cursor = this.editor.buffer.length;
            this.renderAgentInput();
          }
          break;
      }
    }
  }
}
