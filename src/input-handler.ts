import { visibleLen } from "./utils/ansi.js";
import { palette as p } from "./utils/palette.js";
import { LineEditor } from "./utils/line-editor.js";
import type { EventBus } from "./event-bus.js";

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
  }

  /** Write the agent prompt line with cursor at the correct position. */
  private writeAgentPromptLine(showBuffer = true): void {
    const agentInfo = this.onShowAgentInfo();
    const infoPrefix = agentInfo.info ? `${agentInfo.info} ` : "";
    const promptPrefix = infoPrefix + p.warning + p.bold + "❯ " + p.reset;
    const bufferText = showBuffer ? p.accent + this.editor.buffer + p.reset : "";

    process.stdout.write("\r\x1b[2K" + promptPrefix + bufferText);

    // Position cursor within the buffer (not always at end)
    if (showBuffer && this.editor.cursor < this.editor.buffer.length) {
      const charsAfterCursor = this.editor.buffer.length - this.editor.cursor;
      process.stdout.write(`\x1b[${charsAfterCursor}D`);
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
    this.writeAgentPromptLine(false);
  }

  private exitAgentInputMode(): void {
    this.dismissAutocomplete();
    this.agentInputMode = false;
    this.editor.clear();
    process.stdout.write("\r\x1b[2K");
    this.printPrompt();
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
    const actions = this.editor.feed(data);

    for (const act of actions) {
      switch (act.action) {
        case "changed":
          this.autocompleteIndex = 0;
          this.renderAgentInput();
          break;

        case "submit": {
          if (this.autocompleteActive) {
            this.applyAutocomplete();
          }
          const query = act.buffer.trim();
          this.clearAutocompleteLines();
          process.stdout.write("\r\x1b[2K");
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
          }
          break;
      }
    }
  }
}
