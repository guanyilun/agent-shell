/**
 * Core kernel — the minimum viable agent-sh.
 *
 * Wires up EventBus + ContextManager + AcpClient without any frontend.
 * Consumers attach their own I/O (Shell, WebSocket, REST, tests) by
 * subscribing to bus events and calling client methods.
 *
 * The core listens for `agent:submit` and `agent:cancel-request` events
 * from any frontend, routing them to the AcpClient. This means frontends
 * never need a direct reference to AcpClient — they just emit events.
 *
 * Usage:
 *   import { createCore } from "agent-sh";
 *   const core = createCore({ agentCommand: "pi-acp" });
 *   core.bus.on("agent:response-chunk", ({ text }) => ws.send(text));
 *   await core.start();
 *   core.bus.emit("agent:submit", { query: "hello" });
 */
import { EventBus } from "./event-bus.js";
import { ContextManager } from "./context-manager.js";
import { AcpClient } from "./acp-client.js";
import type { AgentShellConfig, ExtensionContext } from "./types.js";
import { setPalette } from "./utils/palette.js";

// Re-export types that library consumers need
export { EventBus } from "./event-bus.js";
export type { ShellEvents } from "./event-bus.js";
export type { AgentShellConfig, ExtensionContext } from "./types.js";
export { palette, setPalette, resetPalette } from "./utils/palette.js";
export type { ColorPalette } from "./utils/palette.js";

export interface AgentShellCore {
  bus: EventBus;
  contextManager: ContextManager;
  client: AcpClient;
  /** Connect to the agent subprocess. Call after wiring up bus listeners. */
  start(): Promise<void>;
  /** Build an ExtensionContext for loading extensions against this core. */
  extensionContext(opts: { quit: () => void }): ExtensionContext;
  /** Tear down the agent process and clean up. */
  kill(): void;
}

export function createCore(config: AgentShellConfig): AgentShellCore {
  const bus = new EventBus();
  const contextManager = new ContextManager(bus);
  const client = new AcpClient({ bus, contextManager, config });

  let connected = false;

  // Route frontend events to the agent — any frontend (Shell, WebSocket,
  // REST handler, test harness) can emit these without knowing about AcpClient.
  bus.on("agent:submit", ({ query }) => {
    (async () => {
      // Wait briefly for agent connection if start() is still in progress
      if (!connected) {
        for (let i = 0; i < 30 && !connected; i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      if (!connected) {
        bus.emit("ui:error", { message: "Agent not connected. Please wait a moment and try again." });
        return;
      }
      await client.sendPrompt(query);
    })().catch((err) => {
      bus.emit("agent:error", {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  bus.on("agent:cancel-request", () => {
    client.cancel().catch(() => {});
  });

  return {
    bus,
    contextManager,
    client,

    async start() {
      await client.start();
      connected = true;
    },

    extensionContext(opts) {
      return {
        bus,
        contextManager,
        getAcpClient: () => client,
        quit: opts.quit,
        setPalette,
      };
    },

    kill() {
      client.kill();
    },
  };
}
