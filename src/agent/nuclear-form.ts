/**
 * Nuclear form — compact one-liner summaries of conversation actions.
 *
 * Used by the three-tier history system:
 *   Tier 1 (full content) → compacts into → Tier 2 (nuclear one-liners)
 *   Tier 2 → flushes to → Tier 3 (history file on disk)
 *
 * Nuclear entries are the currency of Tier 2 and Tier 3.
 */
import type { ChatCompletionMessageParam } from "../utils/llm-client.js";

// ── Types ─────────────────────────────────────────────────────────

export interface NuclearEntry {
  /** Global sequence number. */
  seq: number;
  /** Timestamp (Date.now()). */
  ts: number;
  /** Instance ID — 4-char hex identifying the agent-sh process. */
  iid: string;
  /** Entry kind. */
  kind: "user" | "agent" | "tool" | "error";
  /** Tool name (for kind=tool or kind=error). */
  tool?: string;
  /** The one-liner summary — injected in startup context. */
  sum: string;
  /** Expanded content — on disk only, fetched by conversation_recall expand. */
  body?: string;
}

// ── Tool classification ───────────────────────────────────────────

/** Read-only tools whose results are dropped at Tier 1→2 (agent can re-read). */
export const READ_ONLY_TOOLS = new Set([
  "read_file", "grep", "glob", "ls", "search",
]);

/** State-changing tools whose summaries are kept in nuclear memory. */
export const WRITE_TOOLS = new Set([
  "write_file", "edit_file", "write", "edit", "patch",
]);

// ── Eager nucleation ──────────────────────────────────────────────

/** Body caps by entry kind (in characters). 0 = no body stored. */
const BODY_CAPS: Record<string, number> = {
  user: 2000,
  agent: 2000,
  tool: 4000,
  error: 2000,
};

/**
 * Produce a nuclear entry eagerly — called at each hook point as messages
 * arrive, not during compaction. Returns { sum, body }.
 */
export function nucleate(
  kind: "user" | "agent",
  text: string,
  iid: string,
  seq: number,
): NuclearEntry;

export function nucleate(
  kind: "tool" | "error",
  toolName: string,
  args: Record<string, unknown>,
  resultContent: string,
  isError: boolean,
  iid: string,
  seq: number,
): NuclearEntry;

export function nucleate(
  kindOrName: "user" | "agent" | "tool" | "error",
  textOrTool: string,
  arg2: string | Record<string, unknown>,
  arg3?: string | number,
  arg4?: boolean | string,
  arg5?: number | string,
  arg6?: number,
): NuclearEntry {
  if (kindOrName === "user" || kindOrName === "agent") {
    // Simple overload: nucleate("user", text, iid, seq)
    const text = textOrTool;
    const iid = arg2 as string;
    const seq = arg3 as number;
    const maxSum = kindOrName === "user" ? 80 : 60;
    const cap = BODY_CAPS[kindOrName]!;
    return {
      seq, ts: Date.now(), iid,
      kind: kindOrName,
      sum: `${kindOrName}: "${truncate(text, maxSum)}"`,
      body: text.length > cap ? truncate(text, cap) : text,
    };
  } else {
    // Tool/error overload: nucleate("tool", toolName, args, resultContent, isError, iid, seq)
    const toolName = textOrTool;
    const args = arg2 as Record<string, unknown>;
    const resultContent = arg3 as string;
    const isError = arg4 as boolean;
    const iid = arg5 as string;
    const seq = arg6 as number;
    const kind = isError ? "error" : "tool";
    const summary = summarizeToolCall(toolName, args);
    const enriched = isError
      ? `error: ${toolName} ${truncate(resultContent, 80)}`
      : enrichWithResult(toolName, summary, resultContent);

    let body: string | undefined;
    if (READ_ONLY_TOOLS.has(toolName)) {
      // Read-only tools: no body (agent can re-read the file)
      body = undefined;
    } else {
      const cap = BODY_CAPS[kind]!;
      const fullBody = buildToolBody(toolName, args, resultContent);
      body = fullBody.length > cap ? truncate(fullBody, cap) : fullBody;
    }

    return {
      seq, ts: Date.now(), iid,
      kind,
      tool: toolName,
      sum: enriched,
      body,
    };
  }
}

/** Build body text for a tool result — command + truncated output. */
function buildToolBody(toolName: string, args: Record<string, unknown>, result: string): string {
  const argStr = toolName === "bash" || toolName === "user_shell"
    ? String(args.command ?? "")
    : JSON.stringify(args);
  const maxResult = 3000;
  const truncated = result.length > maxResult
    ? result.slice(0, Math.floor(maxResult * 0.6))
      + `\n[… truncated …]\n`
      + result.slice(result.length - Math.floor(maxResult * 0.4))
    : result;
  return `$ ${argStr}\n${truncated}`;
}

// ── Nuclear entry generation ──────────────────────────────────────

/**
 * Generate nuclear entries from a logical turn (a sequence of messages
 * starting with a user message, followed by assistant + tool messages).
 */
