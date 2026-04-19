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

/**
 * Check if a Unicode code point is a wide character (CJK, fullwidth, emoji, etc.)
 * Returns 2 for wide chars, 1 for normal chars, 0 for combining chars.
 *
 * Based on East Asian Width and Unicode categories.
 */
export function charWidth(codePoint: number): number {
  // Combining characters (zero width)
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0; // Combining Diacritical Marks
  if (codePoint >= 0x1ab0 && codePoint <= 0x1aff) return 0; // Combining Diacritical Marks Extended
  if (codePoint >= 0x1dc0 && codePoint <= 0x1dff) return 0; // Combining Diacritical Marks Supplement
  if (codePoint >= 0x20d0 && codePoint <= 0x20ff) return 0; // Combining Diacritical Marks for Symbols
  if (codePoint >= 0xfe20 && codePoint <= 0xfe2f) return 0; // Combining Half Marks
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 0; // Variation Selectors
  if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) return 0; // Variation Selectors Supplement

  // Emoji and symbols that render as wide (2 columns)
  // Emoji presentation sequences and keycap
  if (codePoint === 0x20e3) return 2; // Combining Enclosing Keycap

  // Emoji blocks
  if (codePoint >= 0x1f600 && codePoint <= 0x1f64f) return 2; // Emoticons
  if (codePoint >= 0x1f300 && codePoint <= 0x1f5ff) return 2; // Misc Symbols and Pictographs
  if (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) return 2; // Transport and Map
  if (codePoint >= 0x1f700 && codePoint <= 0x1f77f) return 2; // Alchemical Symbols
  if (codePoint >= 0x1f780 && codePoint <= 0x1f7ff) return 2; // Geometric Shapes Extended
  if (codePoint >= 0x1f800 && codePoint <= 0x1f8ff) return 2; // Supplemental Arrows-C
  if (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) return 2; // Supplemental Symbols and Pictographs
  if (codePoint >= 0x1fa00 && codePoint <= 0x1faff) return 2; // Chess Symbols, Symbols and Pictographs Extended-A
  // NOTE: 0x2300-0x23ff (Misc Technical), 0x2600-0x26ff (Misc Symbols),
  // and 0x2700-0x27bf (Dingbats) are intentionally NOT width 2 — these ranges
  // contain mostly "Ambiguous" width characters that render as 1 column in
  // non-CJK terminal locales (e.g. ❯, ⌘, ★, ♦).

  // Regional indicator symbols (flag emoji components)
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return 2;

  // CJK Unified Ideographs
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return 2;
  // CJK Unified Ideographs Extension A
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return 2;
  // Hangul Syllables
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) return 2;
  // CJK Unified Ideographs Extension B-F and other CJK blocks
  if (codePoint >= 0x20000 && codePoint <= 0x2ebef) return 2;
  // Fullwidth ASCII variants
  if (codePoint >= 0xff01 && codePoint <= 0xff5e) return 2;
  // Fullwidth bracket forms
  if (codePoint >= 0xff5f && codePoint <= 0xff60) return 2;
  // Fullwidth symbol variants
  if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 2;
  // Japanese hiragana and katakana
  if (codePoint >= 0x3040 && codePoint <= 0x309f) return 2;
  if (codePoint >= 0x30a0 && codePoint <= 0x30ff) return 2;
  // CJK symbols and punctuation
  if (codePoint >= 0x3000 && codePoint <= 0x303f) return 2;
  // Enclosed CJK letters and months
  if (codePoint >= 0x3200 && codePoint <= 0x32ff) return 2;
  // CJK compatibility
  if (codePoint >= 0x3300 && codePoint <= 0x33ff) return 2;
  // Hangul Jamo
  if (codePoint >= 0x1100 && codePoint <= 0x11ff) return 2;
  // Hangul compatibility Jamo
  if (codePoint >= 0x3130 && codePoint <= 0x318f) return 2;

  return 1;
}

/**
 * Measure visible string length in terminal columns.
 * Excludes SGR (color/style) sequences and accounts for CJK double-width chars.
 */
export function visibleLen(str: string): number {
  // First strip ANSI escape sequences
  const cleanStr = str.replace(/\x1b\[[^m]*m/g, "");

  let width = 0;
  for (const char of cleanStr) {
    width += charWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

/**
 * Truncate a string to fit within `maxWidth` visible columns.
 * Accounts for CJK double-width characters. Appends `…` if truncated.
 */
export function truncateToWidth(str: string, maxWidth: number): string {
  const clean = str.replace(/\x1b\[[^m]*m/g, "");
  if (maxWidth < 2) return clean.slice(0, maxWidth > 0 ? 1 : 0);
  // First check if the entire string fits
  let fullWidth = 0;
  for (const char of clean) {
    fullWidth += charWidth(char.codePointAt(0) ?? 0);
  }
  if (fullWidth <= maxWidth) return clean;
  // String doesn't fit — truncate with "…"
  // Reserve 1 column for "…", so target content width is maxWidth - 1
  const target = maxWidth - 1;
  let width = 0;
  let i = 0;
  for (const char of clean) {
    const cw = charWidth(char.codePointAt(0) ?? 0);
    if (width + cw > target) break;
    width += cw;
    i += char.length;
  }
  // If we consumed nothing (first char is wider than target), take at least 1 char
  if (i === 0) i = (clean.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
  return clean.slice(0, i) + "…";
}

/**
 * Pad a string with spaces to fill `targetWidth` visible columns.
 * Accounts for CJK double-width characters.
 */
export function padEndToWidth(str: string, targetWidth: number): string {
  const gap = targetWidth - visibleLen(str);
  return gap > 0 ? str + " ".repeat(gap) : str;
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
