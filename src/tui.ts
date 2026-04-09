import { MarkdownRenderer } from "./markdown.js";
import { CYAN, DIM, YELLOW, GREEN, RED, GRAY, BOLD, RESET } from "./ansi.js";
import type { EventBus } from "./event-bus.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class TUI {
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private renderer: MarkdownRenderer | null = null;
  private commandOutputBuffer = "";
  private isOutputting = false;

  constructor(bus: EventBus) {
    bus.on("agent:query", (e) => this.handleAgentQuery(e));
    bus.on("agent:response-chunk", (e) => this.handleResponseChunk(e));
    bus.on("agent:response-done", () => this.handleResponseDone());
    bus.on("agent:tool-started", (e) => this.handleToolStarted(e));
    bus.on("agent:tool-completed", (e) => this.handleToolCompleted(e));
    bus.on("agent:tool-output-chunk", (e) => this.handleToolOutputChunk(e));
    bus.on("agent:tool-output", () => this.handleToolOutput());
    bus.on("agent:cancelled", () => this.handleCancelled());
    bus.on("agent:error", (e) => this.handleError(e));

    // Flush rendering state before any permission prompt (notify phase of
    // emitPipeAsync fires this before the extension's async handler runs)
    bus.on("permission:request", () => this.prepareForInteractivePrompt());

    // UI feedback events (from extensions and core)
    bus.on("ui:info", (e) => this.showInfo(e.message));
    bus.on("ui:error", (e) => this.showError(e.message));
  }

  private flushOutput(): void {
    if (process.stdout.writable) {
      try {
        process.stdout.write('');
      } catch (e) {
      }
    }
  }

  // ── Event handlers (driven by EventBus) ─────────────────────

  private handleAgentQuery(e: { query: string }): void {
    process.stdout.write(`\n${CYAN}${BOLD}❯ ${RESET}${CYAN}${e.query}${RESET}\n`);
    this.startAgentResponse();
    this.startSpinner();
  }

  private handleResponseChunk(e: { text: string }): void {
    this.writeAgentText(e.text);
  }

  private handleResponseDone(): void {
    this.endAgentResponse();
  }

  private handleToolStarted(e: { title: string }): void {
    this.stopSpinner();
    this.showToolCall(e.title);
  }

  private handleToolCompleted(e: { exitCode: number | null }): void {
    this.showToolResult(e.exitCode);
  }

  private handleToolOutputChunk(e: { chunk: string }): void {
    this.writeCommandOutput(e.chunk);
  }

  private handleToolOutput(): void {
    this.flushCommandOutput();
  }

  private handleCancelled(): void {
    this.stopSpinner();
    this.showInfo("(cancelled)");
    this.endAgentResponse();
  }

  private handleError(e: { message: string }): void {
    this.showError(e.message);
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

  private showError(message: string): void {
    process.stdout.write(`\n${RED}Error: ${message}${RESET}\n`);
  }

  private showInfo(message: string): void {
    process.stdout.write(`${GRAY}${message}${RESET}\n`);
  }

  /**
   * Get agent info as a compact string for display next to the prompt.
   */
  getAgentInfoString(agentInfo: { name: string; version: string } | null, model?: string): string {
    if (!agentInfo) return "";

    // Compact format: "pi (gpt-4o) ●" (remove -acp suffix for cleaner display)
    const name = agentInfo.name.replace(/-acp$/, '').replace(/-/g, ' '); // Clean up name
    let infoStr = `${DIM}${name}${RESET}`;

    // Add model if available
    if (model) {
      // Clean up model name - remove provider prefixes only
      const cleanModel = model
        .replace(/^openai\//i, '')
        .replace(/^anthropic\//i, '')
        .replace(/^google\//i, '');
      infoStr += ` ${DIM}(${cleanModel})${RESET}`;
    }

    return `${infoStr} ${GREEN}●${RESET}`;
  }

  /**
   * Flush all pending rendering state before an interactive prompt.
   * Triggered by extensions via the tui:prepare-interactive event.
   */
  private prepareForInteractivePrompt(): void {
    this.stopSpinner();
    this.flushCommandOutput();
    this.renderer?.flush();
    this.endAgentResponse();
  }
}
