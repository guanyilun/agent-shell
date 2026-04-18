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
  /** Auto-compact threshold as fraction of conversation budget (0-1, default 0.5). */
  autoCompactThreshold?: number;

  // ── Display ───────────────────────────────────────────────
  /** Max command output lines shown inline in TUI. */
  maxCommandOutputLines?: number;
  /** Max read tool output lines shown inline in TUI (0 = hide). */
  readOutputMaxLines?: number;
  /** Max diff lines rendered in the TUI (Infinity = no limit). */
  diffMaxLines?: number;

  // ── Agent integration ─────────────────────────────────────
  /** Tool protocol:
   *   "api" — all tools sent with full schema.
   *   "deferred" — extensions dispatched through `use_extension(name, args)` meta-tool.
   *   "deferred-lookup" — extensions loaded on demand via `load_tool(names[])`; once loaded, callable as first-class tools.
   *   "inline" — tools described as text.
   */
  toolMode?: "api" | "deferred" | "deferred-lookup" | "inline";
  /** Additional directories to scan for skills (supports ~ expansion). */
  skillPaths?: string[];
  /**
   * Enable the "diagnose" tool — lets the agent evaluate JavaScript
   * expressions against its own runtime state. Powerful for introspection
   * (e.g. this.conversation.turns.length) but grants arbitrary code
   * execution within the agent process. Off by default because the
   * agent already has unrestricted bash access — this is a convenience,
   * not a new capability.
   */
  diagnose?: boolean;

  // ── Identity & startup ───────────────────────────────────
  /** Show a startup banner when agent-sh launches. */
  startupBanner?: boolean;
  /** Show a subtle agent-sh indicator in the shell prompt. */
  promptIndicator?: boolean;

  // ── Built-in extensions ──────────────────────────────────
  /** Names of built-in extensions to disable (e.g. ["command-suggest"]). */
  disabledBuiltins?: string[];

  /**
   * Names of user extensions in ~/.agent-sh/extensions/ to skip when
   * auto-discovering. Match by basename without extension for files
   * (e.g. "peer-mesh" matches peer-mesh.ts), or by directory name for
   * directory-style extensions (e.g. "superash" matches superash/index.ts).
   * Beats having to rename files to .disabled every time.
   */
  disabledExtensions?: string[];
}

const DEFAULTS: Required<Settings> = {
  extensions: [],
  historySize: 500,
  providers: {},
  defaultProvider: undefined as unknown as string,
  defaultBackend: "ash",
  toolMode: "api" as "api" | "deferred" | "deferred-lookup" | "inline",
  contextWindowSize: 20,
  contextBudget: 32768,
  shellTruncateThreshold: 20,
  shellHeadLines: 10,
  shellTailLines: 10,
  recallExpandMaxLines: 500,
  shellContextRatio: 0.35,
  historyMaxBytes: 104857600, // 100MB — history is only accessed via search/expand, never loaded wholesale
  historyStartupEntries: 100,
  autoCompactThreshold: 0.5,
  maxCommandOutputLines: 3,
  readOutputMaxLines: 10,
  diffMaxLines: Infinity,
  skillPaths: [],
  diagnose: false,
  startupBanner: true,
  promptIndicator: true,
  disabledBuiltins: [],
  disabledExtensions: [],
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
 * Deep-merge a patch into ~/.agent-sh/settings.json on disk.
 *
 * Reads the raw file (preserving unknown keys), merges the patch, writes back
 * with 2-space indentation, and clears the cache so subsequent getSettings()
 * calls see the new values.
 *
 * Used by runtime controls (`/model`, `/backend`) that want their selection
 * to persist as the default across restarts.
 */
export function updateSettings(patch: Record<string, unknown>): void {
  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // file missing or unreadable — start fresh
  }

  const merged = deepMerge(existing, patch);

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
    cached = null;
  } catch (err) {
    console.error(`[agent-sh] Warning: failed to update ${SETTINGS_PATH}: ${(err as Error).message}`);
  }
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, val] of Object.entries(source)) {
    const existing = out[key];
    if (
      val !== null && typeof val === "object" && !Array.isArray(val) &&
      existing !== null && typeof existing === "object" && !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      out[key] = val;
    }
  }
  return out;
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
