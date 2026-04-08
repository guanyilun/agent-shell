import * as pty from "node-pty";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ShellContext, CommandRecord } from "./types.js";

const MAX_HISTORY = 20;

export class Shell {
  private ptyProcess: pty.IPty;
  private lineBuffer = "";
  private cwd: string;
  // Structured command history
  private commandHistory: CommandRecord[] = [];
  private currentOutputCapture = "";  // accumulates output for the current command
  private lastCommand = "";           // the command that's currently running
  private paused = false;
  private agentActive = false;
  private agentInputMode = false;
  private agentInputBuffer = "";
  private autocompleteActive = false;
  private autocompleteIndex = 0;
  private autocompleteItems: { name: string; description: string }[] = [];
  private autocompleteLines = 0; // how many lines the suggestion list occupies
  private shellActivitySinceAgent: CommandRecord[] = [];
  private foregroundBusy = false; // true while a command is running in the PTY (between Enter and next prompt marker)
  private slashCommandDefs: { name: string; description: string }[] = [];
  private onAgentRequest: (query: string) => void;
  private onAgentCancel: () => void;
  private onSlashCommand: (command: string) => void;
  private onPtyOutput: () => void;

  constructor(opts: {
    onAgentRequest: (query: string) => void;
    onAgentCancel: () => void;
    onSlashCommand?: (command: string) => void;
    onPtyOutput?: () => void;
    slashCommandDefs?: { name: string; description: string }[];
    cols: number;
    rows: number;
    shell: string;
    cwd: string;
  }) {
    this.onAgentRequest = opts.onAgentRequest;
    this.onAgentCancel = opts.onAgentCancel;
    this.onSlashCommand = opts.onSlashCommand ?? (() => {});
    this.onPtyOutput = opts.onPtyOutput ?? (() => {});
    this.slashCommandDefs = opts.slashCommandDefs ?? [];
    this.cwd = opts.cwd;

    // Build environment — filter out undefined values (node-pty's native
    // posix_spawnp fails if any env value is undefined)
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.AGENT_SHELL = "1";

    // Use bash with a minimal config to avoid p10k/oh-my-zsh terminal
    // control that conflicts with our status bar. We set up a custom
    // PS1 with the ⚡ indicator and OSC 7 cwd reporting via PROMPT_COMMAND.
    const shellBin = "/bin/bash";
    const osc7Cmd = 'printf "\\e]7;file://%s%s\\a" "$(hostname)" "$PWD"';
    // Custom OSC marker emitted before each prompt — we parse this to
    // delimit command outputs in the PTY stream.
    const promptMarker = 'printf "\\e]9999;PROMPT\\a"';
    const ps1 = "\\[\\033[36m\\]⚡\\[\\033[0m\\] \\[\\033[1m\\]\\W\\[\\033[0m\\] \\$ ";

    env.PROMPT_COMMAND = `${osc7Cmd}; ${promptMarker}`;
    env.PS1 = ps1;

    // Spawn bash with --norc --noprofile to skip user config entirely
    this.ptyProcess = pty.spawn(shellBin, ["--norc", "--noprofile"], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    });

