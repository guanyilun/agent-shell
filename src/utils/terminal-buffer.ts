/**
 * Headless terminal buffer backed by xterm.js.
 *
 * Provides accurate terminal screen capture — correctly handles ANSI
 * codes, cursor movement, alternate screen (vim/htop), line wrapping,
 * and scrollback.
 *
 * Used by:
 *   - floating-panel.ts: composited overlay rendering + screen restore
 *   - terminal-buffer extension: agent tools (terminal_read, terminal_keys)
 *   - Any extension needing a virtual terminal snapshot
 *
 * The xterm dependency is loaded lazily on first use. If @xterm/headless
 * is not installed, create() returns null.
 *
 * Install (optional):
 *   npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 */
import { createRequire } from "module";
import { stripAnsi } from "./ansi.js";
import type { EventBus } from "../event-bus.js";

// ── Lazy xterm loader ───────────────────────────────────────────

const require = createRequire(import.meta.url);

let loadAttempted = false;
let available = false;
let TerminalCtor: any;
let SerializeAddonCtor: any;

function ensureXterm(): boolean {
  if (loadAttempted) return available;
  loadAttempted = true;
  try {
    TerminalCtor = require("@xterm/headless").Terminal;
    SerializeAddonCtor = require("@xterm/addon-serialize").SerializeAddon;
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/** Check if @xterm/headless is installed without loading it. */
export function isXtermAvailable(): boolean {
  return ensureXterm();
}

// ── Types ───────────────────────────────────────────────────────

export interface TerminalBufferConfig {
  /** Terminal width in columns. Default: process.stdout.columns || 80. */
  cols?: number;
  /** Terminal height in rows. Default: process.stdout.rows || 24. */
  rows?: number;
  /** Scrollback buffer size. Default: 200. */
  scrollback?: number;
}

export interface ScreenSnapshot {
  /** Clean text with ANSI sequences stripped. */
  text: string;
  /** Whether the alternate screen buffer is active (vim, htop, etc.). */
  altScreen: boolean;
  /** Cursor position. */
  cursorX: number;
  cursorY: number;
}

/**
 * Format a screen snapshot as an XML context block for agent injection.
 * Trims, caps to `maxLines` (from the bottom), and wraps in `<terminal_buffer>`.
 * Returns the combined context string (baseContext + section), or just
 * baseContext if the screen is empty.
 */
export function formatScreenContext(
  screen: ScreenSnapshot,
  maxLines = 80,
  baseContext?: string,
): string {
  const trimmed = screen.text.trim();
  if (!trimmed) return baseContext ?? "";

  const lines = trimmed.split("\n");
  const capped = lines.length > maxLines
    ? lines.slice(-maxLines).join("\n")
    : trimmed;

  const header = screen.altScreen
    ? "<terminal_buffer mode=\"alternate\">"
    : "<terminal_buffer>";
  const section = `${header}\n${capped}\n</terminal_buffer>`;
  return baseContext ? baseContext + "\n" + section : section;
}

// ── TerminalBuffer ──────────────────────────────────────────────

export class TerminalBuffer {
  private readonly term: any;
  private readonly serializeAddon: any;

  /** Flush pending drip-feed data (set by createWired). */
  _flushPending: (() => void) | null = null;

  private constructor(term: any, serialize: any) {
    this.term = term;
    this.serializeAddon = serialize;
  }

  /**
   * Create a new TerminalBuffer. Returns null if xterm is not installed.
   */
  static create(config?: TerminalBufferConfig): TerminalBuffer | null {
    if (!ensureXterm()) return null;
    const cols = config?.cols ?? (process.stdout.columns || 80);
    const rows = config?.rows ?? (process.stdout.rows || 24);
    const scrollback = config?.scrollback ?? 200;

    const term = new TerminalCtor({ cols, rows, allowProposedApi: true, scrollback });
    const serialize = new SerializeAddonCtor();
    term.loadAddon(serialize);
    return new TerminalBuffer(term, serialize);
  }

  /**
   * Create a TerminalBuffer and wire it to a bus's shell:pty-data event.
   * Returns null if xterm is not installed.
   */
  static createWired(bus: EventBus, config?: TerminalBufferConfig): TerminalBuffer | null {
    const tb = TerminalBuffer.create(config);
    if (!tb) return null;
    // Buffer PTY data and drip-feed to xterm in the background.
    // Synchronous term.write() in the pty-data handler introduces enough
    // latency to change PTY read coalescing, causing visual artifacts.
    let pending = "";
    bus.on("shell:pty-data", ({ raw }) => { pending += raw; });
    setInterval(() => {
      if (pending) { const d = pending; pending = ""; tb.write(d); }
    }, 50);
    tb._flushPending = () => {
      if (pending) { const d = pending; pending = ""; tb.write(d); }
    };
    process.stdout.on("resize", () => {
      tb.resize(process.stdout.columns || 80, process.stdout.rows || 24);
    });
    return tb;
  }

  /** Flush any pending drip-feed data into the virtual terminal. */
  flush(): void {
    this._flushPending?.();
  }

  /** Write raw data into the virtual terminal. */
  write(data: string): void {
    this.term.write(data);
  }

  /** Get the raw serialized terminal output (includes ANSI sequences). */
  serialize(): string {
    return this.serializeAddon.serialize();
  }

  /** Read clean screen text with metadata. */
  readScreen(opts?: { includeScrollback?: boolean }): ScreenSnapshot {
    const buf = this.term.buffer.active;
    const lines = opts?.includeScrollback
      ? this.readAllLines(buf)
      : this.readViewportLines(buf);
    return {
      text: lines.join("\n"),
      altScreen: buf.type === "alternate",
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
    };
  }

  /**
   * Get terminal screen as lines, padded/trimmed to exactly `rows` lines.
   * Clean text only (ANSI stripped).  Reads from the active buffer's
   * viewport (not scrollback), so it works correctly on both the normal
   * and alternate screen buffers.
   */
  getScreenLines(rows?: number): string[] {
    const targetRows = rows ?? (process.stdout.rows || 24);
    return this.readViewportLines(this.term.buffer.active, targetRows);
  }

  /** Read visible viewport lines from a buffer. */
  private readViewportLines(buf: any, rows?: number): string[] {
    const targetRows = rows ?? buf.length;
    const base = buf.baseY ?? 0;
    const lines: string[] = [];
    for (let y = 0; y < targetRows; y++) {
      const line = buf.getLine(base + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines;
  }

  /** Read all lines including scrollback from a buffer. */
  private readAllLines(buf: any): string[] {
    const total = (buf.baseY ?? 0) + buf.length;
    const lines: string[] = [];
    for (let y = 0; y < total; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : "");
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  }

  /** Get cursor position. */
  getCursor(): { x: number; y: number } {
    return {
      x: this.term.buffer.active.cursorX,
      y: this.term.buffer.active.cursorY,
    };
  }

  /** Resize the virtual terminal. */
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** Whether the alternate screen buffer is active. */
  get altScreen(): boolean {
    return this.term.buffer.active.type === "alternate";
  }
}
