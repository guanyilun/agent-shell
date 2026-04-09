// ── ANSI escape code constants ────────────────────────────────

export const CYAN = "\x1b[36m";
export const DIM = "\x1b[2m";
export const YELLOW = "\x1b[33m";
export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const GRAY = "\x1b[90m";
export const BOLD = "\x1b[1m";
export const RESET = "\x1b[0m";

// ── ANSI utility functions ───────────────────────────────────

/** Measure visible string length, excluding SGR (color/style) sequences. */
export function visibleLen(str: string): number {
  return str.replace(/\x1b\[[^m]*m/g, "").length;
}

/** Strip all ANSI escape sequences (SGR, OSC, CSI, private mode) and carriage returns. */
export function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\][^\x07]*\x07/g, "")        // OSC sequences
    .replace(/\x1b\[[^m]*m/g, "")                // SGR (color) sequences
    .replace(/\x1b\[\?[^a-zA-Z]*[a-zA-Z]/g, "") // private mode sequences
    .replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "")   // CSI sequences
    .replace(/\r/g, "");                          // carriage returns
}
