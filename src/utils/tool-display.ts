/**
 * Tool display renderer with elapsed timer and width-adaptive output.
 *
 * Follows the render(width) -> string[] protocol for completed tools.
 * Also provides a spinner/timer component for in-progress tools.
 */
import * as path from "node:path";
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
  /** Custom icon character — when set, tool name is omitted (icon implies tool). */
  icon?: string;
  /** File locations affected by the tool call. */
  locations?: { path: string; line?: number | null }[];
  /** Raw input parameters sent to the tool. */
  rawInput?: unknown;
  /** Pre-formatted display detail from tool's formatCall(). Takes precedence over rawInput extraction. */
  displayDetail?: string;
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
  display: "◇",
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
  const icon = tool.icon ?? kindIcon(tool.kind);
  // If the tool registered a custom icon, it's self-describing — omit the name.
  // Otherwise, include the tool name so the user knows what ran.
  const hasCustomIcon = !!tool.icon;

  if (mode === "summary") {
    const text = truncateVisible(`${icon} ${tool.title}`, width);
    return [`${p.warning}${text}${p.reset}`];
  }

  const lines: string[] = [];

  // Build a compact detail string to append after the title
  let detail = "";
  const cwd = process.cwd();
  if (mode === "full" && tool.displayDetail) {
    detail = tool.displayDetail;
  } else if (mode === "full") {
    if (tool.command) {
      detail = `$ ${tool.command}`;
    } else if (tool.locations && tool.locations.length > 0) {
      const loc = tool.locations[0]!;
      const lineInfo = loc.line ? `:${loc.line}` : "";
      detail = `${shortenPath(loc.path, cwd)}${lineInfo}`;
    } else if (tool.rawInput) {
      const raw = tool.rawInput as Record<string, unknown>;
      if (raw && typeof raw === "object") {
        if (typeof raw.command === "string") {
          detail = `$ ${raw.command}`;
        } else if (typeof raw.pattern === "string") {
          // grep/glob — show the search pattern
          const target = typeof raw.path === "string" ? ` ${shortenPath(raw.path, cwd)}` : "";
          detail = `${raw.pattern}${target}`;
        } else if (typeof raw.path === "string") {
          // read_file, write_file, etc.
          detail = shortenPath(raw.path, cwd);
        } else if (typeof raw.operation === "string") {
          detail = raw.operation;
          if (raw.ids && Array.isArray(raw.ids)) {
            detail += ` #${(raw.ids as number[]).join(",")}`;
          }
          if (typeof raw.query === "string") {
            detail += ` "${raw.query}"`;
          }
        } else {
          detail = formatRawInput(tool.rawInput, width - 4);
        }
      }
    }
  }

  // Render as single line: icon + kind + detail
  const maxDetailW = Math.max(1, width - 4);
  if (detail && hasCustomIcon && tool.kind) {
    const combined = `${tool.kind} ${detail}`;
    const truncated = combined.length > maxDetailW ? combined.slice(0, maxDetailW - 1) + "…" : combined;
    lines.push(`${p.warning}${icon}${p.reset} ${p.dim}${truncated}${p.reset}`);
  } else if (detail && hasCustomIcon) {
    if (detail.length > maxDetailW) detail = detail.slice(0, maxDetailW - 1) + "…";
    lines.push(`${p.warning}${icon}${p.reset} ${p.dim}${detail}${p.reset}`);
  } else if (detail) {
    const prefix = `${tool.title}: `;
    const combined = prefix + detail;
    const truncated = combined.length > maxDetailW ? combined.slice(0, maxDetailW - 1) + "…" : combined;
    lines.push(`${p.warning}${icon}${p.reset} ${p.dim}${truncated}${p.reset}`);
  } else {
    lines.push(`${p.warning}${icon} ${tool.title}${p.reset}`);
  }

  // Show additional file locations on separate lines (if more than one)
  if (mode === "full" && tool.locations && tool.locations.length > 1) {
    for (const loc of tool.locations.slice(1)) {
      const lineInfo = loc.line ? `:${loc.line}` : "";
      lines.push(`  ${p.dim}${shortenPath(loc.path, cwd)}${lineInfo}${p.reset}`);
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

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface SpinnerState {
  frame: number;
  startTime: number;
}

export interface SpinnerOpts {
  color?: string;
  hint?: string;
  startTime?: number;
}

export function createSpinner(opts?: { startTime?: number }): SpinnerState {
  return { frame: 0, startTime: opts?.startTime || Date.now() };
}

/**
 * Pure function: render the current spinner line and advance the frame.
 * Does not write to stdout — the caller is responsible for output.
 */
export function renderSpinnerLine(
  state: SpinnerState,
  label: string,
  opts?: SpinnerOpts,
): string {
  const frame = SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length];
  state.frame++;
  const color = opts?.color ?? p.accent;
  const elapsed = formatElapsed(Date.now() - state.startTime);
  const timer = elapsed ? ` ${p.dim}${elapsed}${p.reset}` : "";
  const hint = opts?.hint ? ` ${p.dim}${opts.hint}${p.reset}` : "";
  return `${color}${frame} ${label}...${p.reset}${timer}${hint}`;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Shorten an absolute path to a relative or tilde-prefixed form.
 */
function shortenPath(p: string, cwd: string): string {
  if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  if (p.startsWith(cwd)) return p.slice(cwd.length) || ".";
  const home = process.env.HOME;
  if (home && p.startsWith(home + "/")) return "~/" + p.slice(home.length + 1);
  return p;
}

function truncateVisible(text: string, maxWidth: number): string {
  if (visibleLen(text) <= maxWidth) return text;
  // Simple truncation for plain text (no ANSI)
  if (maxWidth <= 1) return "…";
  return text.slice(0, maxWidth - 1) + "…";
}
