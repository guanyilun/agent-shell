/**
 * Diff renderer with width-adaptive presentation modes and inline highlighting.
 *
 * Returns string[] (one per terminal line) — never writes to stdout.
 * Supports unified, split (side-by-side), and summary modes.
 * Uses token-level LCS for word-level inline diff highlighting.
 */
import { highlight } from "cli-highlight";
import type { DiffResult, DiffHunk, DiffLine } from "./diff.js";
import { visibleLen } from "./ansi.js";
import { palette as p } from "./palette.js";
import { wrapLine } from "./markdown.js";

// ── Types ────────────────────────────────────────────────────────

export type DiffDisplayMode = "split" | "unified" | "summary";

export interface DiffRenderOptions {
  /** Available terminal width (columns). */
  width: number;
  /** Force a specific display mode instead of auto-detecting from width. */
  mode?: DiffDisplayMode;
  /** Maximum number of output lines before truncation. Default 50. */
  maxLines?: number;
  /** File path to show in the header (also used to detect language for syntax highlighting). */
  filePath?: string;
  /** Use true-color (24-bit) backgrounds. Default true. */
  trueColor?: boolean;
  /** Enable syntax highlighting on diff lines. Default true. */
  syntaxHighlight?: boolean;
}

// ── Constants ────────────────────────────────────────────────────

const SPLIT_MIN_WIDTH = 120;
const UNIFIED_MIN_WIDTH = 40;

// ── Syntax highlighting ──────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".rb": "ruby", ".rs": "rust", ".go": "go", ".java": "java",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp",
  ".swift": "swift", ".kt": "kotlin", ".scala": "scala",
  ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".fish": "bash",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "ini",
  ".xml": "xml", ".html": "html", ".htm": "html", ".css": "css", ".scss": "scss",
  ".sql": "sql", ".md": "markdown", ".lua": "lua", ".php": "php",
  ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
  ".hs": "haskell", ".ml": "ocaml", ".clj": "clojure",
  ".vim": "vim", ".dockerfile": "dockerfile",
};

function detectLanguage(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) {
    // Handle extensionless files like Dockerfile, Makefile
    const base = filePath.split("/").pop()?.toLowerCase();
    if (base === "dockerfile") return "dockerfile";
    if (base === "makefile") return "makefile";
    return undefined;
  }
  return EXT_TO_LANG[filePath.slice(dot).toLowerCase()];
}

/**
 * Syntax-highlight a single line of code.
 * Returns the original text if highlighting fails or no language detected.
 */
function highlightLine(text: string, language?: string): string {
  if (!language || text.trim() === "") return text;
  try {
    // cli-highlight adds a trailing newline; strip it
    return highlight(text, { language }).replace(/\n$/, "");
  } catch {
    return text;
  }
}

// ── Token-level LCS for inline highlighting ──────────────────────

interface Token {
  text: string;
  kind: "word" | "space" | "punct";
}

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const re = /(\s+)|([A-Za-z0-9_]+)|([^\s\w])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m[1]) tokens.push({ text: m[1], kind: "space" });
    else if (m[2]) tokens.push({ text: m[2], kind: "word" });
    else if (m[3]) tokens.push({ text: m[3], kind: "punct" });
  }
  return tokens;
}

function tokenLcs(
  a: Token[],
  b: Token[],
): { oldMatch: boolean[]; newMatch: boolean[] } {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1].text === b[j - 1].text
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to mark matched tokens
  const oldMatch = new Array<boolean>(m).fill(false);
  const newMatch = new Array<boolean>(n).fill(false);
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1].text === b[j - 1].text) {
      oldMatch[i - 1] = true;
      newMatch[j - 1] = true;
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return { oldMatch, newMatch };
}

/**
 * Rewrite full ANSI resets (\x1b[0m) to foreground-only resets,
 * preserving the given background color across the line.
 */
