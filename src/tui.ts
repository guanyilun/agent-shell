import { MarkdownRenderer } from "./markdown.js";
import type { DiffResult } from "./diff.js";

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const GRAY = "\x1b[90m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function visibleLen(str: string): number {
  return str.replace(/\x1b\[[^m]*m/g, "").length;
}

export class TUI {
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private renderer: MarkdownRenderer | null = null;
  private commandOutputBuffer = "";
  private isOutputting = false;

  constructor(_agentName: string) {}

  private flushOutput(): void {
    if (process.stdout.writable) {
      try {
        process.stdout.write('');
      } catch (e) {
      }
    }
  }

  // Status bar stubs — kept for interface compatibility
  setupStatusBar(): void {}
  scheduleRepaint(): void {}
  handleResize(_cols: number, _rows: number): void {}
  teardownStatusBar(): void {}
  updateStatusBar(_mode: "shell" | "agent"): void {}

  startAgentResponse(): void {
    this.renderer = new MarkdownRenderer();
    process.stdout.write("\n");
    this.renderer.printTopBorder();
  }

  endAgentResponse(): void {
    if (this.renderer) {
      this.renderer.flush();
      this.renderer.printBottomBorder();
      this.renderer = null;
    }
  }

  flushRenderer(): void {
    this.renderer?.flush();
  }

  writeAgentText(text: string): void {
    this.stopSpinner();
    if (!this.renderer) this.startAgentResponse();
    this.renderer!.push(text);
    this.flushOutput();
  }

  showToolCall(title: string, description?: string): void {
    this.stopSpinner();
    if (!this.renderer) this.startAgentResponse();
    this.renderer!.flush();
    const desc = description ? ` ${DIM}${description}${RESET}` : "";
    this.renderer!.writeLine(`${YELLOW}${BOLD}▶ ${title}${RESET}${desc}`);
  }

  showToolResult(exitCode: number | null): void {
    if (!this.renderer) return;
    if (exitCode === null) {
      this.renderer.writeLine(`${GRAY}(timed out)${RESET}`);
    } else if (exitCode === 0) {
      this.renderer.writeLine(`${GREEN}✓${RESET}`);
    } else {
      this.renderer.writeLine(`${RED}✗ exit ${exitCode}${RESET}`);
    }
  }

