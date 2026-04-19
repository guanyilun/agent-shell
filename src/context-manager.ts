import type { EventBus } from "./event-bus.js";
import type { Exchange } from "./types.js";
import type { HandlerRegistry } from "./utils/handler-registry.js";
import { getSettings } from "./settings.js";
import { spillOutput } from "./utils/shell-output-spill.js";

export class ContextManager {
  private exchanges: Exchange[] = [];
  private nextId = 1;
  private currentCwd: string;
  private agentShellActive = false; // true while user_shell command is executing

  constructor(bus: EventBus, _handlers?: HandlerRegistry) {
    this.currentCwd = process.cwd();

    // ── Subscribe to shell events ──
    bus.on("shell:command-done", (e) => {
      const lines = e.output.split("\n");
      const s = getSettings();
      // Spill long outputs to a tempfile so the agent can `read_file` them
      // on demand instead of carrying the full text in LLM context.
      let output = e.output;
      let spillPath: string | undefined;
      if (lines.length > s.shellTruncateThreshold) {
        // Reserve the id we're about to assign so the tempfile name matches.
        const id = this.nextId;
        try {
          spillPath = spillOutput(id, e.output);
          output = buildSpillStub(lines, s.shellHeadLines, s.shellTailLines, spillPath);
        } catch {
          // If spill fails (e.g. disk full), fall back to keeping output in memory.
          output = e.output;
          spillPath = undefined;
        }
      }
      this.addExchange({
        type: "shell_command",
        command: e.command,
        output,
        cwd: e.cwd,
        exitCode: e.exitCode,
        outputLines: lines.length,
        outputBytes: e.output.length,
        source: this.agentShellActive ? "agent" : "user",
        spillPath,
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

    // Outputs already carry head+tail+spillPath stubs from capture time.
    const body = fresh.map((ex) => this.formatExchangeTruncated(ex)).join("\n");
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
   * Clear exchange history (used by /clear command).
   */
  clear(): void {
    this.exchanges = [];
    // Don't reset nextId — IDs should be globally unique within a session
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

function buildSpillStub(
  lines: string[],
  headLines: number,
  tailLines: number,
  spillPath: string,
): string {
  const omitted = lines.length - headLines - tailLines;
  return [
    ...lines.slice(0, headLines),
    `[... ${omitted} lines truncated — full output at ${spillPath}; use read_file to expand ...]`,
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