function preserveBg(text: string, bg: string): string {
  return text.replace(/\x1b\[0m/g, `\x1b[39m${bg}`);
}

/**
 * Pad a rendered line with spaces to fill the given visible width,
 * ensuring background color spans the full column.
 */
function padToWidth(text: string, targetWidth: number): string {
  const vis = visibleLen(text);
  if (vis >= targetWidth) return text;
  return text + " ".repeat(targetWidth - vis);
}

interface InlinePalette {
  rowBg: string;
  emphBg: string;
}

function highlightInlineChanges(
  oldLine: string,
  newLine: string,
  oldPalette: InlinePalette,
  newPalette: InlinePalette,
  useTrueColor: boolean,
  language?: string,
): { old: string; new: string } {
  if (!useTrueColor) {
    // Still apply syntax highlighting even without true-color backgrounds
    if (language) {
      return {
        old: highlightLine(oldLine, language),
        new: highlightLine(newLine, language),
      };
    }
    return { old: oldLine, new: newLine };
  }

  const oldTokens = tokenize(oldLine);
  const newTokens = tokenize(newLine);

  // Skip if either side is trivially small
  if (oldTokens.length === 0 || newTokens.length === 0) {
    return {
      old: language ? highlightLine(oldLine, language) : oldLine,
      new: language ? highlightLine(newLine, language) : newLine,
    };
  }

  // Safety guard: skip if LCS matrix would be too large
  if (oldTokens.length * newTokens.length > 50000) {
    return {
      old: language ? highlightLine(oldLine, language) : oldLine,
      new: language ? highlightLine(newLine, language) : newLine,
    };
  }

  const { oldMatch, newMatch } = tokenLcs(oldTokens, newTokens);

  const buildHighlighted = (
    tokens: Token[],
    matched: boolean[],
    palette: InlinePalette,
  ): string => {
    let result = "";
    for (let i = 0; i < tokens.length; i++) {
      if (matched[i]) {
        // Matched (unchanged) tokens: syntax highlight + row background
        const text = language ? highlightLine(tokens[i].text, language) : tokens[i].text;
        result += palette.rowBg + preserveBg(text, palette.rowBg);
      } else {
        // Changed tokens: emphasis background, no syntax highlighting (emphasis stands out)
        result += palette.emphBg + p.bold + tokens[i].text + p.reset;
      }
    }
    return result;
  };

  return {
    old: buildHighlighted(oldTokens, oldMatch, oldPalette),
    new: buildHighlighted(newTokens, newMatch, newPalette),
  };
}

// ── Change pair detection ────────────────────────────────────────

interface ChangePair {
  removed: DiffLine;
  added: DiffLine;
  removedIdx: number;
  addedIdx: number;
}

/**
 * Scan a hunk for adjacent removed/added runs and pair them 1:1.
 * Returns a set of line indices that are part of a change pair.
 */
function findChangePairs(hunk: DiffHunk): Map<number, ChangePair> {
  const pairs = new Map<number, ChangePair>();
  const lines = hunk.lines;
  let i = 0;

  while (i < lines.length) {
    // Find a run of removed lines
    const removedStart = i;
    while (i < lines.length && lines[i].type === "removed") i++;
    const removedEnd = i;

    // Find a run of added lines immediately after
    const addedStart = i;
    while (i < lines.length && lines[i].type === "added") i++;
    const addedEnd = i;

    // Pair them 1:1
    const removedCount = removedEnd - removedStart;
    const addedCount = addedEnd - addedStart;
    const pairCount = Math.min(removedCount, addedCount);

    for (let k = 0; k < pairCount; k++) {
      const pair: ChangePair = {
        removed: lines[removedStart + k],
        added: lines[addedStart + k],
        removedIdx: removedStart + k,
        addedIdx: addedStart + k,
      };
      pairs.set(removedStart + k, pair);
      pairs.set(addedStart + k, pair);
    }

    // If no removed/added run was found, advance past context lines
    if (removedCount === 0 && addedCount === 0) {
      i++;
    }
  }

  return pairs;
}

// ── Header ───────────────────────────────────────────────────────

function buildHeader(diff: DiffResult, filePath?: string): string {
  const path = filePath ?? "";
  if (diff.isNewFile) {
    return `${p.bold}new: ${path}${p.reset}  ${p.dim}(+${diff.added} lines)${p.reset}`;
  }
  return `${p.bold}${path}${p.reset}  ${p.dim}(+${diff.added} / -${diff.removed})${p.reset}`;
}

// ── Summary mode ─────────────────────────────────────────────────

function renderSummary(diff: DiffResult): string[] {
  if (diff.isIdentical) return [`${p.dim}(no changes)${p.reset}`];
  if (diff.isNewFile) return [`${p.success}+${diff.added} lines${p.reset} ${p.dim}(new file)${p.reset}`];
  return [`${p.success}+${diff.added}${p.reset} ${p.error}-${diff.removed}${p.reset}`];
}

// ── Unified mode ─────────────────────────────────────────────────

interface UnifiedLayout {
  noW: number;
  lineTextW: number;
  textWidth: number;
  useTrueColor: boolean;
  lang: string | undefined;
  removedPalette: InlinePalette;
  addedPalette: InlinePalette;
}

function unifiedLayout(diff: DiffResult, opts: DiffRenderOptions): UnifiedLayout {
  const textWidth = opts.width;
  let maxNo = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      const n = line.oldNo ?? line.newNo ?? 0;
      if (n > maxNo) maxNo = n;
    }
  }
  const noW = Math.max(String(maxNo).length, 1);
  return {
    noW,
    lineTextW: Math.max(1, textWidth - noW - 5),
    textWidth,
    useTrueColor: opts.trueColor !== false,
    lang: opts.syntaxHighlight !== false ? detectLanguage(opts.filePath) : undefined,
    removedPalette: { rowBg: p.errorBg, emphBg: p.errorBgEmph },
    addedPalette: { rowBg: p.successBg, emphBg: p.successBgEmph },
  };
}

