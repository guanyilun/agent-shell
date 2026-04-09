import type { EventBus } from "./event-bus.js";
import { stripAnsi } from "./utils/ansi.js";

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
  private capturingPrompt = false;
  private promptCaptureComplete = false;
  private promptBuffer = "";
  private lastPrompt = "";

  constructor(bus: EventBus, initialCwd: string) {
    this.bus = bus;
    this.cwd = initialCwd;
  }

  /** Process a chunk of PTY output data. */
  processData(data: string): void {
    this.parseOSC7(data);

    // Bracketed prompt capture: accumulate bytes between OSC 9999 and 9998.
    // parsePromptMarker may start capture (setting promptBuffer to the tail
    // of the current chunk), so we only append subsequent chunks here.
    const wasCapturing = this.capturingPrompt;
    this.parsePromptMarker(data);
    this.parsePromptEnd(data);

    // If we were already capturing before this chunk, append it.
    // (If capture just started in parsePromptMarker, the tail is already in promptBuffer.)
    if (wasCapturing && this.capturingPrompt) {
      this.promptBuffer += data;
    }
  }

  /** Called when user presses Enter on a non-empty line. */
  onCommandEntered(command: string, cwd: string): void {
    this.lastCommand = command;
    this.currentOutputCapture = "";
    this.bus.emit("shell:command-start", { command, cwd });
    if (!this.foregroundBusy) {
      this.foregroundBusy = true;
      this.bus.emit("shell:foreground-busy", { busy: true });
    }
  }

  /** Returns the full captured prompt bytes, or empty if incomplete. */
  getLastPrompt(): string {
    if (!this.promptCaptureComplete) return "";
    return this.lastPrompt;
  }

  /**
   * Returns just the last line of the captured prompt (e.g. p10k's "❯ " line).
   * This is safe to replay with \r because it's linear text (colors + chars),
   * not relative cursor positioning. Returns empty if no complete capture.
   */
  getLastPromptLine(): string {
    if (!this.promptCaptureComplete) return "";
    // Find the last \r\n or \n — everything after it is the final prompt line
    const lastNewline = this.lastPrompt.lastIndexOf("\n");
    if (lastNewline < 0) return this.lastPrompt;
    return this.lastPrompt.slice(lastNewline + 1);
  }

  isPromptCaptureComplete(): boolean {
    return this.promptCaptureComplete;
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
      if (this.foregroundBusy) {
        this.foregroundBusy = false;
        this.bus.emit("shell:foreground-busy", { busy: false });
      }
      if (this.lastCommand) {
        const output = stripAnsi(this.currentOutputCapture).trim();
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

      // Start bracketed prompt capture: accumulate bytes until OSC 9998
      this.capturingPrompt = true;
      this.promptCaptureComplete = false;
      this.promptBuffer = "";
      const markerEnd = data.indexOf("\x1b]9999;PROMPT\x07") + "\x1b]9999;PROMPT\x07".length;
      if (markerEnd < data.length) {
        this.promptBuffer = data.slice(markerEnd);
      }
    } else {
      this.currentOutputCapture += data;
    }
  }


  /**
   * Detect end-of-prompt marker (OSC 9998). Finalizes the bracketed capture.
   */
  private parsePromptEnd(data: string): void {
    if (!this.capturingPrompt) return;
    if (!data.includes("\x1b]9998;READY\x07")) return;

    // Append the portion of this chunk before the end marker
    const endIdx = data.indexOf("\x1b]9998;READY\x07");
    this.promptBuffer += data.slice(0, endIdx);

    this.capturingPrompt = false;
    this.promptCaptureComplete = true;
    this.lastPrompt = this.sanitizePromptForReplay(this.promptBuffer);
  }

  /** Strip internal OSC markers from captured prompt so replay is clean. */
  private sanitizePromptForReplay(raw: string): string {
    return raw
      .replace(/\x1b\]7;[^\x07]*\x07/g, "")   // OSC 7 (cwd)
      .replace(/\x1b\]9999;PROMPT\x07/g, "")    // start marker
      .replace(/\x1b\]9998;READY\x07/g, "");    // end marker
  }

  private removeEchoedCommand(output: string, command: string): string {
    const lines = output.split("\n");
    if (lines.length > 0 && lines[0]!.includes(command.slice(0, 20))) {
      return lines.slice(1).join("\n").trim();
    }
    return output;
  }
}
