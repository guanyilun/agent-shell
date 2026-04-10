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
  /** Max agent query history entries to keep. Default 500. */
  historySize?: number;
}

const DEFAULTS: Required<Settings> = {
  extensions: [],
  historySize: 500,
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
