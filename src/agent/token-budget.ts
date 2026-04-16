/**
 * Token budget for shell context sizing.
 *
 * Computes how much of the context window to allocate to shell history
 * (user commands and outputs — situational awareness). The remaining
 * space is for the conversation, system prompt, tools, and response.
 *
 * Shell context is sized loosely — chars/4 accuracy is fine for this.
 * Conversation and compaction decisions use API-grounded token counts
 * (see ConversationState.estimatePromptTokens).
 */
import { getSettings } from "../settings.js";

const SYSTEM_PROMPT_OVERHEAD = 800;
const DYNAMIC_CONTEXT_OVERHEAD = 500; // conventions, metadata, skills list
const TOKENS_PER_TOOL_DEFINITION = 50;

/** Response reserve — tokens reserved for the model's output. */
const RESPONSE_RESERVE = 8192;

/** Fallback when contextWindow is unknown. */
const DEFAULT_CONTEXT_WINDOW = 60_000;

export { RESPONSE_RESERVE, DEFAULT_CONTEXT_WINDOW };

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

  /** Token budget for the shell context stream. */
  get shellBudgetTokens(): number {
    const overhead =
      SYSTEM_PROMPT_OVERHEAD +
      DYNAMIC_CONTEXT_OVERHEAD +
      this.toolCount * TOKENS_PER_TOOL_DEFINITION +
      RESPONSE_RESERVE;
    const contentBudget = Math.max(0, this.contextWindow - overhead);
    const ratio = getSettings().shellContextRatio;
    return Math.floor(contentBudget * ratio);
  }
}
