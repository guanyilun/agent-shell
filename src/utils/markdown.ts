import { visibleLen } from "./ansi.js";
import { palette as p } from "./palette.js";

const MAX_CONTENT_WIDTH = 90;

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
  private pendingLines: string[] = [];
  private width: number;

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
    const rendered = this.renderLine(line);
    const wrapped = wrapLine(rendered, this.contentWidth);
    for (const wl of wrapped) {
      this.writeLine(wl);
    }
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

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      return `${p.muted}${"─".repeat(this.contentWidth)}${p.reset}`;
    }

    // Blockquote
    const bq = line.match(/^>\s?(.*)/);
    if (bq) return `${p.muted}│${p.reset} ${p.dim}${p.italic}${this.renderInline(bq[1] || "")}${p.reset}`;

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
    text = text.replace(/__(.+?)__/g, `${p.bold}$1${p.reset}`);
    // Italic
    text = text.replace(/\*(.+?)\*/g, `${p.italic}$1${p.reset}`);
    text = text.replace(/_(.+?)_/g, `${p.italic}$1${p.reset}`);
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
    if (this.firstLine && visibleLen(text) === 0) return;
    this.firstLine = false;
    this.pendingLines.push(`  ${text}`);
  }
}
