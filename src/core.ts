/**
 * Core kernel — the minimum viable agent-sh.
 *
 * Wires up EventBus + ContextManager without any frontend or agent backend.
 * Consumers attach their own I/O (Shell, WebSocket, REST, tests) by
 * subscribing to bus events.
 *
 * Agent backends are loaded as extensions and register themselves via
 * the agent:register-backend bus event. The built-in "ash" backend is
 * loaded from src/extensions/agent-backend.ts.
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
import type { AgentShellConfig, ExtensionContext, RemoteSessionOptions, RemoteSession } from "./types.js";
import { setPalette } from "./utils/palette.js";
import * as streamTransform from "./utils/stream-transform.js";
import * as settingsMod from "./settings.js";
import { HandlerRegistry } from "./utils/handler-registry.js";
import { TerminalBuffer } from "./utils/terminal-buffer.js";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DefaultCompositor, StdoutSurface } from "./utils/compositor.js";

const STORAGE_ROOT = path.join(os.homedir(), ".agent-sh");

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
  // 3 bytes = 6 hex chars, ~16M values — ample for per-lineage uniqueness and
  // short enough to read/remember. Legacy content may have 16-char iids; any
  // parsers should accept ≥6 hex chars.
  const instanceId = crypto.randomBytes(3).toString("hex");
  const settings = settingsMod.getSettings();

  // Expose raw CLI config so the agent backend extension can resolve
  // providers and create the LLM client.
  handlers.define("config:get-shell-config", () => config);

  // ── Multi-backend registry ───────────────────────────────────
  type Backend = { name: string; kill: () => void; start?: () => Promise<void> };
  const backends = new Map<string, Backend>();
  let activeBackendName: string | null = null;

  const activateByName = async (name: string, silent = false) => {
    const backend = backends.get(name);
    if (!backend) {
      bus.emit("ui:error", { message: `Unknown backend: ${name}` });
      return;
    }

    // Deactivate current backend
    if (activeBackendName) {
      backends.get(activeBackendName)?.kill();
    }

    // Activate new backend
    await backend.start?.();
    activeBackendName = name;

    if (!silent) {
      bus.emit("ui:info", { message: `Backend: ${name}` });
    }
    bus.emit("config:changed", {});
  };

  bus.on("agent:register-backend", (backend) => {
    backends.set(backend.name, backend);
  });

  bus.on("config:switch-backend", ({ name }) => {
    activateByName(name).then(() => {
      if (activeBackendName === name) {
        settingsMod.updateSettings({ defaultBackend: name });
        bus.emit("ui:info", { message: `Saved '${name}' as default backend.` });
      }
    });
  });

  bus.on("config:list-backends", () => {
    const names = [...backends.keys()];
    const list = names
      .map((n) => n === activeBackendName ? `${n} (active)` : n)
      .join(", ");
    bus.emit("ui:info", { message: `Backends: ${list}` });
  });

  bus.onPipe("config:get-backends", () => {
    const names = [...backends.keys()];
    return { names, active: activeBackendName };
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

    activateBackend() {
      // Silent — backend info is shown in the startup banner.
      // Runtime switches (config:switch-backend) still emit ui:info.
      if (backends.size === 0) return;
      const preferred = settings.defaultBackend;
      if (preferred && backends.has(preferred)) {
        activateByName(preferred, true);
      } else {
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
      const ctx: ExtensionContext = {
        bus,
        contextManager,
        instanceId,
        quit: opts.quit,
        setPalette,
        createBlockTransform: (o) => streamTransform.createBlockTransform(bus, o),
        createFencedBlockTransform: (o) =>
          streamTransform.createFencedBlockTransform(bus, o),
        getExtensionSettings: settingsMod.getExtensionSettings,
        getStoragePath: (namespace: string) => {
          const dir = path.join(STORAGE_ROOT, namespace);
          fs.mkdirSync(dir, { recursive: true });
          return dir;
        },
        registerCommand: (name, description, handler) =>
          bus.emit("command:register", { name, description, handler }),
        registerTool: (tool) => bus.emit("agent:register-tool", { tool, extensionName: "" }),
        unregisterTool: (name) => bus.emit("agent:unregister-tool", { name }),
        getTools: () => bus.emitPipe("agent:get-tools", { tools: [] }).tools,
        registerInstruction: (name, text) => bus.emit("agent:register-instruction", { name, text, extensionName: "" }),
        removeInstruction: (name) => bus.emit("agent:remove-instruction", { name }),
        registerSkill: (name, description, filePath) => bus.emit("agent:register-skill", { name, description, filePath, extensionName: "" }),
        removeSkill: (name) => bus.emit("agent:remove-skill", { name }),
        define: (name, fn) => handlers.define(name, fn),
        advise: (name, wrapper) => handlers.advise(name, wrapper),
        call: (name, ...args) => handlers.call(name, ...args),
        list: () => handlers.list(),
        get terminalBuffer() { return getTerminalBuffer(); },
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
      return ctx;
    },

    kill() {
      if (activeBackendName) {
        backends.get(activeBackendName)?.kill();
      }
    },
  };
}
