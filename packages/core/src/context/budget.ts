/**
 * Token budget math:
 *   effectiveWindow = contextWindow - min(outputReserve, 25% of contextWindow)
 *   compactThreshold = min(floor(effectiveWindow * pct / 100), effectiveWindow - buffer)
 * compactThreshold is clamped to stay positive on small windows.
 * Estimates are cached per HistoryItem (immutable after append); provider
 * usage numbers are always authoritative over local estimates.
 */

import {
  COMPACT_BUFFER_TOKENS,
  COMPACT_KEEP_RECENT_MESSAGES,
  COMPACT_THRESHOLD_PERCENT,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MAX_COMPACTION_FAILURES,
  MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS,
  MICROCOMPACT_MIN_SAVINGS_TOKENS,
  MICROCOMPACT_THRESHOLD_PERCENT,
} from "../types/config.js";

/** Maximum fraction of the context window reserved for output in budget calculations. */
export const MAX_OUTPUT_RESERVE_WINDOW_FRACTION = 0.25;

export interface ContextBudgetConfig {
  /** DEFAULT 200_000; env ANYCODE_CONTEXT_WINDOW. */
  contextWindowTokens: number;
  outputReserveTokens: number;
  compactThresholdPercent: number;
  compactBufferTokens: number;
  microcompactThresholdPercent: number;
  /** Tail messages kept verbatim by compaction. */
  keepRecentMessages: number;
  microcompactKeepRecentToolResults: number;
  microcompactMinSavingsTokens: number;
  /** Circuit breaker (design §2.6). */
  maxConsecutiveCompactionFailures: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
  outputReserveTokens: DEFAULT_OUTPUT_RESERVE_TOKENS,
  compactThresholdPercent: COMPACT_THRESHOLD_PERCENT,
  compactBufferTokens: COMPACT_BUFFER_TOKENS,
  microcompactThresholdPercent: MICROCOMPACT_THRESHOLD_PERCENT,
  keepRecentMessages: COMPACT_KEEP_RECENT_MESSAGES,
  microcompactKeepRecentToolResults: MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS,
  microcompactMinSavingsTokens: MICROCOMPACT_MIN_SAVINGS_TOKENS,
  maxConsecutiveCompactionFailures: MAX_COMPACTION_FAILURES,
};

/** Merges partial overrides over the frozen defaults. */
export function resolveContextBudgetConfig(
  overrides?: Partial<ContextBudgetConfig>,
): ContextBudgetConfig {
  return { ...DEFAULT_CONTEXT_BUDGET, ...overrides };
}

/**
 * Cap the reserve at 25% of the window so even an oversized reserve cannot
 * collapse the input budget. This affects budget math, not the output limit.
 */
export function effectiveWindowTokens(config: ContextBudgetConfig): number {
  return config.contextWindowTokens - Math.min(
    config.outputReserveTokens,
    Math.floor(config.contextWindowTokens * MAX_OUTPUT_RESERVE_WINDOW_FRACTION),
  );
}

/**
 * compactThreshold = min(floor(effectiveWindow * pct / 100), effectiveWindow - buffer),
 * clamped to at least 1 token so a degraded window (where the buffer would push the
 * cap to zero or below) never forces compaction on every single turn.
 */
export function compactThresholdTokens(config: ContextBudgetConfig): number {
  const ew = effectiveWindowTokens(config);
  const byPercent = Math.floor((ew * config.compactThresholdPercent) / 100);
  const buffered = ew - config.compactBufferTokens;
  return Math.max(buffered > 0 ? Math.min(byPercent, buffered) : byPercent, 1);
}

/**
 * microcompactThreshold = min(max(floor(effectiveWindow * pct / 100), 1), compactThreshold).
 * The upper clamp keeps the cheap local relief armed at or before LLM compaction,
 * including when callers override the public budget configuration.
 */
export function microcompactThresholdTokens(config: ContextBudgetConfig): number {
  const byPercent = Math.max(
    Math.floor((effectiveWindowTokens(config) * config.microcompactThresholdPercent) / 100),
    1,
  );
  return Math.min(byPercent, compactThresholdTokens(config));
}
