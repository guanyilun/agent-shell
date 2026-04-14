#!/usr/bin/env node
/**
 * agent-sh-acp — ACP (Agent Client Protocol) server wrapping agent-sh's
 * headless core. Speaks JSON-RPC 2.0 over stdin/stdout so agent-shell
 * (Emacs) can drive it as a backend.
 *
 * Usage:
 *   agent-sh-acp                     # uses settings from ~/.agent-sh/settings.json
 *   agent-sh-acp --model gpt-4o      # override model
 *
 * In agent-shell (Emacs):
 *   (setq agent-shell-agentsh-acp-command '("agent-sh-acp"))
 */
import { createCore, type AgentShellCore } from "agent-sh";
import { loadExtensions } from "agent-sh/extension-loader";
import { loadBuiltinExtensions } from "agent-sh/extensions";
import { getSettings } from "agent-sh/settings";
import type { ContentBlock } from "agent-sh/types";

// ── JSON-RPC types ──────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id?: number | string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ── ACP content block ───────────────────────────────────────────────

interface AcpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

// ── Stdio transport ─────────────────────────────────────────────────

function send(msg: JsonRpcResponse | JsonRpcNotification): void {
  const line = JSON.stringify(msg) + "\n";
  process.stdout.write(line);
}

function sendResult(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: number | string, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}

function sendNotification(method: string, params: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method, params });
}

// ── ACP session/update helpers ──────────────────────────────────────

function sendSessionUpdate(update: Record<string, unknown>): void {
  sendNotification("session/update", { update });
}

function sendTextChunk(text: string): void {
  sendSessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
}

function sendThinkingChunk(text: string): void {
  sendSessionUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
  });
}

function sendToolCall(
  toolCallId: string,
  title: string,
  kind: string,
  rawInput?: unknown,
): void {
  sendSessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId,
    title,
    status: "pending",
    kind,
    content: [],
    rawInput,
  });
}

function sendToolCallUpdate(
  toolCallId: string,
  status: string,
  content: AcpContentBlock[],
  kind?: string,
): void {
  sendSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId,
    status,
    content,
    kind,
  });
}

function sendUsageUpdate(
  inputTokens: number,
  outputTokens: number,
): void {
  sendSessionUpdate({
    sessionUpdate: "usage_update",
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
}

// ── Permission bridge ───────────────────────────────────────────────

let nextPermissionId = 1;
const pendingPermissions = new Map<
  number,
  { resolve: (outcome: string) => void }
>();

function buildPermissionToolCall(
  title: string,
  kind: string,
  metadata: Record<string, unknown>,
  toolCallId: string,
): { toolCall: Record<string, unknown> } {
  const args = (metadata.args ?? {}) as Record<string, unknown>;

  // Map agent-sh permission kinds → ACP tool call shapes
  if (kind === "file-write") {
    // File edit/write — send diff content block + rawInput for agent-shell
    const content: unknown[] = [];
    const rawInput: Record<string, unknown> = {};

    // Set path for title display
    const filePath = (args.path as string) ?? "";
    rawInput.path = filePath;
    rawInput.file_path = filePath;

    // For edit_file: old_str/new_str so agent-shell can render a diff
    if (typeof args.old_text === "string") {
      rawInput.old_str = args.old_text;
      rawInput.new_str = args.new_text ?? "";
      content.push({
        type: "diff",
        oldText: args.old_text,
        newText: args.new_text ?? "",
        path: filePath,
      });
    } else if (typeof args.content === "string") {
      // write_file (new file or full overwrite)
      rawInput.new_str = args.content;
      rawInput.old_str = "";
      content.push({
        type: "diff",
        oldText: "",
        newText: args.content,
        path: filePath,
      });
    }

    if (typeof args.description === "string") {
      rawInput.description = args.description;
    }

    return {
      toolCall: {
        toolCallId,
        title,
        status: "pending",
        kind: "diff",
        content,
        rawInput,
      },
    };
  }

  // Generic tool call (bash, etc.)
  const rawInput: Record<string, unknown> = {};
  if (typeof args.command === "string") {
    rawInput.command = args.command;
  }
  if (typeof args.description === "string") {
    rawInput.description = args.description;
  }

  return {
    toolCall: {
      toolCallId,
      title,
      status: "pending",
      kind: kind === "tool-call" ? "execute" : kind,
      content: [],
      rawInput,
    },
  };
}

function requestPermission(
  title: string,
  kind: string,
  metadata: Record<string, unknown>,
  toolCallId?: string,
): Promise<string> {
  const id = nextPermissionId++;
  const tcId = toolCallId ?? `perm-${id}`;
  return new Promise((resolve) => {
    pendingPermissions.set(id, { resolve });
    const { toolCall } = buildPermissionToolCall(title, kind, metadata, tcId);
    send({
      jsonrpc: "2.0",
      method: "session/request_permission",
      id,
      params: {
        toolCall,
        options: [
          { id: "accepted", name: "Accept", description: "Accept this action" },
          { id: "rejected", name: "Reject", description: "Reject this action" },
          { id: "always", name: "Always allow", description: "Always allow for this session" },
        ],
      },
    } as any);
  });
}

// ── Core setup ──────────────────────────────────────────────────────

function parseArgs(): { model?: string; provider?: string } {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) result.model = args[++i];
    if (args[i] === "--provider" && args[i + 1]) result.provider = args[++i];
  }
  return result;
}

