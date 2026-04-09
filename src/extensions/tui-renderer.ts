/**
 * TUI renderer extension.
 *
 * Subscribes to EventBus events and renders agent output to the terminal:
 * bordered markdown responses, spinner, tool call display, streaming
 * command output, error/info messages.
 *
 * Without this extension loaded, agent-shell runs headlessly — PTY
 * passthrough, agent queries, tool execution all function; output is
 * silently dropped. Alternative renderers (web UI, logging, minimal)
 * can subscribe to the same events.
 */
import { MarkdownRenderer } from "../utils/markdown.js";
import { CYAN, DIM, YELLOW, GREEN, RED, GRAY, BOLD, RESET } from "../utils/ansi.js";
import type { ExtensionContext } from "../types.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export default function activate({ bus }: ExtensionContext): void {
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  let renderer: MarkdownRenderer | null = null;
  let commandOutputBuffer = "";

  // ── Event subscriptions ─────────────────────────────────────

  bus.on("agent:query", (e) => {
    process.stdout.write(`\n${CYAN}${BOLD}❯ ${RESET}${CYAN}${e.query}${RESET}\n`);
    startAgentResponse();
    startSpinner();
  });

  bus.on("agent:response-chunk", (e) => writeAgentText(e.text));
  bus.on("agent:response-done", () => endAgentResponse());

  bus.on("agent:tool-started", (e) => {
    stopSpinner();
    showToolCall(e.title);
  });

  bus.on("agent:tool-completed", (e) => showToolResult(e.exitCode));
  bus.on("agent:tool-output-chunk", (e) => writeCommandOutput(e.chunk));
  bus.on("agent:tool-output", () => flushCommandOutput());

  bus.on("agent:cancelled", () => {
    stopSpinner();
    showInfo("(cancelled)");
    endAgentResponse();
  });

  bus.on("agent:error", (e) => showError(e.message));

  // Flush rendering state before any permission prompt
  bus.on("permission:request", () => {
    stopSpinner();
    flushCommandOutput();
    renderer?.flush();
    endAgentResponse();
  });

  bus.on("ui:info", (e) => showInfo(e.message));
  bus.on("ui:error", (e) => showError(e.message));

  // ── Rendering functions ─────────────────────────────────────

  function flushOutput(): void {
    if (process.stdout.writable) {
      try { process.stdout.write(""); } catch {}
    }
  }

  function startAgentResponse(): void {
    renderer = new MarkdownRenderer();
    process.stdout.write("\n");
    renderer.printTopBorder();
  }

  function endAgentResponse(): void {
    if (renderer) {
      renderer.flush();
      renderer.printBottomBorder();
      renderer = null;
    }
  }

  function writeAgentText(text: string): void {
    stopSpinner();
    if (!renderer) startAgentResponse();
    renderer!.push(text);
    flushOutput();
  }

  function showToolCall(title: string): void {
    stopSpinner();
    if (!renderer) startAgentResponse();
    renderer!.flush();
    renderer!.writeLine(`${YELLOW}${BOLD}▶ ${title}${RESET}`);
  }

  function showToolResult(exitCode: number | null): void {
    if (!renderer) return;
    if (exitCode === null) {
      renderer.writeLine(`${GRAY}(timed out)${RESET}`);
    } else if (exitCode === 0) {
      renderer.writeLine(`${GREEN}✓${RESET}`);
    } else {
      renderer.writeLine(`${RED}✗ exit ${exitCode}${RESET}`);
    }
  }

  function startSpinner(label = "Thinking"): void {
    stopSpinner();
    spinnerFrame = 0;
    spinnerInterval = setInterval(() => {
      const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
      process.stdout.write(`\r  ${CYAN}${frame} ${label}...${RESET}\x1b[K`);
      flushOutput();
      spinnerFrame++;
    }, 80);
  }

  function stopSpinner(): void {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
      process.stdout.write("\r\x1b[2K");
    }
  }

  function writeCommandOutput(chunk: string): void {
    if (!renderer) return;
    commandOutputBuffer += chunk;
    const lines = commandOutputBuffer.split("\n");
    commandOutputBuffer = lines.pop()!;
    for (const line of lines) {
      renderer.writeLine(`${DIM}  ${line}${RESET}`);
    }
  }

  function flushCommandOutput(): void {
    if (!renderer) return;
    if (commandOutputBuffer) {
      renderer.writeLine(`${DIM}  ${commandOutputBuffer}${RESET}`);
      commandOutputBuffer = "";
    }
  }

  function showError(message: string): void {
    process.stdout.write(`\n${RED}Error: ${message}${RESET}\n`);
  }

  function showInfo(message: string): void {
    process.stdout.write(`${GRAY}${message}${RESET}\n`);
  }
}
