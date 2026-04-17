import { executeCommand } from "../../executor.js";
import type { EventBus } from "../../event-bus.js";
import type { ToolDefinition } from "../types.js";

export function createBashTool(opts: {
  getCwd: () => string;
  getEnv: () => Record<string, string>;
  bus: EventBus;
}): ToolDefinition {
  return {
    name: "bash",
    description:
      "Execute a bash command in an isolated subprocess. Output is captured and returned. " +
      "Does not affect the user's shell state. " +
      "cwd is set to the working directory from the shell context. " +
      "Do NOT use bash for file searching — use grep/glob instead. " +
      "Do NOT use bash for reading files — use read_file instead.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 60)",
        },
        description: {
          type: "string",
          description:
            "Short description of what this command does (e.g., 'Install dependencies', 'Run test suite')",
        },
      },
      required: ["command"],
    },

    showOutput: true,
    modifiesFiles: true,
    requiresPermission: true,

    getDisplayInfo: (args) => ({
      kind: "execute",
      icon: "▶",
      locations: [],
    }),

    async execute(args, onChunk) {
      const command = args.command as string;
      const timeout = ((args.timeout as number) ?? 60) * 1000;

      // Let extensions intercept before execution
      const intercepted = opts.bus.emitPipe("agent:terminal-intercept", {
        command,
        cwd: opts.getCwd(),
        intercepted: false,
        output: "",
      });
      if (intercepted.intercepted) {
        return {
          content: intercepted.output,
          exitCode: 0,
          isError: false,
        };
      }

      const { session, done } = executeCommand({
        command,
        cwd: opts.getCwd(),
        env: opts.getEnv(),
        timeout,
        onOutput: onChunk,
      });

      await done;

      const content = session.truncated
        ? `[output truncated, showing last portion]\n${session.output}`
        : session.output;

      return {
        content: content || "(no output)",
        exitCode: session.exitCode,
        isError: session.exitCode !== 0,
      };
    },
  };
}