const cliArgs = parseArgs();
let core: AgentShellCore | null = null;
let sessionId: string | null = null;
let sessionCwd: string = process.cwd();

// Track tool output chunks per toolCallId so we can send accumulated content
const toolOutputBuffers = new Map<string, string>();

// Track the active prompt request id so we can respond when processing is done
let activePromptRequestId: number | string | null = null;

// Track always-allowed permission kinds
const alwaysAllowed = new Set<string>();

// Track in-flight async operations so stdin end can wait
let pendingOp: Promise<void> = Promise.resolve();

// ── Wire agent-sh events → ACP notifications ───────────────────────

function wireEvents(core: AgentShellCore): void {
  const { bus } = core;

  bus.on("agent:response-chunk", ({ blocks }) => {
    for (const block of blocks) {
      if (block.type === "text") {
        sendTextChunk(block.text);
      }
      // code-block blocks are sent as text (agent-shell renders markdown)
      if (block.type === "code-block") {
        sendTextChunk("```" + block.language + "\n" + block.code + "\n```");
      }
    }
  });

  bus.on("agent:thinking-chunk", ({ text }) => {
    sendThinkingChunk(text);
  });

  bus.on("agent:tool-started", (e) => {
    const id = e.toolCallId ?? `tool-${Date.now()}`;
    toolOutputBuffers.set(id, "");
    sendToolCall(id, e.title, e.kind ?? "tool", e.rawInput);
  });

  bus.on("agent:tool-output-chunk", ({ chunk }) => {
    // Accumulate — we don't know toolCallId here, but only one tool runs at a time
    // in sequential mode. For parallel tools this is best-effort.
    for (const [id, buf] of toolOutputBuffers) {
      toolOutputBuffers.set(id, buf + chunk);
    }
  });

  bus.on("agent:tool-completed", (e) => {
    const id = e.toolCallId ?? [...toolOutputBuffers.keys()].pop() ?? "unknown";
    const output = toolOutputBuffers.get(id) ?? "";
    toolOutputBuffers.delete(id);

    const status = e.exitCode === 0 || e.exitCode === null ? "completed" : "failed";
    const content: AcpContentBlock[] = output
      ? [{ type: "text", text: output }]
      : [];
    sendToolCallUpdate(id, status, content, e.kind);
  });

  bus.on("agent:usage", ({ prompt_tokens, completion_tokens }) => {
    sendUsageUpdate(prompt_tokens, completion_tokens);
  });

  bus.on("agent:processing-done", () => {
    if (activePromptRequestId !== null) {
      sendResult(activePromptRequestId, { stopReason: "end_turn" });
      activePromptRequestId = null;
    }
  });

  bus.on("agent:error", ({ message }) => {
    if (activePromptRequestId !== null) {
      sendError(activePromptRequestId, -32603, message);
      activePromptRequestId = null;
    }
  });

  bus.on("agent:cancelled", () => {
    if (activePromptRequestId !== null) {
      sendResult(activePromptRequestId, { stopReason: "cancelled" });
      activePromptRequestId = null;
    }
  });

  // Permission gating — auto-approve all tool calls.
  // agent-sh's built-in tools handle their own safety; the ACP layer
  // doesn't add a second permission gate. If you want to bridge
  // permissions to agent-shell's UI, replace this with the
  // requestPermission() flow.
  bus.onPipeAsync("permission:request", async (payload) => {
    payload.decision = { outcome: "approved" };
    return payload;
  });
}

// ── ACP method handlers ─────────────────────────────────────────────

function getModelsPayload(): Record<string, unknown> | undefined {
  if (!core) return undefined;
  const info = core.bus.emitPipe("config:get-models", { models: [], active: null });
  if (!info.models.length) return undefined;
  return {
    currentModelId: info.active ?? info.models[0]?.model,
    availableModels: info.models.map((m) => ({
      modelId: m.model,
      name: m.provider ? `${m.provider}/${m.model}` : m.model,
      description: m.provider ? `Provider: ${m.provider}` : "",
    })),
  };
}

