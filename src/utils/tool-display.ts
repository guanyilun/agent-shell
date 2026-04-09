/**
 * Tool display renderer with elapsed timer and width-adaptive output.
 *
 * Follows the render(width) -> string[] protocol for completed tools.
 * Also provides a spinner/timer component for in-progress tools.
 */
import { visibleLen } from "./ansi.js";
import { palette as p } from "./palette.js";

// ── Types ────────────────────────────────────────────────────────

export type ToolDisplayMode = "full" | "compact" | "summary";

export interface ToolCallRender {
  /** The tool title (e.g. "Read file", "Bash command"). */
  title: string;
  /** Optional command string for bash-like tools. */
  command?: string;
  /** Tool kind from ACP (read, edit, execute, search, etc.). */
  kind?: string;
  /** File locations affected by the tool call. */
  locations?: { path: string; line?: number | null }[];
  /** Raw input parameters sent to the tool. */
  rawInput?: unknown;
}

export interface ToolResultRender {
  exitCode: number | null;
  /** Output lines from the tool. */
  outputLines?: string[];
  /** Maximum output lines to show. Default 10. */
  maxOutputLines?: number;
}

// ── Quiet command detection ──────────────────────────────────────

const QUIET_PATTERNS = [
  /^cd\b/,
  /^mkdir\b/,
  /^touch\b/,
  /^rm\b/,
  /^cp\b/,
  /^mv\b/,
  /^ln\b/,
  /^chmod\b/,
  /^chown\b/,
  /^git\s+(add|checkout|branch|switch|stash|tag|config)\b/,
  /^npm\s+(install|ci|uninstall)\b/,
  /^yarn\s+(add|remove|install)\b/,
  /^pnpm\s+(add|remove|install)\b/,
  /^export\b/,
  /^source\b/,
  /^\.\s/,
];

export function isQuietCommand(command: string): boolean {
  const trimmed = command.trim();
  return QUIET_PATTERNS.some((p) => p.test(trimmed));
}

// ── Mode selection ───────────────────────────────────────────────

export function selectToolDisplayMode(width: number): ToolDisplayMode {
  if (width >= 80) return "full";
  if (width >= 40) return "compact";
  return "summary";
}

// ── Kind icons ──────────────────────────────────────────────────

const KIND_ICONS: Record<string, string> = {
  read: "◆",
  edit: "✎",
  delete: "✕",
  move: "↗",
  search: "⌕",
  execute: "▶",
  think: "◇",
  fetch: "↓",
  switch_mode: "⇄",
};

function kindIcon(kind?: string): string {
  return kind ? (KIND_ICONS[kind] ?? "▶") : "▶";
}

// ── Tool call rendering ──────────────────────────────────────────

export function renderToolCall(
  tool: ToolCallRender,
  width: number,
): string[] {
  const mode = selectToolDisplayMode(width);
  const icon = kindIcon(tool.kind);

  if (mode === "summary") {
    const text = truncateVisible(`${icon} ${tool.title}`, width);
    return [`${p.warning}${text}${p.reset}`];
  }

  const lines: string[] = [];
  lines.push(`${p.warning}${p.bold}${icon} ${tool.title}${p.reset}`);

  if (mode === "full") {
    // Show file locations if available
    if (tool.locations && tool.locations.length > 0) {
      for (const loc of tool.locations) {
        const lineInfo = loc.line ? `:${loc.line}` : "";
        lines.push(`  ${p.dim}${loc.path}${lineInfo}${p.reset}`);
      }
    }

    // Show command string for terminal tools
    if (tool.command) {
      const maxCmdW = Math.max(1, width - 4);
      const cmd = tool.command.length > maxCmdW
        ? tool.command.slice(0, maxCmdW - 1) + "…"
        : tool.command;
      lines.push(`  ${p.dim}$ ${cmd}${p.reset}`);
    }

    // Show raw input args for non-terminal, non-file tools
    if (!tool.command && !tool.locations?.length && tool.rawInput) {
      const detail = formatRawInput(tool.rawInput, width - 4);
      if (detail) lines.push(`  ${p.dim}${detail}${p.reset}`);
    }
  }

  return lines;
}

/**
 * Format raw input parameters into a compact single-line summary.
 */
function formatRawInput(raw: unknown, maxWidth: number): string {
  if (raw == null) return "";
  if (typeof raw === "string") {
    return raw.length > maxWidth ? raw.slice(0, maxWidth - 1) + "…" : raw;
  }
  if (typeof raw !== "object") return String(raw);

  // Show key=value pairs for objects
  const obj = raw as Record<string, unknown>;
  const parts: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val == null) continue;
    const valStr = typeof val === "string" ? val : JSON.stringify(val);
    parts.push(`${key}=${valStr}`);
  }
  const joined = parts.join("  ");
  return joined.length > maxWidth ? joined.slice(0, maxWidth - 1) + "…" : joined;
}

// ── Tool result rendering ────────────────────────────────────────

export function renderToolResult(
  result: ToolResultRender,
  width: number,
): string[] {
  const mode = selectToolDisplayMode(width);
  const lines: string[] = [];

  // Status indicator
  if (result.exitCode === null) {
    lines.push(`  ${p.muted}(timed out)${p.reset}`);
  } else if (result.exitCode === 0) {
    lines.push(`  ${p.success}✓${p.reset}`);
  } else {
    lines.push(`  ${p.error}✗ exit ${result.exitCode}${p.reset}`);
  }

  // Output preview (full mode only)
  if (mode === "full" && result.outputLines && result.outputLines.length > 0) {
    const maxLines = result.maxOutputLines ?? 10;
    const total = result.outputLines.length;
    const shown = result.outputLines.slice(0, maxLines);
    const maxTextW = Math.max(1, width - 6);

    for (const line of shown) {
      const text = line.length > maxTextW
        ? line.slice(0, maxTextW - 1) + "…"
        : line;
      lines.push(`  ${p.dim}  ${text}${p.reset}`);
    }

    if (total > maxLines) {
      lines.push(`  ${p.dim}  … ${total - maxLines} more lines${p.reset}`);
    }
  }

  return lines;
}

// ── Elapsed timer ────────────────────────────────────────────────

export function formatElapsed(ms: number): string {
  if (ms < 1000) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

// ── Spinner with elapsed timer ───────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerState {
  frame: number;
  startTime: number;
  interval: ReturnType<typeof setInterval> | null;
}

export function createSpinner(): SpinnerState {
  return { frame: 0, startTime: Date.now(), interval: null };
}

/**
 * Start a spinner that writes to stdout on the current line.
 * Returns the SpinnerState for later stopping.
 */
export function startSpinner(
  label: string,
  opts?: { color?: string },
): SpinnerState {
  const state = createSpinner();
  const color = opts?.color ?? p.accent;

  state.interval = setInterval(() => {
    const frame = SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length];
    const elapsed = formatElapsed(Date.now() - state.startTime);
    const timer = elapsed ? ` ${p.dim}${elapsed}${p.reset}` : "";
    process.stdout.write(`\r  ${color}${frame} ${label}...${p.reset}${timer}\x1b[K`);
    state.frame++;
  }, 80);

  return state;
}

export function stopSpinner(state: SpinnerState): void {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
    process.stdout.write("\r\x1b[2K");
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function truncateVisible(text: string, maxWidth: number): string {
  if (visibleLen(text) <= maxWidth) return text;
  // Simple truncation for plain text (no ANSI)
  if (maxWidth <= 1) return "…";
  return text.slice(0, maxWidth - 1) + "…";
}