function renderUnifiedHunk(hunk: DiffHunk, layout: UnifiedLayout): string[] {
  const { noW, lineTextW, textWidth, useTrueColor, lang, removedPalette, addedPalette } = layout;
  const out: string[] = [];

  const pairs = findChangePairs(hunk);
  const renderedAsPartOfPair = new Set<number>();

  for (let i = 0; i < hunk.lines.length; i++) {
    const line = hunk.lines[i];
    const no = String(
      line.type === "removed" ? (line.oldNo ?? "") : (line.newNo ?? line.oldNo ?? ""),
    ).padStart(noW);

    if (line.type === "context") {
      const raw = truncateText(line.text, lineTextW);
      const text = lang ? highlightLine(raw, lang) : raw;
      out.push(`  ${p.dim}${no} │${p.reset} ${p.dim}${text}${p.reset}`);
      continue;
    }

    if (line.type === "removed") {
      const pair = pairs.get(i);
      let removedText: string;
      let addedText: string | null = null;
      let addedNo: string | null = null;

      if (pair && pair.removedIdx === i) {
        const highlighted = highlightInlineChanges(
          line.text, pair.added.text, removedPalette, addedPalette, useTrueColor, lang,
        );
        removedText = truncateText(highlighted.old, lineTextW);
        addedText = truncateText(highlighted.new, lineTextW);
        addedNo = String(pair.added.newNo ?? "").padStart(noW);
        renderedAsPartOfPair.add(pair.addedIdx);
      } else {
        const raw = truncateText(line.text, lineTextW);
        removedText = lang ? highlightLine(raw, lang) : raw;
      }

      if (useTrueColor) {
        out.push(padToWidth(`${p.errorBg}${p.error}- ${no} │ ${preserveBg(removedText, p.errorBg)}${p.reset}`, textWidth));
      } else {
        out.push(`${p.error}- ${no} │ ${removedText}${p.reset}`);
      }

      if (addedText !== null && addedNo !== null) {
        if (useTrueColor) {
          out.push(padToWidth(`${p.successBg}${p.success}+ ${addedNo} │ ${preserveBg(addedText, p.successBg)}${p.reset}`, textWidth));
        } else {
          out.push(`${p.success}+ ${addedNo} │ ${addedText}${p.reset}`);
        }
      }
      continue;
    }

    if (line.type === "added") {
      if (renderedAsPartOfPair.has(i)) continue;
      const raw = truncateText(line.text, lineTextW);
      const text = lang ? highlightLine(raw, lang) : raw;
      if (useTrueColor) {
        out.push(padToWidth(`${p.successBg}${p.success}+ ${no} │ ${preserveBg(text, p.successBg)}${p.reset}`, textWidth));
      } else {
        out.push(`${p.success}+ ${no} │ ${text}${p.reset}`);
      }
    }
  }
  return out;
}

