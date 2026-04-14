/**
 * ToolProtocol — abstracts how tools are presented to the LLM and how
 * tool calls are parsed from responses.
 *
 * Two modes:
 *   "api"    — tools sent via OpenAI tools param, parsed from delta.tool_calls
 *   "inline" — tools described as text, tool calls are JSON code blocks
 *
 * The agent loop uses this interface uniformly so the rest of the code
 * doesn't need to know which mode is active.
 */
import type { ChatCompletionTool } from "../utils/llm-client.js";
import type { ToolDefinition } from "./types.js";
import type { ConversationState } from "./conversation-state.js";

export interface PendingToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ToolResult {
  callId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

/** Streaming filter — strips tool calls from display output. */
export interface StreamFilter {
  feed(chunk: string): string;
  flush(): string;
}

export interface ToolProtocol {
  readonly mode: string;

  /** Tools to pass in the API request's `tools` parameter. undefined = omit. */
  getApiTools(tools: ToolDefinition[]): ChatCompletionTool[] | undefined;

  /** Extra text for dynamic context (tool catalog for inline mode). */
  getToolPrompt(tools: ToolDefinition[]): string;

  /** Extract tool calls from a completed response. */
  extractToolCalls(
    responseText: string,
    streamedCalls: PendingToolCall[],
  ): PendingToolCall[];

  /** Rewrite a tool call before execution (e.g., unwrap meta-tool). */
  rewriteToolCall(tc: PendingToolCall): PendingToolCall;

  /** Record the assistant turn in conversation state. */
  recordAssistant(
    conv: ConversationState,
    text: string,
    toolCalls: PendingToolCall[],
  ): void;

  /** Record all tool results for a batch as conversation messages. */
  recordResults(conv: ConversationState, results: ToolResult[]): void;

  /** Create a stream filter for stripping tool calls from display. null = pass-through. */
  createStreamFilter(toolNames: string[]): StreamFilter | null;
}

// ── API mode (current behavior) ──────────────────────────────────

export class ApiToolProtocol implements ToolProtocol {
  readonly mode = "api" as const;

  getApiTools(tools: ToolDefinition[]): ChatCompletionTool[] | undefined {
    if (tools.length === 0) return undefined;
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  getToolPrompt(): string {
    return "";
  }

  extractToolCalls(
    _text: string,
    streamedCalls: PendingToolCall[],
  ): PendingToolCall[] {
    return streamedCalls;
  }

  rewriteToolCall(tc: PendingToolCall): PendingToolCall {
    return tc;
  }

  recordAssistant(
    conv: ConversationState,
    text: string,
    toolCalls: PendingToolCall[],
  ): void {
    const calls = toolCalls.length
      ? toolCalls.map((tc) => ({
          id: tc.id,
          function: { name: tc.name, arguments: tc.argumentsJson },
        }))
      : undefined;
    conv.addAssistantMessage(text || null, calls);
  }

  recordResults(conv: ConversationState, results: ToolResult[]): void {
    for (const r of results) {
      const content = r.isError ? `Error: ${r.content}` : r.content;
      conv.addToolResult(r.callId, content);
    }
  }

  createStreamFilter(): null {
    return null;
  }
}

// ── Inline mode (JSON code block tool calls) ─────────────────────

export class InlineToolProtocol implements ToolProtocol {
  readonly mode = "inline" as const;
  private callCounter = 0;

  getApiTools(): undefined {
    return undefined;
  }

  getToolPrompt(tools: ToolDefinition[]): string {
    if (tools.length === 0) return "";

    const lines = [
      "",
      "# Tools",
      "",
      "To call a tool, write a ```tool fenced block with JSON:",
      "",
      "```tool",
      '{"tool": "grep", "pattern": "TODO", "path": "src/"}',
      "```",
      "",
      "The `tool` field selects which tool. All other fields are arguments.",
      "Multiple tool blocks allowed per response.",
      "",
      "Available: " + tools.map((t) => `${t.name}${formatParams(t.input_schema)}`).join(", "),
    ];

    return lines.join("\n");
  }

  rewriteToolCall(tc: PendingToolCall): PendingToolCall {
    return tc;
  }

