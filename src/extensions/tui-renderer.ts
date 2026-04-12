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
import { highlight } from "cli-highlight";
import { MarkdownRenderer, wrapLine } from "../utils/markdown.js";
import { createFencedBlockTransform, type FencedBlockTransformHandle } from "../utils/stream-transform.js";
import { palette as p } from "../utils/palette.js";
import {
  renderToolCall,
  createSpinner,
  renderSpinnerLine,
  formatElapsed,
  type SpinnerState,
  type SpinnerOpts,
} from "../utils/tool-display.js";
import { renderDiff } from "../utils/diff-renderer.js";
import { renderBoxFrame } from "../utils/box-frame.js";
import type { DiffResult } from "../utils/diff.js";
import { getSettings } from "../settings.js";
import type { ExtensionContext } from "../types.js";
import { StdoutWriter } from "../utils/output-writer.js";

/** Encode a PNG buffer as a terminal inline image escape sequence. */
function encodeImageForTerminal(data: Buffer): string | null {
  const b64 = data.toString("base64");
  if (process.env.TERM_PROGRAM === "iTerm.app" || process.env.TERM_PROGRAM === "WezTerm") {
    return `\x1b]1337;File=inline=1;size=${data.length};preserveAspectRatio=1:${b64}\x07`;
  }
  if (process.env.KITTY_WINDOW_ID || process.env.TERM_PROGRAM === "ghostty") {
    const chunks: string[] = [];
    for (let i = 0; i < b64.length; i += 4096) {
      const chunk = b64.slice(i, i + 4096);
      const isLast = i + 4096 >= b64.length;
      chunks.push(i === 0
        ? `\x1b_Gf=100,t=d,a=T,m=${isLast ? 0 : 1};${chunk}\x1b\\`
        : `\x1b_Gm=${isLast ? 0 : 1};${chunk}\x1b\\`);
    }
    return chunks.join("");
  }
  return null;
}

// ── Render state ─────────────────────────────────────────────────
// All mutable TUI state in one place for clarity and future
// migration to a frame-based rendering model.

interface TruncatedDiff {
  filePath: string;
  diff: DiffResult;
  expandedLines?: string[];
  expanded: boolean;
}

interface RenderState {
  // ── Response rendering ──
  renderer: MarkdownRenderer | null;
  hadToolCalls: boolean;
  /** Tracks the last content kind rendered for gap injection. */
  lastContentKind: "text" | "tool" | "diff" | "code" | "info" | null;

  // ── Spinner ──
  spinner: SpinnerState | null;
  spinnerLabel: string;
  spinnerOpts: SpinnerOpts;
  spinnerInterval: ReturnType<typeof setInterval> | null;
  spinnerStartTime: number;

  // ── Tool output ──
  toolLineOpen: boolean;
  currentToolKind: string | undefined;
  toolStartTime: number;
  toolExitCode: number | null;
  commandOutputBuffer: string;
  commandOutputLineCount: number;
  commandOutputOverflow: number;
  commandOverflowLines: string[];

  // ── Tool grouping (collapse sequential same-type read-only tools) ──
  toolGroupKind: string | undefined;
  toolGroupCount: number;
  toolGroupAllOk: boolean;

  // ── Thinking ──
  isThinking: boolean;
  showThinkingText: boolean;
  thinkingPending: boolean;

  // ── Diff expansion ──
  lastTruncatedDiff: TruncatedDiff | null;
}

function createRenderState(): RenderState {
  return {
    renderer: null,
    hadToolCalls: false,
    lastContentKind: null,
    spinner: null,
    spinnerLabel: "",
    spinnerOpts: {},
    spinnerInterval: null,
    spinnerStartTime: 0,
    toolLineOpen: false,
    currentToolKind: undefined,
    toolStartTime: 0,
    toolExitCode: null,
    commandOutputBuffer: "",
    commandOutputLineCount: 0,
    commandOutputOverflow: 0,
    commandOverflowLines: [],
    toolGroupKind: undefined,
    toolGroupCount: 0,
    toolGroupAllOk: true,
    isThinking: false,
    showThinkingText: false,
    thinkingPending: false,
    lastTruncatedDiff: null,
  };
}

