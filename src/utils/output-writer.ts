/**
 * Abstraction over terminal output.
 *
 * All TUI rendering goes through an OutputWriter instead of calling
 * process.stdout.write directly.  This enables testing (BufferWriter),
 * alternative frontends, and a single point of control for output.
 */

/** Simple ref-counted counter. Increment/decrement never goes below zero. */
export class RefCounter {
  private count = 0;
  increment(): void { this.count++; }
  decrement(): void { this.count = Math.max(0, this.count - 1); }
  reset(): void { this.count = 0; }
  get active(): boolean { return this.count > 0; }
  get value(): number { return this.count; }
}

export interface OutputWriter {
  write(text: string): void;
  get columns(): number;
}

/** Default writer that forwards to process.stdout. */
export class StdoutWriter implements OutputWriter {
  /** When > 0, all writes are silently dropped. Ref-counted. */
  private readonly _hold = new RefCounter();

  hold(): void { this._hold.increment(); }
  release(): void { this._hold.decrement(); }
  get held(): boolean { return this._hold.active; }

  write(text: string): void {
    if (this._hold.active) return;
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