function handleInitialize(id: number | string): void {
  sendResult(id, {
    agentCapabilities: {
      promptCapabilities: {
        image: false,
        embeddedContext: true,
      },
      sessionCapabilities: {},
    },
    modes: {
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default", description: "Standard mode" },
      ],
    },
  });
}

async function handleSessionNew(id: number | string, params: Record<string, unknown>): Promise<void> {
  sessionCwd = (params.cwd as string) ?? process.cwd();
  process.chdir(sessionCwd);

  // Create core lazily on first session
  if (!core) {
    core = createCore({
      model: cliArgs.model,
      provider: cliArgs.provider,
    });
    wireEvents(core);

    const extCtx = core.extensionContext({ quit: () => process.exit(0) });
    const settings = getSettings();

    // Load built-in extensions first (agent-backend, slash-commands, etc.)
    // Skip TUI-only extensions that don't apply in headless mode
    const headlessDisabled = [
      "tui-renderer",
      "file-autocomplete",
      "terminal-buffer",
      "overlay-agent",
      ...(settings.disabledBuiltins ?? []),
    ];
    await loadBuiltinExtensions(extCtx, headlessDisabled);

    // Load user extensions with a timeout (some may hang in headless mode)
    const TIMEOUT_MS = 10000;
    await Promise.race([
      loadExtensions(extCtx),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`Extension loading timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]).catch((err) => {
      process.stderr.write(`Warning: ${err instanceof Error ? err.message : err}\n`);
    });

    core.activateBackend();
  }

  sessionId = `session-${Date.now()}`;
  const result: Record<string, unknown> = {
    sessionId,
    modes: {
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default", description: "Standard mode" },
      ],
    },
  };
  const models = getModelsPayload();
  if (models) result.models = models;
  sendResult(id, result);
}

function handleSessionPrompt(id: number | string, params: Record<string, unknown>): void {
  if (!core) {
    sendError(id, -32603, "No active session");
    return;
  }

  // Extract text from prompt content blocks
  const prompt = params.prompt as Array<{ type: string; text?: string; resource?: { text?: string } }>;
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "resource" && block.resource?.text) {
      parts.push(block.resource.text);
    }
  }

  const query = parts.join("\n");
  if (!query) {
    sendResult(id, { stopReason: "end_turn" });
    return;
  }

  // Store the request id — we'll respond when agent:processing-done fires
  activePromptRequestId = id;
  core.bus.emit("agent:submit", { query });
}

function handleSessionSetMode(id: number | string, _params: Record<string, unknown>): void {
  // Acknowledge — agent-sh doesn't have distinct modes yet
  sendResult(id, {});
}

// ── Message dispatcher ──────────────────────────────────────────────

function dispatch(msg: JsonRpcRequest): void {
  const { method, params, id } = msg;

  // Handle responses to our outgoing requests (permission responses)
  if (!method && id !== undefined && (msg as any).result !== undefined) {
    const pending = pendingPermissions.get(id as number);
    if (pending) {
      pendingPermissions.delete(id as number);
      const result = (msg as any).result;
      const outcome = result?.outcome?.optionId ?? result?.outcome?.outcome ?? "rejected";
      pending.resolve(outcome);
    }
    return;
  }

  if (!id && !method) return; // ignore malformed

  switch (method) {
    case "initialize":
      handleInitialize(id!);
      break;
    case "session/new":
      pendingOp = handleSessionNew(id!, params ?? {}).catch((err) => {
        sendError(id!, -32603, err instanceof Error ? err.message : String(err));
      });
      break;
    case "session/prompt":
      handleSessionPrompt(id!, params ?? {});
      break;
    case "session/set_mode":
      handleSessionSetMode(id!, params ?? {});
      break;
    case "session/set_model":
      if (core && params?.modelId) {
        core.bus.emit("config:switch-model", { model: params.modelId as string });
      }
      sendResult(id!, {
        models: getModelsPayload() ?? {},
      });
      break;
    case "session/cancel":
      if (core) {
        core.bus.emit("agent:cancel-request", {});
      }
      // Notification — no response needed
      break;
    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// ── Stdin line reader ───────────────────────────────────────────────

let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as JsonRpcRequest;
      dispatch(msg);
    } catch {
      // Skip malformed JSON
    }
  }
});

process.stdin.on("end", async () => {
  // Wait for any in-flight async operations (e.g. session/new) to settle
  await pendingOp;
  core?.kill();
  process.exit(0);
});

// Log unhandled rejections to stderr (don't crash, but don't swallow silently)
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[ash-acp-bridge] unhandled rejection: ${err instanceof Error ? err.message : err}\n`);
});

// Redirect stderr from agent-sh internals so it doesn't pollute the protocol
// (agent-shell reads stdout only; stderr goes to its log)
