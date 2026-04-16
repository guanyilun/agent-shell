import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition } from "../types.js";
import { computeDiff, computeEditDiff } from "../../utils/diff.js";

/**
 * Find the closest matching region in the file content to help diagnose
 * why an exact match failed. Returns a hint string.
 */
function findClosestMatch(content: string, needle: string): string {
  const hints: string[] = [];

  // Check if trimming whitespace would match
  const trimmedNeedle = needle.replace(/[ \t]+$/gm, "").replace(/^[ \t]+/gm, "");
  const trimmedContent = content.replace(/[ \t]+$/gm, "").replace(/^[ \t]+/gm, "");
  if (trimmedContent.includes(trimmedNeedle)) {
    hints.push(" Whitespace (indentation or trailing spaces) differs — check leading/trailing spaces on each line.");
    return hints.join("");
  }

  // Check if the first line exists to narrow down the region
  const needleLines = needle.split("\n");
  const firstLine = needleLines[0].trim();
  if (firstLine.length > 10) {
    const contentLines = content.split("\n");
    const matches = contentLines
      .map((l, i) => ({ line: i + 1, text: l }))
      .filter((l) => l.text.includes(firstLine));

    if (matches.length > 0 && needleLines.length > 1) {
      const loc = matches.map((m) => `line ${m.line}`).join(", ");
      hints.push(` First line found at ${loc}, but subsequent lines differ. The file may have changed — use read_file to see current content around that region.`);
      return hints.join("");
    }
  }

  hints.push(" Use read_file to verify the current file contents before retrying.");
  return hints.join("");
}

export function createEditFileTool(getCwd: () => string): ToolDefinition {
  return {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact text match with new text. " +
      "The old_text must appear exactly once unless replace_all=true. " +
      "Include enough context to make the match unique. " +
      "Use replace_all for variable renames or bulk string replacements.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path",
        },
        old_text: {
          type: "string",
          description: "Exact text to find (must appear exactly once)",
        },
        new_text: {
          type: "string",
          description: "Replacement text",
        },
        replace_all: {
          type: "boolean",
          description:
            "Replace ALL occurrences instead of requiring a unique match. Useful for variable renames.",
        },
      },
      required: ["path", "old_text", "new_text"],
    },

    showOutput: true,
    modifiesFiles: true,
    requiresPermission: true,

    getDisplayInfo: (args) => ({
      kind: "write",
      icon: "✎",
      locations: [{ path: args.path as string }],
    }),

    formatResult: (_args, result) => {
      if (result.isError) return {};
      const m = result.content.match(/\((\+\d+(?:\s-\d+)?)\)/);
      return m ? { summary: m[1] } : {};
    },

    async execute(args, onChunk) {
      const filePath = args.path as string;
      const oldText = args.old_text as string;
      const newText = args.new_text as string;
      const replaceAll = (args.replace_all as boolean) ?? false;
      const absPath = path.resolve(getCwd(), filePath);

      try {
        const content = await fs.readFile(absPath, "utf-8");

        // Normalize line endings for matching
        const normalized = content.replace(/\r\n/g, "\n");
        const normalizedOld = oldText.replace(/\r\n/g, "\n");

        const occurrences =
          normalized.split(normalizedOld).length - 1;
        if (occurrences === 0) {
          // Try to find the closest match to help the agent self-correct
          const hint = findClosestMatch(normalized, normalizedOld);
          return {
            content: `Error: old_text not found in ${filePath}.${hint}`,
            exitCode: 1,
            isError: true,
          };
        }
        if (occurrences > 1 && !replaceAll) {
          return {
            content: `Error: old_text found ${occurrences} times, must be unique. Add more surrounding context or use replace_all=true.`,
            exitCode: 1,
            isError: true,
          };
        }

        const normalizedNew = newText.replace(/\r\n/g, "\n");
        // Use split/join for literal replacement everywhere. String.replace()
        // treats dollar-sign patterns in the replacement as special substitution
        // variables, which corrupts file content containing regex escape sequences.
        const newContent = normalized.split(normalizedOld).join(normalizedNew);
        // Note: when !replaceAll, we rely on the occurrence check above to ensure
        // normalizedOld appears exactly once, so split/join replaces only that one.

        // Restore original line endings — only convert if the file was
        // predominantly CRLF (>50% of line endings), to avoid corrupting
        // mixed-ending files.
        const crlfCount = (content.match(/\r\n/g) || []).length;
        const lfCount = (content.match(/(?<!\r)\n/g) || []).length;
        const useCRLF = crlfCount > 0 && crlfCount >= lfCount;
        const finalContent = useCRLF
          ? newContent.replace(/\n/g, "\r\n")
          : newContent;

        await fs.writeFile(absPath, finalContent);

        // Compute and stream diff for display (windowed — only diffs the edit region)
        const diff = computeEditDiff(normalized, normalizedOld, normalizedNew, replaceAll);
        if (onChunk && diff.hunks.length > 0) {
          for (const hunk of diff.hunks) {
            for (const line of hunk.lines) {
              if (line.type === "added") onChunk(`+${line.text}\n`);
              else if (line.type === "removed") onChunk(`-${line.text}\n`);
              else onChunk(` ${line.text}\n`);
            }
          }
        }

        const stats = diff.isNewFile
          ? `+${diff.added}`
          : `+${diff.added} -${diff.removed}`;
        return {
          content: `Edited ${absPath} (${stats})`,
          exitCode: 0,
          isError: false,
        };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        return { content: `Error: ${msg}`, exitCode: 1, isError: true };
      }
    },
  };
}
