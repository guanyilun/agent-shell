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

export interface Settings {
  /** Extensions to load (npm packages or file paths). */
  extensions?: string[];
  /** Max agent query history entries to keep. */
  historySize?: number;

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
  /** Max diff lines shown before "ctrl+o to expand". */
  diffMaxLines?: number;
}

const DEFAULTS: Required<Settings> = {
  extensions: [],
  historySize: 500,
  contextWindowSize: 20,
  contextBudget: 16384,
  shellTruncateThreshold: 10,
  shellHeadLines: 5,
  shellTailLines: 5,
  recallExpandMaxLines: 100,
  maxCommandOutputLines: 30,
  diffMaxLines: 20,
};

let cached: Settings | null = null;

/** Load settings from disk (cached after first call). */
export function getSettings(): Settings & typeof DEFAULTS {
  if (!cached) {
    try {
      const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
      cached = JSON.parse(raw) as Settings;
    } catch {
      cached = {};
    }
  }
  return { ...DEFAULTS, ...cached };
}

/** Reset cached settings (for testing or after external edit). */
export function reloadSettings(): void {
  cached = null;
}
