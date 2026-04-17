/**
 * Project Memory — automatic per-project knowledge accumulation.
 *
 * Observes agent tool calls via the event bus and extracts structured
 * knowledge about each project the agent works in. This knowledge is:
 *
 *   - Accumulated automatically (no manual maintenance)
 *   - Persisted per-project (different knowledge for different codebases)
 *   - Injected into the system prompt (immediate awareness without re-reading)
 *
 * Knowledge extracted:
 *   1. File importance — which files the agent reads/edits most
 *   2. Error patterns — which files/tools fail most often
 *   3. Edit clusters — files edited together (coupling signal)
 *   4. Conventions — detected test frameworks, build systems, etc.
 *
 * Storage: ~/.agent-sh/projects/<dir-hash>/project.json
 *
 * Design principle: observe, don't ask. The agent works as normal;
 * learning happens silently in the background.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { ExtensionContext } from "../../types.js";

const PROJECTS_DIR = path.join(os.homedir(), ".agent-sh", "projects");

// ── Project identity ──────────────────────────────────────────────
// Projects are identified by their absolute directory path, hashed
// to avoid filesystem issues with special characters. Two different
// directories are two different projects, even with the same name.

function projectDir(absolutePath: string): string {
  const hash = crypto.createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
  return path.join(PROJECTS_DIR, hash);
}

function projectFile(absolutePath: string): string {
  return path.join(projectDir(absolutePath), "project.json");
}

// ── Data structures ───────────────────────────────────────────────

interface FileStats {
  /** Number of times the agent read this file. */
  reads: number;
  /** Number of times the agent edited this file. */
  edits: number;
  /** Number of errors encountered on this file. */
  errors: number;
  /** Last commit hash where this file was touched (if known). */
  lastCommitHash?: string;
  /** Last edit timestamp (ISO string). */
  lastEditAt?: string;
}

interface ToolStats {
  /** Tool name. */
  name: string;
  /** Total invocations. */
  invocations: number;
  /** Total errors. */
  errors: number;
}

interface Convention {
  /** What was detected (e.g., "test framework: jest"). */
  kind: string;
  /** How it was detected (e.g., "package.json devDependencies"). */
  source: string;
  /** When it was detected (ISO string). */
  detectedAt: string;
}

interface EditCluster {
  /** Files that were edited within the same session (sorted). */
  files: string[];
  /** Number of times this cluster has been observed. */
  count: number;
  /** Last observed (ISO string). */
  lastSeen: string;
}

interface ProjectData {
  /** The absolute path this project tracks. */
  rootPath: string;
  /** Human-readable directory name (for display). */
  dirName: string;
  /** First time we saw this project. */
  createdAt: string;
  /** Last time we updated data for this project. */
  updatedAt: string;
  /** Per-file statistics. Keyed by relative path. */
  files: Record<string, FileStats>;
  /** Per-tool statistics. */
  tools: Record<string, ToolStats>;
  /** Detected conventions. */
  conventions: Convention[];
  /** Edit clusters — files frequently edited together. */
  clusters: EditCluster[];
  /** Number of sessions observed. */
  sessionCount: number;
}

function emptyProject(rootPath: string, dirName: string): ProjectData {
  return {
    rootPath,
    dirName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: {},
    tools: {},
    conventions: [],
    clusters: [],
    sessionCount: 1,
  };
}

// ── Persistence ───────────────────────────────────────────────────

function loadProject(absolutePath: string): ProjectData | null {
  const file = projectFile(absolutePath);
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveProject(data: ProjectData): void {
  const dir = projectDir(data.rootPath);
  fs.mkdirSync(dir, { recursive: true });
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(data, null, 2));
}

// ── Session tracking ──────────────────────────────────────────────
// Track files edited in the current session for cluster detection.

const sessionEdits = new Map<string, Set<string>>(); // cwd -> set of edited files

function recordEdit(cwd: string, relativePath: string): void {
  if (!sessionEdits.has(cwd)) {
    sessionEdits.set(cwd, new Set());
  }
  sessionEdits.get(cwd)!.add(relativePath);
}

// ── Prompt formatting ─────────────────────────────────────────────
// Convert project data into a concise system prompt block.
// Target: ~200-400 tokens, focused on actionable knowledge.

