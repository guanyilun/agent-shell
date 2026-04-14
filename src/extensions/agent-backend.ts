/**
 * Built-in agent backend extension.
 *
 * Owns the full LLM lifecycle:
 *   1. Resolves providers from settings + CLI config
 *   2. Creates and manages the LlmClient
 *   3. Builds mode list for model cycling
 *   4. Creates AgentLoop and registers it as the "ash" backend
 *   5. Handles runtime provider switching and provider registration
 *   6. Exposes llm:get-client handler for other extensions (e.g. command-suggest)
 */
import type { ExtensionContext } from "../types.js";
import type { AgentMode, AgentShellConfig } from "../types.js";
import { AgentLoop } from "../agent/agent-loop.js";
import { LlmClient } from "../utils/llm-client.js";
import { resolveProvider, getProviderNames, getSettings, type ResolvedProvider } from "../settings.js";

export default function agentBackend(ctx: ExtensionContext): void {
  const { bus } = ctx;

  // ── Resolve providers ──────────────────────────────────────
  const config: AgentShellConfig = ctx.call("config:get-shell-config") ?? {};
  const settings = getSettings();

  let activeProvider: ResolvedProvider | null = null;
  const providerRegistry = new Map<string, ResolvedProvider>();

  for (const name of getProviderNames()) {
    const p = resolveProvider(name);
    if (p) providerRegistry.set(name, p);
  }

  const providerName = config.provider ?? settings.defaultProvider;
  if (providerName) {
    activeProvider = providerRegistry.get(providerName) ?? null;
  }

  // ── Build modes ────────────────────────────────────────────
  const buildModes = (): AgentMode[] => {
    const allModes: AgentMode[] = [];
    for (const [id, p] of providerRegistry) {
      if (!p.apiKey) continue;
      for (const model of p.models) {
        const mc = p.modelCapabilities?.get(model);
        allModes.push({
          model,
          provider: id,
          providerConfig: { apiKey: p.apiKey, baseURL: p.baseURL },
          contextWindow: mc?.contextWindow ?? p.contextWindow,
          reasoning: mc?.reasoning,
          supportsReasoningEffort: p.supportsReasoningEffort,
        });
      }
    }
    return allModes;
  };

  const effectiveApiKey = config.apiKey ?? activeProvider?.apiKey;
  const effectiveBaseURL = config.baseURL ?? activeProvider?.baseURL;
  const effectiveModel = config.model ?? activeProvider?.defaultModel;

  let modes = buildModes();
  if (modes.length === 0 && effectiveApiKey && effectiveModel) {
    modes = [{ model: effectiveModel }];
  }

  const initialModeIndex = Math.max(0, modes.findIndex(
    (m) => m.model === effectiveModel && (!activeProvider || m.provider === activeProvider.id),
  ));

  // ── Create LLM client ─────────────────────────────────────
  if (!effectiveApiKey) return; // No LLM provider configured — skip

  if (!effectiveModel) {
    bus.emit("ui:error", { message: "No model specified. Use --model or configure a provider with defaultModel in ~/.agent-sh/settings.json" });
    return;
  }

  const llmClient = new LlmClient({
    apiKey: effectiveApiKey,
    baseURL: effectiveBaseURL,
    model: effectiveModel,
  });

  // Expose LLM client for other extensions (e.g. command-suggest)
  ctx.define("llm:get-client", () => llmClient);

  // ── Initial modes (queryable via pipe) ─────────────────────
  bus.onPipe("config:get-initial-modes", () => ({
    modes,
    initialModeIndex,
  }));

  // ── Create agent loop ──────────────────────────────────────
  const agentLoop = new AgentLoop({
    bus,
    contextManager: ctx.contextManager,
    llmClient,
    handlers: { define: ctx.define, advise: ctx.advise, call: ctx.call },
    modes,
    initialModeIndex,
    compositor: ctx.compositor,
  });

  // Register as backend
  bus.emit("agent:register-backend", {
    name: "ash",
    kill: () => agentLoop.kill(),
    start: async () => {
      agentLoop.wire();
      bus.emit("agent:info", {
        name: "ash",
        version: "0.4",
        model: llmClient.model,
        provider: modes[initialModeIndex]?.provider,
        contextWindow: modes[initialModeIndex]?.contextWindow,
      });
    },
  });

  // ── Runtime provider registration ──────────────────────────
  bus.on("provider:register", (p) => {
    const rawModels = p.models ?? (p.defaultModel ? [p.defaultModel] : []);
    const modelIds: string[] = [];
    const caps = new Map<string, { reasoning?: boolean; contextWindow?: number }>();
    for (const m of rawModels) {
      if (typeof m === "string") {
        modelIds.push(m);
      } else {
        modelIds.push(m.id);
        caps.set(m.id, { reasoning: m.reasoning, contextWindow: m.contextWindow });
      }
    }
    providerRegistry.set(p.id, {
      id: p.id,
      apiKey: p.apiKey,
      baseURL: p.baseURL,
      defaultModel: p.defaultModel,
      models: modelIds,
      supportsReasoningEffort: p.supportsReasoningEffort,
      modelCapabilities: caps.size > 0 ? caps : undefined,
    });

    const addModes: AgentMode[] = modelIds.map((m) => {
      const mc = caps.get(m);
      return {
        model: m,
        provider: p.id,
        providerConfig: { apiKey: p.apiKey ?? "", baseURL: p.baseURL },
        contextWindow: mc?.contextWindow,
        reasoning: mc?.reasoning,
        supportsReasoningEffort: p.supportsReasoningEffort,
      };
    });
    bus.emit("config:add-modes", { modes: addModes });
  });

  // ── Runtime provider switching ─────────────────────────────
  bus.on("config:switch-provider", ({ provider: name }) => {
    const p = providerRegistry.get(name);
    if (!p) {
      bus.emit("ui:error", { message: `Unknown provider: ${name}` });
      return;
    }

    const newApiKey = p.apiKey;
    if (!newApiKey) {
      bus.emit("ui:error", { message: `Provider "${name}" has no API key configured` });
      return;
    }
    const switchModel = p.defaultModel ?? p.models[0];
    if (!switchModel) {
      bus.emit("ui:error", { message: `Provider "${name}" has no models configured` });
      return;
    }
    llmClient.reconfigure({
      apiKey: newApiKey,
      baseURL: p.baseURL,
      model: switchModel,
    });

    const newModes: AgentMode[] = p.models.map((m) => {
      const mc = p.modelCapabilities?.get(m);
      return {
        model: m,
        provider: name,
        providerConfig: { apiKey: newApiKey, baseURL: p.baseURL },
        contextWindow: mc?.contextWindow ?? p.contextWindow,
        reasoning: mc?.reasoning,
        supportsReasoningEffort: p.supportsReasoningEffort,
      };
    });
    bus.emit("config:set-modes", { modes: newModes });

    activeProvider = p;
    bus.emit("agent:info", { name: "ash", version: "0.4", model: switchModel, provider: name, contextWindow: p.contextWindow });
    bus.emit("ui:info", { message: `Switched to ${name} (${switchModel})` });
    bus.emit("config:changed", {});
  });
}
