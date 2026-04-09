import type { EventBus } from "./event-bus.js";

/**
 * Parses PTY output to detect command boundaries, track cwd,
 * and emit shell events. Owns the command lifecycle state.
 */
export class OutputParser {
  private bus: EventBus;
  private cwd: string;
  private currentOutputCapture = "";
  private lastCommand = "";
  private foregroundBusy = false;

  constructor(bus: EventBus, initialCwd: string) {
    this.bus = bus;
    this.cwd = initialCwd;
  }

  /** Process a chunk of PTY output data. */
  processData(data: string): void {
    this.parseOSC7(data);
    this.parsePromptMarker(data);
  }

  /** Called when user presses Enter on a non-empty line. */
  onCommandEntered(command: string, cwd: string): void {
    this.lastCommand = command;
    this.currentOutputCapture = "";
    this.foregroundBusy = true;
    this.bus.emit("shell:command-start", { command, cwd });
    this.bus.emit("shell:foreground-busy", { busy: true });
  }

  isForegroundBusy(): boolean {
    return this.foregroundBusy;
  }

  getCwd(): string {
    return this.cwd;
  }

  // ── Parsing ─────────────────────────────────────────────────

  private parseOSC7(data: string): void {
    const match = data.match(/\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)/);
    if (match?.[1]) {
      const newCwd = decodeURIComponent(match[1]);
      if (newCwd !== this.cwd) {
        this.cwd = newCwd;
        this.bus.emit("shell:cwd-change", { cwd: this.cwd });
      }
    }
  }

  /**
   * Detect our custom prompt marker (OSC 9999) in the PTY stream.
   * Each time a prompt appears, we finalize the previous command's output.
   */
  private parsePromptMarker(data: string): void {
    if (data.includes("\x1b]9999;PROMPT\x07")) {
      this.foregroundBusy = false;
      this.bus.emit("shell:foreground-busy", { busy: false });
      if (this.lastCommand) {
        const output = this.stripAnsi(this.currentOutputCapture).trim();
        const cleaned = this.removeEchoedCommand(output, this.lastCommand);
        this.bus.emit("shell:command-done", {
          command: this.lastCommand,
          output: cleaned,
          cwd: this.cwd,
          exitCode: null,
        });
      }
      this.lastCommand = "";
      this.currentOutputCapture = "";
    } else {
      this.currentOutputCapture += data;
    }
  }

  private stripAnsi(str: string): string {
    return str
      .replace(/\x1b\][^\x07]*\x07/g, "")
      .replace(/\x1b\[[^m]*m/g, "")
      .replace(/\x1b\[\?[^a-zA-Z]*[a-zA-Z]/g, "")
      .replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "")
      .replace(/\r/g, "");
  }

  private removeEchoedCommand(output: string, command: string): string {
    const lines = output.split("\n");
    if (lines.length > 0 && lines[0]!.includes(command.slice(0, 20))) {
      return lines.slice(1).join("\n").trim();
    }
    return output;
  }
}