function renderUnified(diff: DiffResult, opts: DiffRenderOptions): string[] {
  const layout = unifiedLayout(diff, opts);
  const output: string[] = [];
  for (let hunkIdx = 0; hunkIdx < diff.hunks.length; hunkIdx++) {
    if (hunkIdx > 0) output.push(`  ${p.dim}⋯${p.reset}`);
    output.push(...renderUnifiedHunk(diff.hunks[hunkIdx], layout));
  }
  return output;
}

// ── Split (side-by-side) mode ────────────────────────────────────

interface SplitLayout {
  colWidth: number;
  noW: number;
  textW: number;
  useTrueColor: boolean;
  lang: string | undefined;
  removedPalette: InlinePalette;
  addedPalette: InlinePalette;
}

function splitLayout(diff: DiffResult, opts: DiffRenderOptions): SplitLayout {
  const totalWidth = opts.width;
  const colWidth = Math.max(1, Math.floor((totalWidth - 3) / 2));
  let maxNo = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      const n = line.oldNo ?? line.newNo ?? 0;
      if (n > maxNo) maxNo = n;
    }
  }
  const noW = Math.max(String(maxNo).length, 1);
  return {
    colWidth,
    noW,
    textW: Math.max(1, colWidth - noW - 3),
    useTrueColor: opts.trueColor !== false,
    lang: opts.syntaxHighlight !== false ? detectLanguage(opts.filePath) : undefined,
    removedPalette: { rowBg: p.errorBg, emphBg: p.errorBgEmph },
    addedPalette: { rowBg: p.successBg, emphBg: p.successBgEmph },
  };
}

