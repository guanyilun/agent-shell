import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "./types.js";
import type { EventBus } from "./event-bus.js";
import { CONFIG_DIR, getSettings } from "./settings.js";

const EXT_DIR = path.join(CONFIG_DIR, "extensions");

const TS_EXTS = [".ts", ".tsx", ".mts"];
const SCRIPT_EXTS = [".js", ".mjs", ".ts", ".tsx", ".mts"];

let tsRegistered = false;
let tsxUnregister: (() => Promise<void>) | null = null;

/**
 * Register tsx's ESM loader for .ts file support.
 *
 * Called before importing .ts extensions. The tsx loader uses Node's
 * module.register() which creates a background thread with a MessageChannel.
 * On reload, the old loader may become stale (the MessageChannel port can be
 * GC'd or the loader thread can stop responding), so we unregister the old
 * handle and re-register on each reload.
 *
 * Initial load: registers fresh.
 * Reload: unregisters old handle, registers new one.
 * Non-reload calls within the same load: no-op (tsRegistered guard).
 */
async function ensureTsSupport(force = false): Promise<void> {
  if (tsRegistered && !force) return;
  try {
    // Unregister previous loader if reloading
    if (tsxUnregister) {
      try { await tsxUnregister(); } catch { /* ignore stale handle */ }
    }
    const { register } = await import("tsx/esm/api");
    tsxUnregister = register();
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
function createScopedContext(ctx: ExtensionContext, extensionName: string): { scoped: ExtensionContext; dispose: () => void } {
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

  // Track instruction registrations — extension name captured in scope
  const scopedRegisterInstruction: typeof ctx.registerInstruction = (name, text) => {
    bus.emit("agent:register-instruction", { name, text, extensionName });
    cleanups.push(() => bus.emit("agent:remove-instruction", { name }));
  };

  // Track skill registrations — extension name captured in scope
  const scopedRegisterSkill: typeof ctx.registerSkill = (name, description, filePath) => {
    bus.emit("agent:register-skill", { name, description, filePath, extensionName });
    cleanups.push(() => bus.emit("agent:remove-skill", { name }));
  };

  // Track tool registrations — extension name captured in scope
  const scopedRegisterTool: typeof ctx.registerTool = (tool) => {
    bus.emit("agent:register-tool", { tool, extensionName });
    cleanups.push(() => bus.emit("agent:unregister-tool", { name: tool.name }));
  };

  // Track slash command registrations — without this, reloading an
  // extension stacks its commands (old `/status` + new `/status`) in
  // the slash-commands registry.
  const scopedRegisterCommand: typeof ctx.registerCommand = (name, description, handler) => {
    ctx.registerCommand(name, description, handler);
    cleanups.push(() => bus.emit("command:unregister", { name }));
  };

  const scoped: ExtensionContext = {
    ...ctx,
    bus: scopedBus,
    advise: scopedAdvise,
    registerInstruction: scopedRegisterInstruction,
    removeInstruction: ctx.removeInstruction,
    registerSkill: scopedRegisterSkill,
    removeSkill: ctx.removeSkill,
    registerTool: scopedRegisterTool,
    unregisterTool: ctx.unregisterTool,
    registerCommand: scopedRegisterCommand,
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
  const disabled = new Set(getSettings().disabledExtensions ?? []);
  try {
    const entries = await fs.readdir(EXT_DIR, { withFileTypes: true });
    for (const entry of entries) {
      // Disable check: directory name for dir-extensions, or basename sans
      // extension for file-extensions. Lets settings.json turn one off
      // without renaming it.
      const nameForDisable = entry.name.replace(/\.[^.]+$/, "");
      if (disabled.has(nameForDisable)) continue;

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
        await ensureTsSupport(bustCache);
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

        // Scoped context so /reload can tear user extensions down.
        // Awaiting activate() lets extensions with async setup (e.g.
        // openrouter fetching its model catalog) finish before we move
        // on; a 10s outer timeout in index.ts guards against hangs.
        if (userSet.has(specifier)) {
          // Dispose previous load if reloading
          extensionDisposers.get(name)?.();

          const { scoped, dispose } = createScopedContext(ctx, name);
          await activate(scoped);
          extensionDisposers.set(name, dispose);
        } else {
          const { scoped, dispose } = createScopedContext(ctx, name);
          await activate(scoped);
          // Non-user extensions aren't reloadable, but track for cleanup on shutdown
          extensionDisposers.set(name, dispose);
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
    // Distinguish bare npm specifier from a relative path lacking "./".
    // Scoped packages ("@scope/pkg") contain "/" but are npm specifiers,
    // so the "@" prefix takes precedence over the "/" heuristic.
    if (specifier.includes("/") && !specifier.startsWith("@")) {
      // Treat as relative path from cwd
      resolved = path.resolve(process.cwd(), specifier);
    } else {
      // Bare specifier — npm package (including @scope/pkg)
      return specifier;
    }
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
