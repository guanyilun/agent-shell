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

/** Per-model capability overrides. */
export interface ModelCapabilityConfig {
  /** Model identifier. */
  id: string;
  /** Whether the model supports reasoning/thinking tokens. */
  reasoning?: boolean;
  /** Context window size in tokens for this specific model. */
  contextWindow?: number;
}

/** Provider profile — a named LLM configuration. */
export interface ProviderConfig {
  /** API key (supports $ENV_VAR syntax for runtime expansion). */
  apiKey?: string;
  /** Base URL for OpenAI-compatible API. */
  baseURL?: string;
  /** Default model to use. Falls back to first entry in models list. */
  defaultModel?: string;
  /** Models available for cycling. Plain strings or objects with capabilities. */
  models?: (string | ModelCapabilityConfig)[];
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
  /** Fraction of content budget allocated to shell context (0-1, default 0.35). */
  shellContextRatio?: number;

  // ── History ──────────────────────────────────────────────
  /** Max history file size in bytes (default: 102400 = 100KB). */
  historyMaxBytes?: number;
  /** Number of prior history entries to load on startup (default: 50). */
  historyStartupEntries?: number;
  /** Max nuclear entries kept in-context before flushing to history file (default: 200). */
  nuclearMaxEntries?: number;
  /** Auto-compact threshold as fraction of conversation budget (0-1, default 0.5). */
  autoCompactThreshold?: number;

  // ── Display ───────────────────────────────────────────────
  /** Max command output lines shown inline in TUI. */
  maxCommandOutputLines?: number;
  /** Max read tool output lines shown inline in TUI (0 = hide). */
  readOutputMaxLines?: number;
  /** Max diff lines shown before "ctrl+o to expand". */
  diffMaxLines?: number;

  // ── Agent integration ─────────────────────────────────────
  /** Tool protocol: "api" (all tools), "deferred" (extensions via meta-tool), "inline" (text). */
  toolMode?: "api" | "deferred" | "inline";
  /** Additional directories to scan for skills (supports ~ expansion). */
  skillPaths?: string[];

  // ── Identity & startup ───────────────────────────────────
  /** Show a startup banner when agent-sh launches. */
  startupBanner?: boolean;
  /** Show a subtle agent-sh indicator in the shell prompt. */
  promptIndicator?: boolean;

  // ── Built-in extensions ──────────────────────────────────
  /** Names of built-in extensions to disable (e.g. ["command-suggest"]). */
  disabledBuiltins?: string[];
}

const DEFAULTS: Required<Settings> = {
  extensions: [],
  historySize: 500,
  providers: {},
  defaultProvider: undefined as any,
  defaultBackend: "ash",
  toolMode: "api" as "api" | "deferred" | "inline",
  contextWindowSize: 20,
  contextBudget: 16384,
  shellTruncateThreshold: 10,
  shellHeadLines: 5,
  shellTailLines: 5,
  recallExpandMaxLines: 100,
  shellContextRatio: 0.35,
  historyMaxBytes: 102400,
  historyStartupEntries: 50,
  nuclearMaxEntries: 200,
  autoCompactThreshold: 0.5,
  maxCommandOutputLines: 3,
  readOutputMaxLines: 10,
  diffMaxLines: Infinity,
  skillPaths: [],
  startupBanner: true,
  promptIndicator: true,
  disabledBuiltins: [],
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
  /** Provider supports the reasoning_effort parameter. Default: true. */
  supportsReasoningEffort?: boolean;
  /** Per-model capabilities, keyed by model id. */
  modelCapabilities?: Map<string, { reasoning?: boolean; contextWindow?: number }>;
}

/**
 * Resolve a provider config by name from settings.
 * Returns null if provider not found.
 */
export function resolveProvider(name: string): ResolvedProvider | null {
  const settings = getSettings();
  const provider = settings.providers?.[name];
  if (!provider) return null;

  const rawModels = provider.models ?? (provider.defaultModel ? [provider.defaultModel] : []);
  const modelIds: string[] = [];
  const caps = new Map<string, { reasoning?: boolean; contextWindow?: number }>();
  for (const m of rawModels) {
    if (typeof m === "string") {
      modelIds.push(m);
    } else {
      modelIds.push(m.id);
      if (m.reasoning !== undefined || m.contextWindow !== undefined) {
        caps.set(m.id, { reasoning: m.reasoning, contextWindow: m.contextWindow });
      }
    }
  }

  const defaultModel = provider.defaultModel ?? modelIds[0];

  return {
    id: name,
    apiKey: provider.apiKey ? expandEnvVars(provider.apiKey) : undefined,
    baseURL: provider.baseURL,
    defaultModel,
    models: modelIds.length ? modelIds : (defaultModel ? [defaultModel] : []),
    contextWindow: provider.contextWindow,
    modelCapabilities: caps.size > 0 ? caps : undefined,
  };
}

/** Get all configured provider names. */
export function getProviderNames(): string[] {
  const settings = getSettings();
  return Object.keys(settings.providers ?? {});
}
