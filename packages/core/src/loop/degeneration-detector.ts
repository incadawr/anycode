/**
 * Detects a degenerate generation loop: the model repeating the same text
 * (or reasoning) fragment verbatim, tandem-style, without making forward
 * progress (TASK.210). Live incident: a subagent's final turn repeated a
 * ~296-char phrase 341 times — 46,148 of 58,088 chars of the finished text —
 * for 24m32s, and was only cut by the provider's own 131,072-output-token
 * ceiling. Constants and their justification live next to the TASK.124 block
 * in types/config.ts.
 *
 * One instance covers ONE stream channel for ONE turn: the loop integrating
 * this (agent-loop.ts) runs two instances per turn (text, reasoning) and
 * resets both on stream_retry, since a replayed attempt would otherwise look
 * like an honest tandem repeat of itself.
 *
 * Algorithm: a suffix of a string and that suffix's reverse share the same
 * period (reversal cannot change how a string tiles), so the smallest period
 * of every suffix of the tail buffer can be read off the KMP prefix function
 * of the REVERSED buffer in one O(n) pass — the classic "L - pi[L-1]" period
 * trick applied to prefixes of the reversal instead of suffixes of the
 * original. The buffer is capped at DEGENERATION_WINDOW_CHARS and the O(n)
 * check only re-runs every DEGENERATION_CHECK_STRIDE_CHARS fed characters, so
 * the amortized cost is bounded — O(WINDOW/STRIDE) linear passes over the
 * buffer per character fed, a few tens of comparisons in practice, not the
 * O(1)-per-character claim an earlier revision of this docstring made (codex
 * review correction, TASK.210 second pass) — see
 * DEGENERATION_CHECK_STRIDE_CHARS's own docstring in types/config.ts for the
 * corrected arithmetic. Still independent of total stream length, which is
 * the property that actually matters here. A period above
 * DEGENERATION_WINDOW_CHARS/DEGENERATION_MIN_REPEATS (~1,365 chars) is a hard
 * structural blind spot, not a soft cap — see DEGENERATION_WINDOW_CHARS's
 * own docstring and this file's test suite for the dedicated regression test.
 */

import {
  DEGENERATION_CHECK_STRIDE_CHARS,
  DEGENERATION_MIN_PERIOD_CHARS,
  DEGENERATION_MIN_REPEATS,
  DEGENERATION_MIN_RUN_CHARS,
  DEGENERATION_WINDOW_CHARS,
} from "../types/config.js";

export interface DegenerationVerdict {
  /** Length, in UTF-16 code units, of the repeating fragment. */
  period: number;
  /** How many times that fragment repeats within the flagged run (floor). */
  repeats: number;
}

/** Standard KMP failure function: pi[i] = length of the longest proper prefix of t[0..i] that is also a suffix of it. */
function prefixFunction(t: string): number[] {
  const n = t.length;
  const pi = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    // Every index read below (i-1, k-1, i, k) is in [0, n) by the loop's own
    // invariants (k only ever shrinks via pi[k-1] while k>0, and i<n by the
    // for-condition) — the non-null assertions just satisfy
    // noUncheckedIndexedAccess for indices already proven in range.
    let k = pi[i - 1]!;
    while (k > 0 && t[i] !== t[k]) {
      k = pi[k - 1]!;
    }
    if (t[i] === t[k]) {
      k += 1;
    }
    pi[i] = k;
  }
  return pi;
}

export class DegenerationDetector {
  private buffer = "";
  private sinceLastCheck = 0;

  /** Feeds one chunk of streamed text. Returns a verdict the instant a qualifying loop is found, else null. */
  feed(chunk: string): DegenerationVerdict | null {
    if (chunk.length === 0) {
      return null;
    }
    this.buffer += chunk;
    if (this.buffer.length > DEGENERATION_WINDOW_CHARS) {
      // Keep only the tail: the detector only ever cares about a suffix.
      this.buffer = this.buffer.slice(this.buffer.length - DEGENERATION_WINDOW_CHARS);
    }
    this.sinceLastCheck += chunk.length;
    if (this.sinceLastCheck < DEGENERATION_CHECK_STRIDE_CHARS) {
      return null;
    }
    this.sinceLastCheck = 0;
    return this.check();
  }

  /** Clears all buffered state. Called on stream_retry so a replayed attempt starts with a clean slate. */
  reset(): void {
    this.buffer = "";
    this.sinceLastCheck = 0;
  }

  private check(): DegenerationVerdict | null {
    const s = this.buffer;
    const n = s.length;
    if (n < DEGENERATION_MIN_RUN_CHARS) {
      return null;
    }
    // Reversing turns "period of a suffix of s" into "period of a prefix of
    // the reversal" so the standard prefix-function trick applies directly.
    const reversed = s.split("").reverse().join("");
    const pi = prefixFunction(reversed);
    // Scan suffix lengths from the smallest checkable (MIN_RUN_CHARS) upward
    // and stop at the first that qualifies — the shortest, hence fastest to
    // detect, qualifying run.
    for (let i = DEGENERATION_MIN_RUN_CHARS - 1; i < n; i++) {
      const length = i + 1;
      const period = length - pi[i]!; // i < n === pi.length by construction
      if (period >= DEGENERATION_MIN_PERIOD_CHARS && period * DEGENERATION_MIN_REPEATS <= length) {
        return { period, repeats: Math.floor(length / period) };
      }
    }
    return null;
  }
}