    this.setupOutput();
    this.setupInput();
  }

  private setupOutput(): void {
    this.ptyProcess.onData((data: string) => {
      this.parseOSC7(data);
      this.parsePromptMarker(data);

      if (!this.paused) {
        process.stdout.write(data);
        this.onPtyOutput();
      }
    });
  }

  private setupInput(): void {
    process.stdin.on("data", (data: Buffer) => {
      const str = data.toString("utf-8");
      this.handleInput(str);
    });
  }

  private handleInput(data: string): void {
    // If agent is running (processing a query), handle Ctrl-C as cancel
    if (this.agentActive) {
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
          this.lastCommand = this.lineBuffer.trim();
          this.currentOutputCapture = "";
          this.foregroundBusy = true;
        }
        this.lineBuffer = "";
        this.ptyProcess.write(ch);
      } else if (ch === "\x7f" || ch === "\b") {
        this.lineBuffer = this.lineBuffer.slice(0, -1);
        this.ptyProcess.write(ch);
      } else if (ch === "\x03") {
        this.lineBuffer = "";
        this.ptyProcess.write(ch);
      } else if (ch === "\x04") {
        this.lineBuffer = "";
        this.ptyProcess.write(ch);
      } else if (ch.charCodeAt(0) < 32 && ch !== "\t") {
        this.lineBuffer = "";
        this.ptyProcess.write(ch);
      } else {
        // Check if ">" at start of empty line → enter agent input mode
        // But not if a foreground process (ssh, vim, etc.) is running
        if (this.lineBuffer === "" && ch === ">" && !this.foregroundBusy) {
          this.enterAgentInputMode();
          return; // don't process remaining chars
        }
        this.lineBuffer += ch;
        this.ptyProcess.write(ch);
      }
    }
  }

  private enterAgentInputMode(): void {
    this.agentInputMode = true;
    this.agentInputBuffer = "";
    // Hide the shell's cursor line and show our agent prompt
    // Move to start of line, clear it, show agent prompt
    process.stdout.write(
      "\r\x1b[2K" +
      "\x1b[33m\x1b[1m❯ \x1b[0m"  // yellow bold "❯ "
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
    const dir = this.cwd.split("/").pop() || this.cwd;
    process.stdout.write(`\x1b[36m⚡\x1b[0m \x1b[1m${dir}\x1b[0m $ `);
  }

  private renderAgentInput(): void {
    // Clear suggestion lines first, then redraw
    this.clearAutocompleteLines();

    process.stdout.write(
      "\r\x1b[2K" +
      "\x1b[33m\x1b[1m❯ \x1b[0m" +
      "\x1b[36m" + this.agentInputBuffer + "\x1b[0m"
    );

    // Show autocomplete if buffer starts with "/"
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

  /**
   * List files matching a path query relative to cwd.
   * Supports path segments: "" → top-level, "src/" → contents of src/, etc.
   */
  private listFiles(query: string): { name: string; description: string }[] {
    const lastSlash = query.lastIndexOf("/");
    let searchDir: string;
    let prefix: string;
    let basePath: string;

    if (lastSlash >= 0) {
      basePath = query.slice(0, lastSlash + 1);
      searchDir = path.resolve(this.cwd, query.slice(0, lastSlash) || ".");
      prefix = query.slice(lastSlash + 1);
    } else {
      basePath = "";
      searchDir = this.cwd;
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
        // Inverse/highlight for selected item
        lines.push(
          `  \x1b[7m \x1b[36m${item.name.padEnd(12)}\x1b[0m\x1b[7m ${item.description} \x1b[0m`
        );
      } else {
        lines.push(
          `   \x1b[90m${item.name.padEnd(12)} ${item.description}\x1b[0m`
        );
      }
    }

    // Print lines below cursor
    process.stdout.write("\n" + lines.join("\n"));
    this.autocompleteLines = lines.length;

    // Move cursor back up to the input line
    if (this.autocompleteLines > 0) {
      process.stdout.write(`\x1b[${this.autocompleteLines}A`);
    }
    // Restore cursor to end of input on the prompt line
    // "❯ " = 2 visible columns, then the typed text
    const col = 2 + this.agentInputBuffer.length;
    process.stdout.write(`\r\x1b[${col}C`);
  }

  private clearAutocompleteLines(): void {
    if (this.autocompleteLines <= 0) return;

    // Save cursor, move down to clear each suggestion line, then restore
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

    // Detect whether this is a file (@) or slash command (/) completion
    const atPos = this.agentInputBuffer.lastIndexOf("@");
    const isFileAc =
      atPos >= 0 &&
      (atPos === 0 || this.agentInputBuffer[atPos - 1] === " ") &&
      !this.agentInputBuffer.slice(atPos + 1).includes(" ");

    if (isFileAc) {
      // Replace only the @path portion, keep surrounding text
      this.agentInputBuffer =
        this.agentInputBuffer.slice(0, atPos) + "@" + selected.name;
    } else {
      this.agentInputBuffer = selected.name;
    }

    this.clearAutocompleteLines();
    this.autocompleteActive = false;
    this.autocompleteItems = [];
    this.autocompleteIndex = 0;

    // Re-render input line
    process.stdout.write(
      "\r\x1b[2K" +
      "\x1b[33m\x1b[1m❯ \x1b[0m" +
      "\x1b[36m" + this.agentInputBuffer + "\x1b[0m"
    );

    // Re-trigger for directory drill-down
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
          // Re-render input line to position cursor, then show autocomplete
          process.stdout.write(
            "\r\x1b[2K" +
            "\x1b[33m\x1b[1m❯ \x1b[0m" +
            "\x1b[36m" + this.agentInputBuffer + "\x1b[0m"
          );
          this.renderAutocomplete();
          i += 2; // skip the "[" and letter
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
          // Re-render input without autocomplete
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
        // Tab: apply autocomplete selection
        if (this.autocompleteActive) {
          this.applyAutocomplete();
        }
        continue;
      }

      if (ch === "\r") {
        // Enter: if autocomplete is active, apply and submit; otherwise submit directly
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

  private parseOSC7(data: string): void {
    // OSC 7: \x1b]7;file://hostname/path\x07 or \x1b]7;file://hostname/path\x1b\\
    const match = data.match(/\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)/);
    if (match?.[1]) {
      this.cwd = decodeURIComponent(match[1]);
    }
  }

  /**
   * Detect our custom prompt marker (OSC 9999) in the PTY stream.
   * Each time a prompt appears, we finalize the previous command's output.
   */
  private parsePromptMarker(data: string): void {
    // Check for our marker: \x1b]9999;PROMPT\x07
    if (data.includes("\x1b]9999;PROMPT\x07")) {
      // A new prompt appeared — the foreground process has exited
      this.foregroundBusy = false;
      // Finalize the previous command
      if (this.lastCommand) {
        const output = this.stripAnsi(this.currentOutputCapture).trim();
        // Remove the echoed command from the start of the output
        const cleaned = this.removeEchoedCommand(output, this.lastCommand);
        const record = { command: this.lastCommand, output: cleaned };
        this.commandHistory.push(record);
        this.shellActivitySinceAgent.push(record);
        if (this.commandHistory.length > MAX_HISTORY) {
          this.commandHistory.shift();
        }
      }
      this.lastCommand = "";
      this.currentOutputCapture = "";
    } else {
      // Accumulate output for the current command
      this.currentOutputCapture += data;
    }
  }

  private stripAnsi(str: string): string {
    // Strip ANSI escape sequences and OSC sequences
    return str
      .replace(/\x1b\][^\x07]*\x07/g, "")   // OSC sequences
      .replace(/\x1b\[[^m]*m/g, "")           // SGR (color) sequences
      .replace(/\x1b\[\?[^a-zA-Z]*[a-zA-Z]/g, "") // private mode sequences
      .replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "")   // CSI sequences
      .replace(/\r/g, "");                     // carriage returns
  }

  private removeEchoedCommand(output: string, command: string): string {
    const lines = output.split("\n");
    // The first line is typically the echoed command — remove it
    if (lines.length > 0 && lines[0]!.includes(command.slice(0, 20))) {
      return lines.slice(1).join("\n").trim();
    }
    return output;
  }

  getContext(): ShellContext {
    return {
      cwd: this.cwd,
      history: this.commandHistory.slice(-10),
    };
  }

  /**
   * Get shell commands executed since the last agent interaction, then clear the buffer.
   * Capped at 5 most recent to prevent context blowup.
   */
  getAndClearRecentActivity(): CommandRecord[] {
    const activity = this.shellActivitySinceAgent.slice(-5);
    this.shellActivitySinceAgent = [];
    return activity;
  }

  pauseOutput(): void {
    this.paused = true;
  }

  resumeOutput(): void {
    this.paused = false;
  }

  setAgentActive(active: boolean): void {
    this.agentActive = active;
  }

  /** Whether an interactive foreground process is running in the PTY. */
  isForegroundBusy(): boolean {
    return this.foregroundBusy;
  }

  resize(cols: number, rows: number): void {
    this.ptyProcess.resize(cols, rows);
  }

  onExit(callback: (e: { exitCode: number; signal?: number }) => void): void {
    this.ptyProcess.onExit(callback);
  }

  kill(): void {
    this.ptyProcess.kill();
  }
}
