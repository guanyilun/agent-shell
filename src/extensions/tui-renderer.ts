/**
 * TUI renderer extension.
 *
 * Subscribes to EventBus events and renders agent output to the terminal:
 * bordered markdown responses, spinner, tool call display, streaming
 * command output, error/info messages.
 *
 * Without this extension loaded, agent-sh runs headlessly — PTY
 * passthrough, agent queries, tool execution all function; output is
 * silently dropped. Alternative renderers (web UI, logging, minimal)
 * can subscribe to the same events.
 */
import { MarkdownRenderer } from "../utils/markdown.js";
import { palette as p } from "../utils/palette.js";
import {
  renderToolCall,
  renderToolResult,
  startSpinner,
  stopSpinner as stopToolSpinner,
  type SpinnerState,
} from "../utils/tool-display.js";
import { renderDiff } from "../utils/diff-renderer.js";
import { renderBoxFrame } from "../utils/box-frame.js";
import type { DiffResult } from "../utils/diff.js";
import { getSettings } from "../settings.js";
import type { ExtensionContext } from "../types.js";

export default function activate({ bus, getAcpClient }: ExtensionContext): void {
  let spinner: SpinnerState | null = null;
  let renderer: MarkdownRenderer | null = null;
  let commandOutputBuffer = "";
  let commandOutputLineCount = 0;
  let commandOutputOverflow = 0;
  let lastCommand = "";
  let toolLineOpen = false; // true when tool header was written without \n
  let hadToolCalls = false; // true after any tool call in current response
  let currentToolKind: string | undefined; // kind of the currently executing tool
  let isThinking = false;
  let showThinkingText = false;
  let spinnerStartTime = 0; // preserved across spinner restarts
  let lastTruncatedDiff: {
    filePath: string;
    diff: DiffResult;
    expandedLines?: string[]; // cached full render
    expanded: boolean;
  } | null = null;

  // ── Event subscriptions ─────────────────────────────────────

  bus.on("agent:query", (e) => {
    spinnerStartTime = 0;
    showUserQuery(e.query);
    startAgentResponse();
    startThinkingSpinner();
  });

  bus.on("agent:thinking-chunk", (e) => {
    if (!isThinking) {
      isThinking = true;
      if (showThinkingText) {
        stopCurrentSpinner();
        if (!renderer) startAgentResponse();
        renderer!.writeLine(`${p.dim}Thinking (ctrl+t to collapse)${p.reset}`);
      } else {
        // Restart spinner with ctrl+t hint now that we know thinking is available
        startThinkingSpinner();
      }
    }
    if (showThinkingText && e.text) {
      if (!renderer) startAgentResponse();
      renderer!.push(`${p.dim}${e.text}${p.reset}`);
      flushOutput();
    }
  });

  bus.on("agent:response-chunk", (e) => writeAgentText(e.text));
  bus.on("agent:response-done", () => {
    isThinking = false;
    endAgentResponse();
  });

  bus.on("agent:tool-call", (e) => {
    lastCommand = e.tool;
  });

  bus.on("agent:tool-started", (e) => {
    stopCurrentSpinner();
    currentToolKind = e.kind;
    if (e.title === "user_shell") {
      // Minimal annotation — PTY echo will show the output
      closeToolLine();
      if (!renderer) startAgentResponse();
      renderer!.flush();
      const cmd = (e.rawInput as any)?.command || "";
      renderer!.writeLine(`${p.dim}▶ user_shell: ${cmd}${p.reset}`);
      hadToolCalls = true;
    } else {
      showToolCall(e.title, lastCommand, e);
    }
    lastCommand = "";
  });

  bus.on("agent:tool-completed", (e) => {
    showToolComplete(e.exitCode);
    currentToolKind = undefined;
    spinnerStartTime = 0;
    startThinkingSpinner();
  });
  bus.on("agent:tool-output-chunk", (e) => writeCommandOutput(e.chunk));
  bus.on("agent:tool-output", () => flushCommandOutput());

  bus.on("agent:cancelled", () => {
    isThinking = false;
    stopCurrentSpinner();
    showInfo("(cancelled)");
    endAgentResponse();
  });

  bus.on("agent:processing-done", () => {
    isThinking = false;
    stopCurrentSpinner();
    endAgentResponse();
  });

  bus.on("agent:error", (e) => showError(e.message));

  // Flush rendering state and show inline diff for file writes
  bus.on("permission:request", (e) => {
    stopCurrentSpinner();
    flushCommandOutput();
    renderer?.flush();

    if (e.kind === "file-write" && e.metadata?.diff) {
      showFileDiff(
        e.title,
        e.metadata.diff as DiffResult,
      );
    } else {
      // Non-file permission (e.g. tool-call) — end response box
      // so interactive extensions can render their own UI
      endAgentResponse();
    }
  });

  bus.on("input:keypress", (e) => {
    if (e.key === "\x0f") expandLastDiff();       // Ctrl+O
    if (e.key === "\x14") toggleThinkingDisplay(); // Ctrl+T
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
    hadToolCalls = false;
    renderer.printTopBorder();
  }

  function endAgentResponse(): void {
    closeToolLine();
    if (renderer) {
      renderer.flush();
      renderer.printBottomBorder();
      renderer = null;
    }
  }

  function showUserQuery(query: string): void {
    const termW = process.stdout.columns || 80;
    const boxW = Math.min(84, termW);
    const contentW = boxW - 4; // inside box padding

    // Wrap long queries to fit within box
    const lines: string[] = [];
    for (const raw of query.split("\n")) {
      if (raw.length <= contentW) {
        lines.push(`${p.accent}${raw}${p.reset}`);
      } else {
        // Simple word wrap
        let remaining = raw;
        while (remaining.length > contentW) {
          let breakAt = remaining.lastIndexOf(" ", contentW);
          if (breakAt <= 0) breakAt = contentW;
          lines.push(`${p.accent}${remaining.slice(0, breakAt)}${p.reset}`);
          remaining = remaining.slice(breakAt).trimStart();
        }
        if (remaining) lines.push(`${p.accent}${remaining}${p.reset}`);
      }
    }

    const framed = renderBoxFrame(lines, {
      width: boxW,
      style: "rounded",
      borderColor: p.accent,
      title: `${p.accent}${p.bold}❯${p.reset}`,
    });
    process.stdout.write("\n");
    for (const line of framed) {
      process.stdout.write(line + "\n");
    }
  }

  function writeAgentText(text: string): void {
    closeToolLine();
    const needsGap = hadToolCalls;
    hadToolCalls = false;
    if (isThinking) {
      isThinking = false;
      if (showThinkingText && renderer) {
        renderer.flush();
        const termW = process.stdout.columns || 80;
        const w = Math.min(80, termW);
        renderer.writeLine(`${p.dim}${"─".repeat(w)}${p.reset}`);
      }
    }
    stopCurrentSpinner();
    if (!renderer) startAgentResponse();
    if (needsGap) process.stdout.write("\n");
    renderer!.push(text);
    flushOutput();
  }

  function showToolCall(
    title: string,
    command?: string,
    extra?: {
      kind?: string;
      locations?: { path: string; line?: number | null }[];
      rawInput?: unknown;
    },
  ): void {
    closeToolLine();
    stopCurrentSpinner();
    if (!renderer) startAgentResponse();
    renderer!.flush();
    const termW = process.stdout.columns || 80;
    const lines = renderToolCall({
      title,
      command: command || undefined,
      kind: extra?.kind,
      locations: extra?.locations,
      rawInput: extra?.rawInput,
    }, termW);
    // Write all lines except the last normally, write last without \n
    for (let i = 0; i < lines.length - 1; i++) {
      renderer!.writeLine(lines[i]!);
    }
    if (lines.length > 0) {
      process.stdout.write(`  ${lines[lines.length - 1]}`);
      toolLineOpen = true;
    }
    hadToolCalls = true;
    // Reset output tracking for the new tool
    commandOutputLineCount = 0;
    commandOutputOverflow = 0;
  }

  function showToolComplete(exitCode: number | null): void {
    if (!renderer) return;
    const mark = exitCode === null
      ? `${p.muted}(timed out)${p.reset}`
      : exitCode === 0
        ? `${p.success}✓${p.reset}`
        : `${p.error}✗ exit ${exitCode}${p.reset}`;

    if (toolLineOpen && commandOutputLineCount === 0) {
      // No output written — append mark on same line as tool header
      process.stdout.write(` ${mark}\n`);
      toolLineOpen = false;
    } else {
      closeToolLine();
      flushCommandOutput();
      renderer.writeLine(`  ${mark}`);
    }
  }

  function hasThinkingMode(): boolean {
    const mode = getAcpClient().getCurrentMode();
    return !mode || mode.id !== "off";
  }

  function startThinkingSpinner(): void {
    // Preserve start time if restarting (e.g. toggle), otherwise reset
    if (!spinnerStartTime) spinnerStartTime = Date.now();
    stopCurrentSpinner();
    const thinking = hasThinkingMode();
    const label = thinking ? "Thinking" : "Working";
    const hint = thinking
      ? (showThinkingText ? "(ctrl+t to collapse)" : "(ctrl+t to expand)")
      : "";
    spinner = startSpinner(label, { hint: hint || undefined, startTime: spinnerStartTime });
  }

  function stopCurrentSpinner(): void {
    if (spinner) {
      stopToolSpinner(spinner);
      spinner = null;
    }
  }

  function closeToolLine(): void {
    if (toolLineOpen) {
      process.stdout.write("\n");
      toolLineOpen = false;
    }
  }

  function writeCommandOutput(chunk: string): void {
    if (!renderer) return;
    closeToolLine();
    const maxLines = currentToolKind === "read"
      ? getSettings().readOutputMaxLines
      : getSettings().maxCommandOutputLines;
    commandOutputBuffer += chunk;
    const lines = commandOutputBuffer.split("\n");
    commandOutputBuffer = lines.pop()!;
    for (const line of lines) {
      if (commandOutputLineCount < maxLines) {
        renderer.writeLine(`${p.dim}  ${line}${p.reset}`);
        commandOutputLineCount++;
      } else {
        commandOutputOverflow++;
      }
    }
  }

  function flushCommandOutput(): void {
    if (!renderer) return;
    const maxLines = currentToolKind === "read"
      ? getSettings().readOutputMaxLines
      : getSettings().maxCommandOutputLines;
    if (commandOutputBuffer) {
      if (commandOutputLineCount < maxLines) {
        renderer.writeLine(`${p.dim}  ${commandOutputBuffer}${p.reset}`);
        commandOutputLineCount++;
      } else {
        commandOutputOverflow++;
      }
      commandOutputBuffer = "";
    }
    if (commandOutputOverflow > 0 && maxLines > 0) {
      renderer.writeLine(`${p.dim}  … ${commandOutputOverflow} more lines${p.reset}`);
    }
    commandOutputOverflow = 0;
  }


  function diffTitle(filePath: string, diff: DiffResult): string {
    const stats = diff.isNewFile
      ? `${p.success}+${diff.added}${p.reset}`
      : `${p.success}+${diff.added}${p.reset} ${p.error}-${diff.removed}${p.reset}`;
    return `${p.dim}${filePath}${p.reset}  ${stats}`;
  }

  function showFileDiff(filePath: string, diff: DiffResult): void {
    if (diff.isIdentical) return;

    const termW = process.stdout.columns || 80;
    const boxW = Math.min(84, termW);
    const contentW = boxW - 4;

    const diffLines = renderDiff(diff, {
      width: contentW,
      filePath,
      maxLines: getSettings().diffMaxLines,
      trueColor: true,
      mode: "unified",
    });

    const lastLine = diffLines[diffLines.length - 1] ?? "";
    const isTruncated = lastLine.includes("… ");

    if (isTruncated) {
      lastTruncatedDiff = { filePath, diff, expanded: false };
    } else {
      lastTruncatedDiff = null;
    }

    const body = diffLines.length > 1 ? ["", ...diffLines.slice(1), ""] : diffLines;

    const footer = isTruncated
      ? [`  ${p.dim}ctrl+o to expand${p.reset}`]
      : undefined;

    const framed = renderBoxFrame(body, {
      width: boxW,
      style: "rounded",
      borderColor: p.dim,
      title: diffTitle(filePath, diff),
      footer,
    });

    if (!renderer) startAgentResponse();
    for (const line of framed) {
      renderer!.writeLine(line);
    }
  }

  function expandLastDiff(): void {
    if (!lastTruncatedDiff) return;

    const entry = lastTruncatedDiff;
    entry.expanded = !entry.expanded;

    if (!entry.expanded) {
      showFileDiffCached(entry);
      return;
    }

    if (!entry.expandedLines) {
      const { filePath, diff } = entry;
      const termW = process.stdout.columns || 80;
      const boxW = Math.min(120, termW);
      const contentW = boxW - 4;

      const diffLines = renderDiff(diff, {
        width: contentW,
        filePath,
        maxLines: 500,
        trueColor: true,
      });

      const body = diffLines.length > 1 ? ["", ...diffLines.slice(1), ""] : diffLines;

      entry.expandedLines = renderBoxFrame(body, {
        width: boxW,
        style: "rounded",
        borderColor: p.dim,
        title: diffTitle(filePath, diff),
        footer: [`  ${p.dim}ctrl+o to collapse${p.reset}`],
      });
    }

    process.stdout.write("\n");
    for (const line of entry.expandedLines) {
      process.stdout.write(line + "\n");
    }
  }

  function showFileDiffCached(entry: NonNullable<typeof lastTruncatedDiff>): void {
    const { filePath, diff } = entry;
    const termW = process.stdout.columns || 80;
    const boxW = Math.min(84, termW);
    const contentW = boxW - 4;

    const diffLines = renderDiff(diff, {
      width: contentW,
      filePath,
      maxLines: getSettings().diffMaxLines,
      trueColor: true,
      mode: "unified",
    });

    const body = diffLines.length > 1 ? ["", ...diffLines.slice(1), ""] : diffLines;

    const framed = renderBoxFrame(body, {
      width: boxW,
      style: "rounded",
      borderColor: p.dim,
      title: diffTitle(filePath, diff),
      footer: [`  ${p.dim}ctrl+o to expand${p.reset}`],
    });

    process.stdout.write("\n");
    for (const line of framed) {
      process.stdout.write(line + "\n");
    }
  }

  function toggleThinkingDisplay(): void {
    showThinkingText = !showThinkingText;

    // Update spinner hint to reflect new state, even if not actively thinking
    if (spinner) {
      stopCurrentSpinner();
      startThinkingSpinner();
      return;
    }

    if (!isThinking) return;

    if (showThinkingText) {
      // Switch from spinner to streaming text
      stopCurrentSpinner();
      if (!renderer) startAgentResponse();
      renderer!.writeLine(`${p.dim}Thinking (ctrl+t to collapse)${p.reset}`);
    } else {
      // Switch from streaming text to spinner
      if (renderer) {
        renderer.flush();
        const termW = process.stdout.columns || 80;
        const w = Math.min(80, termW);
        renderer.writeLine(`${p.dim}${"─".repeat(w)}${p.reset}`);
      }
      startThinkingSpinner();
    }
  }

  function showError(message: string): void {
    process.stdout.write(`\n${p.error}Error: ${message}${p.reset}\n`);
  }

  function showInfo(message: string): void {
    process.stdout.write(`${p.muted}${message}${p.reset}\n`);
  }
}
