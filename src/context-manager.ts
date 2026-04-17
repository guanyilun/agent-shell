import type { EventBus } from "./event-bus.js";
import type { Exchange } from "./types.js";
import type { HandlerRegistry } from "./utils/handler-registry.js";
import { getSettings } from "./settings.js";

export class ContextManager {
  private exchanges: Exchange[] = [];
  private nextId = 1;
  private currentCwd: string;
  private sessionStart: number;
  private firstPrompt = true;
  private agentShellActive = false; // true while user_shell command is executing
  private handlers: HandlerRegistry | null = null;

  constructor(bus: EventBus, handlers?: HandlerRegistry) {
    if (handlers) {
      this.handlers = handlers;
      // Extensions can advise this to inject extra context (e.g. terminal buffer)
      handlers.define("context:build-extra", () => "");
    }
    this.currentCwd = process.cwd();
    this.sessionStart = Date.now();

    // ── Subscribe to shell events ──
    bus.on("shell:command-done", (e) => {
      const lines = e.output.split("\n");
      this.addExchange({
        type: "shell_command",
        command: e.command,
        output: e.output,
        cwd: e.cwd,
        exitCode: e.exitCode,
        outputLines: lines.length,
        outputBytes: e.output.length,
        source: this.agentShellActive ? "agent" : "user",
      });
    });

    bus.on("shell:cwd-change", (e) => {
      this.currentCwd = e.cwd;
    });

    // Track agent-initiated shell commands (user_shell tool)
    bus.on("shell:agent-exec-start", () => { this.agentShellActive = true; });
    bus.on("shell:agent-exec-done", () => { this.agentShellActive = false; });

    // ── Subscribe to agent events ──
    // Only track queries (as markers). Agent responses and tool outputs
    // live exclusively in ConversationState to avoid duplication.
    bus.on("agent:query", (e) => {
      this.addExchange({ type: "agent_query", query: e.query });
    });
  }

  // ── Public query API ──────────────────────────────────────────

  getCwd(): string {
    return this.currentCwd;
  }

  /**
   * Build the <shell_context> block for the agent prompt.
   * Pipeline: window → truncate → format
   */
  getContext(budget?: number): string {
    budget ??= getSettings().contextBudget;
    let exchanges = this.applyWindow(this.exchanges);
    exchanges = this.applyTruncation(exchanges, budget);
    return this.formatContext(exchanges);
  }

  /**
   * Regex/keyword search across all exchanges. Returns formatted results.
   */
  search(query: string): string {
    if (!query.trim()) return "No query provided.";

    let regex: RegExp;
    try {
      regex = new RegExp(query, "i");
    } catch {
      // Fallback: treat as literal keywords with OR logic
      const words = query.split(/\s+/).filter((w) => w.length > 0);
      const pattern = words.map((w) => escapeRegex(w)).join("|");
      regex = new RegExp(pattern, "i");
    }

    const matches: { exchange: Exchange; excerpts: string[] }[] = [];

    for (const ex of this.exchanges) {
      const text = this.exchangeSearchText(ex);
      const lines = text.split("\n");
      const matchingLineIndices: number[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          matchingLineIndices.push(i);
        }
      }

      if (matchingLineIndices.length > 0) {
        // Extract excerpts with 2 lines of context around each match
        const excerpts: string[] = [];
        for (const idx of matchingLineIndices.slice(0, 5)) {
          const start = Math.max(0, idx - 2);
          const end = Math.min(lines.length, idx + 3);
          excerpts.push(lines.slice(start, end).join("\n"));
        }
        matches.push({ exchange: ex, excerpts });
      }
    }

    if (matches.length === 0) {
      return `No results found for "${query}".`;
    }

