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

// Resolve to the user's home-based config dir — user's standing instructions to the agent
import * as os from "node:os";
const GLOBAL_AGENTS_MD = path.join(os.homedir(), ".agent-sh", "AGENTS.md");

// ── File caches ─────────────────────────────────────────────────────
// Convention files (CLAUDE.md/AGENT.md) are walked synchronously from
// CWD to root on every query. In practice they almost never change,
// so a short TTL cache keyed by CWD avoids redundant filesystem walks.
// The 5-second TTL is short enough to pick up edits quickly but long
// enough to eliminate repeated walks within a multi-tool agent loop.

const CACHE_TTL_MS = 5_000;

/** TTL cache for convention files, keyed by resolved CWD. */
let conventionCache: { cwd: string; result: string[]; expiry: number } | null = null;

/** TTL cache for global AGENTS.md — changes extremely rarely. */
let agentsMdCache: { result: string | null; expiry: number } | null = null;

export function loadGlobalAgentsMd(): string | null {
  const now = Date.now();
  if (agentsMdCache && now < agentsMdCache.expiry) {
    return agentsMdCache.result;
  }
  try {
    const content = fs.readFileSync(GLOBAL_AGENTS_MD, "utf-8").trim();
    const result = content || null;
    agentsMdCache = { result, expiry: now + CACHE_TTL_MS };
    return result;
  } catch {
    agentsMdCache = { result: null, expiry: now + CACHE_TTL_MS };
    return null;
  }
}

/** Resolve the absolute path to agent-sh's own docs directory. */
const CODE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../",
);

/** File names to scan for project conventions (checked in order). */
const CONVENTION_FILES = ["CLAUDE.md", "AGENT.md"];

/**
 * Scan from `dir` upward for project convention files.
 * Returns contents ordered root-first (general → specific).
 * Results are cached for CACHE_TTL_MS, keyed by resolved directory.
 */
function loadConventionFiles(dir: string): string[] {
  const cwd = path.resolve(dir);
  const now = Date.now();

  if (conventionCache && conventionCache.cwd === cwd && now < conventionCache.expiry) {
    return conventionCache.result;
  }

  const files: { path: string; content: string }[] = [];
  let current = cwd;

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
  const result = files.map(f => `<!-- ${f.path} -->\n${f.content}`);
  conventionCache = { cwd, result, expiry: now + CACHE_TTL_MS };
  return result;
}

/**
 * Static system prompt — identical across all queries, cacheable.
 * Contains only identity and behavioral instructions.
 */
export const STATIC_SYSTEM_PROMPT = `You are an AI coding assistant running inside agent-sh, a terminal shell.
You have access to the user's shell environment and can read, write, and execute code.
You share the user's working directory, environment variables, and shell history.
agent-sh documentation is at ${path.join(CODE_DIR, "docs")} — start with README.md for an index. Read the docs when you need to understand how the runtime works.

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
export interface TokenStatus {
  /** Estimated prompt tokens (API-grounded when available, else chars/4). */
  promptTokens: number;
  /** Model's context window in tokens. */
  contextWindow: number;
}

/**
 * CWD-scoped static context: project conventions (CLAUDE.md / AGENT.md)
 * and discovered skills. Stable for a given cwd — callers should cache
 * on cwd identity rather than rebuilding per LLM iteration.
 */
export function buildStaticByCwd(cwd: string): string {
  const sections: string[] = [];

  const conventions = loadConventionFiles(cwd);
  if (conventions.length > 0) {
    sections.push("# Project Conventions\n\n" + conventions.join("\n\n"));
  }

  const projectSkills = discoverProjectSkills(cwd);
  const skillsBlock = formatSkillsBlock(projectSkills);
  if (skillsBlock) {
    sections.push(skillsBlock);
  }

  return sections.join("\n\n");
}

/**
 * Per-iteration dynamic context: shell state, date, working directory,
 * token usage. Rebuild every LLM call. Extension advisors add more
 * sections (budget, subagents, metacognitive signals, etc.) on top.
 *
 * Each section is wrapped in a named XML tag so the LLM can treat them
 * as distinct world-state elements rather than one concatenated blob.
 */
export function buildDynamicContext(
  contextManager: ContextManager,
  shellBudgetTokens?: number,
  tokenStatus?: TokenStatus,
): string {
  const sections: string[] = [];

  // Shell context is no longer injected here — it flows into the conversation
  // as incremental <shell-events> messages (see AgentLoop.injectShellDelta),
  // so it benefits from the provider's prefix cache instead of being rebuilt
  // and re-sent every turn. shellBudgetTokens is accepted but unused; kept
  // for backward compatibility with callers.
  void shellBudgetTokens;

  const envLines = [
    `Current date: ${new Date().toISOString().split("T")[0]}`,
    `Working directory: ${contextManager.getCwd()}`,
  ];
  if (tokenStatus) {
    const usedK = (tokenStatus.promptTokens / 1000).toFixed(1);
    const maxK = (tokenStatus.contextWindow / 1000).toFixed(0);
    const pct = Math.min(100, Math.round((tokenStatus.promptTokens / tokenStatus.contextWindow) * 100));
    envLines.push(`Token usage: ${usedK}k/${maxK}k (${pct}%)`);
  }
  sections.push(`<environment>\n${envLines.join("\n")}\n</environment>`);

  return sections.join("\n\n");
}
