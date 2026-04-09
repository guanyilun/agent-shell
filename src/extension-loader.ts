import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionContext } from "./types.js";

/**
 * Load user/third-party extensions from two sources:
 * 1. CLI --extensions flag (comma-separated module paths)
 * 2. ~/.agent-shell/extensions/ directory (.js and .mjs files)
 *
 * Each extension module should export a default or named `activate` function
 * that receives an ExtensionContext.
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
      // Resolve relative paths from cwd, keep absolute paths as-is
      let resolved: string;
      if (extPath.startsWith(".")) {
        resolved = path.resolve(process.cwd(), extPath);
      } else if (path.isAbsolute(extPath)) {
        resolved = extPath;
      } else {
        // Bare specifier — let Node resolve (npm packages, etc.)
        resolved = extPath;
      }

      // file:// URL required for absolute paths with dynamic import
      const importPath = path.isAbsolute(resolved)
        ? `file://${resolved}`
        : resolved;

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
