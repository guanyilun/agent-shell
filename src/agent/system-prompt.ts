import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "./types.js";
import type { ContextManager } from "../context-manager.js";
import { discoverSkills } from "./skills.js";

/** File names to scan for project conventions (checked in order). */
const CONVENTION_FILES = ["CLAUDE.md", "AGENT.md"];

/**
 * Scan from `dir` upward for project convention files.
 * Returns contents ordered root-first (general → specific).
 */
function loadConventionFiles(dir: string): string[] {
  const files: { path: string; content: string }[] = [];
  let current = path.resolve(dir);

  while (true) {
    for (const name of CONVENTION_FILES) {
      const candidate = path.join(current, name);
      try {
        const content = fs.readFileSync(candidate, "utf-8").trim();
        if (content) {
          files.push({ path: candidate, content });
          break;
        }
      } catch {
        // File doesn't exist
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  files.reverse();
  return files.map(f => `<!-- ${f.path} -->\n${f.content}`);
}

/**
 * Static system prompt — identical across all queries, cacheable.
 * Contains only identity and behavioral instructions.
 */
export const STATIC_SYSTEM_PROMPT = `You are an AI coding assistant embedded in agent-sh, a terminal shell.
You have access to the user's shell environment and can read, write, and execute code.
You share the user's working directory, environment variables, and shell history.

# Input Modes

The user interacts with you through two modes:

EXECUTE mode (triggered by '>'): The user is asking questions or requesting tasks.
Use your internal tools (bash, file operations, etc.) to accomplish tasks.
Do NOT use user_shell in this mode unless the user explicitly asks to run
something in their live shell.

HELP mode (triggered by '?'): The user wants a command run in their live shell.
You may use your tools to investigate first (read files, grep, etc.), but the
final action must be running the command via user_shell with return_output=false.
The user sees the output directly — you don't need to see or summarize it.
Do not explain, confirm, or comment on the result — just run it and stop.

Each prompt includes a per-query mode instruction — follow it.

# Tool Usage Guidelines
- Use read_file before editing a file you haven't seen
- Prefer edit_file over write_file for modifying existing files
- Use grep/glob to find files before reading them
- Keep bash commands focused; avoid long-running blocking commands
- Always check command exit codes for errors
- user_shell runs commands in the user's live terminal — use for cd, export, source, etc.
- user_shell output is shown directly to the user but NOT returned to you by default.
  Set return_output=true if you need to inspect the result to answer a question.`;

/**
 * Build the dynamic context — injected as a user message before each query.
 * Contains everything that changes: tools, shell context, conventions, cwd.
 *
 * Runs through the "agent:dynamic-context" pipe so extensions can append.
 */
export function buildDynamicContext(
  tools: ToolDefinition[],
  contextManager: ContextManager,
): string {
  const sections: string[] = [];

  // Tools
  sections.push(
    "# Available Tools\n" +
      tools.map((t) => `- ${t.name}: ${t.description}`).join("\n"),
  );

  // Project conventions (CLAUDE.md / AGENT.md)
  const conventions = loadConventionFiles(contextManager.getCwd());
  if (conventions.length > 0) {
    sections.push("# Project Conventions\n\n" + conventions.join("\n\n"));
  }

  // Skills hint
  const skills = discoverSkills(contextManager.getCwd());
  if (skills.length > 0) {
    sections.push(
      `You have access to ${skills.length} skill(s). Use the list_skills tool to see them, then read_file to load one.`,
    );
  }

  // Shell context
  const shellContext = contextManager.getContext();
  if (shellContext) {
    sections.push(shellContext);
  }

  // Metadata
  sections.push(
    `Current date: ${new Date().toISOString().split("T")[0]}\nWorking directory: ${contextManager.getCwd()}`,
  );

  return sections.join("\n\n");
}
