import type { ChatCompletionMessageParam } from "../utils/llm-client.js";

/**
 * Manages the OpenAI chat messages array for the agent loop.
 * Separate from ContextManager — this is the LLM conversation,
 * not the shell history.
 */
export class ConversationState {
  private messages: ChatCompletionMessageParam[] = [];

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  addAssistantMessage(
    content: string | null,
    toolCalls?: {
      id: string;
      function: { name: string; arguments: string };
    }[],
  ): void {
    if (toolCalls?.length) {
      this.messages.push({
        role: "assistant",
        content: content ?? null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: tc.function,
        })),
      });
    } else {
      this.messages.push({ role: "assistant", content: content ?? "" });
    }
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content,
    });
  }

  /** Inject a system-level note into the conversation (e.g. context change). */
  addSystemNote(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  /**
   * Simple compaction — drop oldest turns, keeping the first user message
   * (original task context) and the most recent turns.
   */
  compact(maxTurns: number): void {
    if (this.messages.length <= maxTurns * 2) return;

    const first = this.messages[0];
    const recent = this.messages.slice(-(maxTurns * 2));

    this.messages = [
      first,
      { role: "user", content: "[Earlier conversation turns omitted for context space]" },
      ...recent,
    ];
  }

  clear(): void {
    this.messages = [];
  }
}
