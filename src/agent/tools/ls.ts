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
      "List files and directories in a given path.",
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
      locations: args.path
        ? [{ path: args.path as string }]
        : [],
    }),

    async execute(args) {
      const dirPath = (args.path as string) ?? ".";
      const absPath = path.resolve(getCwd(), dirPath);

      try {
        const entries = await fs.readdir(absPath, {
          withFileTypes: true,
        });

        const lines: string[] = [];
        for (const e of entries) {
          const fullPath = path.join(absPath, e.name);
          try {
            const stat = await fs.stat(fullPath);
            const size = e.isDirectory() ? "-" : formatSize(stat.size);
            const mtime = stat.mtime.toISOString().slice(0, 16).replace("T", " ");
            lines.push(
              `${mtime}  ${size.padStart(8)}  ${e.isDirectory() ? e.name + "/" : e.name}`,
            );
          } catch {
            lines.push(
              `${"?".padStart(16)}  ${"?".padStart(8)}  ${e.isDirectory() ? e.name + "/" : e.name}`,
            );
          }
        }

        return {
          content: lines.join("\n") || "(empty directory)",
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
