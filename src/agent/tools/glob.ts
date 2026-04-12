import { executeCommand } from "../../executor.js";
import type { ToolDefinition } from "../types.js";

export function createGlobTool(getCwd: () => string): ToolDefinition {
  return {
    name: "glob",
    description:
      "Find files matching a glob pattern. Returns file paths sorted by modification time.",
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

    getDisplayInfo: (args) => ({
      kind: "search",
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
        command: parts.join(" ") + " | head -200",
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

      const lines = session.output.trim().split("\n");
      const suffix =
        lines.length >= 200
          ? `\n[Results capped at 200 files]`
          : "";

      return {
        content: session.output.trim() + suffix,
        exitCode: 0,
        isError: false,
      };
    },
  };
}
