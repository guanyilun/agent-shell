import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "./types.js";
import type { EventBus } from "./event-bus.js";
import { CONFIG_DIR, getSettings } from "./settings.js";

const EXT_DIR = path.join(CONFIG_DIR, "extensions");

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

// ── Scoped context for reloadable extensions ────────────────────

type Cleanup = () => void;

/**
 * Wrap an ExtensionContext to track all registrations (bus.on, bus.onPipe,
 * advise, command:register). Returns the wrapped context and a dispose()
 * function that tears down everything registered through it.
 */
function createScopedContext(ctx: ExtensionContext): { scoped: ExtensionContext; dispose: () => void } {
  const cleanups: Cleanup[] = [];
  const bus = ctx.bus;

  const scopedBus: EventBus = Object.create(bus);

  // Track bus.on registrations
  scopedBus.on = ((event: any, fn: any) => {
    bus.on(event, fn);
    cleanups.push(() => bus.off(event, fn));
  }) as typeof bus.on;

  // Track bus.onPipe registrations
  scopedBus.onPipe = ((event: any, fn: any) => {
    bus.onPipe(event, fn);
    cleanups.push(() => bus.offPipe(event, fn));
  }) as typeof bus.onPipe;

  // Track advise registrations
  const scopedAdvise: typeof ctx.advise = (name, wrapper) => {
    const unadvise = ctx.advise(name, wrapper);
    cleanups.push(unadvise);
    return unadvise;
  };

  // Track instruction registrations
  const scopedRegisterInstruction: typeof ctx.registerInstruction = (name, text) => {
    ctx.registerInstruction(name, text);
    cleanups.push(() => ctx.removeInstruction(name));
  };

  // Track tool registrations
  const scopedRegisterTool: typeof ctx.registerTool = (tool) => {
    ctx.registerTool(tool);
    cleanups.push(() => ctx.unregisterTool(tool.name));
  };

  const scoped: ExtensionContext = {
    ...ctx,
    bus: scopedBus,
    advise: scopedAdvise,
    registerInstruction: scopedRegisterInstruction,
    removeInstruction: ctx.removeInstruction,
    registerTool: scopedRegisterTool,
    unregisterTool: ctx.unregisterTool,
  };

  const dispose = () => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* ignore */ }
    }
    cleanups.length = 0;
  };

  return { scoped, dispose };
}

// Track disposers for user extensions so reload can tear them down
const extensionDisposers = new Map<string, () => void>();


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
): Promise<string[]> {
  const specifiers: string[] = [];

  // 1. CLI -e / --extensions
  if (cliExtensions) {
    specifiers.push(...cliExtensions);
  }

  // 2. settings.json
  const settings = getSettings();
  if (settings.extensions.length > 0) {
    specifiers.push(...settings.extensions);
  }

  // 3. ~/.agent-sh/extensions/ directory
  const userSpecifiers = await discoverUserExtensions();
  specifiers.push(...userSpecifiers);

  // Deduplicate
  const seen = new Set<string>();
  const unique = specifiers.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  // Load each extension (user extensions get scoped contexts for reloadability)
  const loaded = await loadSpecifiers(unique, ctx, false, userSpecifiers);
  return loaded;
}

async function discoverUserExtensions(): Promise<string[]> {
  const specifiers: string[] = [];
  try {
    const entries = await fs.readdir(EXT_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(EXT_DIR, entry.name);
      const isDir = entry.isDirectory() ||
        (entry.isSymbolicLink() && (await fs.stat(fullPath)).isDirectory());
      if (isDir) {
        const indexFile = await findIndex(fullPath);
        if (indexFile) specifiers.push(indexFile);
      } else if (SCRIPT_EXTS.some((ext) => entry.name.endsWith(ext))) {
        specifiers.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist — no user extensions
  }
  return specifiers;
}

async function loadSpecifiers(
  specifiers: string[],
  ctx: ExtensionContext,
  bustCache: boolean,
  userSpecifiers?: string[],
): Promise<string[]> {
  const userSet = new Set(userSpecifiers ?? []);
  const loaded: string[] = [];
  for (const specifier of specifiers) {
    try {
      let importPath = await resolveSpecifier(specifier);

      if (TS_EXTS.some((ext) => importPath.endsWith(ext))) {
        await ensureTsSupport();
      }
      // Append timestamp query to bust Node's module cache on reload
      if (bustCache) {
        const sep = importPath.includes("?") ? "&" : "?";
        importPath += `${sep}t=${Date.now()}`;
      }
      const mod = await import(importPath);
      // tsx may double-wrap default exports: mod.default.default
      const activate = typeof mod.default === "function"
        ? mod.default
        : typeof mod.default?.default === "function"
          ? mod.default.default
          : mod.activate;
      if (typeof activate === "function") {
        const base = path.basename(specifier).replace(/\.(ts|js|mjs|mts|tsx)$/, "");
        const name = base === "index" ? path.basename(path.dirname(specifier)) : base;

        // User extensions get a scoped context so /reload can tear them down
        if (userSet.has(specifier)) {
          // Dispose previous load if reloading
          extensionDisposers.get(name)?.();

          const { scoped, dispose } = createScopedContext(ctx);
          activate(scoped);
          extensionDisposers.set(name, dispose);
        } else {
          activate(ctx);
        }
        loaded.push(name);
      }
    } catch (err) {
      ctx.bus.emit("ui:error", {
        message: `Failed to load extension ${specifier}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return loaded;
}

/**
 * Reload user extensions (from ~/.agent-sh/extensions/).
 * Tears down old registrations, busts the module cache, and re-activates.
 */
export async function reloadExtensions(ctx: ExtensionContext): Promise<string[]> {
  const specifiers = await discoverUserExtensions();
  return loadSpecifiers(specifiers, ctx, true, specifiers);
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
