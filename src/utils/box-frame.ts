/**
 * Box frame component for bordered TUI panels.
 *
 * Follows the render(width) -> string[] protocol — pure function,
 * never writes to stdout. Supports multiple border styles and
 * optional title/footer sections with dividers.
 */
import { visibleLen, truncateToWidth } from "./ansi.js";
import { palette as p } from "./palette.js";

// ── Types ────────────────────────────────────────────────────────

export type BorderStyle = "rounded" | "square" | "double" | "heavy";

interface BorderChars {
  tl: string; // top-left
  tr: string; // top-right
  bl: string; // bottom-left
  br: string; // bottom-right
  h: string;  // horizontal
  v: string;  // vertical
  ml: string; // middle-left (├)
  mr: string; // middle-right (┤)
}

const BORDERS: Record<BorderStyle, BorderChars> = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", ml: "├", mr: "┤" },
  square:  { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", ml: "├", mr: "┤" },
  double:  { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", ml: "╠", mr: "╣" },
  heavy:   { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃", ml: "┣", mr: "┫" },
};

export interface BoxFrameOptions {
  /** Total width including borders. */
  width: number;
  /** Border style. Default "rounded". */
  style?: BorderStyle;
  /** Border color (ANSI escape). Default DIM. */
  borderColor?: string;
  /** Title text shown on the left of the top border. */
  title?: string;
  /** Title text shown on the right of the top border. */
  titleRight?: string;
  /** Footer lines shown below a divider, inside the box. */
  footer?: string[];
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Render content lines inside a bordered frame.
 *
 * @param content - Array of pre-rendered content lines (no border)
 * @param opts - Frame options
 * @returns Array of terminal-ready lines with borders
 */
export function renderBoxFrame(content: string[], opts: BoxFrameOptions): string[] {
  const { width: rawWidth, borderColor = p.dim } = opts;
  const width = Math.max(6, rawWidth);
  const style = opts.style ?? "rounded";
  const b = BORDERS[style];
  const bc = borderColor;

  // Content area width = total - 2 borders - 2 padding spaces
  const innerW = Math.max(1, width - 4);
  const output: string[] = [];

  // Top border (with optional left/right titles)
  if (opts.title || opts.titleRight) {
    const leftPart = opts.title
      ? `${p.reset} ${opts.title} ${bc}`
      : "";
    const leftVis = opts.title ? visibleLen(opts.title) + 2 : 0; // +2 for spaces

    const rightPart = opts.titleRight
      ? `${p.reset} ${opts.titleRight} ${bc}`
      : "";
    const rightVis = opts.titleRight ? visibleLen(opts.titleRight) + 2 : 0;

    const dashCount = Math.max(1, width - 2 - leftVis - rightVis);
    output.push(
      `${bc}${b.tl}${leftPart}${b.h.repeat(dashCount)}${rightPart}${b.tr}${p.reset}`,
    );
  } else {
    output.push(`${bc}${b.tl}${b.h.repeat(width - 2)}${b.tr}${p.reset}`);
  }

  // Content lines
  for (const line of content) {
    output.push(boxLine(line, innerW, b.v, bc));
  }

  // Footer with divider
  if (opts.footer && opts.footer.length > 0) {
    output.push(`${bc}${b.ml}${b.h.repeat(width - 2)}${b.mr}${p.reset}`);
    for (const line of opts.footer) {
      output.push(boxLine(line, innerW, b.v, bc));
    }
  }

  // Bottom border
  output.push(`${bc}${b.bl}${b.h.repeat(width - 2)}${b.br}${p.reset}`);

  return output;
}

// ── Helpers ──────────────────────────────────────────────────────

function boxLine(text: string, innerW: number, v: string, bc: string): string {
  const textWidth = visibleLen(text);
  if (textWidth > innerW) {
    // Content is too wide — truncate to fit exactly
    const truncated = truncateToWidth(text, innerW);
    return `${bc}${v}${p.reset} ${truncated} ${bc}${v}${p.reset}`;
  }
  const pad = innerW - textWidth;
  return `${bc}${v}${p.reset} ${text}${" ".repeat(pad)} ${bc}${v}${p.reset}`;
}
