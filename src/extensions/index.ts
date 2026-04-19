/**
 * Built-in extension manifest.
 *
 * These extensions ship with agent-sh and load before user extensions.
 * They receive unscoped contexts (not reloadable) and can be individually
 * disabled via the `disabledBuiltins` setting in ~/.agent-sh/settings.json.
 */
import type { ExtensionContext } from "../types.js";

type ActivateFn = (ctx: ExtensionContext) => void;

export const BUILTIN_EXTENSIONS: Array<{
  name: string;
  load: () => Promise<ActivateFn>;
}> = [
  { name: "agent-backend",    load: () => import("./agent-backend.js").then(m => m.default) },
  { name: "tui-renderer",     load: () => import("./tui-renderer.js").then(m => m.default) },
  { name: "slash-commands",    load: () => import("./slash-commands.js").then(m => m.default) },
  { name: "file-autocomplete", load: () => import("./file-autocomplete.js").then(m => m.default) },
  { name: "command-suggest",   load: () => import("./command-suggest.js").then(m => m.default) },
];

/**
 * Load built-in extensions sequentially, skipping any in the disabled list.
 * Returns the names of extensions that were loaded.
 */
export async function loadBuiltinExtensions(
  ctx: ExtensionContext,
  disabled: string[] = [],
): Promise<string[]> {
  const disabledSet = new Set(disabled);
  const loaded: string[] = [];
  for (const ext of BUILTIN_EXTENSIONS) {
    if (disabledSet.has(ext.name)) continue;
    const activate = await ext.load();
    activate(ctx);
    loaded.push(ext.name);
  }
  return loaded;
}
