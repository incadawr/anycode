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

/** Failure reason when a structural skip happens while the context is under compaction pressure. */
const COMPACTION_SKIP_UNDER_PRESSURE =
  "compaction skipped but the context is still above the compaction threshold";

export interface ContextManagerDeps {
  history: ConversationHistory;
  tokenizer: Tokenizer;
  modelPort: ModelPort;
  config: ContextBudgetConfig;
  requestOverheadTokens?: () => number;
  reasoningEffort?: () => ModelRequest["reasoningEffort"];
}

export type RunCompactionResult =
  | {
      ok: true;
      preTokens: number;
      postTokens: number;
      /**
       * The summary exactly as it was installed in history (own prefix
       * included — that wrapper is part of what the model now sees).
       */
      summary: string;
      /** Id of the persisted `compact_summary` item holding `summary`. */
      summaryItemId: string;
      /** The instruction that was sent to the summarizing model. */
      prompt: string;
      /** Constructed-port model id of the summarizing call, when the port has one. */
      model?: string;
    }
  | {
      ok: false;
      preTokens: number;
      /**
       * The reason, already phrased for a human reader: this field is shown
       * verbatim by the CLI line and the desktop row, so it must never carry
       * internal vocabulary ("keep-recent window", "prefix").
       */
      error: string;
      /**
       * True when nothing was ATTEMPTED — an empty prefix, or one that is
       * already fully summarized. Not a failure: the model was never called
       * and the history was never touched. Consumers render it as a plain
       * statement of a deliberate no-op rather than as a refusal, and the
       * desktop does not repeat it as a second surface (UI audit v0.0.49 §C3).
       */
      skipped?: true;
      /**
       * The instruction that WOULD have been / was sent. Carried on every
       * outcome (GitHub #36) so a refused or failed row can still show the
       * prompt beside its reason; for a structural skip the model was never
       * called, and this is the instruction the skipped call would have used.
       */
      prompt: string;
      /**
       * Constructed-port model id of the summarizing call, present when the
       * port exposes one — on failures too: the model was chosen before the
       * call failed, so a failed row can name who was asked.
       */
      model?: string;
    };

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
      this.baselineEstimate = this.deps.history.totalTokenEstimateForRoute(this.deps.modelPort.reasoningReplaySource?.(this.deps.reasoningEffort?.()));
    }
  }

  /**
   * Current context size. With a provider baseline: providerTokens + the change
   * in the local estimate since that baseline (clamped at 0) — so appends grow
   * it and microcompact shrinks it while the provider number stays authoritative
   * for the bulk. Without one: the pure local estimate.
   */
  estimate(): { tokens: number; source: "provider" | "estimate" } {
    const raw = this.deps.history.totalTokenEstimateForRoute(this.deps.modelPort.reasoningReplaySource?.(this.deps.reasoningEffort?.()));
    if (this.providerTokens !== null) {
      const delta = raw - this.baselineEstimate;
      return { tokens: Math.max(0, this.providerTokens + delta), source: "provider" };
    }
    return { tokens: raw + (this.deps.requestOverheadTokens?.() ?? 0), source: "estimate" };
  }

  /** Discard usage from a previous model while retaining history and breaker state. */
  invalidateProviderAnchor(): void {
    this.providerTokens = null;
    this.baselineEstimate = 0;
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
  maybeMicrocompact(turnId?: string, turnStartItemId?: string): { clearedToolResults: number; savedTokens: number } | null {
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
    // Keep all reasoning from the current turn, including before steering frames.
    const turnStart = items.findIndex((item) => turnStartItemId !== undefined ? item.id === turnStartItemId :
      turnId !== undefined && item.turnId === turnId && item.step === 0 && item.message.role === "user");
    const lastUserIndex = items.findLastIndex((item) => item.message.role === "user" && item.origin !== "system");
    const reasoningCutoff = Math.min(toolItemIndices[toolItemIndices.length - keep] ?? items.length, turnStart >= 0 ? turnStart : (turnId !== undefined || turnStartItemId !== undefined ? 0 : lastUserIndex));

    let clearedToolResults = 0;
    let savedTokens = 0;
    let toolSavedTokens = 0;
    let mutated = false;

    const next: HistoryItem[] = items.map((item, index) => {
      if (item.message.role === "assistant" && index < reasoningCutoff && item.message.content.some((part) => part.type === "reasoning")) {
        mutated = true;
        const message: ChatMessage = { role: "assistant", content: item.message.content.filter((part) => part.type !== "reasoning") };
        const oldEstimate = item.tokenEstimate ?? estimateMessageTokens(this.deps.tokenizer, item.message);
        const newEstimate = estimateMessageTokens(this.deps.tokenizer, message);
        savedTokens += oldEstimate - newEstimate;
        return { ...item, message, tokenEstimate: newEstimate };
      }
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
      toolSavedTokens += oldEstimate - newEstimate;
      return { ...item, message, tokenEstimate: newEstimate, kind: "microcompact_cleared" };
    });

    if (!mutated || clearedToolResults === 0 || toolSavedTokens < this.deps.config.microcompactMinSavingsTokens) {
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
    if (this.deps.history.items.length <= this.deps.config.keepRecentMessages) {
      return false;
    }
    return this.estimate().tokens >= compactThresholdTokens(this.deps.config);
  }

  /**
   * LLM compaction, transactional. The prefix is everything before a boundary
   * placed at `len - keepRecentMessages` and shifted BACK to the nearest user
   * item — or, when the only user item sits before the whole window (a
   * single-steer session), to the nearest assistant item, which starts a block
   * so its tool results stay with it. Either way the verbatim tail never
   * splits a tool_call from its result. The prefix is summarized via
   * modelPort (text only; tool calls ignored) and the whole history is swapped
   * for [compact_summary user item, ...tail] in one replaceAll. On an empty
   * prefix — or one consisting only of existing compact_summary items (
   * a repeated compaction of an already-summarized prefix) — the call is a
   * structural no-op. Below the compaction threshold that is not a breaker
   * failure, and neither on a still-short history whose pressure comes from
   * the request overhead alone; on a longer history under pressure the skip
   * would repeat on every turn while the context keeps growing, so it counts
   * as a breaker failure. On
   * error/empty-summary/abort the history is untouched and — on the auto
   * trigger — the failure counter increments; the configured number of
   * consecutive failures trips the breaker. The breaker is fed on the auto
   * trigger only: a manual /compact never changes its state (its structural
   * skip stays a benign no-op, and a failed attempt leaves the breaker alone —
   * the user is present, reads the error, and simply retries).
   */
  async runCompaction(opts: { signal?: AbortSignal; trigger?: "auto" | "manual" }): Promise<RunCompactionResult> {
    // A manual /compact never feeds the breaker: a structural skip there is
    // the benign no-op it is below the threshold, and none of its real
    // failures (provider error, cancel, empty summary) may disable the
    // session's auto-compaction — the user is present and can read the row
    // and retry, unlike the auto path where a skip would repeat on every turn
    // while the context keeps growing.
    const trigger = opts.trigger ?? "auto";
    const preTokens = this.estimate().tokens;
    const signal = opts.signal;
    const items = this.deps.history.items;
    // Constructed-port identity of the summarizing call (GitHub #36 meta line).
    // Read once here: a port's id never changes, and an unnamed port (a stub,
    // or a transport that exposes none) simply leaves the field off.
    const modelId = this.deps.modelPort.modelId;

    const boundary = this.compactionBoundary(items);
    // Under pressure a structural skip would repeat on every turn while the
    // context keeps growing — invisible to the breaker, so the retry loop
    // would never end. Only when the history is long enough for compaction to
    // be the remedy, though: overhead-dominated pressure on a still-short
    // history (e.g. a degraded small-window boot) skips benignly, exactly as
    // below the threshold. The auto trigger only — see runCompaction's head.
    const underPressure =
      trigger === "auto" &&
      preTokens >= compactThresholdTokens(this.deps.config) &&
      items.length > this.deps.config.keepRecentMessages;
    // boundary <= 0 => empty prefix: nothing to compact. Not a failure below
    // the compaction threshold; under pressure it counts as one.
    if (boundary <= 0) {
      if (underPressure) {
        return this.recordFailure(preTokens, COMPACTION_SKIP_UNDER_PRESSURE, modelId, trigger === "auto");
      }
      return {
        ok: false,
        preTokens,
        error: "Nothing to compact yet — the conversation is too short",
        skipped: true,
        prompt: COMPACTION_INSTRUCTION,
        ...(modelId !== undefined ? { model: modelId } : {}),
      };
    }
    // A prefix made up entirely of existing compact_summary items (a repeated
    // /compact right after a prior success) has nothing new to summarize.
    // Pure structural check on `kind`; same skip semantics as an empty prefix.
    if (items.slice(0, boundary).every((item) => item.kind === "compact_summary")) {
      if (underPressure) {
        return this.recordFailure(preTokens, COMPACTION_SKIP_UNDER_PRESSURE, modelId, trigger === "auto");
      }
      return {
        ok: false,
        preTokens,
        error: "Nothing to compact yet — the earlier conversation is already summarized",
        skipped: true,
        prompt: COMPACTION_INSTRUCTION,
        ...(modelId !== undefined ? { model: modelId } : {}),
      };
    }

    const prefixMessages: ChatMessage[] = [];
    for (let i = 0; i < boundary; i += 1) {
      prefixMessages.push(withoutReasoning(items[i]!.message));
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
        } else if (event.type === "stream_retry") {
          // review: a mid-stream replay discards the partial
          // attempt; keeping its text would install a duplicated summary.
          summary = "";
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
      return this.recordFailure(preTokens, "compaction aborted", modelId, trigger === "auto");
    }
    if (streamError !== null) {
      return this.recordFailure(preTokens, streamError, modelId, trigger === "auto");
    }
    const trimmed = summary.trim();
    if (trimmed.length === 0) {
      return this.recordFailure(preTokens, "compaction produced an empty summary", modelId, trigger === "auto");
    }

    const summaryText = `${COMPACT_SUMMARY_PREFIX}${trimmed}`;
    const message: ChatMessage = { role: "user", content: summaryText };
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
    this.invalidateProviderAnchor();
    const postTokens = this.estimate().tokens;
    // GitHub #36: the row that reports this swap must be able to show what
    // replaced the prefix — the text itself, the durable item that holds it,
    // and which model/instruction produced it.
    return {
      ok: true,
      preTokens,
      postTokens,
      summary: summaryText,
      summaryItemId: summaryItem.id,
      prompt: COMPACTION_INSTRUCTION,
      ...(modelId !== undefined ? { model: modelId } : {}),
    };
  }

  /**
   * Boundary index: the largest index <= (len - keepRecentMessages) whose item
   * is a user message. The prefix is items[0..boundary); the tail items[boundary..].
   * A single-steer session has no user item in that range (its only one sits
   * before the whole window), so the boundary falls back to the largest
   * assistant item there — an assistant item starts a block, so its tool
   * results stay with it in the tail and no tool_call is ever separated from
   * its result. Returns 0 when no clean boundary exists before the keep-recent
   * window (caller treats <= 0 as an empty prefix / skip).
   */
  private compactionBoundary(items: readonly HistoryItem[]): number {
    const raw = items.length - this.deps.config.keepRecentMessages;
    const upper = Math.min(raw, items.length - 1);
    for (let i = upper; i >= 1; i -= 1) {
      if (items[i]!.message.role === "user") {
        return i;
      }
    }
    for (let i = upper; i >= 1; i -= 1) {
      if (items[i]!.message.role === "assistant") {
        return i;
      }
    }
    return 0;
  }

  /**
   * Records a failed attempt. Feeds the circuit breaker only when the caller
   * asked for the compaction itself (the auto trigger): a manual /compact
   * failure returns the error to its caller without touching breaker state.
   */
  private recordFailure(
    preTokens: number,
    error: string,
    modelId: string | undefined,
    feedsBreaker: boolean,
  ): RunCompactionResult {
    if (feedsBreaker) {
      this.consecutiveFailures += 1;
    }
    return {
      ok: false,
      preTokens,
      error,
      prompt: COMPACTION_INSTRUCTION,
      ...(modelId !== undefined ? { model: modelId } : {}),
    };
  }
}

/** The summarizer needs what was said and done, not the old reasoning (GitHub #41). */
function withoutReasoning(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || !message.content.some((part) => part.type === "reasoning")) return message;
  return { role: "assistant", content: message.content.filter((part) => part.type !== "reasoning") };
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
 * `error.message`, which can embed a response body or auth header (
 * W7b-FIX #2).
 */
function errorText(error: unknown): string {
  return classifyProviderFailure(error).safe.message;
}
