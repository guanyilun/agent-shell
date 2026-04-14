import type { ChatCompletionMessageParam } from "../utils/llm-client.js";
import { getSettings } from "../settings.js";
import {
  type NuclearEntry,
  toNuclearEntries,
  formatNuclearLine,
  isReadOnly,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
} from "./nuclear-form.js";
import type { HistoryFile } from "./history-file.js";

/**
 * Three-tier conversation state — works like shell history.
 *
 * Tier 1: Active context   — full content in LLM messages array
 * Tier 2: Nuclear memory   — one-liner summaries IN the conversation +
 *                            recall archive (in-memory) for full content
 * Tier 3: History file     — nuclear entries persisted to disk
 *
 * Content flows downward as the context window fills:
 *   Tier 1 → compact → Tier 2 → flush → Tier 3
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
  // ── Tier 1: Active context ────────────────────────────────────
  private messages: ChatCompletionMessageParam[] = [];

  // ── Tier 2: Nuclear memory ────────────────────────────────────
  private nuclearEntries: NuclearEntry[] = [];
  private recallArchive = new Map<number, ChatCompletionMessageParam[]>();

  // ── Tier 3 reference ──────────────────────────────────────────
  private historyFile: HistoryFile | null;

  // ── Shared state ──────────────────────────────────────────────
  private nextSeq = 1;

  constructor(historyFile?: HistoryFile) {
    this.historyFile = historyFile ?? null;
  }

  get instanceId(): string {
    return this.historyFile?.instanceId ?? "0000";
  }

  // ── Message API (unchanged) ───────────────────────────────────

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

  // ── Token estimation ──────────────────────────────────────────

  estimateTokens(): number {
    return Math.ceil(JSON.stringify(this.messages).length / 4);
  }

  // ── Tier 1 → Tier 2: Compaction ───────────────────────────────

  /**
   * Priority-based compaction. Evicts lowest-priority turns, replacing
   * them with nuclear one-liner summaries that stay in the conversation.
   * Read-only tool results are dropped entirely.
   */
  compact(targetTokens: number, recentTurnsToKeep = 10, force = false): { before: number; after: number } | null {
    const before = this.estimateTokens();
    if (!force && before <= targetTokens) return null;

    const turns = this.parseTurns();
    if (turns.length <= 2) return null;

    // Assign priorities
    const pinnedCount = Math.min(recentTurnsToKeep, turns.length - 1);
    for (const turn of turns) {
      turn.priority = this.inferPriority(turn.messages);
    }
    turns[0]!.priority = Priority.PINNED;
    for (let i = turns.length - pinnedCount; i < turns.length; i++) {
      turns[i]!.priority = Priority.PINNED;
    }

    // Sort candidates: lowest priority first, then oldest
    const candidates = turns
      .map((t, idx) => ({ turn: t, idx }))
      .filter((c) => c.turn.priority !== Priority.PINNED)
      .sort((a, b) => a.turn.priority - b.turn.priority || a.idx - b.idx);

    // Evict until under budget
    const evictedIndices = new Set<number>();
    let currentTokens = this.estimateTokens();

    for (const c of candidates) {
      if (currentTokens <= targetTokens) break;
      const turnTokens = Math.ceil(JSON.stringify(c.turn.messages).length / 4);
      evictedIndices.add(c.idx);
      currentTokens -= turnTokens;

      // Generate nuclear entries from this turn
      const entries = toNuclearEntries(c.turn.messages, this.nextSeq, this.instanceId);
      this.nextSeq += entries.length;

      for (const entry of entries) {
        if (isReadOnly(entry)) {
          // Read-only: archive only (dropped from conversation), agent can re-read
          this.recallArchive.set(entry.seq, c.turn.messages);
        } else {
          // State-changing: keep nuclear one-liner in conversation + archive
          this.nuclearEntries.push(entry);
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

  // ── Tier 2 → Tier 3: Flush ───────────────────────────────────

  /**
   * Flush oldest nuclear entries to the history file when the
   * in-context nuclear block grows too large.
   */
  async flush(): Promise<void> {
    const maxEntries = getSettings().nuclearMaxEntries;
    if (this.nuclearEntries.length <= maxEntries) return;

    const flushCount = this.nuclearEntries.length - maxEntries;
    const toFlush = this.nuclearEntries.slice(0, flushCount);

    // Write to history file
    if (this.historyFile) {
      await this.historyFile.append(toFlush);
    }

    // Remove flushed entries from memory
    for (const entry of toFlush) {
      this.recallArchive.delete(entry.seq);
    }
    this.nuclearEntries = this.nuclearEntries.slice(flushCount);

    // Update the nuclear block in messages
    this.updateNuclearBlockInMessages(this.messages);
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

  /** Search Tier 2 archive + Tier 3 history file. */
  async search(query: string): Promise<string> {
    if (!query.trim()) return "No query provided.";

    const parts: string[] = [];

    // Search Tier 2 (in-memory archive)
    const archiveResults = this.searchArchive(query);
    if (archiveResults) parts.push(archiveResults);

    // Search Tier 3 (history file)
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
    // Check Tier 2 archive first
    const archived = this.recallArchive.get(seq);
    if (archived) {
      const entry = this.nuclearEntries.find((e) => e.seq === seq);
      const header = entry ? formatNuclearLine(entry) : `#${seq}`;
      return `${header}\n\n${this.turnToText(archived)}`;
    }

    return `Entry #${seq}: not found in recall archive (may have been flushed to history file).`;
  }

  /** Browse nuclear entries (Tier 2) + recent history (Tier 3). */
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
        const entry = this.nuclearEntries.find((e) => e.seq === seq);
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
