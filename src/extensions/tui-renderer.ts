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
import type { ToolResultDisplay, ToolResultBody } from "../agent/types.js";
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
  const { bus, llmClient, define } = ctx;
  const writer = new StdoutWriter();
  const s = createRenderState();

  // Suppress all TUI output while stdout is held (overlay extensions)
  bus.on("shell:stdout-hold", () => { writer.hold(); });
  bus.on("shell:stdout-release", () => { writer.release(); });

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

  // ── Tool batch grouping ──────────────────────────────────────────
  const GROUPABLE_KINDS = new Set(["read", "search"]);
  const GROUP_MAX_VISIBLE = 5;
  const KIND_ICONS: Record<string, string> = { read: "◆", search: "⌕" };

  // Batch groups: kind → { total, rendered, headerShown }
  let batchGroups = new Map<string, { total: number; rendered: number; headerShown: boolean }>();

  bus.on("agent:tool-batch", (e) => {
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
    // Preserve lastContentKind across responses so text→tool gaps work
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
    if (s.lastContentKind && s.lastContentKind !== kind) {
      if (s.renderer) {
        s.renderer.flush();
        drain();
      }
      writer.write("\n");
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
    const boxW = Math.min(120, width);
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
    }, writer.columns);

    if (extra?.groupContinuation && lines.length > 0) {
      // Swap the colored kind icon for a muted tree connector,
      // and strip the tool name prefix — show detail only.
      const detail = extra.displayDetail || extractDetail(extra);
      const maxW = Math.max(1, writer.columns - 6);
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
        writer.write(`  ${batchPrefix}${lines[lines.length - 1]}`);
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
    const timer = elapsed ? ` ${p.dim}${elapsed}${p.reset}` : "";
    const summary = resultDisplay?.summary ? ` ${p.dim}${resultDisplay.summary}${p.reset}` : "";
    const mark = exitCode === null
      ? `${p.muted}(timed out)${p.reset}`
      : exitCode === 0
        ? `${p.success}✓${p.reset}${summary}${timer}`
        : `${p.error}✗ exit ${exitCode}${p.reset}${summary}${timer}`;

    if (s.toolLineOpen && s.commandOutputLineCount === 0) {
      writer.write(` ${mark}\n`);
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
    const lines: string[] = ctx.call("render:result-body", body, writer.columns) ?? [];
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
      // 0–1 tools: standalone, nothing to finalize
      s.toolGroupKind = undefined;
      s.toolGroupCount = 0;
      s.toolGroupRendered = 0;
      s.toolGroupSummaries = [];
      return;
    }
    closeToolLine();
    if (!s.renderer) startAgentResponse();
    const mark = s.toolGroupAllOk
      ? `${p.success}✓${p.reset}`
      : `${p.error}✗${p.reset}`;
    const summary = s.toolGroupSummaries.length > 0
      ? ` ${p.dim}${s.toolGroupSummaries.join(", ")}${p.reset}`
      : "";
    const collapsed = s.toolGroupCount - s.toolGroupRendered;
    if (collapsed > 0) {
      s.renderer!.writeLine(
        `  ${p.muted}└${p.reset} ${p.dim}+${collapsed} more${p.reset} ${mark}${summary}`,
      );
    } else {
      // All items visible — close the tree with └ mark + summary
      s.renderer!.writeLine(`  ${p.muted}└${p.reset} ${mark}${summary}`);
    }
    drain();
    s.toolGroupKind = undefined;
    s.toolGroupCount = 0;
    s.toolGroupAllOk = true;
    s.toolGroupRendered = 0;
    s.toolGroupSummaries = [];
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

    const lines: string[] = ctx.call(
      "render:result-body",
      { kind: "diff", diff, filePath } satisfies ToolResultBody,
      writer.columns,
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
    const lines: string[] = ctx.call(
      "render:result-body",
      { kind: "diff", diff: entry.diff, filePath: entry.filePath } satisfies ToolResultBody,
      writer.columns,
    ) ?? [];

    writer.write("\n");
    for (const line of lines) {
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
