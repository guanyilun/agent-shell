/**
 * Differential frame renderer.
 *
 * Accepts a frame (string[]) and writes only the lines that changed
 * compared to the previous frame.  Designed for scrolling content
 * (not full-screen ownership like pi-tui).
 *
 * Fast paths:
 *   1. First render → write everything
 *   2. Append-only → write only new lines
 *   3. Last line changed → \r overwrite (for spinner / partial streaming)
 *   4. General diff → cursor-up, rewrite changed region, cursor-down
 */
import type { OutputWriter } from "./output-writer.js";

export class FrameRenderer {
  private prevLines: string[] = [];

  constructor(private writer: OutputWriter) {}

  /**
   * Render a new frame, writing only the diff to the output.
   * Each line in `lines` should NOT include a trailing newline.
   */
  update(lines: string[]): void {
    const prev = this.prevLines;

    if (prev.length === 0) {
      // Fast path 1: first render
      for (const line of lines) {
        this.writer.write(line + "\n");
      }
      this.prevLines = lines.slice();
      return;
    }

    // Find first and last changed indices
    const minLen = Math.min(prev.length, lines.length);
    let firstChanged = -1;
    let lastChanged = -1;

    for (let i = 0; i < minLen; i++) {
      if (prev[i] !== lines[i]) {
        if (firstChanged === -1) firstChanged = i;
        lastChanged = i;
      }
    }

    // Check for appended or removed lines
    const appended = lines.length > prev.length;
    const truncated = lines.length < prev.length;

    if (firstChanged === -1 && !appended && !truncated) {
      // No changes at all
      this.prevLines = lines.slice();
      return;
    }

    if (firstChanged === -1 && appended) {
      // Fast path 2: only new lines appended, existing unchanged
      for (let i = prev.length; i < lines.length; i++) {
        this.writer.write(lines[i] + "\n");
      }
      this.prevLines = lines.slice();
      return;
    }

    // General diff: move cursor up to first changed line, rewrite
    const linesFromBottom = prev.length - (firstChanged === -1 ? prev.length : firstChanged);
    if (linesFromBottom > 0) {
      this.writer.write(`\x1b[${linesFromBottom}A`); // cursor up
    }
    this.writer.write("\r"); // start of line

    // Rewrite from firstChanged to end of new frame
    const start = firstChanged === -1 ? prev.length : firstChanged;
    for (let i = start; i < lines.length; i++) {
      this.writer.write(`\x1b[2K${lines[i]}\n`); // clear line + write + newline
    }

    // If new frame is shorter, clear remaining old lines
    if (truncated) {
      for (let i = lines.length; i < prev.length; i++) {
        this.writer.write("\x1b[2K\n");
      }
      // Move cursor back up to end of new content
      const extra = prev.length - lines.length;
      if (extra > 0) {
        this.writer.write(`\x1b[${extra}A`);
      }
    }

    this.prevLines = lines.slice();
  }

  /** Reset state — next update will be treated as a first render. */
  reset(): void {
    this.prevLines = [];
  }
}
