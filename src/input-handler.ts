import { visibleLen } from "./utils/ansi.js";
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
  private agentInputBuffer = "";
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

  /** Write the agent prompt line (clear + info prefix + ❯ + buffer text). */
  private writeAgentPromptLine(showBuffer = true): void {
    const agentInfo = this.onShowAgentInfo();
    const infoPrefix = agentInfo.info ? `${agentInfo.info} ` : "";
    process.stdout.write(
      "\r\x1b[2K" +
      infoPrefix +
      "\x1b[33m\x1b[1m❯ \x1b[0m" +
      (showBuffer ? "\x1b[36m" + this.agentInputBuffer + "\x1b[0m" : "")
    );
  }

  handleInput(data: string): void {
    // If agent is running (processing a query), handle Ctrl-C as cancel
    if (this.ctx.isAgentActive()) {
      if (data === "\x03") {
        this.bus.emit("agent:cancel-request", {});
      }
      return;
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
    this.agentInputBuffer = "";
    this.writeAgentPromptLine(false);
  }

  private exitAgentInputMode(): void {
    this.dismissAutocomplete();
    this.agentInputMode = false;
    this.agentInputBuffer = "";
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
      buffer: this.agentInputBuffer,
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
          `  \x1b[7m \x1b[36m${item.name.padEnd(12)}\x1b[0m\x1b[7m ${item.description} \x1b[0m`
        );
      } else {
        lines.push(
          `   \x1b[90m${item.name.padEnd(12)} ${item.description}\x1b[0m`
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
    const col = infoLength + 2 + this.agentInputBuffer.length;
    process.stdout.write(`\r\x1b[${col}C`);
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

  private applyAutocomplete(): void {
    if (!this.autocompleteActive || this.autocompleteItems.length === 0) return;
    const selected = this.autocompleteItems[this.autocompleteIndex];
    if (!selected) return;

    const atPos = this.agentInputBuffer.lastIndexOf("@");
    const isFileAc =
      atPos >= 0 &&
      (atPos === 0 || this.agentInputBuffer[atPos - 1] === " ") &&
      !this.agentInputBuffer.slice(atPos + 1).includes(" ");

    if (isFileAc) {
      this.agentInputBuffer =
        this.agentInputBuffer.slice(0, atPos) + "@" + selected.name;
    } else {
      this.agentInputBuffer = selected.name;
    }

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

  private handleAgentInput(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;

      // Detect arrow key sequences: \x1b[A (up), \x1b[B (down)
      if (ch === "\x1b" && data[i + 1] === "[") {
        const arrow = data[i + 2];
        if (arrow === "A" && this.autocompleteActive) {
          // Arrow up
          this.autocompleteIndex =
            this.autocompleteIndex === 0
              ? this.autocompleteItems.length - 1
              : this.autocompleteIndex - 1;
          this.clearAutocompleteLines();
          this.writeAgentPromptLine();
          this.renderAutocomplete();
          i += 2;
          continue;
        } else if (arrow === "B" && this.autocompleteActive) {
          this.autocompleteIndex =
            this.autocompleteIndex === this.autocompleteItems.length - 1
              ? 0
              : this.autocompleteIndex + 1;
          this.clearAutocompleteLines();
          this.writeAgentPromptLine();
          this.renderAutocomplete();
          i += 2;
          continue;
        } else if (!this.autocompleteActive) {
          // Escape without arrow: cancel agent input mode
          this.dismissAutocomplete();
          this.exitAgentInputMode();
          return;
        }
        // Other escape sequences (e.g. left/right arrow) — ignore for now
        i += 2;
        continue;
      }

      if (ch === "\x1b") {
        // Bare escape (no bracket follows)
        if (this.autocompleteActive) {
          this.dismissAutocomplete();
          this.writeAgentPromptLine();
        } else {
          this.dismissAutocomplete();
          this.exitAgentInputMode();
        }
        return;
      }

      if (ch === "\t") {
        if (this.autocompleteActive) {
          this.applyAutocomplete();
        }
        continue;
      }

      if (ch === "\r") {
        if (this.autocompleteActive) {
          this.applyAutocomplete();
        }
        const query = this.agentInputBuffer.trim();
        this.clearAutocompleteLines();
        process.stdout.write("\r\x1b[2K");
        this.agentInputMode = false;
        this.agentInputBuffer = "";
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
      } else if (ch === "\x03") {
        // Ctrl-C: cancel
        this.dismissAutocomplete();
        this.exitAgentInputMode();
        return;
      } else if (ch === "\x7f" || ch === "\b") {
        // Backspace
        if (this.agentInputBuffer.length > 0) {
          this.agentInputBuffer = this.agentInputBuffer.slice(0, -1);
          this.autocompleteIndex = 0;
          this.renderAgentInput();
        } else {
          this.dismissAutocomplete();
          this.exitAgentInputMode();
          return;
        }
      } else if (ch.charCodeAt(0) >= 32) {
        // Printable character
        this.agentInputBuffer += ch;
        this.autocompleteIndex = 0;
        this.renderAgentInput();
      }
    }
  }
}
