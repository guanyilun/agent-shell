/**
 * OpenRouter provider extension.
 *
 * Registers OpenRouter as a provider and fetches its full model catalog
 * at startup. Models appear in /model autocomplete as "model [openrouter]"
 * and are available for cycling with Shift+Tab.
 *
 * Model capabilities (reasoning, context window) are read from the
 * OpenRouter API response — no hardcoded model lists.
 *
 * Setup:
 *   export OPENROUTER_API_KEY="your-key"
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/openrouter.ts
 *
 *   # Or add to settings.json:
 *   { "extensions": ["./examples/extensions/openrouter.ts"] }
 */
import type { ExtensionContext } from "agent-sh/types";

const BASE_URL = "https://openrouter.ai/api/v1";
const API_KEY = process.env.OPENROUTER_API_KEY ?? "";

/** Curated default models — used immediately while the full catalog loads. */
const DEFAULT_MODELS = [
  "anthropic/claude-sonnet-4",
  "google/gemini-2.5-pro-preview",
  "openai/gpt-4.1",
  "deepseek/deepseek-r1",
  "meta-llama/llama-4-maverick",
];

interface OpenRouterModel {
  id: string;
  name: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt: string; completion: string };
}

export default function activate({ bus }: ExtensionContext): void {
  if (!API_KEY) {
    bus.emit("ui:error", {
      message: "OpenRouter extension: OPENROUTER_API_KEY not set. Skipping.",
    });
    return;
  }

  // Register provider immediately with curated defaults
  bus.emit("provider:register", {
    id: "openrouter",
    apiKey: API_KEY,
    baseURL: BASE_URL,
    defaultModel: DEFAULT_MODELS[0],
    models: DEFAULT_MODELS,
  });

  // Fetch full model catalog in background, re-register with capabilities
  fetchModels().then((models) => {
    if (models.length > 0) {
      bus.emit("provider:register", {
        id: "openrouter",
        apiKey: API_KEY,
        baseURL: BASE_URL,
        defaultModel: DEFAULT_MODELS[0],
        supportsReasoningEffort: true,
        models: models.map((m) => ({
          id: m.id,
          reasoning: m.supported_parameters?.includes("reasoning") ?? false,
          contextWindow: m.context_length,
        })),
      });
    }
  }).catch(() => {
    // Silently fall back to curated defaults
  });
}

async function fetchModels(): Promise<OpenRouterModel[]> {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data ?? []) as OpenRouterModel[];
}
