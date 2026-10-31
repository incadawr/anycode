/**
 * Turn-liveness working row (ui-roadmap §4-R3(a)). Rendered by MessageList at
 * the transcript tail while a turn runs and the tail block isn't itself live
 * (predicate lives in MessageList). Shimmer verb + elapsed seconds + esc hint.
 *
 * The whole row is aria-hidden: turn start/end is announced exactly once by
 * MessageList's dedicated status region, and a per-second tick inside the
 * transcript's aria-live column would spam screen readers.
 *
 * The host start timestamp is passed through the store, so time spent in
 * background tabs and across renderer reloads is included.
 */
import { useEffect, useState } from "react";

/**
 * Sober gerunds — the deliberate anti-whimsy contrast with Claude Code's
 * 184-word vocabulary (roadmap §3-a2). All four are truthful of an agent
 * turn at any phase. Fixed order, opens with "Working". "Waiting" (audit
 * D14) reads as what the fourth band is — the agent between phases — where
 * the old "Checking" stacked on the auto-check toasts and the permission
 * broker's own wording.
 */
export const WORKING_VERBS = ["Working", "Thinking", "Reviewing", "Waiting"] as const;
export const VERB_ROTATE_SECONDS = 12;

/** Verb index derives from elapsed (not mount-local state), so suppression gaps and remounts never reset the word. */
export function workingVerb(elapsedSeconds: number): string {
  const index = Math.floor(Math.max(0, elapsedSeconds) / VERB_ROTATE_SECONDS);
  return WORKING_VERBS[index % WORKING_VERBS.length]!;
}

/** 7s · 1m 04s · 1h 02m — zero-padded minor unit + tabular-nums = no width jitter on tick. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  }
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function WorkingRow({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));

  return (
    <div className="working-row" aria-hidden="true">
      <span className="working-verb shimmer-text">{workingVerb(elapsed)}…</span>
      <span className="working-elapsed">{formatElapsed(elapsed)}</span>
      <span className="working-hint">
        <kbd>esc</kbd> to interrupt
      </span>
    </div>
  );
}