export function toNuclearEntries(
  messages: ChatCompletionMessageParam[],
  startSeq: number,
  instanceId: string,
): NuclearEntry[] {
  const entries: NuclearEntry[] = [];
  let seq = startSeq;
  const ts = Date.now();

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : "";
      // Skip compaction markers
      if (text.startsWith("[")) continue;
      entries.push({
        seq: seq++, ts, iid: instanceId,
        kind: "user",
        sum: `user: "${truncate(text, 80)}"`,
      });
    } else if (msg.role === "assistant") {
      // Process tool calls
      if ("tool_calls" in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (!("function" in tc)) continue;
          const name = tc.function.name;
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments); } catch {}

          // Store the tool call — we'll enrich it when we see the result
          entries.push({
            seq: seq++, ts, iid: instanceId,
            kind: "tool",
            tool: name,
            sum: summarizeToolCall(name, args),
          });
        }
      } else if (typeof msg.content === "string" && msg.content) {
        entries.push({
          seq: seq++, ts, iid: instanceId,
          kind: "agent",
          sum: `agent: "${truncate(msg.content, 60)}"`,
        });
      }
    } else if (msg.role === "tool") {
      // Enrich the most recent tool entry with result info
      const content = typeof msg.content === "string" ? msg.content : "";
      const lastTool = findLastTool(entries);
      if (lastTool) {
        const isError = content.startsWith("Error:");
        if (isError) {
          lastTool.kind = "error";
          lastTool.sum = `error: ${lastTool.tool} ${truncate(content.slice(7).trim(), 80)}`;
        } else {
          lastTool.sum = enrichWithResult(lastTool.tool ?? "", lastTool.sum, content);
        }
      }
    }
  }

  return entries;
}

// ── Formatting ────────────────────────────────────────────────────

/** Format a nuclear entry as a display line (for in-context injection). */
export function formatNuclearLine(entry: NuclearEntry): string {
  const d = new Date(entry.ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  // ISO-ish compact: 2026-04-13 14:05
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `#${entry.seq} [${stamp}] ${entry.sum}`;
}

// ── Serialization (JSONL for history file) ────────────────────────

/** Serialize a nuclear entry to a JSONL line. */
export function serializeEntry(entry: NuclearEntry): string {
  return JSON.stringify(entry);
}

/** Deserialize a JSONL line to a nuclear entry. Returns null on parse failure. */
export function deserializeEntry(line: string): NuclearEntry | null {
  try {
    const obj = JSON.parse(line);
    if (typeof obj.seq === "number" && typeof obj.sum === "string") {
      return obj as NuclearEntry;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Classification helpers ────────────────────────────────────────

/** Check if a nuclear entry represents a read-only action (should be dropped). */
export function isReadOnly(entry: NuclearEntry): boolean {
  return entry.kind === "tool" && entry.tool != null && READ_ONLY_TOOLS.has(entry.tool);
}

// ── Internal helpers ──────────────────────────────────────────────

function truncate(text: string, maxLen: number): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + "..." : oneLine;
}

function findLastTool(entries: NuclearEntry[]): NuclearEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.kind === "tool") return entries[i];
  }
  return undefined;
}

function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "bash":
      return `bash: ${truncate(String(args.command ?? ""), 60)}`;
    case "user_shell":
      return `user_shell: ${truncate(String(args.command ?? ""), 60)}`;
    case "edit_file":
      return `edit_file ${args.path ?? ""}`;
    case "write_file":
    case "write":
      return `write_file ${args.path ?? args.file_path ?? ""}`;
    case "read_file":
      return `read_file ${args.path ?? args.file_path ?? ""}`;
    case "grep":
      return `grep "${truncate(String(args.pattern ?? ""), 30)}"`;
    case "glob":
      return `glob ${args.pattern ?? ""}`;
    case "ls":
      return `ls ${args.path ?? "."}`;
    case "display":
      return `display: ${truncate(String(args.command ?? ""), 60)}`;
    default:
      return `${name}`;
  }
}

function enrichWithResult(toolName: string, summary: string, result: string): string {
  const lines = result.split("\n");
  const lineCount = lines.length;

  switch (toolName) {
    case "bash":
    case "user_shell": {
      // Extract exit code from result if present
      const exitMatch = result.match(/exit code[:\s]*(\d+)/i) ?? result.match(/exit\s+(\d+)/);
      const exitCode = exitMatch ? exitMatch[1] : "0";
      return `${summary} (exit ${exitCode}, ${lineCount} lines)`;
    }
    case "edit_file":
    case "edit": {
      // Try to extract +/- counts from result
      const addMatch = result.match(/\+(\d+)/);
      const delMatch = result.match(/-(\d+)/);
      if (addMatch || delMatch) {
        return `${summary} (+${addMatch?.[1] ?? 0}/-${delMatch?.[1] ?? 0})`;
      }
      return `${summary} (edited)`;
    }
    case "write_file":
    case "write": {
      const created = result.toLowerCase().includes("created") ? "created" : "written";
      return `${summary} (${created}, ${lineCount} lines)`;
    }
    default:
      return `${summary} (${lineCount} lines)`;
  }
}
