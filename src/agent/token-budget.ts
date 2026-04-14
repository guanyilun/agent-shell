/**
 * Unified token budget manager.
 *
 * Splits a model's context window between two streams:
 *   - Shell context (user shell commands and outputs — situational awareness)
 *   - Conversation (agent messages and tool results — task continuity)
 *
 * The budget accounts for fixed overhead (system prompt, tool definitions,
 * response reserve) and divides the remaining space by a configurable ratio.
 */
import { getSettings } from "../settings.js";

/** Overhead estimates (tokens). */
const SYSTEM_PROMPT_OVERHEAD = 800;
const DYNAMIC_CONTEXT_OVERHEAD = 500; // conventions, metadata, skills list
const TOKENS_PER_TOOL_DEFINITION = 50;
const RESPONSE_RESERVE = 8192; // matches llm-client.ts default max_tokens

/** Fallback when contextWindow is unknown. */
const DEFAULT_CONTEXT_WINDOW = 60_000;

export class TokenBudget {
  private contextWindow: number;
  private toolCount: number;

  constructor(contextWindow?: number, toolCount = 0) {
    this.contextWindow = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    this.toolCount = toolCount;
  }

  /** Update when model or tool set changes. */
  update(contextWindow?: number, toolCount?: number): void {
    if (contextWindow != null) this.contextWindow = contextWindow;
    if (toolCount != null) this.toolCount = toolCount;
  }

  /** Total tokens available for shell context + conversation content. */
  get contentBudget(): number {
    const overhead =
      SYSTEM_PROMPT_OVERHEAD +
      DYNAMIC_CONTEXT_OVERHEAD +
      this.toolCount * TOKENS_PER_TOOL_DEFINITION +
      RESPONSE_RESERVE;
    return Math.max(0, this.contextWindow - overhead);
  }

  /** Token budget for the shell context stream. */
  get shellBudgetTokens(): number {
    const ratio = getSettings().shellContextRatio;
    return Math.floor(this.contentBudget * ratio);
  }

  /** Token budget for the conversation messages stream. */
  get conversationBudgetTokens(): number {
    return this.contentBudget - this.shellBudgetTokens;
  }
}
