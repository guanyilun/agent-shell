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

    // If we were already capturing before this chunk (and still are), append
    // the full chunk. If capture just started in parsePromptMarker above, the
    // tail after the start marker is already in promptBuffer — don't double-add.
    if (wasCapturing && this.capturingPrompt) {
      this.promptBuffer += data;
    }

    // Check for end marker. Must run after the append above so that
    // multi-chunk captures include this chunk's data before we finalize.
    this.parsePromptEnd(data);
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
   *
   * By the time this runs, the current chunk has already been appended to
   * promptBuffer (either by parsePromptMarker for the first chunk, or by
   * the wasCapturing guard in processData for subsequent chunks). So we
   * just need to trim everything from the end marker onward.
   */
  private parsePromptEnd(data: string): void {
    if (!this.capturingPrompt) return;
    if (!data.includes("\x1b]9998;READY\x07")) return;

    // promptBuffer already contains this chunk's data. Find the end marker
    // within the buffer and trim everything from it onward.
    const endMarker = "\x1b]9998;READY\x07";
    const bufEndIdx = this.promptBuffer.indexOf(endMarker);
    if (bufEndIdx >= 0) {
      this.promptBuffer = this.promptBuffer.slice(0, bufEndIdx);
    }

    this.capturingPrompt = false;
    this.promptCaptureComplete = true;
    this.lastPrompt = this.sanitizePromptForReplay(this.promptBuffer);
  }

  /**
   * Strip internal OSC markers from captured prompt so replay is clean.
   * We intentionally strip all OSC 7 sequences — they're used for cwd
   * reporting and have no visual effect, so replaying them would just
   * cause duplicate cwd-change events.
   */
  private sanitizePromptForReplay(raw: string): string {
    return raw
      .replace(/\x1b\]7;[^\x07]*\x07/g, "")   // OSC 7 (cwd reporting)
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
