/**
 * Shared token-budget constants used by auto-compaction.
 *
 * RESPONSE_RESERVE: tokens reserved for the model's output.
 * DEFAULT_CONTEXT_WINDOW: fallback when the active mode doesn't declare one.
 */

/** Response reserve — tokens reserved for the model's output. */
export const RESPONSE_RESERVE = 8192;

/** Fallback when contextWindow is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 60_000;
