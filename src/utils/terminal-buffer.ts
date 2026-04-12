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

// ── TerminalBuffer ──────────────────────────────────────────────

export class TerminalBuffer {
  private readonly term: any;
  private readonly serializeAddon: any;

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
    bus.on("shell:pty-data", ({ raw }) => { tb.write(raw); });
    return tb;
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
  readScreen(): ScreenSnapshot {
    const raw = this.serializeAddon.serialize();
    return {
      text: stripAnsi(raw),
      altScreen: this.term.buffer.active.type === "alternate",
      cursorX: this.term.buffer.active.cursorX,
      cursorY: this.term.buffer.active.cursorY,
    };
  }

  /**
   * Get terminal screen as lines, padded/trimmed to exactly `rows` lines.
   * Clean text only (ANSI stripped).
   */
  getScreenLines(rows?: number): string[] {
    const targetRows = rows ?? (process.stdout.rows || 24);
    const raw = this.serializeAddon.serialize();
    const lines = stripAnsi(raw).split("\n");
    while (lines.length < targetRows) lines.push("");
    return lines.slice(0, targetRows);
  }

  /** Get cursor position. */
  getCursor(): { x: number; y: number } {
    return {
      x: this.term.buffer.active.cursorX,
      y: this.term.buffer.active.cursorY,
    };
  }

  /** Whether the alternate screen buffer is active. */
  get altScreen(): boolean {
    return this.term.buffer.active.type === "alternate";
  }
}
