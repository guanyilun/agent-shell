/**
 * Interactive prompts extension.
 *
 * Registers an async pipe handler on permission:request. Inspects the
 * `kind` field to decide how to render the prompt:
 *   - "tool-call": simple yes/no/allow-all permission prompt
 *   - "file-write": interactive diff preview with approve/reject
 *
 * Unknown kinds are passed through unchanged (safe default stands).
 *
 * This is an extension, not core — without it loaded, all permissions
 * fall through to their safe defaults (cancelled/rejected). Alternative
 * extensions could auto-approve, show a web UI, apply policy rules, etc.
 */
import type { DiffResult } from "../diff.js";
import { DIM, YELLOW, GREEN, RED, BOLD, RESET, visibleLen } from "../ansi.js";
import type { ExtensionContext } from "../types.js";

export default function activate({ bus }: ExtensionContext): void {
  let autoApproveWrites = false;

  bus.onPipeAsync("permission:request", async (payload) => {
    switch (payload.kind) {
      case "tool-call":
        return handleToolCallPermission(payload);
      case "file-write": {
        if (autoApproveWrites) {
          return { ...payload, decision: { approved: true } };
        }
        const result = await handleFileWritePermission(payload);
        if ((result.decision as { autoApprove?: boolean }).autoApprove) {
          autoApproveWrites = true;
        }
        return result;
      }
      default:
        return payload;
    }
  });
}

// ── Tool call permission ──────────────────────────────────────

async function handleToolCallPermission(
  payload: { kind: string; title: string; metadata: Record<string, unknown>; decision: Record<string, unknown> },
) {
  const options = payload.metadata.options as Array<{ optionId: string; kind: string }>;
  const answer = await promptPermission(payload.title);

  if (answer === "approve" || answer === "approve_all") {
    const option = answer === "approve_all"
      ? options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once")
      : options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
    if (option) {
      return { ...payload, decision: { outcome: "selected", optionId: option.optionId } };
    }
  }
  return { ...payload, decision: { outcome: "cancelled" } };
}

// ── File write permission ─────────────────────────────────────

async function handleFileWritePermission(
  payload: { kind: string; title: string; metadata: Record<string, unknown>; decision: Record<string, unknown> },
) {
  const diff = payload.metadata.diff as DiffResult;
  const filePath = payload.metadata.path as string;
  const answer = await previewDiff({ path: filePath, diff });
  if (answer === "approve") {
    return { ...payload, decision: { approved: true } };
  }
  if (answer === "approve_all") {
    return { ...payload, decision: { approved: true, autoApprove: true } };
  }
  return { ...payload, decision: { approved: false } };
}

// ── Interactive UI rendering ──────────────────────────────────

async function promptPermission(title: string): Promise<string | null> {
  process.stdout.write(
    `\n${YELLOW}${BOLD}⚠ Permission required:${RESET} ${title}\n` +
      `  ${DIM}[y]es / [n]o / [a]llow all${RESET} `
  );

  return new Promise((resolve) => {
    const handler = (data: Buffer) => {
      const ch = data.toString("utf-8").toLowerCase();
      process.stdin.removeListener("data", handler);
      process.stdout.write("\n");

      if (ch === "y") resolve("approve");
      else if (ch === "a") resolve("approve_all");
      else resolve(null);
    };
    process.stdin.on("data", handler);
  });
}

async function previewDiff(opts: {
  path: string;
  diff: DiffResult;
}): Promise<"approve" | "reject" | "approve_all"> {
  const termW = process.stdout.columns || 80;
  const contentW = Math.min(80, termW - 4);
  const boxW = contentW + 2;
  const MAX_DISPLAY = 25;
  const R = RESET;

  const boxed = (text: string) => {
    const pad = Math.max(0, contentW - visibleLen(text));
    process.stdout.write(
      `${YELLOW}│${R} ${text}${" ".repeat(pad)} ${YELLOW}│${R}\n`,
    );
  };

  let totalLines = 0;
  let maxNo = 0;
  for (const hunk of opts.diff.hunks) {
    totalLines += hunk.lines.length;
    for (const line of hunk.lines) {
      const n = line.oldNo ?? line.newNo ?? 0;
      if (n > maxNo) maxNo = n;
    }
  }
  const noW = String(maxNo).length;
  const textMax = contentW - noW - 6;

  process.stdout.write("\n");
  const stats = opts.diff.isNewFile
    ? `(+${opts.diff.added} lines)`
    : `(+${opts.diff.added} / -${opts.diff.removed})`;
  const headerText = opts.diff.isNewFile
    ? `new: ${opts.path}  ${stats}`
    : `${opts.path}  ${stats}`;
  const afterDashes = Math.max(1, boxW - headerText.length - 2);
  process.stdout.write(
    `${YELLOW}┌${R} ${headerText} ${YELLOW}${"─".repeat(afterDashes)}┐${R}\n`,
  );

  boxed("");

  let shown = 0;
  let hunkIdx = 0;
  for (const hunk of opts.diff.hunks) {
    if (shown >= MAX_DISPLAY) break;
    if (hunkIdx > 0) boxed(`  ${DIM}⋯${R}`);

    for (const line of hunk.lines) {
      if (shown >= MAX_DISPLAY) break;
      shown++;

      const no = String(line.oldNo ?? line.newNo ?? "").padStart(noW);
      const sign =
        line.type === "removed"
          ? `${RED}-${R}`
          : line.type === "added"
            ? `${GREEN}+${R}`
            : " ";
      const color =
        line.type === "removed" ? RED
        : line.type === "added" ? GREEN
        : DIM;
      const text =
        line.text.length > textMax
          ? line.text.slice(0, textMax - 1) + "…"
          : line.text;

      boxed(`${sign} ${DIM}${no}${R} ${DIM}│${R} ${color}${text}${R}`);
    }
    hunkIdx++;
  }

  if (totalLines > MAX_DISPLAY) {
    boxed(`  ${DIM}⋯ ${totalLines - MAX_DISPLAY} more lines${R}`);
  }

  boxed("");

  process.stdout.write(`${YELLOW}├${"─".repeat(boxW)}┤${R}\n`);
  boxed(`  ${BOLD}[y] Apply  [n] Skip  [a] Don't ask again${R}`);
  process.stdout.write(`${YELLOW}└${"─".repeat(boxW)}┘${R}\n`);

  return new Promise((resolve) => {
    const handler = (data: Buffer) => {
      const ch = data.toString("utf-8").toLowerCase();
      process.stdin.removeListener("data", handler);

      if (ch === "y") {
        process.stdout.write(`  ${GREEN}✓ Applied${R}\n`);
        resolve("approve");
      } else if (ch === "a") {
        process.stdout.write(`  ${GREEN}✓ Applied (auto-approve on)${R}\n`);
        resolve("approve_all");
      } else {
        process.stdout.write(`  ${RED}✗ Skipped${R}\n`);
        resolve("reject");
      }
    };
    process.stdin.on("data", handler);
  });
}
