import { MarkdownRenderer } from "./markdown.js";

const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const GRAY = "\x1b[90m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class TUI {
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private renderer: MarkdownRenderer | null = null;
  private commandOutputBuffer = "";

  constructor(_agentName: string) {}

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

  writeAgentText(text: string): void {
    this.stopSpinner();
    if (this.renderer) {
      this.renderer.push(text);
    }
  }

  showToolCall(title: string, description?: string): void {
    this.stopSpinner();
    if (this.renderer) {
      this.renderer.flush();
      const desc = description ? ` ${DIM}${description}${RESET}` : "";
      this.renderer.writeLine(`${YELLOW}${BOLD}▶ ${title}${RESET}${desc}`);
    }
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
      if (this.renderer) {
        // Overwrite the current line inside the box
        const text = `${CYAN}${frame} ${label}...${RESET}`;
        const vLen = label.length + 5; // frame + space + label + "..."
        const contentWidth = this.renderer["contentWidth"];
        const pad = Math.max(0, contentWidth - vLen);
        process.stdout.write(
          `\r${CYAN}│${RESET} ${text}${" ".repeat(pad)} ${CYAN}│${RESET}`
        );
      } else {
        process.stdout.write(`\r${CYAN}${frame} ${label}...${RESET}\x1b[K`);
      }
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
}
