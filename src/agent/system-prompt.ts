import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextManager } from "../context-manager.js";
import { discoverGlobalSkills, discoverProjectSkills, type Skill } from "./skills.js";

/**
 * Format skills for inline display in prompt.
 * Shows name, description, and file path so the model can decide immediately
 * whether to load a skill — no extra round-trip needed.
 */
export function formatSkillsBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return "# Available Skills\n\n"
    + "Load a skill's full content with read_file on its file path when needed.\n\n"
    + skills.map(s => `- **${s.name}**: ${s.description}\n  Path: ${s.filePath}`).join("\n\n");
}

/** Resolve the absolute path to agent-sh's own docs directory. */
const CODE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../",
);

/** File names to scan for project conventions (checked in order). */
const CONVENTION_FILES = ["CLAUDE.md", "AGENT.md"];

// Resolve to the user's home-based config dir for global behavioral rules
import * as os from "node:os";
const GLOBAL_AGENTS_MD = path.join(os.homedir(), ".agent-sh", "AGENTS.md");

export function loadGlobalAgentsMd(): string | null {
  try {
    const content = fs.readFileSync(GLOBAL_AGENTS_MD, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

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
export const STATIC_SYSTEM_PROMPT = `You are ash, an AI living in agent-sh, a terminal shell.
You have access to the user's shell environment and can read, write, and execute code.
You share the user's working directory, environment variables, and shell history.
Your own source code is available in ${CODE_DIR}. Read your own source code. You are a
program.

# Tool Decision Guide
bash, read_file, grep, glob, ls, edit_file, write_file::
Use these to investigate, search, read, and modify files. Output is returned
to you for reasoning — the user doesn't see it directly.

Extensions may register additional tools — follow their instructions.

# Tool Usage Guidelines
- Use read_file before editing a file you haven't seen
- Prefer edit_file over write_file for modifying existing files
- Use grep/glob to find files before reading them
- Keep bash commands focused; avoid long-running blocking commands
- Always check command exit codes for errors

# Preference Learning

Treat the user's past commands as standing preferences. Before acting, check shell history
and conversation context for recurring patterns — apply them proactively and do not wait to
be reminded.`;

/**
 * Build the dynamic context — injected as a user message before each query.
 * Contains everything that changes: shell context, conventions, cwd.
 *
 * Runs through the "dynamic-context:build" handler so extensions can advise.
 */
export function buildDynamicContext(
  contextManager: ContextManager,
  shellBudgetTokens?: number,
): string {
  const sections: string[] = [];

  // Project conventions (CLAUDE.md / AGENT.md)
  const conventions = loadConventionFiles(contextManager.getCwd());
  if (conventions.length > 0) {
    sections.push("# Project Conventions\n\n" + conventions.join("\n\n"));
  }

  // Project-level skills (change with cwd — not cacheable)
  const projectSkills = discoverProjectSkills(contextManager.getCwd());
  const skillsBlock = formatSkillsBlock(projectSkills);
  if (skillsBlock) {
    sections.push(skillsBlock);
  }

  // Shell context — pass token budget converted to bytes (~4 chars/token)
  const shellBudgetBytes = shellBudgetTokens != null ? shellBudgetTokens * 4 : undefined;
  const shellContext = contextManager.getContext(shellBudgetBytes);
  if (shellContext) {
    sections.push(shellContext);
  }

  // Metadata
  sections.push(
    `Current date: ${new Date().toISOString().split("T")[0]}\nWorking directory: ${contextManager.getCwd()}`,
  );

  return sections.join("\n\n");
}
