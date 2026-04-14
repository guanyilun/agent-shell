import { visibleLen, truncateToWidth, padEndToWidth } from "./ansi.js";
import { palette as p } from "./palette.js";

export const MAX_CONTENT_WIDTH = 90;

/**
 * Word-wrap a string (which may contain ANSI codes) to a maximum visible width.
 * Returns an array of lines, each fitting within `maxWidth` visible characters.
 */
export function wrapLine(text: string, maxWidth: number): string[] {
  if (!(maxWidth > 0)) return [text]; // catches NaN, <=0, undefined
  if (visibleLen(text) <= maxWidth) return [text];

  const result: string[] = [];
  // Split into segments: ANSI codes and visible text
  const segments = text.match(/(\x1b\[[^m]*m|[^\x1b]+)/g) || [text];

  let currentLine = "";
  let currentWidth = 0;
  let activeStyles = ""; // track ANSI styles to reapply after wraps

  for (const seg of segments) {
    if (seg.startsWith("\x1b[")) {
      // ANSI code — track it, add to current line
      currentLine += seg;
      if (seg === p.reset) {
        activeStyles = "";
      } else {
        activeStyles += seg;
      }
      continue;
    }

    // Visible text — split into words
    const words = seg.split(/( +)/);
    for (const word of words) {
      if (word.length === 0) continue;

      if (currentWidth + word.length <= maxWidth) {
        currentLine += word;
        currentWidth += word.length;
      } else if (currentWidth === 0) {
        // Single word longer than maxWidth — hard break
        let remaining = word;
        while (remaining.length > 0) {
          const chunk = remaining.slice(0, maxWidth - currentWidth || maxWidth);
          remaining = remaining.slice(chunk.length);
          currentLine += chunk;
          if (remaining.length > 0) {
            result.push(currentLine + p.reset);
            currentLine = activeStyles;
            currentWidth = 0;
          } else {
            currentWidth += chunk.length;
          }
        }
      } else {
        // Wrap to next line
        result.push(currentLine + p.reset);
        currentLine = activeStyles;
        currentWidth = 0;
        // Skip leading spaces on new line
        const trimmed = word.replace(/^ +/, "");
        currentLine += trimmed;
        currentWidth = trimmed.length;
      }
    }
  }

  if (currentLine.length > 0) {
    result.push(currentLine);
  }

  return result;
}

/**
 * Streaming markdown renderer that processes chunks of text,
 * renders complete lines with ANSI formatting, and wraps output
 * in a bordered box.
 *
 * The renderer accumulates lines internally. Call `drainLines()` to
 * extract them — this is the only way output leaves the renderer.
 */
export class MarkdownRenderer {
  private buffer = "";
  private contentWidth: number;
  private firstLine = true;
  private lastLineBlank = false;
  private pendingLines: string[] = [];
  private width: number;
  private tableRows: string[][] = [];

  constructor(width: number) {
    this.width = Math.max(10, width);
    this.contentWidth = Math.min(MAX_CONTENT_WIDTH, this.width - 2);
  }

  /**
   * Push a streaming chunk. Complete lines are rendered immediately;
   * incomplete trailing text stays in the buffer.
   */
  push(chunk: string): void {
    this.buffer += chunk;
    this.processBuffer();
  }

  /**
   * Flush any remaining text in the buffer (called when the response ends).
   */
  flush(): void {
    if (this.buffer.length > 0) {
      this.processLine(this.buffer);
      this.buffer = "";
    }
    this.flushTable();
  }

  printTopBorder(): void {
    this.pendingLines.push(`${p.dim}${p.accent}${"─".repeat(this.width)}${p.reset}`);
    this.firstLine = true;
  }

  printBottomBorder(): void {
    this.pendingLines.push(`${p.dim}${p.accent}${"─".repeat(this.width)}${p.reset}`);
  }

  /**
   * Extract and clear all accumulated lines.
   * This is the only way output leaves the renderer.
   */
  drainLines(): string[] {
    const lines = this.pendingLines;
    this.pendingLines = [];
    return lines;
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;

    for (const line of lines) {
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    // Table row detection: lines with | separators
    if (/^\s*\|/.test(line)) {
      const cells = parseTableRow(line);
      if (cells) {
        this.tableRows.push(cells);
        return;
      }
    }

    // Non-table line — flush any buffered table first
    this.flushTable();

    const rendered = this.renderLine(line);
    const wrapped = wrapLine(rendered, this.contentWidth);
    for (const wl of wrapped) {
      this.writeLine(wl);
    }
  }

  private flushTable(): void {
    if (this.tableRows.length === 0) return;

    const rows = this.tableRows;
    this.tableRows = [];

    // Filter out separator rows (|---|---|)
    const sepIdx: number[] = [];
    const dataRows: string[][] = [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]!.every((c) => /^[-:]+$/.test(c.trim()) || c.trim() === "")) {
        sepIdx.push(i);
      } else {
        dataRows.push(rows[i]!);
      }
    }

    if (dataRows.length === 0) return;

    // Normalize column count
    const numCols = Math.max(...dataRows.map((r) => r.length));
    for (const row of dataRows) {
      while (row.length < numCols) row.push("");
    }

    // Calculate column widths from content
    const colWidths: number[] = new Array(numCols).fill(0);
    for (const row of dataRows) {
      for (let c = 0; c < numCols; c++) {
        colWidths[c] = Math.max(colWidths[c]!, visibleLen(row[c]!));
      }
    }

    // Shrink columns proportionally if total exceeds content width
    // Account for separators: " │ " between cols (3 chars each) + 2 outer padding
    const separatorWidth = (numCols - 1) * 3;
    const availableWidth = this.contentWidth - separatorWidth;
    const totalWidth = colWidths.reduce((a, b) => a + b, 0);
    if (totalWidth > availableWidth && availableWidth > numCols) {
      const scale = availableWidth / totalWidth;
      for (let c = 0; c < numCols; c++) {
        colWidths[c] = Math.max(1, Math.floor(colWidths[c]! * scale));
      }
    }

    // Render rows
    const hasHeader = sepIdx.includes(1) && dataRows.length > 1;

    // Top border
    const topBorder = colWidths.map((w) => "─".repeat(w)).join(`─┬─`);
    this.writeLine(`${p.dim}┌─${topBorder}─┐${p.reset}`);

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i]!;
      const isHeader = hasHeader && i === 0;
      const cells = row.map((cell, c) => {
        const w = colWidths[c]!;
        const text = visibleLen(cell) > w ? truncateToWidth(cell, w) : padEndToWidth(cell, w);
        return isHeader ? `${p.bold}${text}${p.reset}` : text;
      });
      this.writeLine(`${p.dim}│${p.reset} ${cells.join(` ${p.dim}│${p.reset} `)} ${p.dim}│${p.reset}`);

      // Separator after header
      if (isHeader) {
        const sep = colWidths.map((w) => "─".repeat(w)).join(`─┼─`);
        this.writeLine(`${p.dim}├─${sep}─┤${p.reset}`);
      }
    }

    // Bottom border
    const bottomBorder = colWidths.map((w) => "─".repeat(w)).join(`─┴─`);
    this.writeLine(`${p.dim}└─${bottomBorder}─┘${p.reset}`);
  }

  private renderLine(line: string): string {
    if (line.trim() === "") return "";

    // Headings
    const h1 = line.match(/^# (.+)/);
    if (h1) return `${p.bold}${p.warning}${h1[1]}${p.reset}`;

    const h2 = line.match(/^## (.+)/);
    if (h2) return `${p.bold}${p.accent}${h2[1]}${p.reset}`;

    const h3 = line.match(/^### (.+)/);
    if (h3) return `${p.bold}${h3[1]}${p.reset}`;

    const h4 = line.match(/^#{4,} (.+)/);
    if (h4) return `${p.bold}${h4[1]}${p.reset}`;

    // Horizontal rule — subtle short separator, not full-width
    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      return "";
    }

    // Blockquote
    const bq = line.match(/^>\s?(.*)/);
    if (bq) return `${p.muted}│${p.reset} ${p.dim}${p.italic}${this.renderInline(bq[1] || "")}${p.reset}`;

    // Task list (checkbox items) — must come before generic unordered list
    const task = line.match(/^(\s*)[*\-+]\s+\[([ xX])\]\s+(.*)/);
    if (task) {
      const indent = task[1] || "";
      const checked = task[2] !== " ";
      const box = checked
        ? `${p.success}☑${p.reset}`
        : `${p.dim}☐${p.reset}`;
      return `${indent}  ${box} ${this.renderInline(task[3] || "")}`;
    }

    // Unordered list
    const ul = line.match(/^(\s*)[*\-+]\s+(.*)/);
    if (ul) {
      const indent = ul[1] || "";
      return `${indent}  ${p.accent}*${p.reset} ${this.renderInline(ul[2] || "")}`;
    }

    // Ordered list
    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)/);
    if (ol) {
      const indent = ol[1] || "";
      return `${indent}  ${p.accent}${ol[2]}.${p.reset} ${this.renderInline(ol[3] || "")}`;
    }

    return this.renderInline(line);
  }

  private renderInline(text: string): string {
    // Inline code
    text = text.replace(/`([^`]+)`/g, `${p.accent}$1${p.reset}`);
    // Bold + italic
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, `${p.bold}${p.italic}$1${p.reset}`);
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, `${p.bold}$1${p.reset}`);
    text = text.replace(/(?<!\w)__(.+?)__(?!\w)/g, `${p.bold}$1${p.reset}`);
    // Italic
    text = text.replace(/\*(.+?)\*/g, `${p.italic}$1${p.reset}`);
    text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, `${p.italic}$1${p.reset}`);
    // Strikethrough
    text = text.replace(/~~(.+?)~~/g, `${p.dim}$1${p.reset}`);
    // Links
    text = text.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      `$1 ${p.muted}${p.underline}($2)${p.reset}`
    );
    return text;
  }

  /**
   * Add a single line with a subtle left indent.
   * The line is accumulated internally — call drainLines() to extract.
   */
  writeLine(text: string): void {
    const isBlank = visibleLen(text) === 0;
    if (this.firstLine && isBlank) return;
    // Collapse consecutive blank lines to a single one
    if (isBlank && this.lastLineBlank) return;
    this.firstLine = false;
    this.lastLineBlank = isBlank;
    this.pendingLines.push(`  ${text}`);
  }
}

/** Parse a markdown table row into trimmed cell strings, or null if not a table row. */
function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  // Split on |, drop first and last empty entries
  const parts = trimmed.split("|");
  if (parts.length < 3) return null; // need at least |cell|
  return parts.slice(1, -1).map((c) => c.trim());
}