  extractToolCalls(
    text: string,
    _streamedCalls: PendingToolCall[],
  ): PendingToolCall[] {
    const calls: PendingToolCall[] = [];
    // Match ```tool ... ``` blocks
    const regex = /```tool\s*\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const body = match[1]!.trim();
      try {
        const obj = JSON.parse(body);
        const name = obj.tool;
        if (typeof name !== "string") continue;
        // Separate tool name from args
        const { tool: _, ...args } = obj;
        calls.push({
          id: `inline_${++this.callCounter}`,
          name,
          argumentsJson: JSON.stringify(args),
        });
      } catch {
        // Not valid JSON — skip
      }
    }
    return calls;
  }

  recordAssistant(
    conv: ConversationState,
    text: string,
    _toolCalls: PendingToolCall[],
  ): void {
    conv.addAssistantMessage(text || null);
  }

  recordResults(conv: ConversationState, results: ToolResult[]): void {
    if (results.length === 0) return;
    const parts = results.map((r) => {
      const status = r.isError ? "error" : "ok";
      return `[${r.toolName} ${r.callId} ${status}]\n${r.content}`;
    });
    conv.addToolResultInline(parts.join("\n\n"));
  }

  createStreamFilter(_toolNames: string[]): StreamFilter {
    return new CodeBlockFilter();
  }
}

// ── Code block stream filter ────────────────────────────────────

/**
 * Strips ```tool ... ``` blocks from streamed text.
 * Simple state machine: normal → in_fence → normal.
 */
class CodeBlockFilter implements StreamFilter {
  private buf = "";
  private inFence = false;
  private lastEmittedNewlines = 0; // track trailing newlines to collapse blanks

  feed(chunk: string): string {
    this.buf += chunk;
    let raw = "";

    while (this.buf.length > 0) {
      if (this.inFence) {
        // Look for closing ```
        const closeIdx = this.buf.indexOf("```");
        if (closeIdx !== -1) {
          // Skip past closing ``` and any trailing whitespace on that line
          let end = closeIdx + 3;
          while (end < this.buf.length && this.buf[end] === "\n") end++;
          this.buf = this.buf.slice(end);
          this.inFence = false;
          continue;
        }
        // No closing yet — keep buffering
        break;
      }

      // Look for opening ```tool
      const openIdx = this.buf.indexOf("```tool");
      if (openIdx !== -1) {
        // Emit everything before the fence, trimming trailing newline
        let before = this.buf.slice(0, openIdx);
        if (before.endsWith("\n")) before = before.slice(0, -1);
        raw += before;
        this.buf = this.buf.slice(openIdx + 7); // skip ```tool
        this.inFence = true;
        continue;
      }

      // Stray ``` on its own line (residual closing fence)
      const strayIdx = this.buf.indexOf("```");
      if (strayIdx !== -1) {
        // Check if it's just backticks on a line (possibly with whitespace)
        const lineStart = this.buf.lastIndexOf("\n", strayIdx - 1) + 1;
        const lineEnd = this.buf.indexOf("\n", strayIdx);
        const line = this.buf.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
        if (line === "```") {
          raw += this.buf.slice(0, lineStart);
          this.buf = this.buf.slice(lineEnd === -1 ? this.buf.length : lineEnd + 1);
          continue;
        }
      }

      // Could be a partial match at the end
      const marker = "```tool";
      let partial = false;
      for (let i = Math.min(marker.length - 1, this.buf.length); i >= 1; i--) {
        if (this.buf.endsWith(marker.slice(0, i))) {
          raw += this.buf.slice(0, this.buf.length - i);
          this.buf = this.buf.slice(this.buf.length - i);
          partial = true;
          break;
        }
      }
      if (partial) break;

      // No fence anywhere — emit all
      raw += this.buf;
      this.buf = "";
    }

    // Collapse runs of 3+ newlines into 2 (one blank line max)
    return this.collapseNewlines(raw);
  }

  flush(): string {
    const out = this.collapseNewlines(this.buf);
    this.buf = "";
    this.inFence = false;
    return out;
  }

