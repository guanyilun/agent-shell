/**
 * User settings loaded from ~/.agent-sh/settings.json.
 *
 * Settings are loaded once at startup and available synchronously
 * throughout the app. Unknown keys are preserved on write.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const CONFIG_DIR = path.join(os.homedir(), ".agent-sh");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");

/** Provider profile — a named LLM configuration. */
export interface ProviderConfig {
  /** API key (supports $ENV_VAR syntax for runtime expansion). */
  apiKey?: string;
  /** Base URL for OpenAI-compatible API. */
  baseURL?: string;
  /** Default model to use. Falls back to first entry in models list. */
  defaultModel?: string;
  /** Models available for cycling. */
  models?: string[];
  /** Context window size in tokens (e.g. 128000). Used for usage display. */
  contextWindow?: number;
}

export interface Settings {
  /** Extensions to load (npm packages or file paths). */
  extensions?: string[];
  /** Max agent query history entries to keep. */
  historySize?: number;

  // ── Provider profiles ─────────────────────────────────────
  /** Named provider configurations. */
  providers?: Record<string, ProviderConfig>;
  /** Which provider to use by default. */
  defaultProvider?: string;
  /** Preferred agent backend (extension name, e.g. "pi", "claude-code"). */
  defaultBackend?: string;

  // ── Context & truncation ──────────────────────────────────
  /** Recent exchanges included in agent context window. */
  contextWindowSize?: number;
  /** Context budget in bytes (~4 chars per token). */
  contextBudget?: number;
  /** Shell output lines before truncation kicks in. */
  shellTruncateThreshold?: number;
  /** Lines kept from start of truncated shell output. */
  shellHeadLines?: number;
  /** Lines kept from end of truncated shell output. */
  shellTailLines?: number;
  /** Max lines for recall expand before requiring line ranges. */
  recallExpandMaxLines?: number;

  // ── Display ───────────────────────────────────────────────
  /** Max command output lines shown inline in TUI. */
  maxCommandOutputLines?: number;
  /** Max read tool output lines shown inline in TUI (0 = hide). */
  readOutputMaxLines?: number;
  /** Max diff lines shown before "ctrl+o to expand". */
  diffMaxLines?: number;

  // ── Agent integration ─────────────────────────────────────
  /** Additional directories to scan for skills (supports ~ expansion). */
  skillPaths?: string[];
}

const DEFAULTS: Required<Settings> = {
  extensions: [],
  historySize: 500,
  providers: {},
  defaultProvider: undefined as any,
  defaultBackend: "agent-sh",
  contextWindowSize: 20,
  contextBudget: 16384,
  shellTruncateThreshold: 10,
  shellHeadLines: 5,
  shellTailLines: 5,
  recallExpandMaxLines: 100,
  maxCommandOutputLines: 3,
  readOutputMaxLines: 0,
  diffMaxLines: 20,
  skillPaths: [],
};

let cached: Settings | null = null;

/** Load settings from disk (cached after first call). */
export function getSettings(): Settings & typeof DEFAULTS {
  if (!cached) {
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
      cached = JSON.parse(raw) as Settings;
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error(`[agent-sh] Warning: invalid JSON in ${SETTINGS_PATH}: ${err.message}`);
      }
      cached = {};
    }
  }
  return { ...DEFAULTS, ...cached };
}

/**
 * Get settings for an extension, namespaced under its key in settings.json.
 *
 * Example settings.json:
 *   { "latex-images": { "dpi": 600, "fgColor": "ffffff" } }
 *
 * Usage in extension:
 *   const config = getExtensionSettings("latex-images", { dpi: 300, fgColor: "d4d4d4" });
 *   // config.dpi === 600 (overridden), config.fgColor === "ffffff" (overridden)
 */
export function getExtensionSettings<T extends Record<string, unknown>>(
  namespace: string,
  defaults: T,
): T {
  const all = getSettings() as unknown as Record<string, unknown>;
  const ext = all[namespace];
  if (ext && typeof ext === "object" && !Array.isArray(ext)) {
    return { ...defaults, ...(ext as Partial<T>) };
  }
  return defaults;
}

/** Reset cached settings (for testing or after external edit). */
export function reloadSettings(): void {
  cached = null;
}

/**
 * Expand $ENV_VAR references in a string.
 * Supports $VAR and ${VAR} syntax.
 */
export function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, plain) => {
    const name = braced || plain;
    return process.env[name] ?? "";
  });
}

/** Resolved provider ready for use (env vars expanded, defaults applied). */
export interface ResolvedProvider {
  id: string;
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  models: string[];
  contextWindow?: number;
}

/**
 * Resolve a provider config by name from settings.
 * Returns null if provider not found.
 */
export function resolveProvider(name: string): ResolvedProvider | null {
  const settings = getSettings();
  const provider = settings.providers?.[name];
  if (!provider) return null;

  const models = provider.models ?? (provider.defaultModel ? [provider.defaultModel] : []);
  const defaultModel = provider.defaultModel ?? models[0];

  return {
    id: name,
    apiKey: provider.apiKey ? expandEnvVars(provider.apiKey) : undefined,
    baseURL: provider.baseURL,
    defaultModel,
    models: models.length ? models : (defaultModel ? [defaultModel] : []),
    contextWindow: provider.contextWindow,
  };
}

/** Get all configured provider names. */
export function getProviderNames(): string[] {
  const settings = getSettings();
  return Object.keys(settings.providers ?? {});
}
