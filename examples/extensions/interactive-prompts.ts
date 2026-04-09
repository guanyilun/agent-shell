/**
 * Interactive permission prompts extension.
 *
 * Adds permission gates for tool calls and file writes.
 * Without this extension, agent-shell runs in yolo mode (auto-approve).
 *
 * Usage:
 *   # Load by short name (built-in):
 *   agent-shell --extensions interactive-prompts
 *
 *   # Or copy to ~/.agent-shell/extensions/ for permanent use:
 *   cp examples/extensions/interactive-prompts.ts ~/.agent-shell/extensions/
 *
 *   # Or install as an npm package and load by name:
 *   agent-shell --extensions my-prompts-package
 */
import { renderDiff } from "agent-shell/utils/diff-renderer.js";
import { renderBoxFrame } from "agent-shell/utils/box-frame.js";
import { palette as p } from "agent-shell/utils/palette.js";
import type { ExtensionContext } from "agent-shell/types";

export default function activate({ bus }: ExtensionContext) {
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
        if (result.decision.autoApprove) {
          autoApproveWrites = true;
        }
        return result;
      }
      default:
        return payload;
    }
  });
}

async function handleToolCallPermission(payload) {
  const options = payload.metadata.options;
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

async function handleFileWritePermission(payload) {
  const diff = payload.metadata.diff;
  const filePath = payload.metadata.path;
  const answer = await previewDiff({ path: filePath, diff });
  if (answer === "approve") {
    return { ...payload, decision: { approved: true } };
  }
  if (answer === "approve_all") {
    return { ...payload, decision: { approved: true, autoApprove: true } };
  }
  return { ...payload, decision: { approved: false } };
}

async function promptPermission(title) {
  const termW = process.stdout.columns || 80;
  const boxW = Math.min(84, termW);

  const framed = renderBoxFrame(
    [`${p.bold}⚠ ${title}${p.reset}`],
    {
      width: boxW,
      style: "rounded",
      borderColor: p.warning,
      title: "Permission required",
      footer: [`  ${p.dim}[y]es / [n]o / [a]llow all${p.reset}`],
    },
  );

  process.stdout.write("\n");
  for (const line of framed) {
    process.stdout.write(line + "\n");
  }
  process.stdout.write("  ");

  return new Promise((resolve) => {
    const handler = (data) => {
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

async function previewDiff(opts) {
  const termW = process.stdout.columns || 80;
  const boxW = Math.min(84, termW);
  const contentW = boxW - 4;
  const MAX_DISPLAY = 25;

  const stats = opts.diff.isNewFile
    ? `(+${opts.diff.added} lines)`
    : `(+${opts.diff.added} / -${opts.diff.removed})`;
  const title = opts.diff.isNewFile
    ? `new: ${opts.path}  ${stats}`
    : `${opts.path}  ${stats}`;

  const diffLines = renderDiff(opts.diff, {
    width: contentW,
    filePath: opts.path,
    maxLines: MAX_DISPLAY,
    trueColor: true,
    mode: "unified",
  });
  const content = ["", ...diffLines.slice(1), ""];

  const framed = renderBoxFrame(content, {
    width: boxW,
    style: "rounded",
    borderColor: p.warning,
    title,
    footer: [`  ${p.bold}[y] Apply  [n] Skip  [a] Don't ask again${p.reset}`],
  });

  process.stdout.write("\n");
  for (const line of framed) {
    process.stdout.write(line + "\n");
  }

  return new Promise((resolve) => {
    const handler = (data) => {
      const ch = data.toString("utf-8").toLowerCase();
      process.stdin.removeListener("data", handler);

      if (ch === "y") {
        process.stdout.write(`  ${p.success}✓ Applied${p.reset}\n`);
        resolve("approve");
      } else if (ch === "a") {
        process.stdout.write(`  ${p.success}✓ Applied (auto-approve on)${p.reset}\n`);
        resolve("approve_all");
      } else {
        process.stdout.write(`  ${p.error}✗ Skipped${p.reset}\n`);
        resolve("reject");
      }
    };
    process.stdin.on("data", handler);
  });
}
