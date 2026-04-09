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

/**
 * Load user/third-party extensions from three sources:
 * 1. CLI --extensions flag (short names, paths, or npm packages)
 * 2. ~/.agent-shell/extensions/ directory (.js and .mjs files)
 *
 * Short names (e.g. "interactive-prompts") resolve to built-in
 * extensions bundled with agent-shell. This is the equivalent of
 * pi's `-e module` flag.
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
      if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
        paths.push(path.join(extDir, entry));
      }
    }
  } catch {
    // Directory doesn't exist — no user extensions
  }

  // 3. Load each extension
  for (const extPath of paths) {
    try {
      const importPath = await resolveExtension(extPath);
      const mod = await import(importPath);
      const activate = mod.default ?? mod.activate;
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
 * 1. Built-in short name (e.g. "interactive-prompts" → dist/extensions/interactive-prompts.js)
 * 2. Relative path from cwd (starts with ".")
 * 3. Absolute path
 * 4. Bare specifier (npm package — let Node resolve)
 */
async function resolveExtension(specifier: string): Promise<string> {
  // Check if it's a built-in short name (no slashes, no extension)
  if (!specifier.includes("/") && !specifier.includes("\\") && !specifier.endsWith(".js") && !specifier.endsWith(".mjs")) {
    const builtinPath = path.join(BUILTIN_DIR, `${specifier}.js`);
    try {
      await fs.access(builtinPath);
      return `file://${builtinPath}`;
    } catch {
      // Not a built-in — fall through
    }
  }

  if (specifier.startsWith(".")) {
    return `file://${path.resolve(process.cwd(), specifier)}`;
  }

  if (path.isAbsolute(specifier)) {
    return `file://${specifier}`;
  }

  // Bare specifier — let Node resolve (npm packages, etc.)
  return specifier;
}
