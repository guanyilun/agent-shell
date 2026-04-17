import * as fs from "node:fs/promises";
import * as path from "node:path";
import { executeCommand } from "../../executor.js";
import type { ToolDefinition } from "../types.js";

export function createGlobTool(getCwd: () => string): ToolDefinition {
  return {
    name: "glob",
    description:
      "Find files by name pattern. Returns paths sorted by modification time (newest first). " +
      "ALWAYS use this instead of find/ls via bash. " +
      "Use glob to locate files, then read_file or grep to inspect contents.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern (e.g., 'src/**/*.ts', '*.json')",
        },
        path: {
          type: "string",
          description: "Base directory to search (default: cwd)",
        },
      },
      required: ["pattern"],
    },

    showOutput: false,

    formatResult: (_args, result) => {
      if (result.isError || result.content === "No files matched.") return { summary: "0 files" };
      const lines = result.content.split("\n").filter(l => l && !l.startsWith("["));
      return { summary: `${lines.length} files` };
    },

    getDisplayInfo: (args) => ({
      kind: "search",
      icon: "⌕",
      locations: args.path
        ? [{ path: args.path as string }]
        : [],
    }),

    async execute(args) {
      const pattern = args.pattern as string;
      const searchPath = (args.path as string) ?? ".";

      // Use ripgrep for correct glob matching + .gitignore awareness
      const shellEsc = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
      const parts = [
        "rg", "--files",
        "--glob", shellEsc(pattern),
        shellEsc(searchPath),
      ];
      const { session, done } = executeCommand({
        command: parts.join(" "),
        cwd: getCwd(),
        timeout: 10_000,
      });
      await done;

      if (!session.output.trim()) {
        return {
          content: "No files matched.",
          exitCode: 0,
          isError: false,
        };
      }

      const cwd = getCwd();
      const files = session.output.trim().split("\n");

      // Sort by modification time (newest first) — parallel stat calls
      const withMtime = await Promise.all(
        files.map(async (f) => {
          try {
            const abs = path.resolve(cwd, f);
            const stat = await fs.stat(abs);
            return { file: f, mtime: stat.mtimeMs };
          } catch {
            return { file: f, mtime: 0 };
          }
        }),
      );
      withMtime.sort((a, b) => b.mtime - a.mtime);

      const sorted = withMtime.slice(0, 200).map((e) => e.file);
      const truncated = files.length > 200;
      const suffix = truncated
        ? `\n[Results capped at 200 files, ${files.length - 200} more matched]`
        : "";

      return {
        content: sorted.join("\n") + suffix,
        exitCode: 0,
        isError: false,
      };
    },
  };
}
