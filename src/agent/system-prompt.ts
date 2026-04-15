import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContextManager } from "../context-manager.js";
import { discoverSkills } from "./skills.js";

/** Resolve the absolute path to agent-sh's own docs directory. */
const DOCS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs",
);

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
export const STATIC_SYSTEM_PROMPT = `You are ash, an AI coding assistant embedded in agent-sh, a terminal shell.
You have access to the user's shell environment and can read, write, and execute code.
You share the user's working directory, environment variables, and shell history.

# Tool Decision Guide

**Scratchpad tools** (bash, read_file, grep, glob, ls, edit_file, write_file):
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

Treat the user's past commands and corrections as standing preferences. Before acting, check shell history and conversation context for recurring patterns — apply them proactively and do not wait to be reminded.

# Documentation
agent-sh documentation is available in: ${DOCS_DIR}
Use read_file on ${DOCS_DIR}/README.md for an index of all docs.`;

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

  // Skills hint
  const skills = discoverSkills(contextManager.getCwd());
  if (skills.length > 0) {
    sections.push(
      `You have access to ${skills.length} skill(s). Use the list_skills tool to see them, then read_file to load one.`,
    );
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