export default function activate(ctx: ExtensionContext): void {
  const { bus, llmClient, define } = ctx;
  const writer = new StdoutWriter();
  const s = createRenderState();

  // Track backend/model info for display on response border
  let backendInfo: { name: string; model?: string; provider?: string; contextWindow?: number } | null = null;
  bus.on("agent:info", (info) => { backendInfo = info; });

  // ── Register fenced block transform (code blocks → ContentBlock) ──
  // Nobody is special — tui-renderer uses the same primitive as any extension.
  const fencedTransform = createFencedBlockTransform(bus, {
    open: /^```(\w*)\s*$/,
    close: /^```\s*$/,
    transform(match, content) {
      return { type: "code-block", language: match[1] || "", code: content };
    },
  });

  // ── Event subscriptions ─────────────────────────────────────

  bus.on("agent:query", (e) => {
    s.spinnerStartTime = 0;
    showUserQuery(e.query);
    startAgentResponse();
    startThinkingSpinner();
  });

  bus.on("agent:thinking-chunk", (e) => {
    s.thinkingPending = true;
    if (!s.isThinking) {
      s.isThinking = true;
      if (s.showThinkingText) {
        stopCurrentSpinner();
        if (!s.renderer) startAgentResponse();
        s.renderer!.writeLine(`${p.dim}Thinking (ctrl+t to collapse)${p.reset}`);
        drain();
      } else {
        // Restart spinner with ctrl+t hint now that we know thinking is available
        startThinkingSpinner();
      }
    }
    if (s.showThinkingText && e.text) {
      s.thinkingPending = false;
      if (!s.renderer) startAgentResponse();
      s.renderer!.push(`${p.dim}${e.text}${p.reset}`);
      drain();
    }
  });

  bus.on("agent:response-chunk", (e) => {
    const { blocks } = e;
    // Inject spacing: append \n to text blocks that precede non-text blocks
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      const next = blocks[i + 1];
      if (block.type === "text" && next && next.type !== "text") {
        block.text += "\n";
      }
    }
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          if (block.text) writeAgentText(block.text);
          break;
        case "code-block":
          writeCodeBlock(block.language, block.code);
          break;
        case "image":
          writeInlineImage(block.data);
          break;
        case "raw":
          flushForRaw();
          writer.write(block.escape);
          break;
      }
    }
  });
  // Track token usage for display
  let pendingUsage: { prompt_tokens: number; completion_tokens: number } | null = null;
  bus.on("agent:usage", (e) => { pendingUsage = e; });

  bus.on("agent:response-done", () => {
    s.isThinking = false;
    if (pendingUsage && s.renderer) {
      const { prompt_tokens, completion_tokens } = pendingUsage;
      const maxTokens = backendInfo?.contextWindow ?? 128_000;
      // prompt_tokens of the latest call = current context usage
      // (it includes the full conversation history)
      const ctxK = (prompt_tokens / 1000).toFixed(1);
      const maxK = (maxTokens / 1000).toFixed(0);
      const pct = Math.min(100, (prompt_tokens / maxTokens) * 100).toFixed(0);
      s.renderer.writeLine("");
      s.renderer.writeLine(
        `${p.dim}⬆ ${prompt_tokens}  ⬇ ${completion_tokens}  ctx: ${ctxK}k/${maxK}k (${pct}%)${p.reset}`,
      );
      drain();
      pendingUsage = null;
    }
    endAgentResponse();
  });

  // Read-only tool kinds eligible for grouping
  const GROUPABLE_KINDS = new Set(["read", "search"]);

  bus.on("agent:tool-started", (e) => {
    fencedTransform.flush();
    stopCurrentSpinner();
    s.currentToolKind = e.kind;
    s.toolStartTime = Date.now();
    if (e.title === "user_shell") {
      finalizeToolGroup();
      closeToolLine();
      if (!s.renderer) startAgentResponse();
      contentGap("tool");
      s.renderer!.flush();
      const cmd = (e.rawInput as any)?.command || "";
      s.renderer!.writeLine(`${p.dim}▶ user_shell: ${cmd}${p.reset}`);
      drain();
      s.hadToolCalls = true;
    } else if (GROUPABLE_KINDS.has(e.kind ?? "") && e.kind === s.toolGroupKind) {
      // Consecutive same-kind read-only tool — collapse into group
      s.toolGroupCount++;
    } else {
      finalizeToolGroup();
      if (GROUPABLE_KINDS.has(e.kind ?? "")) {
        s.toolGroupKind = e.kind;
        s.toolGroupCount = 1;
        s.toolGroupAllOk = true;
      }
      showToolCall(e.title, "", {
        ...e,
        batchIndex: e.batchIndex,
        batchTotal: e.batchTotal,
      });
    }
  });

  bus.on("agent:tool-completed", (e) => {
    s.toolExitCode = e.exitCode;
    if (s.toolGroupCount > 1) {
      // Grouped tool — just track success/failure, don't render individually
      if (e.exitCode !== 0) s.toolGroupAllOk = false;
      s.currentToolKind = undefined;
      s.spinnerStartTime = 0;
      startThinkingSpinner();
    } else {
      showToolComplete(e.exitCode);
      s.currentToolKind = undefined;
      s.spinnerStartTime = 0;
      startThinkingSpinner();
    }
  });
  bus.on("agent:tool-output-chunk", (e) => writeCommandOutput(e.chunk));
  bus.on("agent:tool-output", () => flushCommandOutput());

  bus.on("agent:cancelled", () => {
    s.isThinking = false;
    stopCurrentSpinner();
    showInfo("(cancelled)");
    endAgentResponse();
  });

  bus.on("agent:processing-done", () => {
    s.isThinking = false;
    stopCurrentSpinner();
    endAgentResponse();
  });

  bus.on("agent:error", (e) => {
    stopCurrentSpinner();
    showCollapsedThinking();
    if (!s.renderer) startAgentResponse();
    contentGap("info");
    s.renderer!.writeLine(`${p.error}Error: ${e.message}${p.reset}`);
    s.renderer!.writeLine("");
    drain();
  });

  bus.on("permission:request", (e) => {
    stopCurrentSpinner();
    flushCommandOutput();
    if (s.renderer) {
      s.renderer.flush();
      drain();
    }

    if (e.kind === "file-write" && e.metadata?.diff) {
      showCollapsedThinking();
      showFileDiff(e.title, e.metadata.diff as DiffResult);
    }
    // Don't endAgentResponse() here — permission requests that aren't
    // file-write diffs are handled inline (auto-approved or by extensions).
    // Closing the response prematurely causes double separator borders.
  });

  bus.on("input:keypress", (e) => {
    if (e.key === "\x0f") expandLastDiff();       // Ctrl+O
    if (e.key === "\x14") toggleThinkingDisplay(); // Ctrl+T
  });
  bus.on("ui:info", (e) => {
    stopCurrentSpinner();
    showInfo(e.message);
    // Restart spinner if agent is still processing
    if (s.renderer) startThinkingSpinner();
  });
  bus.on("ui:error", (e) => showError(e.message));
  bus.on("ui:suggestion", (e) => {
    writer.write(`${p.dim}💡 ${e.text}${p.reset}\n`);
  });

  // ── Rendering functions ─────────────────────────────────────

  function drain(): void {
    if (!s.renderer) return;
    for (const line of s.renderer.drainLines()) {
      writer.write(line + "\n");
      // Track whether we just emitted a blank line (for contentGap dedup).
      // Lines from the renderer are indented ("  "), so a blank line is "  " or empty.
      lastEmittedLineBlank = line.trimEnd() === "" || line.trimEnd().replace(/\x1b\[[^m]*m/g, "").trim() === "";
    }
  }

  function startAgentResponse(): void {
    s.renderer = new MarkdownRenderer(writer.columns);
    s.hadToolCalls = false;
    s.lastContentKind = null;
    s.renderer.printTopBorder();
    drain();
  }

  /**
   * Insert an empty line when transitioning between different content kinds
   * (e.g., text → tool, tool → text, diff → tool) for visual breathing room.
   * Avoids double-blanks by checking if the last emitted line was already empty.
   */
  let lastEmittedLineBlank = false;

  function contentGap(kind: "text" | "tool" | "diff" | "code" | "info"): void {
    if (s.lastContentKind && s.lastContentKind !== kind && s.renderer && !lastEmittedLineBlank) {
      s.renderer.writeLine("");
      drain();
    }
    s.lastContentKind = kind;
  }

  function showCollapsedThinking(): void {
    if (s.thinkingPending && !s.showThinkingText) {
      if (!s.renderer) startAgentResponse();
      s.renderer!.writeLine(`${p.muted}… thinking${p.reset}`);
      s.renderer!.writeLine("");
      s.thinkingPending = false;
    }
  }

  function endAgentResponse(): void {
    finalizeToolGroup();
    closeToolLine();
    stopCurrentSpinner();
    if (s.renderer) {
      s.renderer.flush();
      s.renderer.printBottomBorder();
      drain();
      writer.write("\n");
      s.renderer = null;
    }
  }

  function showUserQuery(query: string): void {
    const boxW = writer.columns;
    const contentW = boxW - 4;

    let lines: string[] = [];
    for (const raw of query.split("\n")) {
      if (raw.length <= contentW) {
        lines.push(`${p.accent}${raw}${p.reset}`);
      } else {
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

    // Truncate very long queries to keep the response visible
    const MAX_QUERY_LINES = 20;
    if (lines.length > MAX_QUERY_LINES) {
      const overflow = lines.length - MAX_QUERY_LINES;
      lines = [
        ...lines.slice(0, MAX_QUERY_LINES),
        `${p.dim}… ${overflow} more lines${p.reset}`,
      ];
    }

    // Mode-specific border color and title
    const borderColor = p.accent;
    const title = `${p.accent}${p.bold}❯${p.reset}`;

    // Backend/model label on the right (backend/model, highlighted)
    const model = backendInfo?.model ?? llmClient?.model;
    const backend = backendInfo?.name;
    let modelLabel: string | undefined;
    if (backend && model) {
      modelLabel = `${p.dim}${backend}/${p.reset}${p.bold}${model}${p.reset}`;
    } else if (model) {
      modelLabel = `${p.bold}${model}${p.reset}`;
    } else if (backend) {
      modelLabel = `${p.bold}${backend}${p.reset}`;
    }

    const framed = renderBoxFrame(lines, {
      width: boxW,
      style: "rounded",
      borderColor,
      title,
      titleRight: modelLabel,
    });
    writer.write("\n");
    for (const line of framed) {
      writer.write(line + "\n");
    }
  }

  function writeAgentText(text: string): void {
    finalizeToolGroup();
    closeToolLine();
    s.hadToolCalls = false;
    if (s.isThinking) {
      s.isThinking = false;
      if (s.showThinkingText && s.renderer) {
        s.renderer.flush();
        const w = Math.min(80, writer.columns);
        s.renderer.writeLine(`${p.dim}${"─".repeat(w)}${p.reset}`);
        drain();
      }
    }
    showCollapsedThinking();
    stopCurrentSpinner();
    if (!s.renderer) startAgentResponse();
    contentGap("text");
    s.renderer!.push(text);
    drain();
  }

  define("render:code-block", (language: string, code: string, width: number) => {
    flushForRaw();
    contentGap("code");
    if (language) {
      s.renderer!.writeLine(`${p.dim}${language}${p.reset}`);
    }
    let highlighted: string;
    try {
      highlighted = language
        ? highlight(code, { language })
        : highlight(code);  // auto-detect
    } catch {
      highlighted = code;
    }
    const contentWidth = Math.min(90, width - 2);
    for (const line of highlighted.split("\n")) {
      const indented = `  ${line}`;
      const wrapped = wrapLine(indented, contentWidth);
      for (const wl of wrapped) {
        s.renderer!.writeLine(wl);
      }
    }
    drain();
  });

  function writeCodeBlock(language: string, code: string): void {
    ctx.call("render:code-block", language, code, writer.columns);
  }

  function flushForRaw(): void {
    closeToolLine();
    stopCurrentSpinner();
    if (!s.renderer) startAgentResponse();
    s.renderer!.flush();
    drain();
  }

  define("render:image", (data: Buffer) => {
    flushForRaw();
    const escape = encodeImageForTerminal(data);
    if (escape) {
      writer.write("  " + escape + "\n");
    }
  });

  function writeInlineImage(data: Buffer): void {
    ctx.call("render:image", data);
  }

  function showToolCall(
    title: string,
    command?: string,
    extra?: {
      kind?: string;
      icon?: string;
      locations?: { path: string; line?: number | null }[];
      rawInput?: unknown;
      batchIndex?: number;
      batchTotal?: number;
    },
  ): void {
    closeToolLine();
    stopCurrentSpinner();
    if (!s.renderer) startAgentResponse();
    showCollapsedThinking();
    contentGap("tool");
    s.renderer!.flush();
    drain();
    const lines = renderToolCall({
      title,
      command: command || undefined,
      kind: extra?.kind,
      icon: extra?.icon,
      locations: extra?.locations,
      rawInput: extra?.rawInput,
    }, writer.columns);

    // Prepend batch progress indicator when multiple tools in a batch
    const batchPrefix = extra?.batchTotal && extra.batchTotal > 1
      ? `${p.dim}[${extra.batchIndex}/${extra.batchTotal}]${p.reset} `
      : "";

    for (let i = 0; i < lines.length - 1; i++) {
      s.renderer!.writeLine(lines[i]!);
    }
    drain();
    if (lines.length > 0) {
      writer.write(`  ${batchPrefix}${lines[lines.length - 1]}`);
      s.toolLineOpen = true;
    }
    s.hadToolCalls = true;
    s.commandOutputLineCount = 0;
    s.commandOutputOverflow = 0;
  }

  function showToolComplete(exitCode: number | null): void {
    if (!s.renderer) return;
    const elapsed = s.toolStartTime ? formatElapsed(Date.now() - s.toolStartTime) : "";
    const timer = elapsed ? ` ${p.dim}${elapsed}${p.reset}` : "";
    const mark = exitCode === null
      ? `${p.muted}(timed out)${p.reset}`
      : exitCode === 0
        ? `${p.success}✓${p.reset}${timer}`
        : `${p.error}✗ exit ${exitCode}${p.reset}${timer}`;

    if (s.toolLineOpen && s.commandOutputLineCount === 0) {
      writer.write(` ${mark}\n`);
      s.toolLineOpen = false;
    } else {
      closeToolLine();
      flushCommandOutput();
      s.renderer.writeLine(`  ${mark}`);
      drain();
    }
  }

  // Thinking is always assumed available — the TUI renders thinking
  // tokens whenever they arrive, regardless of backend.
  function hasThinkingMode(): boolean {
    return true;
  }

  function startThinkingSpinner(): void {
    if (!s.spinnerStartTime) s.spinnerStartTime = Date.now();
    stopCurrentSpinner();
    const thinking = hasThinkingMode();
    s.spinnerLabel = thinking ? "Thinking" : "Working";
    const hint = thinking
      ? (s.showThinkingText ? "(ctrl+t to collapse)" : "(ctrl+t to expand)")
      : "";
    s.spinnerOpts = { hint: hint || undefined, startTime: s.spinnerStartTime };
    s.spinner = createSpinner({ startTime: s.spinnerStartTime });
    s.spinnerInterval = setInterval(() => {
      if (s.spinner) {
        const line = renderSpinnerLine(s.spinner, s.spinnerLabel, s.spinnerOpts);
        writer.write(`\r  ${line}\x1b[K`);
      }
    }, 80);
  }

  function stopCurrentSpinner(): void {
    if (s.spinnerInterval) {
      clearInterval(s.spinnerInterval);
      s.spinnerInterval = null;
    }
    if (s.spinner) {
      writer.write("\r\x1b[2K");
      s.spinner = null;
    }
  }

  function closeToolLine(): void {
    if (s.toolLineOpen) {
      writer.write("\n");
      s.toolLineOpen = false;
    }
  }

  /** Finalize a group of collapsed tool calls, rendering the summary. */
  function finalizeToolGroup(): void {
    if (s.toolGroupCount <= 1) {
      s.toolGroupKind = undefined;
      s.toolGroupCount = 0;
      return;
    }
    closeToolLine();
    if (!s.renderer) startAgentResponse();
    const icon = s.toolGroupKind === "read" ? "◆" : "⌕";
    const label = s.toolGroupKind === "read" ? "files read" : "searches";
    const mark = s.toolGroupAllOk
      ? `${p.success}✓${p.reset}`
      : `${p.error}✗${p.reset}`;
    s.renderer!.writeLine(
      `${p.warning}${icon}${p.reset} ${p.dim}… +${s.toolGroupCount - 1} more ${label}${p.reset} ${mark}`,
    );
    drain();
    s.toolGroupKind = undefined;
    s.toolGroupCount = 0;
    s.toolGroupAllOk = true;
  }

  function writeCommandOutput(chunk: string): void {
    if (!s.renderer) return;
    closeToolLine();
    const maxLines = s.currentToolKind === "read"
      ? getSettings().readOutputMaxLines
      : getSettings().maxCommandOutputLines;
    s.commandOutputBuffer += chunk;
    const lines = s.commandOutputBuffer.split("\n");
    s.commandOutputBuffer = lines.pop()!;
    for (const line of lines) {
      if (s.commandOutputLineCount < maxLines) {
        s.renderer.writeLine(`${p.dim}  ${line}${p.reset}`);
        s.commandOutputLineCount++;
      } else {
        s.commandOutputOverflow++;
        s.commandOverflowLines.push(line);
      }
    }
    drain();
  }

  /** Max overflow lines to show when a command fails. */
  const FAIL_OVERFLOW_MAX = 20;

  function flushCommandOutput(): void {
    if (!s.renderer) return;
    const maxLines = s.currentToolKind === "read"
      ? getSettings().readOutputMaxLines
      : getSettings().maxCommandOutputLines;
    if (s.commandOutputBuffer) {
      if (s.commandOutputLineCount < maxLines) {
        s.renderer.writeLine(`${p.dim}  ${s.commandOutputBuffer}${p.reset}`);
        s.commandOutputLineCount++;
      } else {
        s.commandOutputOverflow++;
        s.commandOverflowLines.push(s.commandOutputBuffer);
      }
      s.commandOutputBuffer = "";
    }

    // On failure, show the tail of the overflow so the user can see the error
    const failed = s.toolExitCode !== null && s.toolExitCode !== 0;
    if (failed && s.commandOverflowLines.length > 0) {
      const tail = s.commandOverflowLines.slice(-FAIL_OVERFLOW_MAX);
      const skipped = s.commandOverflowLines.length - tail.length;
      if (skipped > 0) {
        s.renderer.writeLine(`${p.dim}  … ${skipped} lines hidden${p.reset}`);
      }
      for (const line of tail) {
        s.renderer.writeLine(`${p.dim}  ${line}${p.reset}`);
      }
    } else if (s.commandOutputOverflow > 0 && maxLines > 0) {
      s.renderer.writeLine(`${p.dim}  … ${s.commandOutputOverflow} more lines${p.reset}`);
    }

    s.commandOutputOverflow = 0;
    s.commandOverflowLines = [];
    s.toolExitCode = null;
    drain();
  }

  function diffTitle(filePath: string, diff: DiffResult): string {
    const stats = diff.isNewFile
      ? `${p.success}+${diff.added}${p.reset}`
      : `${p.success}+${diff.added}${p.reset} ${p.error}-${diff.removed}${p.reset}`;
    return `${p.dim}${filePath}${p.reset}  ${stats}`;
  }

  function showFileDiff(filePath: string, diff: DiffResult): void {
    if (diff.isIdentical) return;
    contentGap("diff");

    const boxW = Math.min(120, writer.columns);
    const contentW = boxW - 4;

    const diffLines = renderDiff(diff, {
      width: contentW,
      filePath,
      maxLines: getSettings().diffMaxLines,
      trueColor: true,
    });

    const lastLine = diffLines[diffLines.length - 1] ?? "";
    const isTruncated = lastLine.includes("… ");

    if (isTruncated) {
      s.lastTruncatedDiff = { filePath, diff, expanded: false };
    } else {
      s.lastTruncatedDiff = null;
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

    if (!s.renderer) startAgentResponse();
    for (const line of framed) {
      s.renderer!.writeLine(line);
    }
    drain();
  }

  function expandLastDiff(): void {
    if (!s.lastTruncatedDiff) return;

    const entry = s.lastTruncatedDiff;
    entry.expanded = !entry.expanded;

    if (!entry.expanded) {
      showFileDiffCached(entry);
      return;
    }

    if (!entry.expandedLines) {
      const { filePath, diff } = entry;
      const boxW = Math.min(120, writer.columns);
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

    writer.write("\n");
    for (const line of entry.expandedLines) {
      writer.write(line + "\n");
    }
  }

  function showFileDiffCached(entry: TruncatedDiff): void {
    const { filePath, diff } = entry;
    const boxW = Math.min(120, writer.columns);
    const contentW = boxW - 4;

    const diffLines = renderDiff(diff, {
      width: contentW,
      filePath,
      maxLines: getSettings().diffMaxLines,
      trueColor: true,
    });

    const body = diffLines.length > 1 ? ["", ...diffLines.slice(1), ""] : diffLines;

    const framed = renderBoxFrame(body, {
      width: boxW,
      style: "rounded",
      borderColor: p.dim,
      title: diffTitle(filePath, diff),
      footer: [`  ${p.dim}ctrl+o to expand${p.reset}`],
    });

    writer.write("\n");
    for (const line of framed) {
      writer.write(line + "\n");
    }
  }

  function toggleThinkingDisplay(): void {
    s.showThinkingText = !s.showThinkingText;

    if (s.spinner) {
      stopCurrentSpinner();
      if (s.showThinkingText) {
        // Expanding: replace spinner with thinking text header
        if (!s.renderer) startAgentResponse();
        s.renderer!.writeLine(`${p.dim}Thinking (ctrl+t to collapse)${p.reset}`);
        drain();
      } else {
        // Collapsing: restart spinner with updated hint
        startThinkingSpinner();
      }
      return;
    }

    if (!s.isThinking) return;

    if (s.showThinkingText) {
      stopCurrentSpinner();
      if (!s.renderer) startAgentResponse();
      s.renderer!.writeLine(`${p.dim}Thinking (ctrl+t to collapse)${p.reset}`);
      drain();
    } else {
      if (s.renderer) {
        s.renderer.flush();
        const w = Math.min(80, writer.columns);
        s.renderer.writeLine(`${p.dim}${"─".repeat(w)}${p.reset}`);
        drain();
      }
      startThinkingSpinner();
    }
  }

  function showError(message: string): void {
    writer.write(`\n${p.error}Error: ${message}${p.reset}\n`);
  }

  function showInfo(message: string): void {
    writer.write(`${p.muted}${message}${p.reset}\n`);
  }
}
