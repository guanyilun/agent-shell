import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "./types.js";
import type { ContextManager } from "../context-manager.js";
import { discoverSkills } from "./skills.js";

/** File names to scan for project conventions (checked in order). */
const CONVENTION_FILES = ["CLAUDE.md", "AGENT.md"];

/**
 * Scan from `dir` upward to the filesystem root for project convention files.
 * Checks for CLAUDE.md (de facto standard) and AGENT.md as fallback.
 * Returns contents ordered root-first (general → specific), so more
 * specific project context appears last and takes precedence.
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
          break; // only use the first match per directory
        }
      } catch {
        // File doesn't exist — try next name
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }

  // Reverse so root-level appears first, cwd-level last
  files.reverse();
  return files.map(f => `<!-- ${f.path} -->\n${f.content}`);
}

/**
 * Build the system prompt for the internal agent.
 * Combines static instructions, tool descriptions, mode descriptions,
 * and dynamic shell context from ContextManager.
 */
export function buildSystemPrompt(
  tools: ToolDefinition[],
  contextManager: ContextManager,
): string {
  const sections: string[] = [];

  // 1. Identity and capabilities
  sections.push(
    `You are an AI coding assistant embedded in agent-sh, a terminal shell.
You have access to the user's shell environment and can read, write, and execute code.
You share the user's working directory, environment variables, and shell history.`,
  );

  // 2. Input modes
  sections.push(
    `# Input Modes

The user interacts with you through two modes:

QUERY mode (triggered by '?'): The user is asking questions or requesting tasks.
Use your internal tools (bash, file operations, etc.) to accomplish tasks.
Do NOT use user_shell in this mode unless the user explicitly asks to run
something in their live shell.

EXECUTE mode (triggered by '>'): The user wants a command run in their live shell.
You may use your tools to investigate first (read files, grep, etc.), but the
final action must be running the command via user_shell with return_output=false.
The user sees the output directly — you don't need to see or summarize it.
Do not explain, confirm, or comment on the result — just run it and stop.

Each prompt includes a per-query mode instruction — follow it.`,
  );

  // 3. Tool descriptions
  sections.push(
    "# Available Tools\n" +
      tools
        .map((t) => `- ${t.name}: ${t.description}`)
        .join("\n"),
  );

  // 4. Tool usage guidelines
  sections.push(
    `# Tool Usage Guidelines
- Use read_file before editing a file you haven't seen
- Prefer edit_file over write_file for modifying existing files
- Use grep/glob to find files before reading them
- Keep bash commands focused; avoid long-running blocking commands
- Always check command exit codes for errors
- user_shell runs commands in the user's live terminal — use for cd, export, source, etc.
- user_shell output is shown directly to the user but NOT returned to you by default.
  Set return_output=true if you need to inspect the result to answer a question.`,
  );

  // 5. Project conventions (CLAUDE.md / AGENT.md from cwd hierarchy)
  const agentMdSections = loadConventionFiles(contextManager.getCwd());
  if (agentMdSections.length > 0) {
    sections.push(
      "# Project Conventions\n\n" + agentMdSections.join("\n\n"),
    );
  }

  // 6. Skills hint (only if skills are available — agent discovers via list_skills tool)
  const skills = discoverSkills(contextManager.getCwd());
  if (skills.length > 0) {
    sections.push(
      `You have access to ${skills.length} skill(s). Use the list_skills tool to see them, then read_file to load one.`,
    );
  }

  // 7. Shell context (from ContextManager — recent commands, output, exchanges)
  const shellContext = contextManager.getContext();
  if (shellContext) {
    sections.push(shellContext);
  }

  // 8. Dynamic metadata
  sections.push(
    `Current date: ${new Date().toISOString().split("T")[0]}
Working directory: ${contextManager.getCwd()}`,
  );

  return sections.join("\n\n");
}
