/**
 * Core kernel — the minimum viable agent-sh.
 *
 * Wires up EventBus + ContextManager + AgentBackend without any frontend.
 * Consumers attach their own I/O (Shell, WebSocket, REST, tests) by
 * subscribing to bus events.
 *
 * The default backend (AgentLoop) is created eagerly but wired lazily —
 * extensions can register alternative backends via agent:register-backend
 * before activateBackend() is called.
 *
 * Usage:
 *   import { createCore } from "agent-sh";
 *   const core = createCore({ apiKey: "...", model: "gpt-4o" });
 *   core.bus.on("agent:response-chunk", ({ blocks }) => { ... });
 *   core.activateBackend();
 *   const response = await core.query("hello");
 */
import { EventBus, type ContentBlock } from "./event-bus.js";
import { ContextManager } from "./context-manager.js";
import { AgentLoop } from "./agent/agent-loop.js";
import { LlmClient } from "./utils/llm-client.js";
import type { AgentShellConfig, AgentMode, ExtensionContext, RemoteSessionOptions, RemoteSession } from "./types.js";
import { setPalette } from "./utils/palette.js";
import * as streamTransform from "./utils/stream-transform.js";
import * as settingsMod from "./settings.js";
import { resolveProvider, getProviderNames, type ResolvedProvider } from "./settings.js";
import { HandlerRegistry } from "./utils/handler-registry.js";
import { TerminalBuffer } from "./utils/terminal-buffer.js";
import { FloatingPanel, type FloatingPanelConfig } from "./utils/floating-panel.js";
import { DefaultCompositor, StdoutSurface } from "./utils/compositor.js";

// Re-export types that library consumers need
export { EventBus } from "./event-bus.js";
export type { ShellEvents } from "./event-bus.js";
export type { AgentShellConfig, ExtensionContext } from "./types.js";
export { palette, setPalette, resetPalette } from "./utils/palette.js";
export type { ColorPalette } from "./utils/palette.js";
export type { AgentBackend, ToolDefinition } from "./agent/types.js";
export { runSubagent, type SubagentOptions } from "./agent/subagent.js";
export { LlmClient } from "./utils/llm-client.js";

export interface AgentShellCore {
  bus: EventBus;
  contextManager: ContextManager;
  /** Handler registry for define/advise/call. */
  handlers: HandlerRegistry;
  /** LLM client for fast-path features (null when no provider configured). */
  llmClient: LlmClient | null;
  /** Activate the agent backend (call after extensions load). */
  activateBackend(): void;
  /** Convenience: emit agent:submit and await the response. */
  query(text: string): Promise<string>;
  /** Convenience: emit agent:cancel-request. */
  cancel(): void;
  /** Build an ExtensionContext for loading extensions against this core. */
  extensionContext(opts: { quit: () => void }): ExtensionContext;
  /** Tear down the agent and clean up. */
  kill(): void;
}

