/**
 * Skill discovery and loading.
 *
 * Follows the Agent Skills standard (agentskills.io):
 *   - Skills are directories containing a SKILL.md with YAML frontmatter
 *   - Frontmatter must include `name` and `description`
 *   - Full content is loaded on-demand (only names/descriptions in system prompt)
 *
 * Discovery locations:
 *   Global:  ~/.agent-sh/skills/ (default), plus skillPaths from settings
 *   Project: .agents/skills/ in cwd and ancestor dirs (up to git root)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getSettings } from "../settings.js";

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
}

/** Parse YAML frontmatter from a SKILL.md file. */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      meta[key] = value;
    }
  }

  return { meta, body: match[2] };
}

/** Load a single skill from a SKILL.md file. */
function loadSkillFromFile(filePath: string): Skill | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseFrontmatter(content);
    if (!parsed) return null;

    const name = parsed.meta.name;
    const description = parsed.meta.description;
    if (!name || !description) return null;

    if (parsed.meta["disable-model-invocation"] === "true") return null;

    return {
      name,
      description,
      filePath,
      baseDir: path.dirname(filePath),
    };
  } catch {
    return null;
  }
}

/** Recursively scan a directory for SKILL.md files. */
function scanDir(dir: string): Skill[] {
  const skills: Skill[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  // If this directory has a SKILL.md, it's a skill root — don't recurse further
  const skillMd = path.join(dir, "SKILL.md");
  try {
    fs.accessSync(skillMd);
    const skill = loadSkillFromFile(skillMd);
    if (skill) skills.push(skill);
    return skills;
  } catch {
    // No SKILL.md here — check subdirectories
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const fullPath = path.join(dir, entry.name);
    const isDir = entry.isDirectory() ||
      (entry.isSymbolicLink() && (() => { try { return fs.statSync(fullPath).isDirectory(); } catch { return false; } })());

    if (isDir) {
      skills.push(...scanDir(fullPath));
    }
  }

  return skills;
}

/** Find the git root from a directory. */
function findGitRoot(dir: string): string | null {
  let current = path.resolve(dir);
  while (true) {
    try {
      fs.accessSync(path.join(current, ".git"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** Expand ~ to home directory. */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function addUnique(target: Skill[], source: Skill[], seen: Set<string>): void {
  for (const skill of source) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      target.push(skill);
    }
  }
}

// ── Global skills cache ─────────────────────────────────────────
// Global skills don't change within a session (based on ~/.agent-sh/skills/
// and settings.skillPaths, both stable). Cache to avoid redundant filesystem
// scans on every system-prompt:build.

let _cachedGlobalSkills: Skill[] | null = null;

/**
 * Discover global skills (stable across cwd changes).
 * Results are cached for the lifetime of the process.
 * Call invalidateGlobalSkillsCache() after /reload to refresh.
 */
export function discoverGlobalSkills(): Skill[] {
  if (_cachedGlobalSkills) return _cachedGlobalSkills;

  const seen = new Set<string>();
  const skills: Skill[] = [];

  addUnique(skills, scanDir(path.join(os.homedir(), ".agent-sh", "skills")), seen);

  const settings = getSettings();
  for (const p of settings.skillPaths ?? []) {
    addUnique(skills, scanDir(path.resolve(expandHome(p))), seen);
  }

  _cachedGlobalSkills = skills;
  return skills;
}

/** Invalidate the global skills cache (e.g. after extension reload). */
export function invalidateGlobalSkillsCache(): void {
  _cachedGlobalSkills = null;
}

/**
 * Discover project-level skills from .agents/skills/ in cwd hierarchy.
 * Scans from cwd up to git root.
 */
export function discoverProjectSkills(cwd: string): Skill[] {
  const seen = new Set<string>();
  const skills: Skill[] = [];
  const gitRoot = findGitRoot(cwd);
  let current = path.resolve(cwd);

  while (true) {
    addUnique(skills, scanDir(path.join(current, ".agents", "skills")), seen);

    if (gitRoot && current === gitRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return skills;
}

/**
 * Discover all skills (global + project).
 */
export function discoverSkills(cwd: string): Skill[] {
  const seen = new Set<string>();
  const skills: Skill[] = [];
  addUnique(skills, discoverGlobalSkills(), seen);
  addUnique(skills, discoverProjectSkills(cwd), seen);
  return skills;
}

/**
 * Load the full content of a skill (frontmatter stripped).
 * Returns XML-wrapped content suitable for injection into conversation.
 */
export function loadSkillContent(skill: Skill): string | null {
  try {
    const content = fs.readFileSync(skill.filePath, "utf-8");
    const parsed = parseFrontmatter(content);
    if (!parsed) return content;

    return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${parsed.body.trim()}\n</skill>`;
  } catch {
    return null;
  }
}
