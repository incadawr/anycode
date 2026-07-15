/**
 * ContextManager (design §2.6): microcompact (local, no LLM) + transactional
 * LLM auto-compaction with a circuit breaker. Called by the loop at the start
 * of every iteration; provider usage numbers recorded via noteUsage always
 * override local estimates.
 */

import { COMPACTION_INSTRUCTION } from "../prompts/compaction.js";
import { classifyProviderFailure } from "../provider/failure.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { TokenUsage } from "../types/events.js";
import type { ChatMessage, HistoryItem } from "../types/history.js";
import {
  compactThresholdTokens,
  microcompactThresholdTokens,
  type ContextBudgetConfig,
} from "./budget.js";
import { estimateMessageTokens, type ConversationHistory } from "./history.js";
import type { Tokenizer } from "./tokenizer.js";

/** Replacement text for tool results cleared by microcompact (own text, design §2.6). */
export const MICROCOMPACT_CLEARED_TEXT =
  "[tool result cleared to free context space; re-run the tool if this output is needed again]";

/** Own wrapper prefixed to the LLM summary when it replaces the compacted prefix (design §2.6). */
const COMPACT_SUMMARY_PREFIX = "Session continued. Summary of the earlier conversation:\n\n";

export interface ContextManagerDeps {
  history: ConversationHistory;
  tokenizer: Tokenizer;
  modelPort: ModelPort;
  config: ContextBudgetConfig;
}

export type RunCompactionResult =
  | { ok: true; preTokens: number; postTokens: number }
  | { ok: false; preTokens: number; error: string };

export class ContextManager {
  /** Authoritative last-context-size from the provider, or null before any usage / after compaction. */
  private providerTokens: number | null = null;
  /** Local estimate captured at the moment providerTokens was recorded (the delta anchor). */
  private baselineEstimate = 0;
  /** Consecutive compaction failures; trips the circuit breaker at the configured max. */
  private consecutiveFailures = 0;

  constructor(private readonly deps: ContextManagerDeps) {}

  /**
   * Records provider usage after a finish. inputTokens (the provider's own
   * count of everything sent for that step) becomes the authoritative baseline;
   * subsequent estimate() calls add only the locally-estimated delta on top of
   * it. Usage without a numeric inputTokens is ignored (keeps the last anchor).
   */
  noteUsage(usage: TokenUsage): void {
    if (typeof usage.inputTokens === "number" && usage.inputTokens >= 0) {
      this.providerTokens = usage.inputTokens;
      this.baselineEstimate = this.deps.history.totalTokenEstimate();
    }
  }

  /**
   * Current context size. With a provider baseline: providerTokens + the change
   * in the local estimate since that baseline (clamped at 0) — so appends grow
   * it and microcompact shrinks it while the provider number stays authoritative
   * for the bulk. Without one: the pure local estimate.
   */
  estimate(): { tokens: number; source: "provider" | "estimate" } {
    const raw = this.deps.history.totalTokenEstimate();
    if (this.providerTokens !== null) {
      const delta = raw - this.baselineEstimate;
      return { tokens: Math.max(0, this.providerTokens + delta), source: "provider" };
    }
    return { tokens: raw, source: "estimate" };
  }

  /** Current budget config (slice 6.4: /context introspection + the re-budget base). */
  getBudgetConfig(): ContextBudgetConfig {
    return this.deps.config;
  }

  /**
   * Replaces the budget config mid-session (slice 6.4: /model re-budget).
   * Every internal read already goes through deps.config, so the swap takes
   * effect on the very next shouldAutoCompact/microcompact/compaction call.
   * Deliberately does NOT touch providerTokens/baselineEstimate/
   * consecutiveFailures — the provider estimate anchor and the circuit
   * breaker survive a window change.
   */
  setBudgetConfig(config: ContextBudgetConfig): void {
    this.deps.config = config;
  }

  /** True once consecutive failures tripped the auto-compact breaker (manual /compact still works). */
  breakerTripped(): boolean {
    return this.consecutiveFailures >= this.deps.config.maxConsecutiveCompactionFailures;
  }

  /**
   * Clears tool-result texts of tool-role messages older than the most recent
   * N (config.microcompactKeepRecentToolResults). Messages are never deleted —
   * only their text is replaced with a marker — so tool_call/tool_result pairs
   * stay intact by construction. Returns null (and leaves history untouched)
   * when pressure is below the microcompact threshold, nothing is clearable, or
   * the savings fall below the configured minimum.
   */
  maybeMicrocompact(): { clearedToolResults: number; savedTokens: number } | null {
    if (this.estimate().tokens < microcompactThresholdTokens(this.deps.config)) {
      return null;
    }
    const items = this.deps.history.items;
    const keep = this.deps.config.microcompactKeepRecentToolResults;

    const toolItemIndices: number[] = [];
    for (let i = 0; i < items.length; i += 1) {
      if (items[i]!.message.role === "tool") {
        toolItemIndices.push(i);
      }
    }
    if (toolItemIndices.length <= keep) {
      return null;
    }
    const clearable = new Set(toolItemIndices.slice(0, toolItemIndices.length - keep));

    let clearedToolResults = 0;
    let savedTokens = 0;
    let mutated = false;

    const next: HistoryItem[] = items.map((item, index) => {
      if (!clearable.has(index) || item.message.role !== "tool") {
        return item;
      }
      let itemChanged = false;
      const content = item.message.content.map((part) => {
        if (part.text === MICROCOMPACT_CLEARED_TEXT) {
          return part;
        }
        itemChanged = true;
        clearedToolResults += 1;

        // destructuring exclusion, NOT a spread-over — spreading `...part` would
        // carry `images` through and leak the very payload this clear frees.
        const { images: _cleared, ...rest } = part;
        return { ...rest, text: MICROCOMPACT_CLEARED_TEXT };
      });
      if (!itemChanged) {
        return item;
      }
      mutated = true;
      const message: ChatMessage = { role: "tool", content };
      const oldEstimate =
        item.tokenEstimate ?? estimateMessageTokens(this.deps.tokenizer, item.message);
      const newEstimate = estimateMessageTokens(this.deps.tokenizer, message);
      savedTokens += oldEstimate - newEstimate;
      return { ...item, message, tokenEstimate: newEstimate, kind: "microcompact_cleared" };
    });

    if (!mutated || savedTokens < this.deps.config.microcompactMinSavingsTokens) {
      return null;
    }
    this.deps.history.replaceAll(next);
    return { clearedToolResults, savedTokens };
  }

