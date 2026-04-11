/**
 * Agent backend factory.
 *
 * Creates a bus-driven backend based on config:
 *   - If apiKey is provided → AgentLoop (in-process, OpenAI-compatible API)
 *   - Otherwise → AcpClient (subprocess, ACP protocol)
 *
 * Both backends self-wire to bus events in their constructor.
 * Core just holds the returned reference for kill().
 */
import type { EventBus } from "../event-bus.js";
import type { ContextManager } from "../context-manager.js";
import type { AgentShellConfig, AgentMode } from "../types.js";
import type { LlmClient } from "../utils/llm-client.js";
import type { AgentBackend } from "./types.js";
import { AcpClient } from "./acp-client.js";
import { AgentLoop } from "./agent-loop.js";

export type { AgentBackend } from "./types.js";
export type { ToolDefinition, ToolResult, ToolDisplayInfo } from "./types.js";
export { AgentLoop } from "./agent-loop.js";
export { ToolRegistry } from "./tool-registry.js";

export function createAgentBackend(
  config: AgentShellConfig,
  bus: EventBus,
  contextManager: ContextManager,
  llmClient?: LlmClient,
  modes?: AgentMode[],
  initialModeIndex?: number,
): AgentBackend {
  if (llmClient) {
    // AgentLoop self-wires to bus events — no routing needed
    return new AgentLoop(bus, contextManager, llmClient, modes, initialModeIndex);
  }

  // AcpClient self-wires to bus events in its constructor.
  return new AcpClient({ bus, contextManager, config });
}