  private collapseNewlines(text: string): string {
    if (!text) return text;
    // Count leading newlines and merge with trailing from last emit
    let i = 0;
    while (i < text.length && text[i] === "\n") i++;
    const leading = i;
    const totalNewlines = this.lastEmittedNewlines + leading;

    // Allow at most 2 consecutive newlines
    let prefix = "";
    if (leading > 0) {
      const allowed = Math.max(0, 2 - this.lastEmittedNewlines);
      prefix = "\n".repeat(Math.min(leading, allowed));
      text = text.slice(leading);
    }

    // Collapse internal runs
    text = text.replace(/\n{3,}/g, "\n\n");

    // Track trailing newlines for next call
    let trailing = 0;
    let j = text.length;
    while (j > 0 && text[j - 1] === "\n") { j--; trailing++; }
    this.lastEmittedNewlines = trailing > 0 ? trailing : (prefix ? totalNewlines - leading + prefix.length : 0);

    return prefix + text;
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function formatParams(schema: Record<string, unknown>): string {
  const props = schema.properties as Record<string, any> | undefined;
  if (!props || Object.keys(props).length === 0) return "()";

  const required = new Set((schema.required as string[]) ?? []);
  const params = Object.entries(props).map(([name, prop]) => {
    const opt = required.has(name) ? "" : "?";
    const enumVals = prop.enum as string[] | undefined;
    if (enumVals) return `${name}${opt}: ${enumVals.join("|")}`;
    return `${name}${opt}`;
  });
  return `(${params.join(", ")})`;
}

// ── Deferred mode (core tools full schema, extensions via meta-tool) ──

const META_TOOL_NAME = "use_extension";

export class DeferredToolProtocol implements ToolProtocol {
  readonly mode = "deferred" as const;
  private coreNames: Set<string>;
  /** Cached extension tool schemas for arg validation. */
  private extSchemas = new Map<string, Record<string, unknown>>();

  constructor(coreNames: string[]) {
    this.coreNames = new Set(coreNames);
  }

  getApiTools(tools: ToolDefinition[]): ChatCompletionTool[] | undefined {
    const core = tools.filter((t) => this.coreNames.has(t.name));
    const ext = tools.filter((t) => !this.coreNames.has(t.name));

    // Cache extension schemas for validation in rewriteToolCall
    this.extSchemas.clear();
    for (const t of ext) {
      this.extSchemas.set(t.name, t.input_schema);
    }

    const apiTools: ChatCompletionTool[] = core.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    if (ext.length > 0) {
      const catalog = ext
        .map((t) => `${t.name}${formatParams(t.input_schema)}`)
        .join(", ");
      apiTools.push({
        type: "function" as const,
        function: {
          name: META_TOOL_NAME,
          description: `Call an extension tool. Available: ${catalog}`,
          parameters: {
            type: "object" as const,
            properties: {
              name: { type: "string", description: "Tool name to call" },
              args: {
                type: "object",
                description: "Tool arguments",
                properties: {},
                additionalProperties: true,
              },
            },
            required: ["name"],
          },
        },
      });
    }

    return apiTools.length > 0 ? apiTools : undefined;
  }

  getToolPrompt(): string {
    return "";
  }

  extractToolCalls(
    _text: string,
    streamedCalls: PendingToolCall[],
  ): PendingToolCall[] {
    return streamedCalls;
  }

  rewriteToolCall(tc: PendingToolCall): PendingToolCall {
    if (tc.name !== META_TOOL_NAME) return tc;
    // Unwrap: use_extension(name="foo", args={...}) → foo({...})
    try {
      const parsed = JSON.parse(tc.argumentsJson);
      const targetName = parsed.name as string;
      const targetArgs = (parsed.args ?? {}) as Record<string, unknown>;

      // Validate: does the extension exist?
      const schema = this.extSchemas.get(targetName);
      if (!schema) {
        const available = [...this.extSchemas.keys()].join(", ");
        return {
          id: tc.id,
          name: META_TOOL_NAME,
          argumentsJson: JSON.stringify({
            _error: `Unknown extension "${targetName}". Available: ${available}`,
          }),
        };
      }

      // Validate: check for unknown/missing params against schema
      const schemaProps = schema.properties as Record<string, unknown> | undefined;
      const requiredParams = new Set((schema.required as string[]) ?? []);
      if (schemaProps) {
        const validParams = new Set(Object.keys(schemaProps));
        const providedParams = Object.keys(targetArgs);

        // Check for unknown params (likely wrong names)
        const unknown = providedParams.filter((p) => !validParams.has(p));
        // Check for missing required params
        const missing = [...requiredParams].filter((p) => !targetArgs[p]);

        if (unknown.length > 0 || missing.length > 0) {
          const expected = [...validParams]
            .map((p) => `${p}${requiredParams.has(p) ? " (required)" : ""}`)
            .join(", ");
          let hint = `Wrong arguments for "${targetName}". Expected params: ${expected}.`;
          if (unknown.length > 0) hint += ` Unknown: ${unknown.join(", ")}.`;
          if (missing.length > 0) hint += ` Missing: ${missing.join(", ")}.`;
          return {
            id: tc.id,
            name: META_TOOL_NAME,
            argumentsJson: JSON.stringify({ _error: hint }),
          };
        }
      }

      return {
        id: tc.id,
        name: targetName,
        argumentsJson: JSON.stringify(targetArgs),
      };
    } catch {
      return tc; // Let it fail naturally downstream
    }
  }

  recordAssistant(
    conv: ConversationState,
    text: string,
    toolCalls: PendingToolCall[],
  ): void {
    const calls = toolCalls.length
      ? toolCalls.map((tc) => ({
          id: tc.id,
          function: { name: tc.name, arguments: tc.argumentsJson },
        }))
      : undefined;
    conv.addAssistantMessage(text || null, calls);
  }

  recordResults(conv: ConversationState, results: ToolResult[]): void {
    for (const r of results) {
      const content = r.isError ? `Error: ${r.content}` : r.content;
      conv.addToolResult(r.callId, content);
    }
  }

  createStreamFilter(): null {
    return null;
  }
}

// ── Factory ─────────────────────────────────────────────────────

/** Core tool names — always sent with full schema. */
const CORE_TOOLS = [
  "bash", "read_file", "write_file", "edit_file",
  "grep", "glob", "ls", "user_shell", "display",
  "list_skills", "conversation_recall",
];

export function createToolProtocol(mode: "api" | "inline" | "deferred"): ToolProtocol {
  if (mode === "inline") return new InlineToolProtocol();
  if (mode === "deferred") return new DeferredToolProtocol(CORE_TOOLS);
  return new ApiToolProtocol();
}
