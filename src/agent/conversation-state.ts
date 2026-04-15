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
    if (this.historyFile && entries.length > 0) {
      // Fire-and-forget — don't block the conversation flow
      this.historyFile.append(entries).catch(() => {});
    }
  }

  // ── Token estimation ──────────────────────────────────────────

  estimateTokens(): number {
    return Math.ceil(JSON.stringify(this.messages).length / 4);
  }

  // ── Compaction (uses pre-computed nuclear entries) ─────────────

  /**
   * Priority-based compaction. Evicts lowest-priority turns, replacing
   * them with their pre-computed nuclear one-liner summaries.
   * Read-only tool results are dropped entirely from context.
   */
  compact(targetTokens: number, recentTurnsToKeep = 10, force = false): { before: number; after: number } | null {
    const before = this.estimateTokens();
    if (!force && before <= targetTokens) return null;

    const turns = this.parseTurns();
    if (turns.length <= 2) return null;

    // Assign priorities with recency weighting
    const pinnedCount = Math.min(recentTurnsToKeep, turns.length - 1);
    for (let i = 0; i < turns.length; i++) {
      turns[i]!.priority = this.inferPriority(turns[i]!.messages);
    }
    turns[0]!.priority = Priority.PINNED;
    for (let i = turns.length - pinnedCount; i < turns.length; i++) {
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
      if (currentTokens <= targetTokens) break;
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

    // Rebuild: first turn + nuclear summary block + remaining turns
    const rebuilt: ChatCompletionMessageParam[] = [];
    let insertedNuclearBlock = false;

    for (let i = 0; i < turns.length; i++) {
      if (evictedIndices.has(i)) {
        if (!insertedNuclearBlock) {
          rebuilt.push(this.buildNuclearBlock());
          insertedNuclearBlock = true;
        }
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

  /** Search in-memory archive + history file. */
  async search(query: string): Promise<string> {
    if (!query.trim()) return "No query provided.";

    const parts: string[] = [];

    // Search in-memory archive
    const archiveResults = this.searchArchive(query);
    if (archiveResults) parts.push(archiveResults);

    // Search history file
    if (this.historyFile) {
      const fileResults = await this.historyFile.search(query);
      if (fileResults.length > 0) {
        parts.push(`History file matches (${fileResults.length}):`);
        for (const r of fileResults.slice(0, 20)) {
          parts.push(`  ${r.line}`);
        }
      }
    }

    if (parts.length === 0) return `No results found for "${query}".`;
    return parts.join("\n\n");
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
    // No existing block found — insert after the first turn
    if (messages.length > 0) {
      // Find end of first turn (next user message or end)
      let insertIdx = 1;
      for (let i = 1; i < messages.length; i++) {
        if (messages[i]!.role === "user") { insertIdx = i; break; }
        insertIdx = i + 1;
      }
      messages.splice(insertIdx, 0, this.buildNuclearBlock());
    }
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
        if (content.startsWith("Error:") || content.includes("error")) {
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

  private searchArchive(query: string): string | null {
    if (this.recallArchive.size === 0) return null;

    let regex: RegExp;
    try {
      regex = new RegExp(query, "i");
    } catch {
      const words = query.split(/\s+/).filter((w) => w.length > 0);
      const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      regex = new RegExp(pattern, "i");
    }

    const matches: string[] = [];
    for (const [seq, msgs] of this.recallArchive) {
      const text = this.turnToText(msgs);
      if (regex.test(text)) {
        const entry = this.nuclearBySeq.get(seq);
        matches.push(entry ? formatNuclearLine(entry) : `#${seq}`);
      }
    }

    if (matches.length === 0) return null;
    return `Recall archive matches (${matches.length}):\n${matches.map((m) => `  ${m}`).join("\n")}`;
  }

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
              lines.push(`[tool_call] ${tc.function.name}(${tc.function.arguments.slice(0, 200)})`);
            }
          }
        }
      } else if (msg.role === "tool") {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        lines.push(`[tool_result] ${content.slice(0, 500)}`);
      }
    }
    return lines.join("\n");
  }
}

// ── Recency weighting ────────────────────────────────────────────

function recencyWeight(idx: number, total: number): number {
  return Math.max(0.1, 1 - idx / total);
}