function renderSplitHunk(hunk: DiffHunk, layout: SplitLayout): string[] {
  const { colWidth, noW, textW, useTrueColor, lang, removedPalette, addedPalette } = layout;
  const out: string[] = [];
  const rows = buildSplitRows(hunk);

  for (const row of rows) {
    const leftNo = row.left
      ? String(row.left.oldNo ?? row.left.newNo ?? "").padStart(noW)
      : " ".repeat(noW);
    const rightNo = row.right
      ? String(row.right.newNo ?? row.right.oldNo ?? "").padStart(noW)
      : " ".repeat(noW);

    let leftText = row.left ? truncateText(row.left.text, textW) : "";
    let rightText = row.right ? truncateText(row.right.text, textW) : "";

    if (row.left && row.right && row.left.type === "removed" && row.right.type === "added") {
      const highlighted = highlightInlineChanges(
        row.left.text, row.right.text, removedPalette, addedPalette, useTrueColor, lang,
      );
      leftText = truncateText(highlighted.old, textW);
      rightText = truncateText(highlighted.new, textW);
    } else if (lang) {
      if (leftText) leftText = highlightLine(leftText, lang);
      if (rightText) rightText = highlightLine(rightText, lang);
    }

    let leftCol: string;
    let rightCol: string;

    if (!row.left || row.left.type === "context") {
      leftCol = padToWidth(`${p.dim}${leftNo} │${p.reset} ${p.dim}${leftText}${p.reset}`, colWidth);
    } else if (row.left.type === "removed") {
      if (useTrueColor) {
        leftCol = padToWidth(
          `${p.errorBg}${p.error}${leftNo} │ ${preserveBg(leftText, p.errorBg)}${p.reset}`, colWidth,
        );
      } else {
        leftCol = padToWidth(`${p.error}${leftNo} │ ${leftText}${p.reset}`, colWidth);
      }
    } else {
      leftCol = padToWidth(`${p.dim}${leftNo} │${p.reset} ${leftText}`, colWidth);
    }

    if (!row.right || row.right.type === "context") {
      rightCol = padToWidth(`${p.dim}${rightNo} │${p.reset} ${p.dim}${rightText}${p.reset}`, colWidth);
    } else if (row.right.type === "added") {
      if (useTrueColor) {
        rightCol = padToWidth(
          `${p.successBg}${p.success}${rightNo} │ ${preserveBg(rightText, p.successBg)}${p.reset}`, colWidth,
        );
      } else {
        rightCol = padToWidth(`${p.success}${rightNo} │ ${rightText}${p.reset}`, colWidth);
      }
    } else {
      rightCol = padToWidth(`${p.dim}${rightNo} │${p.reset} ${rightText}`, colWidth);
    }

    out.push(`${leftCol} ${p.dim}│${p.reset} ${rightCol}`);
  }
  return out;
}

function renderSplit(diff: DiffResult, opts: DiffRenderOptions): string[] {
  const layout = splitLayout(diff, opts);
  const output: string[] = [];

  // Column header
  const leftHeader = padToWidth(`${p.dim}${"─".repeat(layout.colWidth)}${p.reset}`, layout.colWidth);
  const rightHeader = padToWidth(`${p.dim}${"─".repeat(layout.colWidth)}${p.reset}`, layout.colWidth);
  output.push(`${leftHeader} ${p.dim}│${p.reset} ${rightHeader}`);

  for (let hunkIdx = 0; hunkIdx < diff.hunks.length; hunkIdx++) {
    if (hunkIdx > 0) {
      output.push(`${p.dim}${" ".repeat(layout.colWidth)} │ ${" ".repeat(layout.colWidth)}${p.reset}`);
      output.push(`${p.dim}${"·".repeat(layout.colWidth)} │ ${"·".repeat(layout.colWidth)}${p.reset}`);
    }
    output.push(...renderSplitHunk(diff.hunks[hunkIdx], layout));
  }
  return output;
}

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

function buildSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = hunk.lines;
  let i = 0;

  while (i < lines.length) {
    if (lines[i].type === "context") {
      rows.push({ left: lines[i], right: lines[i] });
      i++;
      continue;
    }

    // Collect a run of removed lines
    const removed: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "removed") {
      removed.push(lines[i]);
      i++;
    }

    // Collect a run of added lines
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "added") {
      added.push(lines[i]);
      i++;
    }

    // Pair them side by side
    const maxLen = Math.max(removed.length, added.length);
    for (let k = 0; k < maxLen; k++) {
      rows.push({
        left: k < removed.length ? removed[k] : null,
        right: k < added.length ? added[k] : null,
      });
    }
  }

  return rows;
}

// ── Async variants (yield between hunks) ──────────────────────────

/** Optional hook called between hunks to yield to the event loop. */
type YieldFn = () => Promise<void>;

async function renderUnifiedAsync(
  diff: DiffResult,
  opts: DiffRenderOptions,
  yieldFn: YieldFn,
): Promise<string[]> {
  const layout = unifiedLayout(diff, opts);
  const output: string[] = [];
  for (let hunkIdx = 0; hunkIdx < diff.hunks.length; hunkIdx++) {
    if (hunkIdx > 0) await yieldFn();
    if (hunkIdx > 0) output.push(`  ${p.dim}⋯${p.reset}`);
    output.push(...renderUnifiedHunk(diff.hunks[hunkIdx], layout));
  }
  return output;
}

