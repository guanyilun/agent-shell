import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionContext } from "./types.js";

const CONFIG_DIR = path.join(os.homedir(), ".agent-sh");
const EXT_DIR = path.join(CONFIG_DIR, "extensions");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");

const TS_EXTS = [".ts", ".tsx", ".mts"];
const SCRIPT_EXTS = [".js", ".mjs", ".ts", ".tsx", ".mts"];

let tsRegistered = false;

async function ensureTsSupport(): Promise<void> {
  if (tsRegistered) return;
  try {
    const { register } = await import("tsx/esm/api");
    register();
    tsRegistered = true;
  } catch {
    // tsx not available — TS extensions will fail with a clear error
  }
}

interface Settings {
  extensions?: string[];
}

async function loadSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    return JSON.parse(raw) as Settings;
  } catch {
    return {};
  }
}

/**
 * Load extensions from three sources (merged, deduplicated):
 *
 * 1. CLI flags: -e / --extensions (npm packages or file paths)
 * 2. settings.json: ~/.agent-sh/settings.json → extensions[]
 * 3. Extensions dir: ~/.agent-sh/extensions/ (files and directories with index.{ts,js})
 *
 * Extension specifiers resolve as:
 *   - File path (relative or absolute) → import directly
 *   - Bare name → npm package (Node resolution)
 *
 * Each module should export a default or named `activate(ctx)` function.
 * Errors are non-fatal — logged via ui:error and skipped.
 */
export async function loadExtensions(
  ctx: ExtensionContext,
  cliExtensions?: string[],
): Promise<void> {
  const specifiers: string[] = [];

  // 1. CLI -e / --extensions
  if (cliExtensions) {
    specifiers.push(...cliExtensions);
  }

  // 2. settings.json
  const settings = await loadSettings();
  if (settings.extensions) {
    specifiers.push(...settings.extensions);
  }

  // 3. ~/.agent-sh/extensions/ directory
  try {
    const entries = await fs.readdir(EXT_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(EXT_DIR, entry.name);
      if (entry.isDirectory()) {
        // Directory extension: look for index.{ts,js,mjs,...}
        const indexFile = await findIndex(fullPath);
        if (indexFile) {
          specifiers.push(indexFile);
        }
      } else if (SCRIPT_EXTS.some((ext) => entry.name.endsWith(ext))) {
        specifiers.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist — no user extensions
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = specifiers.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  // Load each extension
  for (const specifier of unique) {
    try {
      const importPath = await resolveSpecifier(specifier);

      if (TS_EXTS.some((ext) => importPath.endsWith(ext))) {
        await ensureTsSupport();
      }
      const mod = await import(importPath);
      // tsx may double-wrap default exports: mod.default.default
      const activate = typeof mod.default === "function"
        ? mod.default
        : typeof mod.default?.default === "function"
          ? mod.default.default
          : mod.activate;
      if (typeof activate === "function") {
        activate(ctx);
      }
    } catch (err) {
      ctx.bus.emit("ui:error", {
        message: `Failed to load extension ${specifier}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

/**
 * Find an index file in a directory extension.
 */
async function findIndex(dir: string): Promise<string | null> {
  for (const ext of SCRIPT_EXTS) {
    const candidate = path.join(dir, `index${ext}`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Resolve a specifier to an importable string.
 *
 * - Relative path (starts with ".") → resolve from cwd, file:// URL
 * - Absolute path → file:// URL (directories resolved to index file)
 * - Bare name → npm package (let Node resolve)
 */
async function resolveSpecifier(specifier: string): Promise<string> {
  let resolved: string;

  if (specifier.startsWith(".")) {
    resolved = path.resolve(process.cwd(), specifier);
  } else if (path.isAbsolute(specifier)) {
    resolved = specifier;
  } else {
    // Bare specifier — npm package
    return specifier;
  }

  // If it's a directory, find the index file
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      const indexFile = await findIndex(resolved);
      if (indexFile) {
        return `file://${indexFile}`;
      }
      throw new Error(`No index file found in ${resolved}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Not a directory, treat as file
    } else if (err instanceof Error && err.message.startsWith("No index")) {
      throw err;
    }
  }

  return `file://${resolved}`;
}
