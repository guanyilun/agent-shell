import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "./types.js";

// Built-in extensions that can be loaded by short name via --extensions
const BUILTIN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "extensions",
);

const TS_EXTS = [".ts", ".tsx", ".mts"];
const ALL_EXTS = [".js", ".mjs", ".ts", ".tsx", ".mts"];

let tsRegistered = false;

/**
 * Register tsx so that .ts/.tsx extensions can be loaded via import().
 * Called lazily on first TS extension encountered.
 */
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

/**
 * Load user/third-party extensions from two sources:
 * 1. CLI --extensions flag (npm packages, short names, or file paths)
 * 2. ~/.agent-shell/extensions/ directory (.js, .mjs, .ts files)
 *
 * Resolution for bare names (e.g. "interactive-prompts"):
 *   - First tries as an npm package (import("interactive-prompts"))
 *   - Falls back to built-in extension in dist/extensions/
 *
 * Each extension module should export a default or named `activate`
 * function that receives an ExtensionContext.
 *
 * Errors are non-fatal — logged via ui:error and skipped.
 */
export async function loadExtensions(
  ctx: ExtensionContext,
  extensionPaths?: string[],
): Promise<void> {
  const paths: string[] = [];

  // 1. CLI-specified extensions
  if (extensionPaths) {
    paths.push(...extensionPaths);
  }

  // 2. Directory-based discovery
  const extDir = path.join(os.homedir(), ".agent-shell", "extensions");
  try {
    const entries = await fs.readdir(extDir);
    for (const entry of entries) {
      if (ALL_EXTS.some((ext) => entry.endsWith(ext))) {
        paths.push(path.join(extDir, entry));
      }
    }
  } catch {
    // Directory doesn't exist — no user extensions
  }

  // 3. Load each extension
  for (const extPath of paths) {
    try {
      // Enable TS support if any TS extension is encountered
      if (TS_EXTS.some((ext) => extPath.endsWith(ext))) {
        await ensureTsSupport();
      }

      const importPath = await resolveExtension(extPath);
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
        message: `Failed to load extension ${extPath}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

/**
 * Resolve an extension specifier to an importable path.
 *
 * Resolution order:
 * 1. File path (relative from cwd or absolute)
 * 2. Bare name → npm package (let Node resolve)
 * 3. Bare name → built-in extension (dist/extensions/<name>.js)
 */
async function resolveExtension(specifier: string): Promise<string> {
  // Explicit file paths
  if (specifier.startsWith(".")) {
    return `file://${path.resolve(process.cwd(), specifier)}`;
  }
  if (path.isAbsolute(specifier)) {
    return `file://${specifier}`;
  }

  // Bare name — could be an npm package or a built-in short name
  const isBareShortName = !specifier.includes("/") && !specifier.includes("\\")
    && !ALL_EXTS.some((ext) => specifier.endsWith(ext));

  if (isBareShortName) {
    // Try npm package first
    try {
      await import.meta.resolve?.(specifier);
      return specifier;
    } catch {
      // Not an installed package — try built-in
    }

    // Fall back to built-in extension
    const builtinPath = path.join(BUILTIN_DIR, `${specifier}.js`);
    try {
      await fs.access(builtinPath);
      return `file://${builtinPath}`;
    } catch {
      // Not a built-in either — let it fail naturally below
    }
  }

  // Let Node try to resolve it (npm package with subpath, etc.)
  return specifier;
}
