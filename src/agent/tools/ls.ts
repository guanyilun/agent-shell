import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition } from "../types.js";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

export function createLsTool(getCwd: () => string): ToolDefinition {
  return {
    name: "ls",
    description:
      "List files and directories with timestamps and sizes. " +
      "Use for exploring a single directory. Use glob for recursive file search by pattern.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to list (default: cwd)",
        },
      },
    },

    showOutput: false,

    getDisplayInfo: (args) => ({
      kind: "read",
      icon: "◆",
      locations: args.path
        ? [{ path: args.path as string }]
        : [],
    }),

    formatResult: (_args, result) => {
      if (result.isError || result.content === "(empty directory)") return { summary: "0 entries" };
      const lines = result.content.split("\n").filter(Boolean);
      return { summary: `${lines.length} entries` };
    },

    async execute(args) {
      const dirPath = (args.path as string) ?? ".";
      const absPath = path.resolve(getCwd(), dirPath);

      try {
        const entries = await fs.readdir(absPath, {
          withFileTypes: true,
        });

        // Batch stat calls in parallel to avoid N+1 serial overhead
        const items = await Promise.all(
          entries.map(async (e) => {
            const fullPath = path.join(absPath, e.name);
            try {
              const stat = await fs.stat(fullPath);
              const size = e.isDirectory() ? "-" : formatSize(stat.size);
              const mtime = stat.mtime.toISOString().slice(0, 16).replace("T", " ");
              return `${mtime}  ${size.padStart(8)}  ${e.isDirectory() ? e.name + "/" : e.name}`;
            } catch {
              return `${"?".padStart(16)}  ${"?".padStart(8)}  ${e.isDirectory() ? e.name + "/" : e.name}`;
            }
          }),
        );

        return {
          content: items.join("\n") || "(empty directory)",
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
