import type { EventBus } from "../../event-bus.js";
import type { ToolDefinition } from "../types.js";

/**
 * user_shell — runs commands in the user's live PTY shell.
 *
 * Unlike bash, this affects the user's shell state (cd, export, source).
 * Output is shown directly in the terminal. By default, the agent doesn't
 * see the output (return_output=false) to save tokens.
 */
export function createUserShellTool(opts: {
  getCwd: () => string;
  bus: EventBus;
}): ToolDefinition {
  return {
    name: "user_shell",
    description:
      "Run a complete, non-interactive command in the user's live shell (cd, export, install packages, start servers, git commands). " +
      "Use this for commands that have side effects or that the user wants to see. Output is shown directly to the user but NOT returned " +
      "to you by default — set return_output=true if you need to inspect the result. " +
      "Do NOT use this to interact with programs that are already running in the terminal — use terminal_keys/terminal_read instead.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to execute in user's shell",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 30)",
        },
        return_output: {
          type: "boolean",
          default: false,
          description:
            "Whether to return the command output to you. Default false — output is shown directly to the user. Set true only if you need to inspect the result to answer a question.",
        },
      },
      required: ["command"],
    },

    showOutput: false,
    modifiesFiles: true,

    getDisplayInfo: () => ({
      kind: "execute",
      icon: "▷",
      locations: [],
    }),

    async execute(args) {
      const command = args.command as string;
      const timeoutSec = (args.timeout as number) ?? 30;
      const returnOutput = (args.return_output as boolean) ?? false;

      // Execute via the shell-exec extension's async pipe with timeout
      let result: { output: string; exitCode: number | null; [k: string]: unknown };
      try {
        const execPromise = opts.bus.emitPipeAsync(
          "shell:exec-request",
          {
            command,
            output: "",
            cwd: opts.getCwd(),
            exitCode: null as number | null,
            done: false,
          },
        );
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutSec * 1000),
        );
        result = await Promise.race([execPromise, timeoutPromise]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "timeout") {
          return {
            content: `Command timed out after ${timeoutSec}s.`,
            exitCode: -1,
            isError: true,
          };
        }
        return { content: `Error: ${msg}`, exitCode: -1, isError: true };
      }

      const exitCode = result.exitCode ?? 0;
      const isError = exitCode !== 0 && exitCode !== null;

      if (returnOutput) {
        return {
          content: result.output || "(no output)",
          exitCode,
          isError,
        };
      }

      return {
        content: isError
          ? `Command failed with exit code ${exitCode}.`
          : "Command executed.",
        exitCode,
        isError,
      };
    },
  };
}
