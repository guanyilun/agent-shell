import type { EventBus } from "../event-bus.js";
import { stripAnsi } from "../utils/ansi.js";

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
  private promptReady = false;

  constructor(bus: EventBus, initialCwd: string) {
    this.bus = bus;
    this.cwd = initialCwd;
  }

  /** Process a chunk of PTY output data. */
  processData(data: string): void {
    this.parseOSC7(data);
    data = this.handlePreexec(data);
    this.parsePromptMarker(data);
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

  /** Whether the shell's prompt is fully rendered and ready for input. */
  isPromptReady(): boolean {
    return this.promptReady;
  }

  isForegroundBusy(): boolean {
    return this.foregroundBusy;
  }

  getCwd(): string {
    return this.cwd;
  }

  // ── Parsing ─────────────────────────────────────────────────

  /**
   * Detect preexec marker (OSC 9997) emitted by the shell's preexec hook.
   * This carries the actual command text from the shell — more reliable than
   * the InputHandler's lineBuffer which can't track history recall or tab
   * completion. Returns data with the OSC stripped out.
   */
  private handlePreexec(data: string): string {
    const marker = "\x1b]9997;";
    const idx = data.indexOf(marker);
    if (idx === -1) return data;

    const endIdx = data.indexOf("\x07", idx + marker.length);
    if (endIdx === -1) return data; // incomplete OSC, wait for next chunk

    const command = data.slice(idx + marker.length, endIdx);

    // Authoritative command from the shell — override any lineBuffer guess
    this.lastCommand = command;
    this.currentOutputCapture = ""; // discard echoed text accumulated before preexec

    if (!this.foregroundBusy) {
      this.foregroundBusy = true;
      this.bus.emit("shell:foreground-busy", { busy: true });
    }
    this.bus.emit("shell:command-start", { command, cwd: this.cwd });

    // Return only data after the OSC — everything before was the echo
    return data.slice(endIdx + 1);
  }

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
    const marker = "\x1b]9999;PROMPT\x07";
    const markerIdx = data.indexOf(marker);
    if (markerIdx !== -1) {
      // Capture any output that arrived in the same chunk before the marker
      if (markerIdx > 0) {
        this.currentOutputCapture += data.slice(0, markerIdx);
      }
      this.promptReady = false;
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
    } else {
      // Cap capture buffer to avoid unbounded growth when a foreground
      // program (tmux, vim, etc.) produces output without prompt markers.
      // Keep only the tail — the final output is what matters for
      // command-done context.
      const MAX_CAPTURE = 128 * 1024; // 128 KB
      this.currentOutputCapture += data;
      if (this.currentOutputCapture.length > MAX_CAPTURE) {
        this.currentOutputCapture = this.currentOutputCapture.slice(-MAX_CAPTURE);
      }
    }
  }

  /**
   * Detect end-of-prompt marker (OSC 9998). The prompt is fully rendered
   * and the shell is ready for input.
   */
  private parsePromptEnd(data: string): void {
    if (data.includes("\x1b]9998;READY\x07")) {
      this.promptReady = true;
    }
  }

  private removeEchoedCommand(output: string, command: string): string {
    const lines = output.split("\n");
    if (lines.length > 0 && lines[0]!.includes(command.slice(0, 20))) {
      return lines.slice(1).join("\n").trim();
    }
    return output;
  }
}