async function renderSplitAsync(
  diff: DiffResult,
  opts: DiffRenderOptions,
  yieldFn: YieldFn,
): Promise<string[]> {
  const layout = splitLayout(diff, opts);
  const output: string[] = [];

  const leftHeader = padToWidth(`${p.dim}${"─".repeat(layout.colWidth)}${p.reset}`, layout.colWidth);
  const rightHeader = padToWidth(`${p.dim}${"─".repeat(layout.colWidth)}${p.reset}`, layout.colWidth);
  output.push(`${leftHeader} ${p.dim}│${p.reset} ${rightHeader}`);

  for (let hunkIdx = 0; hunkIdx < diff.hunks.length; hunkIdx++) {
    if (hunkIdx > 0) await yieldFn();
    if (hunkIdx > 0) {
      output.push(`${p.dim}${" ".repeat(layout.colWidth)} │ ${" ".repeat(layout.colWidth)}${p.reset}`);
      output.push(`${p.dim}${"·".repeat(layout.colWidth)} │ ${"·".repeat(layout.colWidth)}${p.reset}`);
    }
    output.push(...renderSplitHunk(diff.hunks[hunkIdx], layout));
  }
  return output;
}

// ── Utilities ────────────────────────────────────────────────────

/**
 * Truncate text to fit within maxWidth visible characters.
 * ANSI-aware: measures visible length and preserves escape codes.
 */
function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleLen(text) <= maxWidth) return text;
  if (maxWidth <= 1) return "…";

  // Walk through the string, tracking visible characters
  let visible = 0;
  let i = 0;
  while (i < text.length && visible < maxWidth - 1) {
    // Check for ANSI escape sequence
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    visible++;
    i++;
  }

  return text.slice(0, i) + p.reset + "…";
}

// ── Truncation ──────────────────────────────────────────────────

/**
 * Trim context lines from hunks so the rendered output fits within a budget.
 * Change lines are never removed — only the surrounding context shrinks.
 */
function trimHunksToFit(hunks: DiffHunk[], maxLines: number): DiffHunk[] {
  // Count change lines across all hunks
  let changeCount = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type !== "context") changeCount++;
    }
  }

  // Separators between hunks
  const separators = Math.max(0, hunks.length - 1);

  // How many context lines can we afford?
  const contextBudget = Math.max(0, maxLines - changeCount - separators);

  // Count total context to see if trimming is needed
  let totalContext = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "context") totalContext++;
    }
  }

  if (totalContext <= contextBudget) return hunks;

  // Determine how many context lines to keep per side of each change.
  // Binary-search for the largest per-side context that fits.
  let lo = 0;
  let hi = 3; // original context size from groupHunks
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countContextWithLimit(hunks, mid) <= contextBudget) lo = mid;
    else hi = mid - 1;
  }

  return rebuildHunks(hunks, lo);
}

/** Count how many context lines remain if we keep at most `ctx` per side of each change. */
function countContextWithLimit(hunks: DiffHunk[], ctx: number): number {
  let count = 0;
  for (const hunk of hunks) {
    const lines = hunk.lines;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.type !== "context") continue;
      // Keep this context line if it's within `ctx` of any change
      let nearChange = false;
      for (let d = 1; d <= ctx; d++) {
        if ((i - d >= 0 && lines[i - d]!.type !== "context") ||
            (i + d < lines.length && lines[i + d]!.type !== "context")) {
          nearChange = true;
          break;
        }
      }
      if (nearChange) count++;
    }
  }
  return count;
}