export function createCore(config: AgentShellConfig): AgentShellCore {
  const bus = new EventBus();
  const handlers = new HandlerRegistry();
  const contextManager = new ContextManager(bus, handlers);

  // ── Resolve provider ─────────────────────────────────────────
  const settings = settingsMod.getSettings();
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

  // Build flat modes list across all providers
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
    (m) => m.model === effectiveModel && (!activeProvider || m.provider === activeProvider.id)
  ));

  // Shared LLM client — used by agent loop AND fast-path features
  let llmClient: LlmClient | null = null;
  if (effectiveApiKey) {
    if (!effectiveModel) {
      throw new Error("No model specified. Use --model or configure a provider with defaultModel in ~/.agent-sh/settings.json");
    }
    llmClient = new LlmClient({
      apiKey: effectiveApiKey,
      baseURL: effectiveBaseURL,
      model: effectiveModel,
    });
  }

  // Create AgentLoop (unwired — tools only, no bus subscriptions yet)
  const agentLoop = llmClient
    ? new AgentLoop(bus, contextManager, llmClient, handlers, modes, initialModeIndex)
    : null;

  // ── Multi-backend registry ───────────────────────────────────
  type Backend = { name: string; kill: () => void; start?: () => Promise<void> };
  const backends = new Map<string, Backend>();
  let activeBackendName: string | null = null;

  const activateByName = async (name: string, silent = false) => {
    const backend = name === "agent-sh" ? null : backends.get(name);
    if (name !== "agent-sh" && !backend) {
      bus.emit("ui:error", { message: `Unknown backend: ${name}` });
      return;
    }

    // Deactivate current backend
    if (activeBackendName === "agent-sh") {
      agentLoop?.unwire();
    } else if (activeBackendName) {
      backends.get(activeBackendName)?.kill();
    }

    // Activate new backend
    if (name === "agent-sh") {
      if (!agentLoop) {
        bus.emit("ui:error", { message: "No LLM provider configured for built-in backend" });
        return;
      }
      agentLoop.wire();
      activeBackendName = "agent-sh";
      bus.emit("agent:info", { name: "agent-sh", version: "0.4", model: llmClient?.model, provider: activeProvider?.id, contextWindow: activeProvider?.contextWindow });
    } else {
      await backend!.start?.();
      activeBackendName = name;
    }

    if (!silent) {
      bus.emit("ui:info", { message: `Backend: ${name}` });
    }
    bus.emit("config:changed", {});
  };

  bus.on("agent:register-backend", (backend) => {
    backends.set(backend.name, backend);
  });

  bus.on("config:switch-backend", ({ name }) => {
    activateByName(name);
  });

  bus.on("config:list-backends", () => {
    const names: string[] = [];
    if (agentLoop) names.push("agent-sh");
    for (const name of backends.keys()) names.push(name);
    const list = names
      .map((n) => n === activeBackendName ? `${n} (active)` : n)
      .join(", ");
    bus.emit("ui:info", { message: `Backends: ${list}` });
  });

  bus.onPipe("config:get-backends", (payload) => {
    const names: string[] = [];
    if (agentLoop) names.push("agent-sh");
    for (const name of backends.keys()) names.push(name);
    return { names, active: activeBackendName };
  });

  // ── Runtime provider management ──────────────────────────────

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

    // Push registered models into the agent loop so they appear in
    // autocomplete and are selectable via /model.
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

  bus.on("config:switch-provider", ({ provider: name }) => {
    const p = providerRegistry.get(name);
    if (!p) {
      bus.emit("ui:error", { message: `Unknown provider: ${name}` });
      return;
    }
    if (!llmClient) {
      bus.emit("ui:error", { message: `Provider switching requires internal agent mode` });
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
    bus.emit("agent:info", { name: "agent-sh", version: "0.4", model: switchModel, provider: name, contextWindow: p.contextWindow });
    bus.emit("ui:info", { message: `Switched to ${name} (${switchModel})` });
    bus.emit("config:changed", {});
  });

  // ── Compositor ──────────────────────────────────────────────
  const compositor = new DefaultCompositor();
  const stdoutSurface = new StdoutSurface();
  compositor.setDefault("agent", stdoutSurface);
  compositor.setDefault("query", stdoutSurface);
  compositor.setDefault("status", stdoutSurface);

  // ── Lazy singleton terminal buffer ──────────────────────────
  let terminalBufferSingleton: TerminalBuffer | null | undefined; // undefined = not yet created
  const getTerminalBuffer = (): TerminalBuffer | null => {
    if (terminalBufferSingleton !== undefined) return terminalBufferSingleton;
    terminalBufferSingleton = TerminalBuffer.createWired(bus);
    return terminalBufferSingleton;
  };

  return {
    bus,
    contextManager,
    handlers,
    llmClient,

    activateBackend() {
      // Silent — backend info is shown in the startup banner.
      // Runtime switches (config:switch-backend) still emit ui:info.
      const preferred = settings.defaultBackend;
      if (preferred && backends.has(preferred)) {
        activateByName(preferred, true);
      } else if (backends.size > 0 && !agentLoop) {
        activateByName(backends.keys().next().value!, true);
      } else if (agentLoop) {
        agentLoop.wire();
        activeBackendName = "agent-sh";
        bus.emit("agent:info", { name: "agent-sh", version: "0.4", model: llmClient?.model, provider: activeProvider?.id, contextWindow: activeProvider?.contextWindow });
      } else if (backends.size > 0) {
        activateByName(backends.keys().next().value!, true);
      }
    },

    async query(text) {
      return new Promise((resolve, reject) => {
        let response = "";
        let settled = false;

        const onChunk = (e: { blocks: ContentBlock[] }) => {
          for (const b of e.blocks) if (b.type === "text") response += b.text;
        };
        const onDone = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(response);
        };
        const onError = (e: { message: string }) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(e.message));
        };
        const cleanup = () => {
          bus.off("agent:response-chunk", onChunk);
          bus.off("agent:processing-done", onDone);
          bus.off("agent:error", onError);
        };

        bus.on("agent:response-chunk", onChunk);
        bus.on("agent:processing-done", onDone);
        bus.on("agent:error", onError);

        bus.emit("agent:submit", { query: text });
      });
    },

    cancel() {
      bus.emit("agent:cancel-request", {});
    },

    extensionContext(opts) {
      return {
        bus,
        contextManager,
        llmClient,
        quit: opts.quit,
        setPalette,
        createBlockTransform: (o) => streamTransform.createBlockTransform(bus, o),
        createFencedBlockTransform: (o) =>
          streamTransform.createFencedBlockTransform(bus, o),
        getExtensionSettings: settingsMod.getExtensionSettings,
        registerCommand: (name, description, handler) =>
          bus.emit("command:register", { name, description, handler }),
        registerTool: (tool) => agentLoop?.registerTool(tool),
        unregisterTool: (name) => agentLoop?.unregisterTool(name),
        getTools: () => agentLoop?.getTools() ?? [],
        registerInstruction: (name, text) => agentLoop?.registerInstruction(name, text),
        removeInstruction: (name) => agentLoop?.removeInstruction(name),
        define: (name, fn) => handlers.define(name, fn),
        advise: (name, wrapper) => handlers.advise(name, wrapper),
        call: (name, ...args) => handlers.call(name, ...args),
        get terminalBuffer() { return getTerminalBuffer(); },
        createFloatingPanel: (config: FloatingPanelConfig) => {
          const tb = config.dimBackground !== false ? getTerminalBuffer() : null;
          return new FloatingPanel(bus, { ...config, terminalBuffer: tb ?? undefined });
        },
        compositor,
        createRemoteSession: (opts: RemoteSessionOptions): RemoteSession => {
          const { surface } = opts;
          const cleanups: (() => void)[] = [];
          let active = true;

          // Redirect all render streams
          cleanups.push(compositor.redirect("agent", surface));
          cleanups.push(compositor.redirect("query", surface));
          cleanups.push(compositor.redirect("status", surface));

          // Keep shell interactive
          cleanups.push(handlers.advise("shell:on-processing-start", (next) => active ? undefined : next()));
          cleanups.push(handlers.advise("shell:on-processing-done", (next) => active ? undefined : next()));

          // Suppress chrome
          if (opts.suppressBorders !== false) {
            cleanups.push(handlers.advise("tui:response-border", (next, ...a) => active ? null : next(...a)));
          }
          if (opts.suppressQueryBox) {
            cleanups.push(handlers.advise("tui:render-user-query", (next, ...a) => active ? [] : next(...a)));
          }
          if (opts.suppressUsage !== false) {
            cleanups.push(handlers.advise("tui:render-usage", (next, ...a) => active ? "" : next(...a)));
          }
          if (opts.interactive) {
            cleanups.push(handlers.advise("dynamic-context:build", (next) => {
              const base = next() as string;
              return active ? base + "\ninteractive-session: true\n" : base;
            }));
          }

          return {
            submit(query: string) { bus.emit("agent:submit", { query }); },
            get surface() { return surface; },
            get active() { return active; },
            close() {
              if (!active) return;
              active = false;
              for (const fn of cleanups.reverse()) fn();
              cleanups.length = 0;
            },
          };
        },
      };
    },

    kill() {
      if (activeBackendName === "agent-sh") {
        agentLoop?.kill();
      } else if (activeBackendName) {
        backends.get(activeBackendName)?.kill();
      }
    },
  };
}
