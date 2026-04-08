import { highlight } from "cli-highlight";

const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const MAGENTA = "\x1b[35m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

const MAX_CONTENT_WIDTH = 90;

/**
 * Strip ANSI escape sequences to get the visible text length.
 */
function visibleLength(str: string): number {
  return str.replace(/\x1b\[[^m]*m/g, "").length;
}

/**
 * Word-wrap a string (which may contain ANSI codes) to a maximum visible width.
 * Returns an array of lines, each fitting within `maxWidth` visible characters.
 */
function wrapLine(text: string, maxWidth: number): string[] {
  if (visibleLength(text) <= maxWidth) return [text];

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
      if (seg === RESET) {
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
            result.push(currentLine + RESET);
            currentLine = activeStyles;
            currentWidth = 0;
          } else {
            currentWidth += chunk.length;
          }
        }
      } else {
        // Wrap to next line
        result.push(currentLine + RESET);
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
 */
export class MarkdownRenderer {
  private buffer = "";
  private inCodeBlock = false;
  private codeLanguage = "";
  private codeLines: string[] = [];
  private contentWidth: number;
  private firstLine = true;

  constructor(terminalWidth?: number) {
    const termW = terminalWidth ?? (process.stdout.columns || 100);
    // 2-char left indent for content
    this.contentWidth = Math.min(MAX_CONTENT_WIDTH, termW - 2);
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
    if (this.inCodeBlock) {
      this.renderCodeBlock();
    }
    if (this.buffer.length > 0) {
      this.processLine(this.buffer);
      this.buffer = "";
    }
  }

  printTopBorder(): void {
    const w = Math.min(this.contentWidth, 40);
    process.stdout.write(`${DIM}${CYAN}${"─".repeat(w)}${RESET}\n`);
    this.firstLine = true;
  }

  printBottomBorder(): void {
    const w = Math.min(this.contentWidth, 40);
    process.stdout.write(`${DIM}${CYAN}${"─".repeat(w)}${RESET}\n`);
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop()!;

    for (const line of lines) {
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    // Code fence detection
    const fenceMatch = line.match(/^(\s*)```(\w*)/);
    if (fenceMatch) {
      if (!this.inCodeBlock) {
        this.inCodeBlock = true;
        this.codeLanguage = fenceMatch[2] || "";
        this.codeLines = [];
        return;
      } else {
        this.inCodeBlock = false;
        this.renderCodeBlock();
        return;
      }
    }

    if (this.inCodeBlock) {
      this.codeLines.push(line);
      return;
    }

    const rendered = this.renderLine(line);
    // Word-wrap and output each wrapped line
    const wrapped = wrapLine(rendered, this.contentWidth);
    for (const wl of wrapped) {
      this.writeLine(wl);
    }
  }

  private renderLine(line: string): string {
    if (line.trim() === "") return "";

    // Headings
    const h1 = line.match(/^# (.+)/);
    if (h1) return `${BOLD}${MAGENTA}${h1[1]}${RESET}`;

    const h2 = line.match(/^## (.+)/);
    if (h2) return `${BOLD}${CYAN}${h2[1]}${RESET}`;

    const h3 = line.match(/^### (.+)/);
    if (h3) return `${BOLD}${h3[1]}${RESET}`;

    const h4 = line.match(/^#{4,} (.+)/);
    if (h4) return `${BOLD}${h4[1]}${RESET}`;

    // Horizontal rule
    if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      return `${GRAY}${"─".repeat(this.contentWidth)}${RESET}`;
    }

    // Blockquote
    const bq = line.match(/^>\s?(.*)/);
    if (bq) return `${GRAY}│${RESET} ${DIM}${ITALIC}${this.renderInline(bq[1] || "")}${RESET}`;

    // Unordered list
    const ul = line.match(/^(\s*)[*\-+]\s+(.*)/);
    if (ul) {
      const indent = ul[1] || "";
      return `${indent}  ${CYAN}*${RESET} ${this.renderInline(ul[2] || "")}`;
    }

    // Ordered list
    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.*)/);
    if (ol) {
      const indent = ol[1] || "";
      return `${indent}  ${CYAN}${ol[2]}.${RESET} ${this.renderInline(ol[3] || "")}`;
    }

    return this.renderInline(line);
  }

  private renderInline(text: string): string {
    // Inline code
    text = text.replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`);
    // Bold + italic
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`);
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
    text = text.replace(/__(.+?)__/g, `${BOLD}$1${RESET}`);
    // Italic
    text = text.replace(/\*(.+?)\*/g, `${ITALIC}$1${RESET}`);
    text = text.replace(/_(.+?)_/g, `${ITALIC}$1${RESET}`);
    // Strikethrough
    text = text.replace(/~~(.+?)~~/g, `${DIM}$1${RESET}`);
    // Links
    text = text.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      `$1 ${GRAY}${UNDERLINE}($2)${RESET}`
    );
    return text;
  }

  private renderCodeBlock(): void {
    const code = this.codeLines.join("\n");
    const lang = this.codeLanguage;

    if (lang) {
      this.writeLine(`${DIM}${lang}${RESET}`);
    }

    let highlighted: string;
    try {
      highlighted = highlight(code, { language: lang || undefined });
    } catch {
      highlighted = `${GREEN}${code}${RESET}`;
    }

    // Code blocks get indented, and each line is individually wrapped
    for (const line of highlighted.split("\n")) {
      const indented = `  ${line}`;
      const wrapped = wrapLine(indented, this.contentWidth);
      for (const wl of wrapped) {
        this.writeLine(wl);
      }
    }

    this.codeLanguage = "";
    this.codeLines = [];
  }

  /**
   * Write a single line with a subtle left indent.
   */
  writeLine(text: string): void {
    if (this.firstLine && visibleLength(text) === 0) return;
    this.firstLine = false;
    process.stdout.write(`  ${text}\n`);
    if (process.stdout.writable) {
      try {
        process.stdout.write('');
      } catch (e) {
      }
    }
  }
}