/** Rebuild hunks keeping only context lines within `ctx` distance of a change. */
function rebuildHunks(hunks: DiffHunk[], ctx: number): DiffHunk[] {
  return hunks.map((hunk) => {
    const lines = hunk.lines;
    const kept: DiffLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.type !== "context") {
        kept.push(lines[i]!);
        continue;
      }
      for (let d = 1; d <= ctx; d++) {
        if ((i - d >= 0 && lines[i - d]!.type !== "context") ||
            (i + d < lines.length && lines[i + d]!.type !== "context")) {
          kept.push(lines[i]!);
          break;
        }
      }
    }
    return { lines: kept };
  });
}

// ── Public API ───────────────────────────────────────────────────

/** Select display mode based on available terminal width. */
export function selectMode(width: number): DiffDisplayMode {
  if (width >= SPLIT_MIN_WIDTH) return "split";
  if (width >= UNIFIED_MIN_WIDTH) return "unified";
  return "summary";
}

/** Render a diff result as an array of ANSI-formatted terminal lines. */
export function renderDiff(diff: DiffResult, opts: DiffRenderOptions): string[] {
  if (diff.isIdentical) return [`${p.dim}(no changes)${p.reset}`];

  const mode = opts.mode ?? selectMode(opts.width);
  const maxLines = opts.maxLines ?? 50;

  const header = buildHeader(diff, opts.filePath);

  if (mode === "summary") {
    return [header, ...renderSummary(diff)];
  }

  // Trim context lines from hunks if the diff would exceed the budget,
  // so that actual changes are always visible.
  const trimmed: DiffResult = { ...diff, hunks: trimHunksToFit(diff.hunks, maxLines) };

  let bodyLines: string[];
  switch (mode) {
    case "split":
      bodyLines = renderSplit(trimmed, opts);
      break;
    case "unified":
      bodyLines = renderUnified(trimmed, opts);
      break;
  }

  // Final safety net — if still over budget, simple tail truncation.
  if (bodyLines.length > maxLines) {
    const overflow = bodyLines.length - maxLines;
    bodyLines = bodyLines.slice(0, maxLines);
    bodyLines.push(`${p.dim}… ${overflow} more lines${p.reset}`);
  }

  return [header, ...bodyLines];
}

/**
 * Async variant of renderDiff that yields to the event loop between hunks.
 * Use when rendering in a context where a spinner or other UI needs to stay
 * responsive (e.g. showing a large diff during a permission prompt).
 *
 * @param onLines - Callback invoked with each batch of rendered lines as they
 *                  are produced. Allows progressive/streaming display.
 */
export async function renderDiffAsync(
  diff: DiffResult,
  opts: DiffRenderOptions,
  onLines: (lines: string[]) => void,
): Promise<void> {
  if (diff.isIdentical) {
    onLines([`${p.dim}(no changes)${p.reset}`]);
    return;
  }

  const mode = opts.mode ?? selectMode(opts.width);
  const maxLines = opts.maxLines ?? 50;

  const header = buildHeader(diff, opts.filePath);

  if (mode === "summary") {
    onLines([header, ...renderSummary(diff)]);
    return;
  }

  // Trim context lines from hunks if the diff would exceed the budget
  const trimmed: DiffResult = { ...diff, hunks: trimHunksToFit(diff.hunks, maxLines) };

  const yieldFn: YieldFn = () => new Promise<void>(r => setImmediate(r));

  let bodyLines: string[];
  switch (mode) {
    case "split":
      bodyLines = await renderSplitAsync(trimmed, opts, yieldFn);
      break;
    case "unified":
      bodyLines = await renderUnifiedAsync(trimmed, opts, yieldFn);
      break;
  }

  // Final safety net — if still over budget, simple tail truncation.
  if (bodyLines.length > maxLines) {
    const overflow = bodyLines.length - maxLines;
    bodyLines = bodyLines.slice(0, maxLines);
    bodyLines.push(`${p.dim}… ${overflow} more lines${p.reset}`);
  }

  onLines([header, ...bodyLines]);
}