  /** Threshold check; false once the circuit breaker has tripped for the session. */
  shouldAutoCompact(): boolean {
    if (this.consecutiveFailures >= this.deps.config.maxConsecutiveCompactionFailures) {
      return false;
    }
    return this.estimate().tokens >= compactThresholdTokens(this.deps.config);
  }

  /**
   * LLM compaction, transactional. The prefix is everything before a boundary
   * placed at `len - keepRecentMessages` and shifted BACK to the nearest user
   * item, so the verbatim tail always starts with a user message and no
   * tool_call is ever separated from its result. The prefix is summarized via
   * modelPort (text only; tool calls ignored) and the whole history is swapped
   * for [compact_summary user item, ...tail] in one replaceAll. On an empty
   * prefix the call is a structural no-op (not a breaker failure). On
   * error/empty-summary/abort the history is untouched and the failure counter
   * increments; the configured number of consecutive failures trips the breaker.
   */
  async runCompaction(opts: { signal?: AbortSignal }): Promise<RunCompactionResult> {
    const preTokens = this.estimate().tokens;
    const signal = opts.signal;
    const items = this.deps.history.items;

    const boundary = this.compactionBoundary(items);
    // boundary <= 0 => empty prefix: nothing to compact. Not a failure.
    if (boundary <= 0) {
      return {
        ok: false,
        preTokens,
        error: "compaction skipped: no prefix before the keep-recent window",
      };
    }

    const prefixMessages: ChatMessage[] = [];
    for (let i = 0; i < boundary; i += 1) {
      prefixMessages.push(items[i]!.message);
    }
    const tail = items.slice(boundary);

    let summary = "";
    let streamError: string | null = null;
    let aborted = false;
    try {
      const request: ModelRequest = {
        messages: [...prefixMessages, { role: "user", content: COMPACTION_INSTRUCTION }],
        tools: [],
        abortSignal: signal,
      };
      for await (const event of this.deps.modelPort.streamText(request)) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        if (event.type === "text_delta") {
          summary += event.text;
        } else if (event.type === "error") {
          streamError = errorText(event.error);
          break;
        }
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        aborted = true;
      } else {
        streamError = errorText(error);
      }
    }

    if (aborted || signal?.aborted) {
      return this.recordFailure(preTokens, "compaction aborted");
    }
    if (streamError !== null) {
      return this.recordFailure(preTokens, streamError);
    }
    const trimmed = summary.trim();
    if (trimmed.length === 0) {
      return this.recordFailure(preTokens, "compaction produced an empty summary");
    }

    const message: ChatMessage = { role: "user", content: `${COMPACT_SUMMARY_PREFIX}${trimmed}` };
    const summaryItem: HistoryItem = {
      id: globalThis.crypto.randomUUID(),
      createdAt: Date.now(),
      message,
      tokenEstimate: estimateMessageTokens(this.deps.tokenizer, message),
      kind: "compact_summary",
    };

    this.deps.history.replaceAll([summaryItem, ...tail]);
    this.consecutiveFailures = 0;
    // The provider baseline counted the pre-compaction context; it is now stale.
    this.providerTokens = null;
    const postTokens = this.estimate().tokens;
    return { ok: true, preTokens, postTokens };
  }

  /**
   * Boundary index: the largest index <= (len - keepRecentMessages) whose item
   * is a user message. The prefix is items[0..boundary); the tail items[boundary..].
   * Returns 0 when no clean boundary exists before the keep-recent window
   * (caller treats <= 0 as an empty prefix / skip).
   */
  private compactionBoundary(items: readonly HistoryItem[]): number {
    const raw = items.length - this.deps.config.keepRecentMessages;
    const upper = Math.min(raw, items.length - 1);
    for (let i = upper; i >= 0; i -= 1) {
      if (items[i]!.message.role === "user") {
        return i;
      }
    }
    return 0;
  }

  private recordFailure(preTokens: number, error: string): RunCompactionResult {
    this.consecutiveFailures += 1;
    return { ok: false, preTokens, error };
  }
}

/** Detects a DOMException/AbortError-shaped rejection so aborts aren't treated as errors. */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * Redacted description of a compaction stream failure. Surfaces as
 * `compaction_end.error`, which crosses the host↔renderer wire and is rendered
 * by the CLI, so it must be the whitelist-derived safe message — NEVER the raw
 * `error.message`, which can embed a response body or auth header (TASK.33
 * W7b-FIX #2).
 */
function errorText(error: unknown): string {
  return classifyProviderFailure(error).safe.message;
}
