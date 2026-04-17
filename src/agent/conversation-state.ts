import type { ChatCompletionMessageParam } from "../utils/llm-client.js";
import {
  type NuclearEntry,
  toNuclearEntries,
  formatNuclearLine,
  isReadOnly,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
} from "./nuclear-form.js";
import type { HandlerFunctions } from "../utils/handler-registry.js";

/** Search hit shape returned by the `history:search` handler. */
export interface HistoryHit {
  entry: NuclearEntry;
  line: string;
}

// ── Compact result ───────────────────────────────────────────────

export interface CompactResult {
  before: number;
  after: number;
  evictedCount: number;
  [extra: string]: unknown;
}

// ── Search helpers ────────────────────────────────────────────────

function buildSearchRegex(query: string): RegExp {
  try {
    return new RegExp(query, "i");
  } catch {
    const words = query.split(/\s+/).filter((w) => w.length > 0);
    const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const lookaheads = escaped.map((w) => `(?=.*${w})`).join("");
    return new RegExp(lookaheads, "i");
  }
}

function firstMatchExcerpt(text: string, regex: RegExp): string | null {
  const idx = text.search(regex);
  if (idx === -1) return null;
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  const lineEnd = text.indexOf("\n", idx);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
  if (line.length > 120) {
    const matchInLine = idx - lineStart;
    const start = Math.max(0, matchInLine - 40);
    const end = Math.min(line.length, matchInLine + 80);
    return (start > 0 ? "\u2026" : "") + line.slice(start, end) + (end < line.length ? "\u2026" : "");
  }
  return line;
}

// ── Priority tiers (lower number = evicted first) ─────────────────

const enum Priority {
  /** Large read-only tool results (grep, ls, read_file) — agent can re-read. */
  LOWEST = 0,
  /** Successful tool results with no errors. */
  LOW = 1,
  /** Tool results from write/edit operations. */
  MEDIUM = 2,
  /** User messages, error messages, assistant reasoning. */
  HIGH = 3,
  /** First user message + last N turns — never evicted. */
  PINNED = 4,
}

function recencyWeight(idx: number, total: number): number {
  return Math.max(0.1, 1 - idx / total);
}

/**
 * Conversation state with eager nucleation — shell-history shaped.
 *
 * Every add nucleates into a one-line NuclearEntry and flushes to disk.
 * Compaction evicts turns, replacing them with their nuclear one-liners
 * in context; the originals stay searchable via `conversation_recall`
 * and survive restarts in `~/.agent-sh/history`.
 *
 * Nucleation and history I/O go through advisable handlers — extensions
 * swap strategies without touching this class. When no handlers are
 * provided (subagents, tests), both become no-ops and this becomes a
 * plain message buffer.
 */
export class ConversationState {
  private messages: ChatCompletionMessageParam[] = [];
  private messagesDirty = true;
  private cachedMessagesJson: string | null = null;

  private nuclearEntries: NuclearEntry[] = [];
  private nuclearBySeq = new Map<number, NuclearEntry>();
  private recallArchive = new Map<number, ChatCompletionMessageParam[]>();

  readonly instanceId: string;
  private readonly handlers: HandlerFunctions | null;
  private nextSeq = 1;

  private lastApiTokenCount: number | null = null;
  private lastApiMessageCount: number = 0;

  constructor(handlers?: HandlerFunctions, instanceId: string = "0000") {
    this.handlers = handlers ?? null;
    this.instanceId = instanceId;
  }

  /** Get JSON.stringify of messages, cached until next mutation. */
  private getMessagesJson(): string {
    if (this.messagesDirty || this.cachedMessagesJson === null) {
      this.cachedMessagesJson = JSON.stringify(this.messages);
      this.messagesDirty = false;
    }
    return this.cachedMessagesJson;
  }

  private invalidateMessagesCache(): void {
    this.messagesDirty = true;
    this.cachedMessagesJson = null;
  }

