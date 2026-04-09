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
import type { DiffResult } from "../utils/diff.js";
import { renderDiff } from "../utils/diff-renderer.js";
import { renderBoxFrame } from "../utils/box-frame.js";
import { DIM, YELLOW, GREEN, RED, BOLD, RESET } from "../utils/ansi.js";
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
  const termW = process.stdout.columns || 80;
  const boxW = Math.min(84, termW);

  const framed = renderBoxFrame(
    [`${BOLD}⚠ ${title}${RESET}`],
    {
      width: boxW,
      style: "rounded",
      borderColor: YELLOW,
      title: "Permission required",
      footer: [`  ${DIM}[y]es / [n]o / [a]llow all${RESET}`],
    },
  );

  process.stdout.write("\n");
  for (const line of framed) {
    process.stdout.write(line + "\n");
  }
  process.stdout.write("  ");

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
  const boxW = Math.min(84, termW);
  const contentW = boxW - 4; // borders + padding
  const MAX_DISPLAY = 25;

  // Build title
  const stats = opts.diff.isNewFile
    ? `(+${opts.diff.added} lines)`
    : `(+${opts.diff.added} / -${opts.diff.removed})`;
  const title = opts.diff.isNewFile
    ? `new: ${opts.path}  ${stats}`
    : `${opts.path}  ${stats}`;

  // Render diff content
  const diffLines = renderDiff(opts.diff, {
    width: contentW,
    filePath: opts.path,
    maxLines: MAX_DISPLAY,
    trueColor: true,
    mode: "unified",
  });
  // Skip the header line from renderDiff (we show it in the box title)
  const content = ["", ...diffLines.slice(1), ""];

  // Render framed box
  const framed = renderBoxFrame(content, {
    width: boxW,
    style: "rounded",
    borderColor: YELLOW,
    title,
    footer: [`  ${BOLD}[y] Apply  [n] Skip  [a] Don't ask again${RESET}`],
  });

  process.stdout.write("\n");
  for (const line of framed) {
    process.stdout.write(line + "\n");
  }

  return new Promise((resolve) => {
    const handler = (data: Buffer) => {
      const ch = data.toString("utf-8").toLowerCase();
      process.stdin.removeListener("data", handler);

      if (ch === "y") {
        process.stdout.write(`  ${GREEN}✓ Applied${RESET}\n`);
        resolve("approve");
      } else if (ch === "a") {
        process.stdout.write(`  ${GREEN}✓ Applied (auto-approve on)${RESET}\n`);
        resolve("approve_all");
      } else {
        process.stdout.write(`  ${RED}✗ Skipped${RESET}\n`);
        resolve("reject");
      }
    };
    process.stdin.on("data", handler);
  });
}
