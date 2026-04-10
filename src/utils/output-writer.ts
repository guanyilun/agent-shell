/**
 * Abstraction over terminal output.
 *
 * All TUI rendering goes through an OutputWriter instead of calling
 * process.stdout.write directly.  This enables testing (BufferWriter),
 * alternative frontends, and a single point of control for output.
 */

export interface OutputWriter {
  write(text: string): void;
  get columns(): number;
}

/** Default writer that forwards to process.stdout. */
export class StdoutWriter implements OutputWriter {
  write(text: string): void {
    if (process.stdout.writable) {
      try { process.stdout.write(text); } catch {}
    }
  }
  get columns(): number {
    return process.stdout.columns || 80;
  }
}

/** Captures all output in memory. Useful for testing. */
export class BufferWriter implements OutputWriter {
  output: string[] = [];
  columns = 80;
  write(text: string): void {
    this.output.push(text);
  }
}