  // ── Message API (with eager nucleation) ───────────────────────

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text });
    this.invalidateMessagesCache();
    this.eagerNucleateUser(text);
  }

  addAssistantMessage(
    content: string | null,
    toolCalls?: { id: string; function: { name: string; arguments: string } }[],
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
    this.invalidateMessagesCache();
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({ role: "tool", tool_call_id: toolCallId, content });
    this.invalidateMessagesCache();
  }

  /** Add tool results as a user message (for inline tool protocol). */
  addToolResultInline(content: string): void {
    this.messages.push({ role: "user", content });
    this.invalidateMessagesCache();
  }

  addSystemNote(text: string): void {
    this.messages.push({ role: "user", content: text });
    this.invalidateMessagesCache();
  }

  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  /**
   * Replace the messages array wholesale — the write side for custom
   * compaction strategies. Invalidates API token baseline since the
   * new array's token count is unknown.
   */
  replaceMessages(messages: ChatCompletionMessageParam[]): void {
    this.messages = messages;
    this.invalidateMessagesCache();
    this.lastApiTokenCount = null;
    this.lastApiMessageCount = 0;
  }

  // ── Eager nucleation (via advisable handlers) ─────────────────

  private eagerNucleateUser(text: string): void {
    if (!this.handlers) return;
    const seq = this.nextSeq++;
    const entry = this.handlers.call("conversation:nucleate-user", text, this.instanceId, seq) as NuclearEntry;
    this.recordNuclearEntry(entry, [{ role: "user", content: text }]);
    this.appendToHistory([entry]);
  }

  /** Nucleate an agent text response. Called by agent-loop when the loop finishes without tool calls. */
  eagerNucleateAgent(text: string): void {
    if (!text || !this.handlers) return;
    const seq = this.nextSeq++;
    const entry = this.handlers.call("conversation:nucleate-agent", text, this.instanceId, seq) as NuclearEntry;
    this.recordNuclearEntry(entry, [{ role: "assistant", content: text }]);
    this.appendToHistory([entry]);
  }

  /** Nucleate tool call results. One entry per tool call, enriched with result. */
  eagerNucleateTools(
    results: Array<{ toolName: string; args: Record<string, unknown>; content: string; isError: boolean }>,
  ): void {
    if (!this.handlers || results.length === 0) return;
    const entries: NuclearEntry[] = [];
    for (const r of results) {
      const seq = this.nextSeq++;
      const entry = this.handlers.call(
        "conversation:nucleate-tool",
        r.toolName, r.args, r.content, r.isError, this.instanceId, seq,
      ) as NuclearEntry;
      entries.push(entry);
      this.recordNuclearEntry(entry, [
        { role: "assistant", content: null, tool_calls: [{ id: `seq_${seq}`, type: "function", function: { name: r.toolName, arguments: JSON.stringify(r.args) } }] },
        { role: "tool", tool_call_id: `seq_${seq}`, content: r.content },
      ]);
    }
    this.appendToHistory(entries);
  }

  /** Track an entry in memory (nuclear list + recall archive). */
  private recordNuclearEntry(entry: NuclearEntry, originalMessages: ChatCompletionMessageParam[]): void {
    this.nuclearEntries.push(entry);
    this.nuclearBySeq.set(entry.seq, entry);
    this.recallArchive.set(entry.seq, originalMessages);
  }

  private appendToHistory(entries: NuclearEntry[]): void {
    if (!this.handlers || entries.length === 0) return;
    this.handlers.call("history:append", entries);
  }

  // ── Token estimation ──────────────────────────────────────────

  updateApiTokenCount(promptTokens: number): void {
    this.lastApiTokenCount = promptTokens;
    this.lastApiMessageCount = this.messages.length;
  }

  estimatePromptTokens(): number {
    if (this.lastApiTokenCount === null) return this.estimateTokens();
    const trailing = this.messages.length - this.lastApiMessageCount;
    if (trailing <= 0) return this.lastApiTokenCount;
    const trailingMessages = this.messages.slice(this.lastApiMessageCount);
    return this.lastApiTokenCount + Math.ceil(JSON.stringify(trailingMessages).length / 4);
  }

  estimateTokens(): number {
    return Math.ceil(this.getMessagesJson().length / 4);
  }

  // ── Compaction (uses pre-computed nuclear entries) ─────────────

  /**
   * Two-tier pin compaction: evict lowest-priority turns (replaced by
   * their nuclear one-liners), slim the window before the last verbatim
   * turn, drop read-only tool results entirely. Extensions replace the
   * whole strategy by advising `conversation:compact` and skipping next.
   */
  compact(maxPromptTokens: number, recentTurnsToKeep = 10, force = false): CompactResult | null {
    const promptEstimate = this.estimatePromptTokens();
    const convEstimate = this.estimateTokens();
    const overhead = promptEstimate - convEstimate;
    const convTarget = Math.max(0, maxPromptTokens - overhead);

    const before = promptEstimate;
    if (!force && convEstimate <= convTarget) return null;

    const turns = this.parseTurns();
    if (turns.length <= 2) return null;

    // Cap the pinned window so enough turns remain evictable.
    const maxPinnedFraction = force ? 0.4 : 0.6;
    const maxPinned = Math.max(2, Math.floor(turns.length * maxPinnedFraction));
    const pinnedCount = Math.min(recentTurnsToKeep, turns.length - 1, maxPinned);
    for (let i = 0; i < turns.length; i++) {
      turns[i]!.priority = this.inferPriority(turns[i]!.messages);
    }

    // Two-tier pin: last turn verbatim, next (pinnedCount-1) slimmed.
    const verbatimCount = 1;
    const slimmedCount = Math.max(0, pinnedCount - verbatimCount);
    const slimStart = turns.length - pinnedCount;
    const slimEnd = slimStart + slimmedCount;
    const slimmedIndices = new Set<number>();
    for (let i = slimStart; i < slimEnd; i++) slimmedIndices.add(i);

    turns[0]!.priority = Priority.PINNED;
    for (let i = turns.length - verbatimCount; i < turns.length; i++) turns[i]!.priority = Priority.PINNED;
    for (const i of slimmedIndices) turns[i]!.priority = Priority.PINNED;

    const candidates = turns
      .map((t, idx) => ({ turn: t, idx }))
      .filter((c) => c.turn.priority !== Priority.PINNED)
      .sort((a, b) => {
        const effA = a.turn.priority * recencyWeight(a.idx, turns.length);
        const effB = b.turn.priority * recencyWeight(b.idx, turns.length);
        return effA - effB || a.idx - b.idx;
      });

    const evictedIndices = new Set<number>();
    let currentTokens = convEstimate;

    for (const c of candidates) {
      if (currentTokens <= convTarget) break;
      const turnTokens = Math.ceil(JSON.stringify(c.turn.messages).length / 4);
      evictedIndices.add(c.idx);
      currentTokens -= turnTokens;

      // Fallback for turn messages that missed eager nucleation (e.g.
      // injected system notes). Entries already nucleated live in
      // nuclearEntries under their original seqs.
      const turnEntries = toNuclearEntries(c.turn.messages, this.nextSeq, this.instanceId);
      this.nextSeq += turnEntries.length;

      for (const entry of turnEntries) {
        if (isReadOnly(entry)) {
          this.recallArchive.set(entry.seq, c.turn.messages);
        } else {
          this.nuclearEntries.push(entry);
          this.nuclearBySeq.set(entry.seq, entry);
          this.recallArchive.set(entry.seq, c.turn.messages);
        }
      }
    }

    if (evictedIndices.size === 0) return null;

    const rebuilt: ChatCompletionMessageParam[] = [];
    let insertedNuclearBlock = false;
    for (let i = 0; i < turns.length; i++) {
      if (evictedIndices.has(i)) {
        if (!insertedNuclearBlock) {
          rebuilt.push(this.buildNuclearBlock());
          insertedNuclearBlock = true;
        }
      } else if (slimmedIndices.has(i)) {
        rebuilt.push(...this.slimTurn(turns[i]!.messages));
      } else {
        rebuilt.push(...turns[i]!.messages);
      }
    }

    if (!insertedNuclearBlock && this.nuclearEntries.length > 0) {
      this.updateNuclearBlockInMessages(rebuilt);
    }

    this.messages = rebuilt;
    this.invalidateMessagesCache();
    // Preserve system+tools+dynamic overhead so estimatePromptTokens() stays
    // full-prompt-accurate until the next API call refines it. Nulling here
    // caused /context to under-report by ~overhead tokens after every compact.
    const after = overhead + this.estimateTokens();
    this.lastApiTokenCount = after;
    this.lastApiMessageCount = this.messages.length;
    return {
      before,
      after,
      evictedCount: evictedIndices.size,
    };
  }

  // ── Startup: Load prior history ───────────────────────────────

  /**
   * Inject prior session history as a context preamble. The preamble
   * layout goes through the `conversation:format-prior-history` handler,
   * so extensions can swap the flat list for grouped/richer rendering.
   */
  loadPriorHistory(entries: NuclearEntry[]): void {
    if (entries.length === 0 || !this.handlers) return;
    const maxSeq = Math.max(...entries.map((e) => e.seq));
    if (maxSeq >= this.nextSeq) this.nextSeq = maxSeq + 1;

    const content = this.handlers.call("conversation:format-prior-history", entries) as string | null;
    if (!content) return;
    this.messages.push({ role: "user", content });
    this.invalidateMessagesCache();
  }

  // ── Conversation recall ───────────────────────────────────────

  async search(query: string): Promise<string> {
    if (!query.trim()) return "No query provided.";
    const regex = buildSearchRegex(query);
    const seenSeqs = new Set<number>();
    const hits: string[] = [];

    for (const [seq, msgs] of this.recallArchive) {
      const text = this.turnToText(msgs);
      const excerpt = firstMatchExcerpt(text, regex);
      if (excerpt) {
        seenSeqs.add(seq);
        const entry = this.nuclearBySeq.get(seq);
        const header = entry ? formatNuclearLine(entry) : `#${seq}`;
        hits.push(`${header}\n  ${excerpt}`);
      }
    }

    const fileResults = this.handlers
      ? ((await this.handlers.call("history:search", query)) as HistoryHit[] | undefined)
      : undefined;
    if (fileResults) {
      for (const r of fileResults) {
        if (seenSeqs.has(r.entry.seq)) continue;
        seenSeqs.add(r.entry.seq);
        const excerpt = r.entry.body ? firstMatchExcerpt(r.entry.body, regex) : null;
        hits.push(excerpt ? `${r.line}\n  ${excerpt}` : r.line);
      }
    }

    if (hits.length === 0) return `No results found for "${query}".`;
    const total = hits.length;
    const summary = `Found ${total} match${total === 1 ? "" : "es"} for "${query}"`;
    return `${summary}\n\n${hits.slice(0, 30).join("\n\n")}`;
  }

  async expand(seq: number): Promise<string> {
    const archived = this.recallArchive.get(seq);
    if (archived) {
      const entry = this.nuclearBySeq.get(seq);
      const header = entry ? formatNuclearLine(entry) : `#${seq}`;
      return `${header}\n\n${this.turnToText(archived)}`;
    }
    if (this.handlers) {
      const entry = (await this.handlers.call("history:find-by-seq", seq)) as NuclearEntry | null | undefined;
      if (entry?.body) return `${formatNuclearLine(entry)}\n\n${entry.body}`;
    }
    return `Entry #${seq}: no expanded content available.`;
  }

  async browse(): Promise<string> {
    const parts: string[] = [];
    if (this.nuclearEntries.length > 0) {
      parts.push("In-context nuclear entries:");
      for (const e of this.nuclearEntries) parts.push(`  ${formatNuclearLine(e)}`);
    }
    const recent = this.handlers
      ? ((await this.handlers.call("history:read-recent", 25)) as NuclearEntry[] | undefined)
      : undefined;
    if (recent && recent.length > 0) {
      parts.push("\nRecent history file entries:");
      for (const e of recent) parts.push(`  ${formatNuclearLine(e)}`);
    }
    if (parts.length === 0) return "No conversation history.";
    return parts.join("\n");
  }

  // ── Stats ─────────────────────────────────────────────────────

  getNuclearEntries(): readonly NuclearEntry[] {
    return this.nuclearEntries;
  }

  getNuclearEntryCount(): number {
    return this.nuclearEntries.length;
  }

  getNuclearSummary(): string | null {
    if (this.nuclearEntries.length === 0) return null;
    return this.nuclearEntries.map(formatNuclearLine).join("\n");
  }

  getRecallArchiveSize(): number {
    return this.recallArchive.size;
  }

  // ── Clear ─────────────────────────────────────────────────────

  clear(): void {
    this.messages = [];
    this.nuclearEntries = [];
    this.nuclearBySeq.clear();
    this.recallArchive.clear();
    this.invalidateMessagesCache();
    this.lastApiTokenCount = null;
    this.lastApiMessageCount = 0;
  }

  // ── Internal: Nuclear block management ────────────────────────

  private buildNuclearBlock(): ChatCompletionMessageParam {
    const lines = this.nuclearEntries.map(formatNuclearLine);
    return {
      role: "user",
      content: `[Conversation history — use conversation_recall to expand any entry]\n${lines.join("\n")}`,
    };
  }

  private updateNuclearBlockInMessages(messages: ChatCompletionMessageParam[]): void {
    if (this.nuclearEntries.length === 0) return;
    const marker = "[Conversation history — use conversation_recall";
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.role === "user" && typeof msg.content === "string" && msg.content.startsWith(marker)) {
        messages[i] = this.buildNuclearBlock();
        return;
      }
    }
    if (messages.length > 0) {
      let insertIdx = 1;
      for (let i = 1; i < messages.length; i++) {
        if (messages[i]!.role === "user") { insertIdx = i; break; }
        insertIdx = i + 1;
      }
      messages.splice(insertIdx, 0, this.buildNuclearBlock());
    }
  }

  // ── Internal: Two-tier pin for recent turns ────────────────────

  private slimTurn(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    const MAX_RESULT_LEN = 1500;
    const result: ChatCompletionMessageParam[] = [];
    const readOnlyToolIds = new Set<string>();

    for (const msg of messages) {
      if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        const kept = msg.tool_calls.filter((tc) => {
          if (!("function" in tc)) return true;
          if (READ_ONLY_TOOLS.has(tc.function.name)) {
            readOnlyToolIds.add(tc.id);
            return false;
          }
          return true;
        });
        if (kept.length === 0) {
          const { tool_calls: _, ...rest } = msg;
          result.push(rest);
        } else {
          result.push({ ...msg, tool_calls: kept });
        }
        continue;
      }
      if (msg.role === "tool") {
        if (readOnlyToolIds.has(msg.tool_call_id)) continue;
        const content = typeof msg.content === "string" ? msg.content : "";
        if (content.length > MAX_RESULT_LEN) {
          result.push({ ...msg, content: content.slice(0, MAX_RESULT_LEN) + "\n... [truncated by compact]" });
        } else {
          result.push(msg);
        }
        continue;
      }
      result.push(msg);
    }
    return result;
  }

  // ── Internal: Turn parsing and priority ───────────────────────

  private parseTurns(): { messages: ChatCompletionMessageParam[]; priority: Priority }[] {
    const turns: { messages: ChatCompletionMessageParam[]; priority: Priority }[] = [];
    let current: ChatCompletionMessageParam[] = [];
    for (const msg of this.messages) {
      if (msg.role === "user" && current.length > 0) {
        turns.push({ messages: current, priority: Priority.MEDIUM });
        current = [];
      }
      current.push(msg);
    }
    if (current.length > 0) turns.push({ messages: current, priority: Priority.MEDIUM });
    return turns;
  }

  private inferPriority(messages: ChatCompletionMessageParam[]): Priority {
    let hasError = false;
    let hasWriteTool = false;
    let allReadOnly = true;
    let hasToolResult = false;

    for (const msg of messages) {
      if (msg.role === "user") return Priority.HIGH;
      if (msg.role === "tool") {
        hasToolResult = true;
        const content = typeof msg.content === "string" ? msg.content : "";
        if (content.startsWith("Error:") || content.includes("error")) hasError = true;
      }
      if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const fn = "function" in tc ? tc.function : undefined;
          if (!fn) continue;
          if (WRITE_TOOLS.has(fn.name)) hasWriteTool = true;
          if (!READ_ONLY_TOOLS.has(fn.name)) allReadOnly = false;
        }
      }
    }

    if (hasError) return Priority.HIGH;
    if (hasWriteTool) return Priority.MEDIUM;
    if (hasToolResult && allReadOnly) return Priority.LOWEST;
    if (hasToolResult) return Priority.LOW;
    return Priority.MEDIUM;
  }

  private turnToText(messages: ChatCompletionMessageParam[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      if (msg.role === "user") {
        lines.push(`[user] ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`);
      } else if (msg.role === "assistant") {
        if (typeof msg.content === "string" && msg.content) lines.push(`[assistant] ${msg.content}`);
        if ("tool_calls" in msg && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if ("function" in tc) lines.push(`[tool_call] ${tc.function.name}(${tc.function.arguments})`);
          }
        }
      } else if (msg.role === "tool") {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        lines.push(`[tool_result] ${content}`);
      }
    }
    return lines.join("\n");
  }
}
