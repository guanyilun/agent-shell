import * as fs from "node:fs";
import * as path from "node:path";

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
}

function visibleLen(str: string): number {
  return str.replace(/\x1b\[[^m]*m/g, "").length;
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
  private slashCommandDefs: { name: string; description: string }[];
  private onAgentRequest: (query: string) => void;
  private onAgentCancel: () => void;
  private onSlashCommand: (command: string) => void;
  private onShowAgentInfo: () => { info: string; model?: string };

  constructor(opts: {
    ctx: InputContext;
    slashCommandDefs: { name: string; description: string }[];
    onAgentRequest: (query: string) => void;
    onAgentCancel: () => void;
    onSlashCommand: (command: string) => void;
    onShowAgentInfo: () => { info: string; model?: string };
  }) {
    this.ctx = opts.ctx;
    this.slashCommandDefs = opts.slashCommandDefs;
    this.onAgentRequest = opts.onAgentRequest;
    this.onAgentCancel = opts.onAgentCancel;
    this.onSlashCommand = opts.onSlashCommand;
    this.onShowAgentInfo = opts.onShowAgentInfo;
  }

  handleInput(data: string): void {
    // If agent is running (processing a query), handle Ctrl-C as cancel
    if (this.ctx.isAgentActive()) {
      if (data === "\x03") {
        this.onAgentCancel();
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
    // Hide the shell's cursor line and show our agent prompt
    const agentInfo = this.onShowAgentInfo();
    const infoPrefix = agentInfo.info ? `${agentInfo.info} ` : "";
    process.stdout.write(
      "\r\x1b[2K" +
      infoPrefix +
      "\x1b[33m\x1b[1m❯ \x1b[0m"
    );
  }

  private exitAgentInputMode(): void {
    this.dismissAutocomplete();
    this.agentInputMode = false;
    this.agentInputBuffer = "";
    process.stdout.write("\r\x1b[2K");
    this.printPrompt();
  }

  /**
   * Print the shell prompt to stdout. Used to restore the prompt
   * after agent mode or agent response without sending anything to the PTY.
   */
  printPrompt(): void {
    const dir = this.ctx.getCwd().split("/").pop() || this.ctx.getCwd();
    process.stdout.write(`\x1b[36m⚡\x1b[0m \x1b[1m${dir}\x1b[0m $ `);
  }

  private renderAgentInput(): void {
    // Clear suggestion lines first, then redraw
    this.clearAutocompleteLines();

    const agentInfo = this.onShowAgentInfo();
    const infoPrefix = agentInfo.info ? `${agentInfo.info} ` : "";

    process.stdout.write(
      "\r\x1b[2K" +
      infoPrefix +
      "\x1b[33m\x1b[1m❯ \x1b[0m" +
      "\x1b[36m" + this.agentInputBuffer + "\x1b[0m"
    );

    this.updateAutocomplete();
  }

  private updateAutocomplete(): void {
    // ── File autocomplete: @ triggers file path completion ──
    const atPos = this.agentInputBuffer.lastIndexOf("@");
    if (
      atPos >= 0 &&
      (atPos === 0 || this.agentInputBuffer[atPos - 1] === " ")
    ) {
      const afterAt = this.agentInputBuffer.slice(atPos + 1);
      if (!afterAt.includes(" ") && /^[a-zA-Z0-9_.\/-]*$/.test(afterAt)) {
        this.autocompleteItems = this.listFiles(afterAt);
        if (this.autocompleteItems.length > 0) {
          this.autocompleteActive = true;
          if (this.autocompleteIndex >= this.autocompleteItems.length) {
            this.autocompleteIndex = 0;
          }
          this.renderAutocomplete();
          return;
        }
      }
    }

    // ── Slash command autocomplete ──
    if (this.agentInputBuffer.startsWith("/")) {
      const prefix = this.agentInputBuffer.toLowerCase();
      this.autocompleteItems = this.slashCommandDefs.filter((c) =>
        c.name.toLowerCase().startsWith(prefix)
      );
      if (this.autocompleteItems.length > 0) {
        this.autocompleteActive = true;
        if (this.autocompleteIndex >= this.autocompleteItems.length) {
          this.autocompleteIndex = 0;
        }
        this.renderAutocomplete();
        return;
      }
    }

    // ── Nothing to autocomplete ──
    this.autocompleteActive = false;
    this.autocompleteItems = [];
    this.autocompleteLines = 0;
  }

  private listFiles(query: string): { name: string; description: string }[] {
    const cwd = this.ctx.getCwd();
    const lastSlash = query.lastIndexOf("/");
    let searchDir: string;
    let prefix: string;
    let basePath: string;

    if (lastSlash >= 0) {
      basePath = query.slice(0, lastSlash + 1);
      searchDir = path.resolve(cwd, query.slice(0, lastSlash) || ".");
      prefix = query.slice(lastSlash + 1);
    } else {
      basePath = "";
      searchDir = cwd;
      prefix = query;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(searchDir, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter(
        (e) =>
          !e.name.startsWith(".") &&
          e.name.toLowerCase().startsWith(prefix.toLowerCase()),
      )
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 15)
      .map((e) => ({
        name: basePath + e.name + (e.isDirectory() ? "/" : ""),
        description: e.isDirectory() ? "dir" : "",
      }));
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

    process.stdout.write(
      "\r\x1b[2K" +
      "\x1b[33m\x1b[1m❯ \x1b[0m" +
      "\x1b[36m" + this.agentInputBuffer + "\x1b[0m"
    );

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
          process.stdout.write(
            "\r\x1b[2K" +
            "\x1b[33m\x1b[1m❯ \x1b[0m" +
            "\x1b[36m" + this.agentInputBuffer + "\x1b[0m"
          );
          this.renderAutocomplete();
          i += 2;
          continue;
        } else if (arrow === "B" && this.autocompleteActive) {
          // Arrow down
          this.autocompleteIndex =
            this.autocompleteIndex === this.autocompleteItems.length - 1
              ? 0
              : this.autocompleteIndex + 1;
          this.clearAutocompleteLines();
          process.stdout.write(
            "\r\x1b[2K" +
            "\x1b[33m\x1b[1m❯ \x1b[0m" +
            "\x1b[36m" + this.agentInputBuffer + "\x1b[0m"
          );
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
          process.stdout.write(
            "\r\x1b[2K" +
            "\x1b[33m\x1b[1m❯ \x1b[0m" +
            "\x1b[36m" + this.agentInputBuffer + "\x1b[0m"
          );
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
          this.onSlashCommand(query);
        } else if (query) {
          this.onAgentRequest(query);
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
