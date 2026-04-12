import { executeCommand } from "../../executor.js";
import type { ToolDefinition } from "../types.js";

export function createGrepTool(getCwd: () => string): ToolDefinition {
  return {
    name: "grep",
    description:
      "Search file contents using ripgrep (rg). Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for",
        },
        path: {
          type: "string",
          description: "Directory or file to search (default: cwd)",
        },
        include: {
          type: "string",
          description:
            "Glob pattern for files to include (e.g., '*.ts')",
        },
      },
      required: ["pattern"],
    },

    showOutput: false,

    getDisplayInfo: (args) => ({
      kind: "search",
      locations: args.path
        ? [{ path: args.path as string }]
        : [],
    }),

    async execute(args) {
      const pattern = args.pattern as string;
      const searchPath = (args.path as string) ?? ".";
      const include = args.include as string | undefined;

      const shellEsc = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
      const parts = [
        "rg",
        "--line-number",
        "--no-heading",
        "--color=never",
        "--max-count=200",
      ];
      if (include) {
        parts.push("--glob", shellEsc(include));
      }
      parts.push("-e", shellEsc(pattern), shellEsc(searchPath));

      const { session, done } = executeCommand({
        command: parts.join(" "),
        cwd: getCwd(),
        timeout: 10_000,
        maxOutputBytes: 64 * 1024,
      });
      await done;

      if (session.exitCode === 1 && !session.output.trim()) {
        return {
          content: "No matches found.",
          exitCode: 0,
          isError: false,
        };
      }

      // Truncate to ~100 lines
      const lines = session.output.split("\n");
      if (lines.length > 100) {
        return {
          content:
            lines.slice(0, 100).join("\n") +
            `\n[${lines.length - 100} more lines truncated]`,
          exitCode: 0,
          isError: false,
        };
      }

      return {
        content: session.output || "No matches found.",
        exitCode: 0,
        isError: false,
      };
    },
  };
}
