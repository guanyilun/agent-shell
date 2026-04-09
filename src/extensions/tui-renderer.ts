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
import {
  renderToolCall,
  renderToolResult,
  startSpinner,
  stopSpinner as stopToolSpinner,
  type SpinnerState,
} from "../utils/tool-display.js";
import type { ExtensionContext } from "../types.js";

export default function activate({ bus }: ExtensionContext): void {
  let spinner: SpinnerState | null = null;
  let renderer: MarkdownRenderer | null = null;
  let commandOutputBuffer = "";

  // ── Event subscriptions ─────────────────────────────────────

  bus.on("agent:query", (e) => {
    process.stdout.write(`\n${CYAN}${BOLD}❯ ${RESET}${CYAN}${e.query}${RESET}\n`);
    startAgentResponse();
    startThinkingSpinner();
  });

  bus.on("agent:response-chunk", (e) => writeAgentText(e.text));
  bus.on("agent:response-done", () => endAgentResponse());

  bus.on("agent:tool-started", (e) => {
    stopCurrentSpinner();
    showToolCall(e.title);
  });

  bus.on("agent:tool-completed", (e) => showToolComplete(e.exitCode));
  bus.on("agent:tool-output-chunk", (e) => writeCommandOutput(e.chunk));
  bus.on("agent:tool-output", () => flushCommandOutput());

  bus.on("agent:cancelled", () => {
    stopCurrentSpinner();
    showInfo("(cancelled)");
    endAgentResponse();
  });

  bus.on("agent:error", (e) => showError(e.message));

  // Flush rendering state before any permission prompt
  bus.on("permission:request", () => {
    stopCurrentSpinner();
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
    stopCurrentSpinner();
    if (!renderer) startAgentResponse();
    renderer!.push(text);
    flushOutput();
  }

  function showToolCall(title: string): void {
    stopCurrentSpinner();
    if (!renderer) startAgentResponse();
    renderer!.flush();
    const termW = process.stdout.columns || 80;
    const lines = renderToolCall({ title }, termW);
    for (const line of lines) {
      renderer!.writeLine(line);
    }
  }

  function showToolComplete(exitCode: number | null): void {
    if (!renderer) return;
    const termW = process.stdout.columns || 80;
    const lines = renderToolResult({ exitCode }, termW);
    for (const line of lines) {
      renderer.writeLine(line);
    }
  }

  function startThinkingSpinner(label = "Thinking"): void {
    stopCurrentSpinner();
    spinner = startSpinner(label);
  }

  function stopCurrentSpinner(): void {
    if (spinner) {
      stopToolSpinner(spinner);
      spinner = null;
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
