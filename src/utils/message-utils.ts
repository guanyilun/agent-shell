/**
 * Utilities for manipulating OpenAI-format message arrays.
 *
 * Used by extensions advising `conversation:prepare` to transform
 * the message array before it's sent to the LLM.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Find tool call IDs matching a tool name and optional argument filter.
 *
 * Scans assistant messages for tool_calls where `function.name` matches
 * and parsed arguments satisfy the filter (shallow key/value match).
 *
 * Returns call IDs in message order (earliest first).
 */
export function findToolCallIds(
  messages: any[],
  toolName: string,
  argFilter?: Record<string, unknown>,
): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      const fn = tc.function ?? tc.fn;
      if (!fn || fn.name !== toolName) continue;
      if (argFilter) {
        let args: Record<string, unknown>;
        try { args = JSON.parse(fn.arguments); } catch { continue; }
        const match = Object.entries(argFilter).every(([k, v]) => args[k] === v);
        if (!match) continue;
      }
      ids.push(tc.id);
    }
  }
  return ids;
}

/**
 * Replace tool result content for specific call IDs.
 *
 * Returns a new array (shallow copy) with matching tool messages
 * replaced. Non-matching messages are passed through by reference.
 */
export function stubToolResults(
  messages: any[],
  callIds: Set<string>,
  stub: string,
): any[] {
  return messages.map((msg) => {
    if (msg.role === "tool" && callIds.has(msg.tool_call_id)) {
      return { ...msg, content: stub };
    }
    return msg;
  });
}

/**
 * Deduplicate tool results: keep only the latest result for a given
 * tool name + argument filter, replace all older results with a stub.
 *
 * Common use case: a file that's read repeatedly (e.g. a live transcript)
 * — only the most recent read matters.
 *
 * Example:
 *   dedupeToolResults(messages, "read_file",
 *     { path: "/path/to/transcript.txt" },
 *     "[stale — superseded by later read]")
 */
export function dedupeToolResults(
  messages: any[],
  toolName: string,
  argFilter?: Record<string, unknown>,
  stub = "[superseded by later call]",
): any[] {
  const callIds = findToolCallIds(messages, toolName, argFilter);
  if (callIds.length <= 1) return messages;

  // Keep the last one, stub the rest
  const staleIds = new Set(callIds.slice(0, -1));
  return stubToolResults(messages, staleIds, stub);
}