  startSpinner(label = "Thinking"): void {
    this.stopSpinner();
    this.spinnerFrame = 0;
    this.spinnerInterval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length];
      process.stdout.write(`\r  ${CYAN}${frame} ${label}...${RESET}\x1b[K`);
      this.flushOutput();
      this.spinnerFrame++;
    }, 80);
  }

  stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
      process.stdout.write("\r\x1b[2K");
    }
  }

  /**
   * Stream command output inside the bordered box (ANSI already stripped).
   * Buffers partial lines; emits complete lines in gray.
   */
  writeCommandOutput(chunk: string): void {
    if (!this.renderer) return;
    this.commandOutputBuffer += chunk;
    const lines = this.commandOutputBuffer.split("\n");
    this.commandOutputBuffer = lines.pop()!;
    for (const line of lines) {
      this.renderer.writeLine(`${DIM}  ${line}${RESET}`);
    }
  }

  /**
   * Flush any remaining buffered command output.
   */
  flushCommandOutput(): void {
    if (!this.renderer) return;
    if (this.commandOutputBuffer) {
      this.renderer.writeLine(`${DIM}  ${this.commandOutputBuffer}${RESET}`);
      this.commandOutputBuffer = "";
    }
  }

  showError(message: string): void {
    process.stdout.write(`\n${RED}Error: ${message}${RESET}\n`);
  }

  showInfo(message: string): void {
    process.stdout.write(`${GRAY}${message}${RESET}\n`);
  }

  async promptPermission(title: string, description?: string): Promise<string | null> {
    const desc = description ? `\n  ${DIM}${description}${RESET}` : "";
    process.stdout.write(
      `\n${YELLOW}${BOLD}⚠ Permission required:${RESET} ${title}${desc}\n` +
        `  ${DIM}[y]es / [n]o / [a]llow all${RESET} `
    );

    return new Promise((resolve) => {
      const handler = (data: Buffer) => {
        const ch = data.toString("utf-8").toLowerCase();
        process.stdin.removeListener("data", handler);
        process.stdout.write("\n");

        if (ch === "y") resolve("approve");
        else if (ch === "a") resolve("approve_all");
        else resolve(null);
      };
      process.stdin.on("data", handler);
    });
  }

  /**
   * Show an interactive diff preview box and wait for the user's decision.
   * Returns "approve", "reject", or "approve_all".
   */
  async previewDiff(opts: {
    path: string;
    diff: DiffResult;
  }): Promise<"approve" | "reject" | "approve_all"> {
    const termW = process.stdout.columns || 80;
    const contentW = Math.min(80, termW - 4);
    const boxW = contentW + 2;
    const MAX_DISPLAY = 25;
    const R = RESET;

    // Helper: write one line inside the box with proper padding
    const boxed = (text: string) => {
      const pad = Math.max(0, contentW - visibleLen(text));
      process.stdout.write(
        `${YELLOW}│${R} ${text}${" ".repeat(pad)} ${YELLOW}│${R}\n`,
      );
    };

    // ── Count lines & measure line-number column ──
    let totalLines = 0;
    let maxNo = 0;
    for (const hunk of opts.diff.hunks) {
      totalLines += hunk.lines.length;
      for (const line of hunk.lines) {
        const n = line.oldNo ?? line.newNo ?? 0;
        if (n > maxNo) maxNo = n;
      }
    }
    const noW = String(maxNo).length;
    const textMax = contentW - noW - 6;

    // ── Top border with header ──
    process.stdout.write("\n");
    const stats = opts.diff.isNewFile
      ? `(+${opts.diff.added} lines)`
      : `(+${opts.diff.added} / -${opts.diff.removed})`;
    const headerText = opts.diff.isNewFile
      ? `new: ${opts.path}  ${stats}`
      : `${opts.path}  ${stats}`;
    const afterDashes = Math.max(1, boxW - headerText.length - 2);
    process.stdout.write(
      `${YELLOW}┌${R} ${headerText} ${YELLOW}${"─".repeat(afterDashes)}┐${R}\n`,
    );

    boxed("");

    // ── Diff lines ──
    let shown = 0;
    let hunkIdx = 0;
    for (const hunk of opts.diff.hunks) {
      if (shown >= MAX_DISPLAY) break;
      if (hunkIdx > 0) boxed(`  ${DIM}⋯${R}`);

      for (const line of hunk.lines) {
        if (shown >= MAX_DISPLAY) break;
        shown++;

        const no = String(line.oldNo ?? line.newNo ?? "").padStart(noW);
        const sign =
          line.type === "removed"
            ? `${RED}-${R}`
            : line.type === "added"
              ? `${GREEN}+${R}`
              : " ";
        const color =
          line.type === "removed" ? RED
          : line.type === "added" ? GREEN
          : DIM;
        const text =
          line.text.length > textMax
            ? line.text.slice(0, textMax - 1) + "…"
            : line.text;

        boxed(`${sign} ${DIM}${no}${R} ${DIM}│${R} ${color}${text}${R}`);
      }
      hunkIdx++;
    }

    if (totalLines > MAX_DISPLAY) {
      boxed(`  ${DIM}⋯ ${totalLines - MAX_DISPLAY} more lines${R}`);
    }

    boxed("");

    // ── Prompt ──
    process.stdout.write(`${YELLOW}├${"─".repeat(boxW)}┤${R}\n`);
    boxed(`  ${BOLD}[y] Apply  [n] Skip  [a] Don't ask again${R}`);
    process.stdout.write(`${YELLOW}└${"─".repeat(boxW)}┘${R}\n`);

    // ── Wait for keypress ──
    return new Promise((resolve) => {
      const handler = (data: Buffer) => {
        const ch = data.toString("utf-8").toLowerCase();
        process.stdin.removeListener("data", handler);

        if (ch === "y") {
          process.stdout.write(`  ${GREEN}✓ Applied${R}\n`);
          resolve("approve");
        } else if (ch === "a") {
          process.stdout.write(`  ${GREEN}✓ Applied (auto-approve on)${R}\n`);
          resolve("approve_all");
        } else {
          process.stdout.write(`  ${RED}✗ Skipped${R}\n`);
          resolve("reject");
        }
      };
      process.stdin.on("data", handler);
    });
  }
}
