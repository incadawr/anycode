/**
 * Pure final-text accumulator (TASK.102 CUT-S2 §2.6.3, slice S2b B4). A
 * child-mode host's terminal tap uses this to derive the SAME "final text"
 * an inline subagent's outcome would carry for an identical event sequence —
 * mirroring, verbatim, the text-lifecycle rules `createSubagentRunner`
 * applies to its own local `currentTurnText`/`finalText` variables
 * (subagents/runner.ts's `for await` loop over `loop.runTurn()`):
 *
 *  - `turn_start` RESETS the in-progress text (a fresh model step begins).
 *  - `text_delta` APPENDS to the in-progress text.
 *  - `stream_retry` RESETS the in-progress text — the step is replayed from
 *    scratch, so a partial attempt's text must never leak into the result
 *    (runner.ts: "The step is replayed from scratch; discard the aborted
 *    attempt's text").
 *  - `turn_end` FIXATES the in-progress text as the committed final text —
 *    runner.ts's own `finalText = currentTurnText` assignment. A later
 *    cutoff `turn_start` (max_turns) or an error before the NEXT `turn_end`
 *    can never overwrite an already-fixated result, because `final` is only
 *    ever written by `fixate`, never by `reset`/`append`.
 *
 * A child-mode host chains further turns across its whole lifetime for
 * queued steer messages (CUT-S2 §1.1/§2.6.3): each `turn_end` re-fixates
 * over the prior committed text, so `final` always reflects the LAST
 * completed turn — the same behavior runner.ts would exhibit if it were fed
 * more than one turn_end in a single run.
 *
 * Pure, immutable, I/O-free — mirrors card-snapshot.ts's
 * create*Accumulator/reduce-style precedent in this same directory so the
 * whole state transition surface is independently testable without a real
 * AgentLoop or ModelPort.
 */

import { capUtf8Bytes } from "../util/bytes.js";
import { SUBAGENT_OUTPUT_MAX_BYTES } from "../types/config.js";

export interface FinalTextAccumulator {
  /** Text accumulated since the last reset (turn_start/stream_retry); never itself the result. */
  readonly current: string;
  /** The last FIXATED (turn_end) text — the committed result. "" until the first turn_end. */
  readonly final: string;
}

export function createFinalTextAccumulator(): FinalTextAccumulator {
  return { current: "", final: "" };
}

/** `turn_start` / `stream_retry`: discards the in-progress text. Never touches `final`. */
export function resetFinalText(acc: FinalTextAccumulator): FinalTextAccumulator {
  return acc.current === "" ? acc : { ...acc, current: "" };
}

/** `text_delta`: appends model output onto the in-progress text. Never touches `final`. */
export function appendFinalText(acc: FinalTextAccumulator, text: string): FinalTextAccumulator {
  return text === "" ? acc : { ...acc, current: acc.current + text };
}

/** `turn_end`: commits the in-progress text as the new `final`, overwriting any prior fixation. */
export function fixateFinalText(acc: FinalTextAccumulator): FinalTextAccumulator {
  return acc.final === acc.current ? acc : { ...acc, final: acc.current };
}

/**
 * Caps the committed `final` text to `maxBytes` UTF-8 bytes (default
 * `SUBAGENT_OUTPUT_MAX_BYTES`, the SAME cap runner.ts applies via
 * `capUtf8Bytes(finalText, SUBAGENT_OUTPUT_MAX_BYTES)`), reporting whether
 * truncation happened. The in-progress `current` text is never read here —
 * only a fixated result is ever reported to a caller.
 */
export function finalizeFinalText(
  acc: FinalTextAccumulator,
  maxBytes: number = SUBAGENT_OUTPUT_MAX_BYTES,
): { text: string; truncated: boolean } {
  return capUtf8Bytes(acc.final, maxBytes);
}
