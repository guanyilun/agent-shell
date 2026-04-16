/**
 * Line-level diff computation, powered by the `diff` npm package.
 *
 * Exposes a unified `DiffResult` interface consumed by the diff renderer.
 * Three entry points cover the main use cases:
 *
 *   computeDiff       — full-file diff (write_file, or when edit region can't be located)
 *   computeEditDiff   — edit_file: locates the edit region, builds the new file, full diff
 *   computeInputDiff  — fast preview: diffs only old_text vs new_text, no file I/O
 */

import * as Diff from "diff";

// ── Types ────────────────────────────────────────────────────────────

export interface DiffLine {
  type: "context" | "added" | "removed";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface DiffHunk {
  lines: DiffLine[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  isIdentical: boolean;
  isNewFile: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Convert a `diff` library Change[] into our DiffLine[], tracking real
 * old/new line numbers.
 */
function changesToDiffLines(changes: Diff.Change[]): DiffLine[] {
  const result: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const change of changes) {
    const lines = change.value.replace(/\n$/, "").split("\n");
    for (const text of lines) {
      if (change.added) {
        newNo++;
        result.push({ type: "added", oldNo: null, newNo, text });
      } else if (change.removed) {
        oldNo++;
        result.push({ type: "removed", oldNo, newNo: null, text });
      } else {
        oldNo++;
        newNo++;
        result.push({ type: "context", oldNo, newNo, text });
      }
    }
  }

  return result;
}

/**
 * Group raw DiffLines into hunks with `context` lines of surrounding context.
 */
function groupHunks(lines: DiffLine[], ctx: number): DiffHunk[] {
  const changeIdx: number[] = [];
  for (let i = 0; i < lines.length; i++)
    if (lines[i].type !== "context") changeIdx.push(i);

  if (changeIdx.length === 0) return [];

  const hunks: DiffHunk[] = [];
  let start = Math.max(0, changeIdx[0]! - ctx);
  let end = Math.min(lines.length - 1, changeIdx[0]! + ctx);

  for (let k = 1; k < changeIdx.length; k++) {
    const ns = Math.max(0, changeIdx[k]! - ctx);
    const ne = Math.min(lines.length - 1, changeIdx[k]! + ctx);
    if (ns <= end + 1) {
      end = ne;
    } else {
      hunks.push({ lines: lines.slice(start, end + 1) });
      start = ns;
      end = ne;
    }
  }
  hunks.push({ lines: lines.slice(start, end + 1) });
  return hunks;
}

function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "added") added++;
    else if (l.type === "removed") removed++;
  }
  return { added, removed };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Compute a line-level diff between old and new file content.
 */
export function computeDiff(
  oldText: string | null,
  newText: string,
): DiffResult {
  // New file — everything is an addition
  if (oldText === null) {
    const lines = newText.split("\n");
    return {
      hunks: [
        {
          lines: lines.map((text, i) => ({
            type: "added" as const,
            oldNo: null,
            newNo: i + 1,
            text,
          })),
        },
      ],
      added: lines.length,
      removed: 0,
      isIdentical: false,
      isNewFile: true,
    };
  }

  // Identical — nothing to show
  if (oldText === newText) {
    return { hunks: [], added: 0, removed: 0, isIdentical: true, isNewFile: false };
  }

  const changes = Diff.diffLines(oldText, newText);
  const raw = changesToDiffLines(changes);
  const { added, removed } = countChanges(raw);

  return {
    hunks: groupHunks(raw, 3),
    added,
    removed,
    isIdentical: false,
    isNewFile: false,
  };
}

/**
 * Compute a diff for an edit operation where we know the old/new text.
 * Locates the edit region(s) in the file, constructs the full new file,
 * then diffs the whole thing so line numbers are file-relative.
 */
export function computeEditDiff(
  oldFileText: string,
  editOld: string,
  editNew: string,
  replaceAll = false,
): DiffResult {
  const a = oldFileText.split("\n");
  const editOldLines = editOld.split("\n");
  const editNewLines = editNew.split("\n");

  // Find all occurrences of editOld in the file
  const regions: { start: number; end: number }[] = [];
  if (replaceAll) {
    let i = 0;
    while (i <= a.length - editOldLines.length) {
      let match = true;
      for (let k = 0; k < editOldLines.length; k++) {
        if (a[i + k] !== editOldLines[k]) { match = false; break; }
      }
      if (match) {
        regions.push({ start: i, end: i + editOldLines.length });
        i += editOldLines.length;
      } else {
        i++;
      }
    }
  } else {
    for (let i = 0; i <= a.length - editOldLines.length; i++) {
      let match = true;
      for (let k = 0; k < editOldLines.length; k++) {
        if (a[i + k] !== editOldLines[k]) { match = false; break; }
      }
      if (match) {
        regions.push({ start: i, end: i + editOldLines.length });
        break;
      }
    }
  }

  // Build the full new file
  let newFile: string[];
  if (replaceAll && regions.length > 0) {
    const parts: string[] = [];
    let last = 0;
    for (const r of regions) {
      parts.push(...a.slice(last, r.start));
      parts.push(...editNewLines);
      last = r.end;
    }
    parts.push(...a.slice(last));
    newFile = parts;
  } else if (regions.length === 1) {
    const r = regions[0]!;
    newFile = [...a.slice(0, r.start), ...editNewLines, ...a.slice(r.end)];
  } else {
    // Couldn't locate edit — fall back to string replace + full diff
    const newContent = replaceAll
      ? oldFileText.split(editOld).join(editNew)
      : oldFileText.replace(editOld, editNew);
    return computeDiff(oldFileText, newContent);
  }

  return computeDiff(oldFileText, newFile.join("\n"));
}

/**
 * Diff two edit strings directly — no file read needed.
 * Line numbers are relative to the edit region, not the file.
 * Use for permission prompt previews where speed matters more than
 * exact file-relative line numbers.
 */
export function computeInputDiff(
  oldText: string,
  newText: string,
): DiffResult {
  const changes = Diff.diffLines(oldText, newText);
  const raw = changesToDiffLines(changes);
  const { added, removed } = countChanges(raw);

  return {
    hunks: groupHunks(raw, 3),
    added,
    removed,
    isIdentical: false,
    isNewFile: false,
  };
}