function formatProjectContext(data: ProjectData): string {
  const parts: string[] = [];
  parts.push(`# Project Memory (${data.dirName})`);
  parts.push(`${data.sessionCount} sessions observed. Last updated: ${data.updatedAt.split("T")[0]}`);

  // Top files by edit frequency — proxy for importance
  const topEdited = Object.entries(data.files)
    .filter(([, s]) => s.edits > 0)
    .sort((a, b) => b[1].edits - a[1].edits)
    .slice(0, 10);

  if (topEdited.length > 0) {
    parts.push("\n## Most Edited Files");
    for (const [file, stats] of topEdited) {
      let line = `- \`${file}\`: ${stats.edits} edits`;
      if (stats.errors > 0) line += `, ${stats.errors} errors`;
      if (stats.lastEditAt) line += ` (last: ${stats.lastEditAt.split("T")[0]})`;
      parts.push(line);
    }
  }

  // Error-prone files — proxy for fragility
  const errorProne = Object.entries(data.files)
    .filter(([, s]) => s.errors > 0)
    .sort((a, b) => b[1].errors - a[1].errors)
    .slice(0, 5);

  if (errorProne.length > 0) {
    parts.push("\n## Error-Prone Files");
    for (const [file, stats] of errorProne) {
      parts.push(`- \`${file}\`: ${stats.errors} errors across ${stats.edits + stats.reads} interactions`);
    }
  }

  // Edit clusters — files that change together
  const significantClusters = data.clusters
    .filter(c => c.count >= 2 && c.files.length >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  if (significantClusters.length > 0) {
    parts.push("\n## Edit Clusters (files changed together)");
    for (const cluster of significantClusters) {
      parts.push(`- ${cluster.files.map(f => `\`${f}\``).join(", ")} (${cluster.count}×)`);
    }
  }

  // Detected conventions
  if (data.conventions.length > 0) {
    parts.push("\n## Detected Conventions");
    for (const conv of data.conventions) {
      parts.push(`- ${conv.kind} (via ${conv.source})`);
    }
  }

  return parts.join("\n");
}

// ── Convention detection ──────────────────────────────────────────
// Detect common project conventions from file existence and contents.

function detectConventions(cwd: string, existing: Convention[]): Convention[] {
  const detected = [...existing];
  const existingKinds = new Set(existing.map(c => c.kind));

  const addIfNew = (kind: string, source: string) => {
    if (!existingKinds.has(kind)) {
      detected.push({ kind, source, detectedAt: new Date().toISOString() });
    }
  };

  // Package.json based detection
  const pkgPath = path.join(cwd, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Test frameworks
    if (deps.jest) addIfNew("test: jest", "package.json");
    if (deps.vitest) addIfNew("test: vitest", "package.json");
    if (deps.mocha) addIfNew("test: mocha", "package.json");
    if (deps.pytest) addIfNew("test: pytest", "package.json"); // unlikely in pkg.json but pattern

    // Language / transpilation
    if (deps.typescript || fs.existsSync(path.join(cwd, "tsconfig.json"))) {
      addIfNew("language: TypeScript", "package.json / tsconfig.json");
    }

    // Build tools
    if (deps.esbuild) addIfNew("build: esbuild", "package.json");
    if (deps.vite) addIfNew("build: vite", "package.json");
    if (deps.webpack) addIfNew("build: webpack", "package.json");
    if (deps.turbo || deps["@turbo/gen"]) addIfNew("monorepo: turborepo", "package.json");

    // Frameworks
    if (deps.react) addIfNew("framework: React", "package.json");
    if (deps.next) addIfNew("framework: Next.js", "package.json");
    if (deps.express) addIfNew("framework: Express", "package.json");
    if (deps.fastify) addIfNew("framework: Fastify", "package.json");

    // Linting
    if (deps.eslint) addIfNew("lint: eslint", "package.json");
    if (deps.biome) addIfNew("lint: biome", "package.json");

    // Module type
    if (pkg.type === "module") addIfNew("modules: ESM", "package.json");
  } catch {
    // No package.json — not a Node project
  }

  // Python detection
  if (fs.existsSync(path.join(cwd, "pyproject.toml"))) {
    addIfNew("language: Python", "pyproject.toml");
  }
  if (fs.existsSync(path.join(cwd, "requirements.txt"))) {
    addIfNew("language: Python", "requirements.txt");
  }

  // Git
  if (fs.existsSync(path.join(cwd, ".git"))) {
    addIfNew("vcs: git", ".git directory");
  }

  // Docker
  if (fs.existsSync(path.join(cwd, "Dockerfile"))) {
    addIfNew("container: Docker", "Dockerfile");
  }

  return detected;
}

// ── Cluster extraction ────────────────────────────────────────────
// At session end (or periodically), extract edit clusters from the
// session's edit set. Clusters are sets of files edited together,
// keyed by their sorted file list.

function updateClusters(data: ProjectData, cwd: string): void {
  const edits = sessionEdits.get(cwd);
  if (!edits || edits.size < 2) return;

  const files = [...edits].sort();
  const key = files.join("|");

  const existing = data.clusters.find(c => c.files.join("|") === key);
  if (existing) {
    existing.count++;
    existing.lastSeen = new Date().toISOString();
  } else {
    data.clusters.push({
      files,
      count: 1,
      lastSeen: new Date().toISOString(),
    });
  }
}

// ── Main extension ────────────────────────────────────────────────

export default function activate(ctx: ExtensionContext): void {
  const { bus, contextManager } = ctx;

  // ── Bridge: tool-started → tool-completed ─────────────────────
  // tool-started has title (tool name) and rawInput (arguments including
  // file paths). tool-completed has exitCode. We bridge them via toolCallId.

  const pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>();

  bus.on("agent:tool-started", ({ title, toolCallId, rawInput }) => {
    if (!toolCallId || !rawInput) return;
    pendingTools.set(toolCallId, { name: title, args: rawInput as Record<string, unknown> });
  });

  bus.on("agent:tool-completed", ({ toolCallId, exitCode }) => {
    if (!toolCallId) return;

    const pending = pendingTools.get(toolCallId);
    pendingTools.delete(toolCallId);

    const cwd = contextManager.getCwd();

    // Load or create project data
    let project = loadProject(cwd);
    if (!project) {
      project = emptyProject(cwd, path.basename(cwd));
    }

    // Detect conventions on early sessions or periodically
    if (project.sessionCount <= 3 || Math.random() < 0.1) {
      project.conventions = detectConventions(cwd, project.conventions);
    }

    // Track tool stats if we have the pending tool info
    if (pending) {
      const { name, args } = pending;

      if (!project.tools[name]) {
        project.tools[name] = { name, invocations: 0, errors: 0 };
      }
      project.tools[name].invocations++;
      if (exitCode !== 0 && exitCode !== null) {
        project.tools[name].errors++;
      }

      // Extract file path from tool arguments
      const filePath = (args.path || args.file || args.directory || "") as string;
      if (filePath) {
        // Make path relative to cwd
        let relPath = filePath;
        if (filePath.startsWith(cwd)) {
          relPath = path.relative(cwd, filePath);
        }

        // Ensure file stats exist
        if (!project.files[relPath]) {
          project.files[relPath] = { reads: 0, edits: 0, errors: 0 };
        }

        const stats = project.files[relPath];

        // Update stats based on tool type
        switch (name) {
          case "read_file":
          case "grep":
          case "glob":
          case "ls":
            stats.reads++;
            break;
          case "edit_file":
          case "write_file":
            stats.edits++;
            stats.lastEditAt = new Date().toISOString();
            recordEdit(cwd, relPath);
            break;
          case "bash":
            // bash tool edits are harder to track — skip for now
            break;
        }

        // Track errors
        if (exitCode !== 0 && exitCode !== null) {
          stats.errors++;
        }
      }
    }

    saveProject(project);
  });

  // ── Update clusters on processing done ────────────────────────
  // When the agent finishes processing, extract edit clusters
  // from the current session's accumulated edits.

  bus.on("agent:processing-done", () => {
    const cwd = contextManager.getCwd();
    if (!cwd) return;

    const project = loadProject(cwd);
    if (!project) return;

    updateClusters(project, cwd);
    saveProject(project);

    // Clean up session edits for this cwd
    sessionEdits.delete(cwd);
  });

  // ── Inject project memory into system prompt ──────────────────
  // When building the system prompt, add project context if available.

  ctx.advise("system-prompt:build", (next) => {
    const base = next() as string;
    const cwd = contextManager.getCwd();
    if (!cwd) return base;

    const project = loadProject(cwd);
    if (!project) return base;

    // Only inject if there's enough data to be useful
    const totalEdits = Object.values(project.files).reduce((sum, f) => sum + f.edits, 0);
    const totalReads = Object.values(project.files).reduce((sum, f) => sum + f.reads, 0);
    if (totalEdits + totalReads < 5) return base;

    const context = formatProjectContext(project);
    return base + "\n\n" + context;
  });

  // ── Increment session count on first query ────────────────────
  // Each time the agent starts processing, increment the session
  // counter if this is the first interaction for this project.

  let sessionCounted = false;

  bus.on("agent:processing-start", () => {
    if (sessionCounted) return;
    sessionCounted = true;

    const cwd = contextManager.getCwd();
    if (!cwd) return;

    const project = loadProject(cwd);
    if (!project) return;

    project.sessionCount++;
    project.conventions = detectConventions(cwd, project.conventions);
    saveProject(project);
  });
}
