import type { EventBus } from "./event-bus.js";
import type { Exchange, ToolCallRecord } from "./types.js";

const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_BUDGET = 16384; // ~4K tokens at ~4 chars/token

// Truncation thresholds (in lines)
const SHELL_TRUNCATE_THRESHOLD = 30;
const SHELL_HEAD_LINES = 10;
const SHELL_TAIL_LINES = 10;
const AGENT_RESPONSE_TRUNCATE_THRESHOLD = 20;
const AGENT_RESPONSE_HEAD_LINES = 15;
const TOOL_TRUNCATE_THRESHOLD = 20;
const TOOL_HEAD_LINES = 5;
const TOOL_TAIL_LINES = 5;
const RECALL_EXPAND_MAX_LINES = 500;

export class ContextManager {
  private exchanges: Exchange[] = [];
  private nextId = 1;
  private currentCwd: string;
  private sessionStart: number;
  private pendingToolCalls: ToolCallRecord[] = [];

  constructor(bus: EventBus) {
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
      });
    });

    bus.on("shell:cwd-change", (e) => {
      this.currentCwd = e.cwd;
    });

    // ── Subscribe to agent events ──
    bus.on("agent:query", (e) => {
      this.pendingToolCalls = [];
      this.addExchange({ type: "agent_query", query: e.query });
    });

    bus.on("agent:response-done", (e) => {
      this.addExchange({
        type: "agent_response",
        response: e.response,
        toolCalls: this.pendingToolCalls,
      });
      this.pendingToolCalls = [];
    });

    bus.on("agent:tool-call", (e) => {
      // Accumulate tool calls for the agent_response summary
      this.pendingToolCalls.push({
        tool: e.tool,
        args: e.args,
        output: "",
        exitCode: null,
      });
    });

    bus.on("agent:tool-output", (e) => {
      // Update the last pending tool call with output
      const last = this.pendingToolCalls[this.pendingToolCalls.length - 1];
      if (last) {
        last.output = e.output;
        last.exitCode = e.exitCode;
      }

      // Also store as a separate exchange for chronological log
      const lines = e.output.split("\n");
      this.addExchange({
        type: "tool_execution",
        tool: e.tool,
        args: {},
        output: e.output,
        exitCode: e.exitCode,
        outputLines: lines.length,
        outputBytes: e.output.length,
      });
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
  getContext(budget: number = DEFAULT_BUDGET): string {
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
   * Return full untruncated content for specific exchange IDs.
   */
  expand(ids: number[]): string {
    const results: string[] = [];
    for (const id of ids) {
      const ex = this.exchanges.find((e) => e.id === id);
      if (!ex) {
        results.push(`#${id}: not found`);
        continue;
      }
      results.push(this.formatExchangeFull(ex));
    }
    return results.join("\n\n");
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
    this.pendingToolCalls = [];
    // Don't reset nextId — IDs should be globally unique within a session
  }

  // ── Pipeline stages ───────────────────────────────────────────

  private applyWindow(
    exchanges: Exchange[],
    windowSize: number = DEFAULT_WINDOW_SIZE,
  ): Exchange[] {
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
        ex.output = truncateOutput(
          ex.output,
          SHELL_TRUNCATE_THRESHOLD,
          SHELL_HEAD_LINES,
          SHELL_TAIL_LINES,
          ex.id,
        );
      } else if (ex.type === "agent_response") {
        ex.response = truncateHead(
          ex.response,
          AGENT_RESPONSE_TRUNCATE_THRESHOLD,
          AGENT_RESPONSE_HEAD_LINES,
          ex.id,
        );
      } else if (ex.type === "tool_execution") {
        ex.output = truncateOutput(
          ex.output,
          TOOL_TRUNCATE_THRESHOLD,
          TOOL_HEAD_LINES,
          TOOL_TAIL_LINES,
          ex.id,
        );
      }
    }

    // Pass 2: budget enforcement — strip output from oldest if over budget
    let totalSize = result.reduce((sum, ex) => sum + this.exchangeSize(ex), 0);
    for (let i = 0; i < result.length - 1 && totalSize > budget; i++) {
      const ex = result[i]!;
      const before = this.exchangeSize(ex);
      if (ex.type === "shell_command") {
        ex.output = `[output omitted, use shell_recall tool to expand id ${ex.id}]`;
      } else if (ex.type === "tool_execution") {
        ex.output = `[output omitted, use shell_recall tool to expand id ${ex.id}]`;
      } else if (ex.type === "agent_response") {
        ex.response = `[response omitted, use shell_recall tool to expand id ${ex.id}]`;
      }
      totalSize -= before - this.exchangeSize(ex);
    }

    return result;
  }

  private formatContext(exchanges: Exchange[]): string {
    const elapsed = Math.round((Date.now() - this.sessionStart) / 60000);
    const totalCount = this.exchanges.length;

    let out = "<shell_context>\n";
    out += `cwd: ${this.currentCwd}\n`;
    out += `session: ${totalCount} exchanges, ${elapsed}m elapsed\n`;
    out += `[hint: use the shell_recall tool to retrieve truncated content — search(query) or expand(ids)]\n`;

    for (const ex of exchanges) {
      out += "\n" + this.formatExchangeTruncated(ex);
    }

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
        let s = `#${ex.id} [shell] $ ${ex.command}\n`;
        if (ex.output) s += indent(ex.output, "  ") + "\n";
        if (ex.exitCode !== null) s += `  exit ${ex.exitCode}\n`;
        return s;
      }
      case "agent_query":
        return `#${ex.id} [you] > ${ex.query}\n`;
      case "agent_response": {
        let s = `#${ex.id} [agent] `;
        if (ex.response) s += ex.response.split("\n")[0] + "\n";
        if (ex.response.includes("\n")) {
          const rest = ex.response.slice(ex.response.indexOf("\n") + 1);
          if (rest.trim()) s += indent(rest, "  ") + "\n";
        }
        return s;
      }
      case "tool_execution": {
        let s = `#${ex.id} [tool] ${ex.tool}\n`;
        if (ex.output) s += indent(ex.output, "  ") + "\n";
        if (ex.exitCode !== null) s += `  exit ${ex.exitCode}\n`;
        return s;
      }
    }
  }

  private truncateForRecall(text: string): string {
    const lines = text.split("\n");
    if (lines.length <= RECALL_EXPAND_MAX_LINES) return text;
    const half = RECALL_EXPAND_MAX_LINES / 2;
    return (
      lines.slice(0, half).join("\n") +
      `\n[... ${lines.length - RECALL_EXPAND_MAX_LINES} more lines ...]\n` +
      lines.slice(-half).join("\n")
    );
  }

  private formatExchangeFull(ex: Exchange): string {
    switch (ex.type) {
      case "shell_command": {
        const output = this.truncateForRecall(ex.output);
        let s = `#${ex.id} [shell] $ ${ex.command} (${ex.outputLines} lines, ${ex.outputBytes} bytes)\n`;
        if (output) s += output + "\n";
        if (ex.exitCode !== null) s += `exit ${ex.exitCode}\n`;
        return s;
      }
      case "agent_query":
        return `#${ex.id} [you] > ${ex.query}`;
      case "agent_response":
        return `#${ex.id} [agent]\n${ex.response}`;
      case "tool_execution": {
        const output = this.truncateForRecall(ex.output);
        let s = `#${ex.id} [tool] ${ex.tool} (${ex.outputLines} lines, ${ex.outputBytes} bytes)\n`;
        if (output) s += output + "\n";
        if (ex.exitCode !== null) s += `exit ${ex.exitCode}\n`;
        return s;
      }
    }
  }

  private exchangeOneLiner(ex: Exchange): string {
    switch (ex.type) {
      case "shell_command":
        return `#${ex.id} shell: ${ex.command} (${ex.outputLines} lines, exit ${ex.exitCode ?? "?"})`;
      case "agent_query":
        return `#${ex.id} query: ${ex.query}`;
      case "agent_response": {
        const preview = ex.response.split("\n")[0]?.slice(0, 80) ?? "";
        return `#${ex.id} agent: ${preview}${ex.response.length > 80 ? "..." : ""}`;
      }
      case "tool_execution":
        return `#${ex.id} tool: ${ex.tool} (${ex.outputLines} lines, exit ${ex.exitCode ?? "?"})`;
    }
  }

  private exchangeSearchText(ex: Exchange): string {
    switch (ex.type) {
      case "shell_command":
        return `${ex.command}\n${ex.output}`;
      case "agent_query":
        return ex.query;
      case "agent_response":
        return ex.response;
      case "tool_execution":
        return `${ex.tool}\n${ex.output}`;
    }
  }

  private exchangeSize(ex: Exchange): number {
    switch (ex.type) {
      case "shell_command":
        return ex.command.length + ex.output.length;
      case "agent_query":
        return ex.query.length;
      case "agent_response":
        return ex.response.length;
      case "tool_execution":
        return ex.tool.length + ex.output.length;
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

function truncateHead(
  text: string,
  threshold: number,
  headLines: number,
  id: number,
): string {
  const lines = text.split("\n");
  if (lines.length <= threshold) return text;

  return [
    ...lines.slice(0, headLines),
    `[... truncated, use shell_recall tool with expand and id ${id} for full response ...]`,
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
