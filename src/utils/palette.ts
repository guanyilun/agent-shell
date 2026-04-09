/**
 * Semantic color palette with a small set of base roles.
 *
 * Components use these roles instead of raw ANSI escapes.
 * Extensions can override via setPalette() for theming.
 *
 * Design: ~10 base slots that cover all UI needs. Components
 * derive specific uses from these (e.g. "diff added" = success,
 * "tool title" = warning, "user query border" = accent).
 */

export interface ColorPalette {
  // ── Semantic foreground roles ─────────────────────────────
  accent: string;   // primary highlight — user queries, spinner, links
  success: string;  // positive — diff added, checkmarks
  warning: string;  // attention — tool titles, agent prompt
  error: string;    // negative — diff removed, errors
  muted: string;    // de-emphasized — info, context lines, borders

  // ── True-color backgrounds (diff highlighting) ────────────
  successBg: string;      // subtle green tint for added lines
  errorBg: string;        // subtle red tint for removed lines
  successBgEmph: string;  // stronger green for changed tokens
  errorBgEmph: string;    // stronger red for changed tokens

  // ── Style modifiers ───────────────────────────────────────
  bold: string;
  dim: string;
  italic: string;
  reset: string;
}

const defaultPalette: ColorPalette = {
  accent:  "\x1b[36m",   // cyan
  success: "\x1b[32m",   // green
  warning: "\x1b[33m",   // yellow
  error:   "\x1b[31m",   // red
  muted:   "\x1b[90m",   // gray

  successBg:     "\x1b[48;2;0;60;0m",
  errorBg:       "\x1b[48;2;50;0;0m",
  successBgEmph: "\x1b[48;2;0;112;0m",
  errorBgEmph:   "\x1b[48;2;90;0;0m",

  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  italic: "\x1b[3m",
  reset:  "\x1b[0m",
};

/** Active palette — import and use directly in components. */
export const palette: ColorPalette = { ...defaultPalette };

/** Override palette slots. Merges with current values. */
export function setPalette(overrides: Partial<ColorPalette>): void {
  Object.assign(palette, overrides);
}

/** Reset palette to defaults. */
export function resetPalette(): void {
  Object.assign(palette, defaultPalette);
}
