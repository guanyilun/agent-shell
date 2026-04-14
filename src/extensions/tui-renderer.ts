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
import { MarkdownRenderer, wrapLine, MAX_CONTENT_WIDTH } from "../utils/markdown.js";
import { createFencedBlockTransform, type FencedBlockTransformHandle } from "../utils/stream-transform.js";
import { palette as p } from "../utils/palette.js";
import {
  renderToolCall,
  createSpinner,
  formatElapsed,
  SPINNER_FRAMES,
  type SpinnerState,
  type SpinnerOpts,
} from "../utils/tool-display.js";
import { renderDiff } from "../utils/diff-renderer.js";
import { renderBoxFrame } from "../utils/box-frame.js";
import type { DiffResult } from "../utils/diff.js";
import { getSettings } from "../settings.js";
import type { ExtensionContext } from "../types.js";
import type { ToolResultDisplay, ToolResultBody } from "../agent/types.js";
import type { RenderSurface } from "../utils/compositor.js";

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
  /** Number of tools rendered individually in current group. */
  toolGroupRendered: number;
  /** Accumulated result summaries from grouped tools. */
  toolGroupSummaries: string[];

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
    toolGroupRendered: 0,
    toolGroupSummaries: [],
    isThinking: false,
    showThinkingText: false,
    thinkingPending: false,
    lastTruncatedDiff: null,
  };
}