    const parts: string[] = [`Search results for "${query}" (${matches.length} exchanges):\n`];
    for (const m of matches.slice(0, 20)) {
      parts.push(`#${m.exchange.id} [${m.exchange.type}]`);
      for (const excerpt of m.excerpts) {
        parts.push(indent(excerpt, "  "));
      }
      parts.push("");
    }
    return parts.join("\n");
  }

  /**
   * Return content for specific exchange IDs.
   * Optional start/end restrict to a line range (1-indexed).
   */
  expand(ids: number[], start?: number, end?: number): string {
    const results: string[] = [];
    for (const id of ids) {
      const ex = this.exchanges.find((e) => e.id === id);
      if (!ex) {
        results.push(`#${id}: not found`);
        continue;
      }
      const text = this.formatExchangeFull(ex);
      const lines = text.split("\n");
      const total = lines.length;

      if (start != null || end != null) {
        // Line range requested
        const s = Math.max(0, (start ?? 1) - 1);
        const e = end ?? total;
        results.push(
          lines.slice(s, e).join("\n") +
          `\n[showing lines ${s + 1}-${Math.min(e, total)} of ${total}]`,
        );
      } else if (total > getSettings().recallExpandMaxLines) {
        // Too large — tell the agent to narrow down
        results.push(
          `#${ex.id}: output is ${total} lines, too large to expand fully. ` +
          `Use start/end params to select a line range (e.g. start=1, end=50), ` +
          `or use search with a regex to find specific content.`,
        );
      } else {
        results.push(text);
      }
    }
    return results.join("\n\n");
  }

  /**
   * Return shell events with id > afterId, formatted as an incremental
   * delta suitable for injection into conversation history. Skips
   * agent-source commands (already visible in tool results). Returns
   * null when nothing new exists.
   *
   * The motivation: resending the full <shell_context> every turn wastes
   * tokens — N turns × full history = O(N²) cost for O(N) information.
   * Instead we inject only new events as regular conversation messages,
   * so the provider's prefix cache amortizes them to O(N).
   */
  getEventsSince(afterId: number): { text: string; lastSeq: number } | null {
    const fresh = this.exchanges.filter((e) => e.id > afterId && !(e.type === "shell_command" && e.source === "agent"));
    if (fresh.length === 0) return null;

    const lastSeq = this.exchanges[this.exchanges.length - 1]!.id;

    // Apply per-type truncation so giant outputs don't blow up the turn.
    const truncated: Exchange[] = fresh.map((ex) => {
      if (ex.type === "shell_command") {
        const s = getSettings();
        return {
          ...ex,
          output: truncateOutput(ex.output, s.shellTruncateThreshold, s.shellHeadLines, s.shellTailLines, ex.id),
        };
      }
      return { ...ex };
    });

    const body = truncated.map((ex) => this.formatExchangeTruncated(ex)).join("\n");
    return {
      text: `<shell-events>\n${body}</shell-events>`,
      lastSeq,
    };
  }

  /** Highest exchange id seen so far (0 if none). */
  lastSeq(): number {
    return this.exchanges.length === 0 ? 0 : this.exchanges[this.exchanges.length - 1]!.id;
  }

  /**
   * One-line summaries of last N exchanges.
   */
  getRecentSummary(n: number = 25): string {
    const recent = this.exchanges.slice(-n);
    if (recent.length === 0) return "No exchanges yet.";

    return recent.map((ex) => this.exchangeOneLiner(ex)).join("\n");
  }

  /**
   * Parse and handle shell_recall commands.
   */
  handleRecallCommand(command: string): string {
    const args = command.replace(/^_*shell_recall\s*/, "").trim();

    if (!args || args === "--help") {
      return [
        "Usage:",
        "  shell_recall                    Browse recent exchanges",
        "  shell_recall --search <query>   Search all exchanges",
        "  shell_recall --expand <id,...>   Show full content of exchanges",
        "",
        "Examples:",
        '  shell_recall --search "test fail"',
        "  shell_recall --expand 41",
        "  shell_recall --expand 41,42,43",
      ].join("\n");
    }

    const searchMatch = args.match(/^--search\s+(?:"([^"]+)"|(\S+))/);
    if (searchMatch) {
      return this.search(searchMatch[1] ?? searchMatch[2] ?? "");
    }

    const expandMatch = args.match(
      /^--expand\s+([\d,\s]+)/,
    );
    if (expandMatch) {
      const ids = expandMatch[1]!
        .split(/[,\s]+/)
        .map(Number)
        .filter((n) => !isNaN(n));
      if (ids.length === 0) return "No valid IDs provided.";
      return this.expand(ids);
    }

    // Default: browse
    return this.getRecentSummary();
  }

  /**
   * Clear exchange history (used by /clear command).
   */
  clear(): void {
    this.exchanges = [];
    this.firstPrompt = true;
    // Don't reset nextId — IDs should be globally unique within a session
  }

  // ── Pipeline stages ───────────────────────────────────────────

  private applyWindow(
    exchanges: Exchange[],
    windowSize?: number,
  ): Exchange[] {
    windowSize ??= getSettings().contextWindowSize;
    return exchanges.slice(-windowSize);
  }

  private applyTruncation(
    exchanges: Exchange[],
    budget: number,
  ): Exchange[] {
    // Deep clone so we don't mutate the source
    const result: Exchange[] = exchanges.map((e) => ({ ...e }));

    // Pass 1: per-type truncation
    for (const ex of result) {
      if (ex.type === "shell_command") {
        const s = getSettings();
        ex.output = truncateOutput(
          ex.output,
          s.shellTruncateThreshold,
          s.shellHeadLines,
          s.shellTailLines,
          ex.id,
        );
      }
      // agent_query has no output to truncate
    }

    // Pass 2: budget enforcement — strip output from oldest if over budget
    let totalSize = result.reduce((sum, ex) => sum + this.exchangeSize(ex), 0);
    for (let i = 0; i < result.length - 1 && totalSize > budget; i++) {
      const ex = result[i]!;
      const before = this.exchangeSize(ex);
      if (ex.type === "shell_command") {
        ex.output = `[output omitted, use shell_recall tool to expand id ${ex.id}]`;
      }
      totalSize -= before - this.exchangeSize(ex);
    }

    return result;
  }

  private formatContext(exchanges: Exchange[]): string {
    const elapsed = Math.round((Date.now() - this.sessionStart) / 60000);
    const totalCount = this.exchanges.length;

    let out = "<shell_context>\n";

    if (this.firstPrompt) {
      out += `You are an AI assistant living inside agent-sh, a shell-first terminal.\n`;
      out += `The user interacts with a real shell (PTY) and sends you queries inline. You are there to help them with their tasks.\n`;
      out += `\n`;
      out += `IMPORTANT tool usage rules:\n`;
      out += `- Your internal tools (bash, read, write, ls, etc.) run in an isolated subprocess. The user CANNOT see their output.\n`;
      out += `- Only use internal tools when YOU need to reason about content silently (e.g. reading a file to answer a question about it).\n`;
      out += `- You can browse or search shell history with shell_recall.\n`;
      out += `\n`;
      this.firstPrompt = false;
    }

    out += `cwd: ${this.currentCwd}\n`;
    out += `session: ${totalCount} exchanges, ${elapsed}m elapsed\n`;

    for (const ex of exchanges) {
      out += "\n" + this.formatExchangeTruncated(ex);
    }

    // Allow extensions to inject extra context (e.g. terminal buffer snapshot)
    const extra = this.handlers?.call("context:build-extra") as string | undefined;
    if (extra) out += "\n" + extra + "\n";

    out += "\n</shell_context>\n";
    return out;
  }

  // ── Internal helpers ──────────────────────────────────────────

  private addExchange(partial: Record<string, unknown>): void {
    const exchange = {
      ...partial,
      id: this.nextId++,
      timestamp: Date.now(),
    } as Exchange;
    this.exchanges.push(exchange);
  }

  private formatExchangeTruncated(ex: Exchange): string {
    switch (ex.type) {
      case "shell_command": {
        const label = ex.source === "agent" ? "agent → shell" : "shell";
        let s = `#${ex.id} [${label} cwd:${ex.cwd}] $ ${ex.command}\n`;
        if (ex.output) s += indent(ex.output, "  ") + "\n";
        if (ex.exitCode !== null) s += `  exit ${ex.exitCode}\n`;
        return s;
      }
      case "agent_query":
        return `#${ex.id} [you] > ${ex.query}\n`;
    }
  }

  private formatExchangeFull(ex: Exchange): string {
    switch (ex.type) {
      case "shell_command": {
        const label = ex.source === "agent" ? "agent → shell" : "shell";
        const output = ex.output;
        let s = `#${ex.id} [${label}] $ ${ex.command} (${ex.outputLines} lines, ${ex.outputBytes} bytes)\n`;
        if (output) s += output + "\n";
        if (ex.exitCode !== null) s += `exit ${ex.exitCode}\n`;
        return s;
      }
      case "agent_query":
        return `#${ex.id} [you] > ${ex.query}`;
    }
  }

  private exchangeOneLiner(ex: Exchange): string {
    switch (ex.type) {
      case "shell_command": {
        const label = ex.source === "agent" ? "agent → shell" : "shell";
        return `#${ex.id} ${label} [cwd:${ex.cwd}]: ${ex.command} (${ex.outputLines} total lines, exit ${ex.exitCode ?? "?"})`;
      }
      case "agent_query":
        return `#${ex.id} query: ${ex.query}`;
    }
  }

  private exchangeSearchText(ex: Exchange): string {
    switch (ex.type) {
      case "shell_command":
        return `${ex.command}\n${ex.output}`;
      case "agent_query":
        return ex.query;
    }
  }

  private exchangeSize(ex: Exchange): number {
    switch (ex.type) {
      case "shell_command":
        return ex.command.length + ex.output.length;
      case "agent_query":
        return ex.query.length;
    }
  }
}

// ── Utility functions ─────────────────────────────────────────

function truncateOutput(
  text: string,
  threshold: number,
  headLines: number,
  tailLines: number,
  id: number,
): string {
  const lines = text.split("\n");
  if (lines.length <= threshold) return text;

  const omitted = lines.length - headLines - tailLines;
  return [
    ...lines.slice(0, headLines),
    `[... ${omitted} lines truncated, use shell_recall tool with expand and id ${id} to see full output ...]`,
    ...lines.slice(-tailLines),
  ].join("\n");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
