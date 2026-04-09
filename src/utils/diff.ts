/**
 * Lightweight LCS-based line diff for file modification previews.
 */

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

/**
 * Compute a line-level diff between old and new file content.
 * Returns grouped hunks with 3 lines of context around each change.
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
    return {
      hunks: [],
      added: 0,
      removed: 0,
      isIdentical: true,
      isNewFile: false,
    };
  }

  // Build LCS table and backtrack to produce diff lines
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const dp = buildLcs(a, b);
  const raw = backtrack(dp, a, b);

  let added = 0;
  let removed = 0;
  for (const l of raw) {
    if (l.type === "added") added++;
    else if (l.type === "removed") removed++;
  }

  return {
    hunks: groupHunks(raw, 3),
    added,
    removed,
    isIdentical: false,
    isNewFile: false,
  };
}

function buildLcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp;
}

function backtrack(dp: number[][], a: string[], b: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: "context", oldNo: i, newNo: j, text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "added", oldNo: null, newNo: j, text: b[j - 1] });
      j--;
    } else {
      result.unshift({
        type: "removed",
        oldNo: i,
        newNo: null,
        text: a[i - 1],
      });
      i--;
    }
  }
  return result;
}

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
