import type { ChatCompletionMessageParam } from "../utils/llm-client.js";
import { getSettings } from "../settings.js";
import {
  type NuclearEntry,
  nucleate,
  toNuclearEntries,
  formatNuclearLine,
  isReadOnly,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
} from "./nuclear-form.js";
import type { HistoryFile } from "./history-file.js";

// ── Search helpers (module-level) ─────────────────────────────

/** Build a regex that requires ALL words in the query to match (AND logic). */
function buildSearchRegex(query: string): RegExp {
  // Try the raw query as-is first (supports exact phrases and advanced syntax)
  try {
    return new RegExp(query, "i");
  } catch {
    // Fallback: escape each word and require all to match via lookahead
    const words = query.split(/\s+/).filter((w) => w.length > 0);
    const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // (?=.*word1)(?=.*word2)... matches lines containing all words
    const lookaheads = escaped.map((w) => `(?=.*${w})`).join("");
    return new RegExp(lookaheads, "i");
  }
}

/** Extract first matching line with surrounding context (120 chars centered on match). */
function firstMatchExcerpt(text: string, regex: RegExp): string | null {
  const idx = text.search(regex);
  if (idx === -1) return null;
  // Find the start of the line containing the match
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


/**
 * Conversation state with eager nucleation — works like shell history.
 *
 * Three stores:
 *   LLM context   — full messages + nuclear block (session-only)
 *   In-session mem — full original messages in recallArchive (session-only)
 *   History file   — nuclear entries (JSONL, persistent)
 *
 * Every message is nucleated eagerly on arrival → appended to disk.
 * Compaction evicts from LLM context, replacing with pre-computed nuclear
 * entries. Session end → nuclear entries survive on disk, memory is lost.
 */

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

export class ConversationState {
  // ── LLM context ───────────────────────────────────────────────
  private messages: ChatCompletionMessageParam[] = [];

  // ── Nuclear entries (pre-computed, used by compact) ────────────
  private nuclearEntries: NuclearEntry[] = [];
  /** Map from seq → nuclear entry for lookup during compact. */
  private nuclearBySeq = new Map<number, NuclearEntry>();

  // ── In-session memory (ephemeral) ─────────────────────────────
  private recallArchive = new Map<number, ChatCompletionMessageParam[]>();

  // ── History file reference ────────────────────────────────────
  private historyFile: HistoryFile | null;

  // ── Shared state ──────────────────────────────────────────────
  private nextSeq = 1;

  // ── Token tracking ────────────────────────────────────────────
  /** Last known token count from the API (prompt_tokens). null until first response. */
  private lastApiTokenCount: number | null = null;
  /** Number of messages in the array when lastApiTokenCount was recorded. */
  private lastApiMessageCount: number = 0;

  constructor(historyFile?: HistoryFile) {
    this.historyFile = historyFile ?? null;
  }

  get instanceId(): string {
    return this.historyFile?.instanceId ?? "0000";
  }

  // ── Message API (with eager nucleation) ───────────────────────

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text });
    this.eagerNucleateUser(text);
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

  /** Add tool results as a user message (for inline tool protocol). */
  addToolResultInline(content: string): void {
    this.messages.push({ role: "user", content });
  }

  addSystemNote(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  // ── Eager nucleation ──────────────────────────────────────────

  /** Nucleate a user query — called from addUserMessage. */
  private eagerNucleateUser(text: string): void {
    const seq = this.nextSeq++;
    const entry = nucleate("user", text, this.instanceId, seq);
    this.nuclearEntries.push(entry);
    this.nuclearBySeq.set(seq, entry);
    this.recallArchive.set(seq, [{ role: "user", content: text }]);
    this.appendToFile([entry]);
  }

  /**
   * Nucleate an agent text response. Called by agent-loop when the loop
   * finishes without tool calls.
   */
  eagerNucleateAgent(text: string): void {
    if (!text) return;
    const seq = this.nextSeq++;
    const entry = nucleate("agent", text, this.instanceId, seq);
    this.nuclearEntries.push(entry);
    this.nuclearBySeq.set(seq, entry);
    this.recallArchive.set(seq, [{ role: "assistant", content: text }]);
    this.appendToFile([entry]);
  }

  /**
   * Nucleate tool call results. Called by agent-loop after all tool results
   * are collected. One entry per tool call, enriched with result.
   */
  eagerNucleateTools(
    results: Array<{ toolName: string; args: Record<string, unknown>; content: string; isError: boolean }>,
  ): void {
    const entries: NuclearEntry[] = [];
    for (const r of results) {
      const seq = this.nextSeq++;
      const entry = nucleate(
        r.isError ? "error" : "tool",
        r.toolName,
        r.args,
        r.content,
        r.isError,
        this.instanceId,
        seq,
      );
      entries.push(entry);
      this.nuclearEntries.push(entry);
      this.nuclearBySeq.set(seq, entry);
      // Store minimal turn in recall archive
      this.recallArchive.set(seq, [
        { role: "assistant", content: null, tool_calls: [{ id: `seq_${seq}`, type: "function", function: { name: r.toolName, arguments: JSON.stringify(r.args) } }] },
        { role: "tool", tool_call_id: `seq_${seq}`, content: r.content },
      ]);
    }
    this.appendToFile(entries);
  }

  private appendToFile(entries: NuclearEntry[]): void {
    if (!this.historyFile || entries.length === 0) return;
    // Skip read-only tools (read_file, grep, glob, ls) — they bloat the
    // file without adding searchable value since the agent can re-run them.
    const writable = entries.filter((e) => !isReadOnly(e));
    if (writable.length > 0) {
      // Fire-and-forget — don't block the conversation flow
      this.historyFile.append(writable).catch(() => {});
    }
  }

  // ── Token estimation ──────────────────────────────────────────

  /**
   * Update the token count baseline from an API response.
   * `promptTokens` is the total input tokens (system prompt + context + messages).
   */
  updateApiTokenCount(promptTokens: number): void {
    this.lastApiTokenCount = promptTokens;
    this.lastApiMessageCount = this.messages.length;
  }

  /**
   * Estimate total tokens the next API call will consume.
   *
   * This includes everything: system prompt, dynamic context, tool definitions,
   * and conversation messages. When API usage data is available, it uses the
   * real prompt_tokens as a baseline and only estimates the delta for messages
   * added since. Falls back to chars/4 if no API data yet.
   *
   * Should be compared against the model's context window.
   */
  estimatePromptTokens(): number {
    if (this.lastApiTokenCount === null) {
      return this.estimateTokens();
    }

    const trailing = this.messages.length - this.lastApiMessageCount;
    if (trailing <= 0) {
      return this.lastApiTokenCount;
    }

    const trailingMessages = this.messages.slice(this.lastApiMessageCount);
    return this.lastApiTokenCount + Math.ceil(JSON.stringify(trailingMessages).length / 4);
  }

  /**
   * Rough conversation-only token estimate (chars/4 heuristic).
   * Used internally by compact() for eviction bookkeeping, and for stats.
   */
  estimateTokens(): number {
    return Math.ceil(JSON.stringify(this.messages).length / 4);
  }

  // ── Compaction (uses pre-computed nuclear entries) ─────────────

  /**
   * Priority-based compaction. Evicts lowest-priority turns, replacing
   * them with their pre-computed nuclear one-liner summaries.
   * Read-only tool results are dropped entirely from context.
   *
   * @param maxPromptTokens  Target ceiling for total prompt tokens
   *                         (system + context + conversation). Internally
   *                         converted to a conversation-only target.
   */
  compact(maxPromptTokens: number, recentTurnsToKeep = 10, force = false): { before: number; after: number } | null {
    // Convert total-prompt target to conversation-only target.
    // overhead = prompt total - conversation estimate (both approximate,
    // but the ratio is stable since both share the same messages array).
    const promptEstimate = this.estimatePromptTokens();
    const convEstimate = this.estimateTokens();
    const overhead = promptEstimate - convEstimate;
    const convTarget = Math.max(0, maxPromptTokens - overhead);

    const before = convEstimate;
    if (!force && before <= convTarget) return null;

    const turns = this.parseTurns();
    if (turns.length <= 2) return null;

    // Cap the pinned window so at least ~40% of turns are evictable.
    // Without this, sessions with few turns but large tool outputs would have
    // everything pinned and nothing to compact — the user sees high usage but
    // gets "nothing to compact". When force=true, be more aggressive (60% evictable).
    const maxPinnedFraction = force ? 0.4 : 0.6;
    const maxPinned = Math.max(2, Math.floor(turns.length * maxPinnedFraction));
    const pinnedCount = Math.min(recentTurnsToKeep, turns.length - 1, maxPinned);
    for (let i = 0; i < turns.length; i++) {
      turns[i]!.priority = this.inferPriority(turns[i]!.messages);
    }
    // Two-tier pin: last turn verbatim, next (pinnedCount-1) slimmed
    const verbatimCount = 1;
    const slimmedCount = Math.max(0, pinnedCount - verbatimCount);
    const slimStart = turns.length - pinnedCount;
    const slimEnd = slimStart + slimmedCount;
    const slimmedIndices = new Set<number>();
    for (let i = slimStart; i < slimEnd; i++) {
      slimmedIndices.add(i);
    }
    // Pin first turn and last verbatim turn (not evictable)
    turns[0]!.priority = Priority.PINNED;
    for (let i = turns.length - verbatimCount; i < turns.length; i++) {
      turns[i]!.priority = Priority.PINNED;
    }
    // Slimmed turns are also not evictable — they'll be trimmed, not removed
    for (const i of slimmedIndices) {
      turns[i]!.priority = Priority.PINNED;
    }

    // Sort candidates: lowest effective priority first (base * recency), then oldest
    const candidates = turns
      .map((t, idx) => ({ turn: t, idx }))
      .filter((c) => c.turn.priority !== Priority.PINNED)
      .sort((a, b) => {
        const effA = a.turn.priority * recencyWeight(a.idx, turns.length);
        const effB = b.turn.priority * recencyWeight(b.idx, turns.length);
        return effA - effB || a.idx - b.idx;
      });

    // Evict until under budget — use pre-computed nuclear entries
    const evictedIndices = new Set<number>();
    let currentTokens = this.estimateTokens();

    for (const c of candidates) {
      if (currentTokens <= convTarget) break;
      const turnTokens = Math.ceil(JSON.stringify(c.turn.messages).length / 4);
      evictedIndices.add(c.idx);
      currentTokens -= turnTokens;

      // Generate nuclear entries from this turn ONLY if not already nucleated.
      // This handles the case where messages were added before eager nucleation
      // was wired up (e.g. loadPriorHistory).
      const turnEntries = toNuclearEntries(c.turn.messages, this.nextSeq, this.instanceId);
      this.nextSeq += turnEntries.length;

      for (const entry of turnEntries) {
        if (isReadOnly(entry)) {
          // Read-only: archive only (dropped from conversation), agent can re-read
          this.recallArchive.set(entry.seq, c.turn.messages);
        } else {
          // State-changing: keep nuclear one-liner in conversation + archive
          this.nuclearEntries.push(entry);
          this.nuclearBySeq.set(entry.seq, entry);
          this.recallArchive.set(entry.seq, c.turn.messages);
        }
      }
    }

    if (evictedIndices.size === 0) return null;

    // Rebuild: first turn + nuclear block + slimmed turns + verbatim last turn
    const rebuilt: ChatCompletionMessageParam[] = [];
    let insertedNuclearBlock = false;
    this.nuclearBlockIdx = -1; // reset — rebuilt is a new array

    for (let i = 0; i < turns.length; i++) {
      if (evictedIndices.has(i)) {
        if (!insertedNuclearBlock) {
          const block = this.buildNuclearBlock();
          this.nuclearBlockIdx = rebuilt.length;
          rebuilt.push(block);
          insertedNuclearBlock = true;
        }
      } else if (slimmedIndices.has(i)) {
        rebuilt.push(...this.slimTurn(turns[i]!.messages));
      } else {
        rebuilt.push(...turns[i]!.messages);
      }
    }

    // If no nuclear block was inserted but we have entries from prior compactions,
    // update the existing nuclear block
    if (!insertedNuclearBlock && this.nuclearEntries.length > 0) {
      this.updateNuclearBlockInMessages(rebuilt);
    }

    this.messages = rebuilt;
    // Reset API token baseline — messages changed, old count is stale.
    // The next API response will provide a fresh baseline.
    this.lastApiTokenCount = null;
    this.lastApiMessageCount = 0;
    return { before, after: this.estimateTokens() };
  }

  // ── Startup: Load prior history ───────────────────────────────

  /**
   * Inject prior session history from the history file as a context note.
   */
  loadPriorHistory(entries: NuclearEntry[]): void {
    if (entries.length === 0) return;
    // Update nextSeq to avoid collisions
    const maxSeq = Math.max(...entries.map((e) => e.seq));
    if (maxSeq >= this.nextSeq) this.nextSeq = maxSeq + 1;

    const lines = entries.map(formatNuclearLine);
    this.messages.push({
      role: "user",
      content: `[Prior session history — loaded from ~/.agent-sh/history]\n${lines.join("\n")}`,
    });
  }

  // ── Conversation recall ───────────────────────────────────────

  /** Search in-memory archive + history file (deduplicated, with match context). */
  async search(query: string): Promise<string> {
    if (!query.trim()) return "No query provided.";

    const regex = buildSearchRegex(query);
    const seenSeqs = new Set<number>();
    const hits: string[] = [];

    // Search in-memory archive (full content)
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

    // Search history file (skip seqs already found in archive)
    if (this.historyFile) {
      const fileResults = await this.historyFile.search(query);
      for (const r of fileResults) {
        if (seenSeqs.has(r.entry.seq)) continue;
        seenSeqs.add(r.entry.seq);
        const excerpt = r.entry.body
          ? firstMatchExcerpt(r.entry.body, regex)
          : null;
        hits.push(excerpt ? `${r.line}\n  ${excerpt}` : r.line);
      }
    }

    if (hits.length === 0) return `No results found for "${query}".`;

    const total = hits.length;
    const summary = `Found ${total} match${total === 1 ? "" : "es"} for "${query}"`;
    return `${summary}\n\n${hits.slice(0, 30).join("\n\n")}`;
  }

  /** Expand full content of a nuclear entry by seq number. */
  async expand(seq: number): Promise<string> {
    // Try in-session memory first (full content)
    const archived = this.recallArchive.get(seq);
    if (archived) {
      const entry = this.nuclearBySeq.get(seq);
      const header = entry ? formatNuclearLine(entry) : `#${seq}`;
      return `${header}\n\n${this.turnToText(archived)}`;
    }

    // Fall back to history file body field
    if (this.historyFile) {
      const entry = await this.historyFile.findBySeq(seq);
      if (entry?.body) return `${formatNuclearLine(entry)}\n\n${entry.body}`;
    }

    return `Entry #${seq}: no expanded content available.`;
  }

  /** Browse nuclear entries (in-context) + recent history file. */
  async browse(): Promise<string> {
    const parts: string[] = [];

    if (this.nuclearEntries.length > 0) {
      parts.push("In-context nuclear entries:");
      for (const e of this.nuclearEntries) {
        parts.push(`  ${formatNuclearLine(e)}`);
      }
    }

    if (this.historyFile) {
      const recent = await this.historyFile.readRecent(25);
      if (recent.length > 0) {
        parts.push("\nRecent history file entries:");
        for (const e of recent) {
          parts.push(`  ${formatNuclearLine(e)}`);
        }
      }
    }

    if (parts.length === 0) return "No conversation history.";
    return parts.join("\n");
  }

  // ── Stats ─────────────────────────────────────────────────────

  getNuclearEntryCount(): number {
    return this.nuclearEntries.length;
  }

  /** Formatted nuclear summary text (one line per entry), or null if empty. */
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
  }

  // ── Internal: Nuclear block management ────────────────────────

  private buildNuclearBlock(): ChatCompletionMessageParam {
    const lines = this.nuclearEntries.map(formatNuclearLine);
    return {
      role: "user",
      content: `[Conversation history — use conversation_recall to expand any entry]\n${lines.join("\n")}`,
    };
  }

  /** Index of the nuclear block in messages[], or -1 if not present. */
  private nuclearBlockIdx = -1;

  private updateNuclearBlockInMessages(messages: ChatCompletionMessageParam[]): void {
    if (this.nuclearEntries.length === 0) return;
    const marker = "[Conversation history — use conversation_recall";
    const newBlock = this.buildNuclearBlock();

    // Fast path: if we know the index, update in place
    if (this.nuclearBlockIdx >= 0 && this.nuclearBlockIdx < messages.length) {
      messages[this.nuclearBlockIdx] = newBlock;
      return;
    }

    // Slow path: scan for the marker (only on first compaction)
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg.role === "user" && typeof msg.content === "string" && msg.content.startsWith(marker)) {
        this.nuclearBlockIdx = i;
        messages[i] = newBlock;
        return;
      }
    }
    // No existing block found — insert after the first turn
    if (messages.length > 0) {
      let insertIdx = 1;
      for (let i = 1; i < messages.length; i++) {
        if (messages[i]!.role === "user") { insertIdx = i; break; }
        insertIdx = i + 1;
      }
      messages.splice(insertIdx, 0, newBlock);
      this.nuclearBlockIdx = insertIdx;
    }
  }

  // ── Internal: Two-tier pin for recent turns ────────────────────

  /**
   * Slim down a turn's messages for the "second tier" of the recent window.
   * - Drops read-only tool call/results (read_file, grep, glob, ls, search)
   * - Truncates remaining tool results to ~500 chars
   * - Keeps user/assistant messages intact
   */
  private slimTurn(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
    const MAX_RESULT_LEN = 1500;
    const result: ChatCompletionMessageParam[] = [];

    // Collect tool_call ids that are read-only so we can skip their results
    const readOnlyToolIds = new Set<string>();

    for (const msg of messages) {
      // Assistant message with tool calls — filter out read-only tools
      if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        const kept = msg.tool_calls.filter((tc) => {
          if (!("function" in tc)) return true; // keep custom tool calls
          if (READ_ONLY_TOOLS.has(tc.function.name)) {
            readOnlyToolIds.add(tc.id);
            return false;
          }
          return true;
        });
        if (kept.length === 0) {
          // All calls were read-only — drop the tool_calls field entirely
          const { tool_calls: _, ...rest } = msg;
          result.push(rest);
        } else {
          result.push({ ...msg, tool_calls: kept });
        }
        continue;
      }

      // Tool result — skip if read-only, truncate otherwise
      if (msg.role === "tool") {
        if (readOnlyToolIds.has(msg.tool_call_id)) continue;
        const content = typeof msg.content === "string" ? msg.content : "";
        if (content.length > MAX_RESULT_LEN) {
          result.push({
            ...msg,
            content: content.slice(0, MAX_RESULT_LEN) + "\n... [truncated by compact]",
          });
        } else {
          result.push(msg);
        }
        continue;
      }

      // User / assistant text — keep intact
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
    if (current.length > 0) {
      turns.push({ messages: current, priority: Priority.MEDIUM });
    }

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
        if (content.startsWith("Error:")) {
          hasError = true;
        }
      }

      if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const fn = "function" in tc ? tc.function : undefined;
          if (!fn) continue;
          const name = fn.name;
          if (WRITE_TOOLS.has(name)) hasWriteTool = true;
          if (!READ_ONLY_TOOLS.has(name)) allReadOnly = false;
        }
      }
    }

    if (hasError) return Priority.HIGH;
    if (hasWriteTool) return Priority.MEDIUM;
    if (hasToolResult && allReadOnly) return Priority.LOWEST;
    if (hasToolResult) return Priority.LOW;
    return Priority.MEDIUM;
  }

  // ── Internal: Search helpers ──────────────────────────────────

  // ── searchArchive removed — search() now directly iterates recallArchive ──

  private turnToText(messages: ChatCompletionMessageParam[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      if (msg.role === "user") {
        lines.push(`[user] ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`);
      } else if (msg.role === "assistant") {
        if (typeof msg.content === "string" && msg.content) {
          lines.push(`[assistant] ${msg.content}`);
        }
        if ("tool_calls" in msg && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if ("function" in tc) {
              lines.push(`[tool_call] ${tc.function.name}(${tc.function.arguments})`);
            }
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

// ── Recency weighting ────────────────────────────────────────────

function recencyWeight(idx: number, total: number): number {
  return Math.max(0.1, 1 - idx / total);
}