export default function activate(ctx: ExtensionContext): void {
  const { bus, define, compositor } = ctx;
  const s = createRenderState();

  /** Shorthand — get the current agent surface. */
  function out(): RenderSurface { return compositor.surface("agent"); }

  /** Capped width for borders, tool lines, and content — keeps everything aligned. */
  function cappedW(): number { return Math.min(MAX_CONTENT_WIDTH + 2, out().columns); }

  // Gate: other extensions (e.g. overlay) can advise this to suppress
  // TUI rendering of agent output while they own the display.
  define("tui:should-render-agent", (): boolean => true);
  function shouldRender(): boolean { return ctx.call("tui:should-render-agent"); }

  // ── Advisable rendering handlers ───────────────────────────────
  // Extensions advise these to customize how the TUI renders content.
  // Each handler receives data and returns rendered strings.

  define("tui:response-border", (position: "top" | "bottom", width: number): string | null => {
    return `${p.dim}${p.accent}${"─".repeat(width)}${p.reset}`;
  });
  define("tui:response-start", (): void => {});
  define("tui:response-end", (_hadToolCalls: boolean): void => {});

  define("tui:render-info", (message: string): string =>
    `${p.muted}${message}${p.reset}`);

  define("tui:render-error", (message: string): string =>
    `${p.error}Error: ${message}${p.reset}`);

  define("tui:render-usage", (promptTokens: number, completionTokens: number, maxTokens: number): string => {
    const ctxK = (promptTokens / 1000).toFixed(1);
    const maxK = (maxTokens / 1000).toFixed(0);
    const pct = Math.min(100, (promptTokens / maxTokens) * 100).toFixed(0);
    return `${p.dim}⬆ ${promptTokens}  ⬇ ${completionTokens}  ctx: ${ctxK}k/${maxK}k (${pct}%)${p.reset}`;
  });

  define("tui:render-content-gap", (fromKind: string, toKind: string): string | null =>
    fromKind !== toKind ? "\n" : null);

  define("tui:render-tool-complete", (exitCode: number | null, elapsed: string, summary: string | undefined): string => {
    const timer = elapsed ? ` ${p.dim}${elapsed}${p.reset}` : "";
    const summaryStr = summary ? ` ${p.dim}${summary}${p.reset}` : "";
    if (exitCode === null) return `${p.muted}(timed out)${p.reset}`;
    if (exitCode === 0) return `${p.success}✓${p.reset}${summaryStr}${timer}`;
    return `${p.error}✗ exit ${exitCode}${p.reset}${summaryStr}${timer}`;
  });

  define("tui:render-tool-group-summary", (count: number, rendered: number, allOk: boolean, summaries: string[]): string => {
    const mark = allOk ? `${p.success}✓${p.reset}` : `${p.error}✗${p.reset}`;
    const summaryStr = summaries.length > 0 ? ` ${p.dim}${summaries.join(", ")}${p.reset}` : "";
    const collapsed = count - rendered;
    if (collapsed > 0) {
      return `  ${p.muted}└${p.reset} ${p.dim}+${collapsed} more${p.reset} ${mark}${summaryStr}`;
    }
    return `  ${p.muted}└${p.reset} ${mark}${summaryStr}`;
  });

  define("tui:render-command-output", (line: string, _kind: string | undefined): string =>
    `${p.dim}  ${line}${p.reset}`);

  define("tui:render-spinner", (label: string, frame: string, elapsed: string, hint: string | undefined): string => {
    const timer = elapsed ? ` ${p.dim}${elapsed}${p.reset}` : "";
    const hintStr = hint ? ` ${p.dim}${hint}${p.reset}` : "";
    return `${p.accent}${frame} ${label}...${p.reset}${timer}${hintStr}`;
  });

  define("tui:render-user-query", (query: string, width: number, modelLabel: string | undefined): string[] => {
    const contentW = width - 4;
    let lines: string[] = [];
    for (const raw of query.split("\n")) {
      for (const wrapped of wrapLine(`${p.accent}${raw}${p.reset}`, contentW)) {
        lines.push(wrapped);
      }
    }
    const MAX_QUERY_LINES = 20;
    if (lines.length > MAX_QUERY_LINES) {
      const overflow = lines.length - MAX_QUERY_LINES;
      lines = [...lines.slice(0, MAX_QUERY_LINES), `${p.dim}… ${overflow} more lines${p.reset}`];
    }
    return renderBoxFrame(lines, {
      width,
      style: "rounded",
      borderColor: p.accent,
      title: `${p.accent}${p.bold}❯${p.reset}`,
      titleRight: modelLabel,
    });
  });

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
    if (!shouldRender()) return;
    s.spinnerStartTime = 0;
    showUserQuery(e.query);
    startAgentResponse();
    startThinkingSpinner();
  });

  bus.on("agent:thinking-chunk", (e) => {
    if (!shouldRender()) return;
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
    if (!shouldRender()) return;
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
          out().write(block.escape);
          break;
      }
    }
  });
  // Track token usage for display
  let pendingUsage: { prompt_tokens: number; completion_tokens: number } | null = null;
  bus.on("agent:usage", (e) => { pendingUsage = e; });

  bus.on("agent:response-done", () => {
    if (!shouldRender()) return;
    s.isThinking = false;
    if (pendingUsage && s.renderer) {
      const { prompt_tokens, completion_tokens } = pendingUsage;
      const maxTokens = backendInfo?.contextWindow ?? 128_000;
      s.renderer.writeLine("");
      s.renderer.writeLine(ctx.call("tui:render-usage", prompt_tokens, completion_tokens, maxTokens));
      drain();
      pendingUsage = null;
    }
    endAgentResponse();
  });

  // ── Tool batch grouping ──────────────────────────────────────────
  const GROUPABLE_KINDS = new Set(["read", "search"]);
  const GROUP_MAX_VISIBLE = 5;
  const KIND_ICONS: Record<string, string> = { read: "◆", search: "⌕" };

  // Batch groups: kind → { total, rendered, headerShown }
  let batchGroups = new Map<string, { total: number; rendered: number; headerShown: boolean }>();

  bus.on("agent:tool-batch", (e) => {
    if (!shouldRender()) return;
    fencedTransform.flush();
    finalizeToolGroup();
    batchGroups = new Map();
    for (const group of e.groups) {
      batchGroups.set(group.kind, {
        total: group.tools.length,
        rendered: 0,
        headerShown: false,
      });
    }
  });

  bus.on("agent:tool-started", (e) => {
    if (!shouldRender()) return;
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
      return;
    }

    const kind = e.kind ?? "execute";
    const group = batchGroups.get(kind);
    const isGrouped = group && group.total > 1 && GROUPABLE_KINDS.has(kind);

    if (isGrouped) {
      // Render group header on first tool of this kind in the batch
      if (!group.headerShown) {
        finalizeToolGroup();
        closeToolLine();
        if (!s.renderer) startAgentResponse();
        showCollapsedThinking();
        contentGap("tool");
        s.renderer!.flush();
        drain();

        const icon = KIND_ICONS[kind] ?? "▶";
        s.renderer!.writeLine(`${p.warning}${icon}${p.reset} ${kind}`);
        drain();

        group.headerShown = true;
        s.toolGroupKind = kind;
        s.toolGroupCount = 0;
        s.toolGroupRendered = 0;
        s.toolGroupAllOk = true;
        s.toolGroupSummaries = [];
      }

      s.toolGroupCount++;

      if (s.toolGroupRendered < GROUP_MAX_VISIBLE) {
        showToolCall(e.title, "", {
          ...e,
          batchIndex: e.batchIndex,
          batchTotal: e.batchTotal,
          groupContinuation: true,
        });
        s.toolGroupRendered++;
      }
    } else {
      // Standalone tool — single in its batch kind, or not groupable
      finalizeToolGroup();
      showToolCall(e.title, "", {
        ...e,
        batchIndex: e.batchIndex,
        batchTotal: e.batchTotal,
      });
    }
  });

  bus.on("agent:tool-completed", (e) => {
    if (!shouldRender()) return;
    s.toolExitCode = e.exitCode;
    if (e.exitCode !== 0) s.toolGroupAllOk = false;

    if (s.toolGroupKind) {
      // Grouped tool — track success/failure and summaries, show aggregate on ⎿ line.
      // Don't restart spinner between grouped tools — it's already running from group start.
      if (e.resultDisplay?.summary) s.toolGroupSummaries.push(e.resultDisplay.summary);
      s.currentToolKind = undefined;
    } else {
      showToolComplete(e.exitCode, e.resultDisplay);
      s.currentToolKind = undefined;
      s.spinnerStartTime = 0;
      startThinkingSpinner();
    }
  });
  bus.on("agent:tool-output-chunk", (e) => { if (shouldRender()) writeCommandOutput(e.chunk); });
  bus.on("agent:tool-output", () => { if (shouldRender()) flushCommandOutput(); });

  bus.on("agent:cancelled", () => {
    if (!shouldRender()) return;
    s.isThinking = false;
    stopCurrentSpinner();
    showInfo("(cancelled)");
    endAgentResponse();
  });

  bus.on("agent:processing-done", () => {
    if (!shouldRender()) return;
    s.isThinking = false;
    stopCurrentSpinner();
    endAgentResponse();
  });

  bus.on("agent:error", (e) => {
    if (!shouldRender()) return;
    stopCurrentSpinner();
    showCollapsedThinking();
    if (!s.renderer) startAgentResponse();
    contentGap("info");
    s.renderer!.writeLine(`${p.error}Error: ${e.message}${p.reset}`);
    s.renderer!.writeLine("");
    drain();
  });

  bus.on("permission:request", (e) => {
    if (!shouldRender()) return;
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
  // Interactive tool UI — stop spinner while tool has control
  bus.on("tool:interactive-start", () => { stopCurrentSpinner(); });

  bus.on("ui:info", (e) => {
    stopCurrentSpinner();
    showInfo(e.message);
    // Restart spinner if agent is still processing
    if (s.renderer) startThinkingSpinner();
  });
  bus.on("ui:error", (e) => showError(e.message));
  bus.on("ui:suggestion", (e) => {
    compositor.surface("status").writeLine(`${p.dim}💡 ${e.text}${p.reset}`);
  });

  // ── Rendering functions ─────────────────────────────────────

  function drain(): void {
    if (!s.renderer) return;
    for (const line of s.renderer.drainLines()) {
      out().write(line + "\n");
      // Track whether we just emitted a blank line (for contentGap dedup).
      // Lines from the renderer are indented ("  "), so a blank line is "  " or empty.
      lastEmittedLineBlank = line.trimEnd() === "" || line.trimEnd().replace(/\x1b\[[^m]*m/g, "").trim() === "";
    }
  }

  function startAgentResponse(): void {
    s.renderer = new MarkdownRenderer(cappedW());
    s.hadToolCalls = false;
    const border: string | null = ctx.call("tui:response-border", "top", cappedW());
    if (border) s.renderer.writeLine(border);
    drain();
    ctx.call("tui:response-start");
  }

  /**
   * Insert an empty line when transitioning between different content kinds
   * (e.g., text → tool, tool → text, diff → tool) for visual breathing room.
   * Avoids double-blanks by checking if the last emitted line was already empty.
   */
  let lastEmittedLineBlank = false;

  function contentGap(kind: "text" | "tool" | "diff" | "code" | "info"): void {
    if (s.lastContentKind) {
      const gap: string | null = ctx.call("tui:render-content-gap", s.lastContentKind, kind);
      if (gap) {
        if (s.renderer) { s.renderer.flush(); drain(); }
        out().write(gap);
      }
    }
    s.lastContentKind = kind;
  }

  function showCollapsedThinking(): void {
    if (s.thinkingPending && !s.showThinkingText) {
      // Just clear the pending flag — the spinner already indicates thinking.
      // No need for a separate "… thinking" label that clutters the output.
      s.thinkingPending = false;
    }
  }

  function endAgentResponse(): void {
    finalizeToolGroup();
    closeToolLine();
    stopCurrentSpinner();
    if (s.renderer) {
      ctx.call("tui:response-end", s.hadToolCalls);
      s.renderer.flush();
      const border: string | null = ctx.call("tui:response-border", "bottom", cappedW());
      if (border) s.renderer.writeLine(border);
      drain();
      out().write("\n");
      s.renderer = null;
    }
  }

  function showUserQuery(query: string): void {
    const model = backendInfo?.model;
    const backend = backendInfo?.name;
    let modelLabel: string | undefined;
    if (backend && model) {
      modelLabel = `${p.dim}${backend}/${p.reset}${p.bold}${model}${p.reset}`;
    } else if (model) {
      modelLabel = `${p.bold}${model}${p.reset}`;
    } else if (backend) {
      modelLabel = `${p.bold}${backend}${p.reset}`;
    }

    const querySurface = compositor.surface("query");
    const framed: string[] = ctx.call("tui:render-user-query", query, querySurface.columns, modelLabel);
    if (framed.length > 0) {
      querySurface.write("\n");
      for (const line of framed) {
        querySurface.writeLine(line);
      }
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
        const w = Math.min(80, out().columns);
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
    ctx.call("render:code-block", language, code, cappedW());
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
      out().write("  " + escape + "\n");
    }
  });

  function writeInlineImage(data: Buffer): void {
    ctx.call("render:image", data);
  }

  /**
   * Default renderer for tool result bodies. Extensions can advise this handler
   * to override rendering for specific body kinds or add new ones:
   *
   *   ctx.advise("render:result-body", (next, body, width) => {
   *     if (body.kind === "diff") return myCustomDiffRenderer(body, width);
   *     return next(body, width);
   *   });
   */
  define("render:result-body", (body: ToolResultBody, width: number): string[] => {
    if (body.kind === "diff") {
      return renderDiffBody(body.diff as DiffResult, body.filePath, width);
    }
    if (body.kind === "lines") {
      return renderLinesBody(body.lines, width, body.maxLines);
    }
    return [];
  });

  /** Render a diff as framed box lines (pure — no TUI state side effects). */
  function renderDiffBody(diff: DiffResult, filePath: string, width: number): string[] {
    if (diff.isIdentical) return [];
    const boxW = Math.min(120, width - 2);  // -2 for writeLine indent
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

    return renderBoxFrame(body, {
      width: boxW,
      style: "rounded",
      borderColor: p.dim,
      title: diffTitle(filePath, diff),
      footer,
    });
  }

  /** Render output lines with truncation. */
  function renderLinesBody(lines: string[], width: number, maxLines?: number): string[] {
    const max = maxLines ?? 10;
    const shown = lines.slice(0, max);
    const contentW = Math.max(1, width - 6);
    const output: string[] = [];
    for (const line of shown) {
      const text = line.length > contentW ? line.slice(0, contentW - 1) + "…" : line;
      output.push(`  ${p.dim}  ${text}${p.reset}`);
    }
    if (lines.length > max) {
      output.push(`  ${p.dim}  … ${lines.length - max} more lines${p.reset}`);
    }
    return output;
  }

  /** Extract a detail string from tool args for group continuation display. */
  function extractDetail(extra: { rawInput?: unknown; locations?: { path: string; line?: number | null }[] }): string {
    if (extra.locations && extra.locations.length > 0) {
      const loc = extra.locations[0]!;
      const cwd = process.cwd();
      const home = process.env.HOME;
      let fp = loc.path;
      if (fp.startsWith(cwd + "/")) fp = fp.slice(cwd.length + 1);
      else if (home && fp.startsWith(home + "/")) fp = "~/" + fp.slice(home.length + 1);
      return loc.line ? `${fp}:${loc.line}` : fp;
    }
    const raw = extra.rawInput as Record<string, unknown> | undefined;
    if (!raw) return "";
    if (typeof raw.command === "string") return `$ ${raw.command}`;
    if (typeof raw.pattern === "string") return raw.pattern;
    if (typeof raw.path === "string") {
      const cwd = process.cwd();
      const home = process.env.HOME;
      let fp = raw.path as string;
      if (fp.startsWith(cwd + "/")) fp = fp.slice(cwd.length + 1);
      else if (home && fp.startsWith(home + "/")) fp = "~/" + fp.slice(home.length + 1);
      return fp;
    }
    if (typeof raw.query === "string") return `"${raw.query}"`;
    return "";
  }

  function showToolCall(
    title: string,
    command?: string,
    extra?: {
      kind?: string;
      icon?: string;
      locations?: { path: string; line?: number | null }[];
      rawInput?: unknown;
      displayDetail?: string;
      batchIndex?: number;
      batchTotal?: number;
      groupContinuation?: boolean;
    },
  ): void {
    closeToolLine();
    stopCurrentSpinner();
    if (!s.renderer) startAgentResponse();
    showCollapsedThinking();
    // No gap between grouped tools — they're visually connected
    if (!extra?.groupContinuation) contentGap("tool");
    s.renderer!.flush();
    drain();
    const lines = renderToolCall({
      title,
      command: command || undefined,
      kind: extra?.kind,
      icon: extra?.icon,
      locations: extra?.locations,
      rawInput: extra?.rawInput,
      displayDetail: extra?.displayDetail,
    }, cappedW());

    if (extra?.groupContinuation && lines.length > 0) {
      // Swap the colored kind icon for a muted tree connector,
      // and strip the tool name prefix — show detail only.
      const detail = extra.displayDetail || extractDetail(extra);
      const maxW = Math.max(1, cappedW() - 6);
      const text = detail.length > maxW ? detail.slice(0, maxW - 1) + "…" : detail;
      lines[0] = detail
        ? `${p.muted}├${p.reset} ${p.dim}${text}${p.reset}`
        : lines[0]!.replace(/^\x1b\[[^m]*m.\x1b\[0m/, `${p.muted}├${p.reset}`);
    }

    const batchPrefix = "";

    for (let i = 0; i < lines.length - 1; i++) {
      s.renderer!.writeLine(lines[i]!);
    }
    drain();
    if (lines.length > 0) {
      if (extra?.groupContinuation) {
        // Grouped tools: close the line immediately — checkmarks go on the ⎿ summary
        s.renderer!.writeLine(`  ${batchPrefix}${lines[lines.length - 1]}`);
        drain();
        s.toolLineOpen = false;
      } else {
        out().write(`  ${batchPrefix}${lines[lines.length - 1]}`);
        s.toolLineOpen = true;
      }
    }
    s.hadToolCalls = true;
    s.commandOutputLineCount = 0;
    s.commandOutputOverflow = 0;
  }

  function showToolComplete(exitCode: number | null, resultDisplay?: ToolResultDisplay): void {
    if (!s.renderer) return;
    stopCurrentSpinner();
    const elapsed = s.toolStartTime ? formatElapsed(Date.now() - s.toolStartTime) : "";
    const mark: string = ctx.call("tui:render-tool-complete", exitCode, elapsed, resultDisplay?.summary);

    if (s.toolLineOpen && s.commandOutputLineCount === 0) {
      out().write(` ${mark}\n`);
      s.toolLineOpen = false;
    } else {
      closeToolLine();
      flushCommandOutput();
      s.renderer.writeLine(`  ${mark}`);
      drain();
    }

    // Render structured body if present
    if (resultDisplay?.body) {
      renderResultBody(resultDisplay.body);
    }
  }

  function renderResultBody(body: ToolResultBody): void {
    if (!s.renderer) return;
    const lines: string[] = ctx.call("render:result-body", body, cappedW()) ?? [];
    for (const line of lines) {
      s.renderer!.writeLine(line);
    }
    if (lines.length > 0) drain();
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
        const frame = SPINNER_FRAMES[s.spinner.frame % SPINNER_FRAMES.length]!;
        s.spinner.frame++;
        const elapsed = formatElapsed(Date.now() - s.spinner.startTime);
        const line: string = ctx.call("tui:render-spinner", s.spinnerLabel, frame, elapsed, s.spinnerOpts.hint);
        out().write(`\r  ${line}\x1b[K`);
      }
    }, 80);
  }

  function stopCurrentSpinner(): void {
    if (s.spinnerInterval) {
      clearInterval(s.spinnerInterval);
      s.spinnerInterval = null;
    }
    if (s.spinner) {
      out().write("\r\x1b[2K");
      s.spinner = null;
    }
  }

  function closeToolLine(): void {
    if (s.toolLineOpen) {
      out().write("\n");
      s.toolLineOpen = false;
    }
  }

  /** Finalize a group of collapsed tool calls, rendering the summary. */
  function finalizeToolGroup(): void {
    if (s.toolGroupCount <= 1) {
      // 0–1 tools: standalone, nothing to finalize
      s.toolGroupKind = undefined;
      s.toolGroupCount = 0;
      s.toolGroupRendered = 0;
      s.toolGroupSummaries = [];
      return;
    }
    closeToolLine();
    if (!s.renderer) startAgentResponse();
    const groupLine: string = ctx.call(
      "tui:render-tool-group-summary",
      s.toolGroupCount, s.toolGroupRendered, s.toolGroupAllOk, s.toolGroupSummaries,
    );
    s.renderer!.writeLine(groupLine);
    drain();
    s.toolGroupKind = undefined;
    s.toolGroupCount = 0;
    s.toolGroupAllOk = true;
    s.toolGroupRendered = 0;
    s.toolGroupSummaries = [];
  }

  function renderCommandLine(line: string): string {
    return ctx.call("tui:render-command-output", line, s.currentToolKind) as string;
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
        s.renderer.writeLine(renderCommandLine(line));
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
        s.renderer.writeLine(renderCommandLine(s.commandOutputBuffer));
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
        s.renderer.writeLine(renderCommandLine(`… ${skipped} lines hidden`));
      }
      for (const line of tail) {
        s.renderer.writeLine(renderCommandLine(line));
      }
    } else if (s.commandOutputOverflow > 0 && maxLines > 0) {
      // Show last line of output so the user sees the tail (often the most useful part)
      const tail = s.commandOverflowLines[s.commandOverflowLines.length - 1];
      const hidden = tail ? s.commandOutputOverflow - 1 : s.commandOutputOverflow;
      if (hidden > 0) {
        s.renderer.writeLine(renderCommandLine(`… ${hidden} more lines`));
      }
      if (tail) {
        s.renderer.writeLine(renderCommandLine(tail));
      }
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

    const lines: string[] = ctx.call(
      "render:result-body",
      { kind: "diff", diff, filePath } satisfies ToolResultBody,
      cappedW(),
    ) ?? [];

    if (!s.renderer) startAgentResponse();
    for (const line of lines) {
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
      const boxW = Math.min(cappedW() - 2, out().columns - 2);  // -2 for writeLine indent
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

    out().write("\n");
    for (const line of entry.expandedLines) {
      out().write(line + "\n");
    }
  }

  function showFileDiffCached(entry: TruncatedDiff): void {
    const lines: string[] = ctx.call(
      "render:result-body",
      { kind: "diff", diff: entry.diff, filePath: entry.filePath } satisfies ToolResultBody,
      cappedW(),
    ) ?? [];

    out().write("\n");
    for (const line of lines) {
      out().write(line + "\n");
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
        const w = Math.min(80, out().columns);
        s.renderer.writeLine(`${p.dim}${"─".repeat(w)}${p.reset}`);
        drain();
      }
      startThinkingSpinner();
    }
  }

  function showError(message: string): void {
    const s = compositor.surface("status");
    s.write("\n" + ctx.call("tui:render-error", message) + "\n");
  }

  function showInfo(message: string): void {
    compositor.surface("status").writeLine(ctx.call("tui:render-info", message));
  }
}
