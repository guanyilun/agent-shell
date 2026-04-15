/**
 * Interactive permission prompts extension.
 *
 * Adds permission gates for tool calls and file writes.
 * Without this extension, agent-sh runs in yolo mode (auto-approve).
 *
 * Uses the interactive UI primitive for compositor-aware, themed rendering.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/interactive-prompts.ts
 *
 *   # Or copy to ~/.agent-sh/extensions/ for permanent use:
 *   cp examples/extensions/interactive-prompts.ts ~/.agent-sh/extensions/
 */
import { renderDiff } from "agent-sh/utils/diff-renderer.js";
import { renderBoxFrame } from "agent-sh/utils/box-frame.js";
import { palette as p } from "agent-sh/utils/palette.js";
import type { ExtensionContext } from "agent-sh/types";
import type { ToolUI } from "agent-sh/agent/types.js";

export default function activate(ctx: ExtensionContext) {
  let autoApproveWrites = false;

  // Advise the TUI diff renderer to add permission prompt framing.
  // This replaces the default plain diff box with one that has a warning
  // border and key hints, so only one diff box is shown (not two).
  ctx.advise("tui:render-diff", (next, filePath: string, diff: any, width: number) => {
    const boxW = Math.min(84, width);
    const contentW = boxW - 4;
    const MAX_DISPLAY = 25;

    const stats = diff.isNewFile
      ? `(+${diff.added} lines)`
      : `(+${diff.added} / -${diff.removed})`;
    const title = diff.isNewFile
      ? `new: ${filePath}  ${stats}`
      : `${filePath}  ${stats}`;

    const diffLines = renderDiff(diff, {
      width: contentW,
      filePath,
      maxLines: MAX_DISPLAY,
      trueColor: true,
      mode: "unified",
    });
    const content = ["", ...diffLines.slice(1), ""];

    return renderBoxFrame(content, {
      width: boxW,
      style: "rounded",
      borderColor: p.warning,
      title,
      footer: [`  ${p.bold}[y] Apply  [n] Skip  [a] Don't ask again${p.reset}`],
    });
  });

  const { bus } = ctx;

  bus.onPipeAsync("permission:request", async (payload) => {
    const ui = payload.ui as ToolUI | undefined;
    if (!ui) return payload;

    switch (payload.kind) {
      case "tool-call":
        return handleToolCall(payload, ui);
      case "file-write": {
        if (autoApproveWrites) {
          return { ...payload, decision: { outcome: "approved" } };
        }
        const result = await handleFileWrite(payload, ui);
        if ((result.decision as any).autoApprove) {
          autoApproveWrites = true;
        }
        return result;
      }
      default:
        return payload;
    }
  });
}

async function handleToolCall(payload: any, ui: ToolUI) {
  const options = payload.metadata.options;

  const answer = await ui.custom<"approve" | "approve_all" | "deny">({
    render(width) {
      const boxW = Math.min(84, width);
      return renderBoxFrame(
        [`${p.bold}⚠ ${payload.title}${p.reset}`],
        {
          width: boxW,
          style: "rounded",
          borderColor: p.warning,
          title: "Permission required",
          footer: [`  ${p.dim}[y]es / [n]o / [a]llow all${p.reset}`],
        },
      );
    },
    handleInput(data, done) {
      const ch = data.toLowerCase();
      if (ch === "y") done("approve");
      else if (ch === "a") done("approve_all");
      else if (ch === "n" || ch === "\x1b") done("deny");
    },
  });

  if (answer === "approve" || answer === "approve_all") {
    const kind = answer === "approve_all" ? "allow_always" : "allow_once";
    const option = options?.find((o: any) => o.kind === kind)
      ?? options?.find((o: any) => o.kind === "allow_once" || o.kind === "allow_always");
    if (option) {
      return { ...payload, decision: { outcome: "selected", optionId: option.optionId } };
    }
    return { ...payload, decision: { outcome: "approved" } };
  }
  return { ...payload, decision: { outcome: "cancelled" } };
}

async function handleFileWrite(payload: any, ui: ToolUI) {
  const answer = await ui.custom<"approve" | "approve_all" | "reject">({
    render(width) {
      const boxW = Math.min(84, width);
      // Just show the prompt actions — the diff itself was already rendered
      // by our advise on "tui:render-diff".
      return renderBoxFrame([], {
        width: boxW,
        style: "rounded",
        borderColor: p.warning,
        footer: [`  ${p.bold}[y] Apply  [n] Skip  [a] Don't ask again${p.reset}`],
      });
    },
    handleInput(data, done) {
      const ch = data.toLowerCase();
      if (ch === "y") done("approve");
      else if (ch === "a") done("approve_all");
      else if (ch === "n" || ch === "\x1b") done("reject");
    },
  });

  if (answer === "approve") {
    return { ...payload, decision: { outcome: "approved" } };
  }
  if (answer === "approve_all") {
    return { ...payload, decision: { outcome: "approved", autoApprove: true } };
  }
  return { ...payload, decision: { outcome: "cancelled" } };
}
