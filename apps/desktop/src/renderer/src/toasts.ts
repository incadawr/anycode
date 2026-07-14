/**
 * Renderer-side toast queue over the store's one-slot notice channel
 * (ui-roadmap §4-R8(a,b)) — pure logic only. The store's `notice` stays a
 * single overwrite slot (wire truth, and automation.ts projects it); this
 * module models the QUEUE the renderer derives from slot transitions plus
 * App-shell errors. Capped at TOAST_CAP live entries, newest first; evicted /
 * dismissed / expired entries are marked `leaving` (exit motion) and removed
 * by the component on animationend.
 *
 * Pure module law (frozen pure-export/test law): no React, no DOM, no side
 * effects — total functions over plain data, unit-tested in a node env
 * (toasts.test.ts), mirroring paste.ts/keymap.ts/fuzzy.ts.
 */
import type { NoticeKind } from "./store.js";

/** Renderer-only kind extension: App-shell create/resume errors join the
 *  queue without touching the frozen store NoticeKind union. */
export type ToastKind = NoticeKind | "shell_error";

/** Color is state (design thesis): neutral = informational chrome,
 *  warning = degraded-but-self-healing or settled-without-you,
 *  danger = the user's action was refused. */
export type ToastTone = "neutral" | "warning" | "danger";

/** Two glyphs only (R6 consumer-driven icon law: R8 draws Info + Warning). */
export type ToastGlyph = "info" | "warning";

export interface Toast {
  /** Stable renderer-side id (monotonic ref counter in App — the store notice has none). */
  id: number;
  kind: ToastKind;
  text: string;
  /** Exit-motion phase: still rendered, animating out, removed on animationend. */
  leaving: boolean;
  /** Bumped when a same-kind arrival coalesces into this entry — restarts the auto-hide window. */
  revision: number;
}

/** Live (non-leaving) stack cap — the 4th live toast evicts the oldest with exit motion. */
export const TOAST_CAP = 3;

/** Auto-hide window per toast; hover/focus on the stack pauses it. 0 disables. */
export const TOAST_AUTO_HIDE_MS = 5000;

/**
 * Kind → tone. Existing tints kept: permission_settled/turn_rejected =
 * warning, mode_change_rejected = danger. New rulings: stream_retry escalates
 * neutral→warning (a retry IS a degraded state — color encodes state);
 * shell_error = danger (the user's create/resume action failed); the
 * compaction family + microcompact + history truncation stay neutral
 * (informational bookkeeping). compaction_end is neutral even on failure —
 * the kind cannot see `event.ok`, the text carries it (accepted, §6-8 note).
 * Slice P7.26/R2: rewind_restored is neutral (a completed, user-confirmed
 * action — informational, like compaction_end), rewind_rejected is danger
 * (the user's rewind was refused, same tint as mode_change_rejected).
 * Codex-fixes TASK.39: engine_notice is warning — its only producer today
 * (cut §2(k).2) is a drift check firing when the server's effective posture
 * came back weaker than the persisted preset claims, a degraded-but-not-
 * refused state (same tint family as stream_retry/permission_settled).
 */
const TOAST_TONES: Readonly<Record<ToastKind, ToastTone>> = {
  turn_rejected: "warning",
  mode_change_rejected: "danger",
  permission_settled: "warning",
  compaction_start: "neutral",
  compaction_end: "neutral",
  microcompact: "neutral",
  stream_retry: "warning",
  session_history_truncated: "neutral",
  image_attach_rejected: "danger",
  background_task_rejected: "warning",
  rewind_restored: "neutral",
  rewind_rejected: "danger",
  engine_notice: "warning",
  worktree_notice: "warning",
  shell_error: "danger",
};

export function toastTone(kind: ToastKind): ToastTone {
  return TOAST_TONES[kind];
}

/** Glyph follows tone: neutral → Info, warning/danger → Warning. */
export function toastGlyph(kind: ToastKind): ToastGlyph {
  return TOAST_TONES[kind] === "neutral" ? "info" : "warning";
}

/**
 * Copy enrichment (ui-roadmap §4-R8(b): "errors name the fix") — display-side
 * ONLY, exact-full-string match, passthrough on any miss. This keeps every
 * store SET site and the wire byte-untouched: the three rewritable inputs are
 * (1) the host's single mode_change_rejected reason (host/session.ts:400 —
 * its only emit site) and (2,3) store.ts's two turn_rejected constants. Any
 * other text — including future/unknown host reasons — renders verbatim
 * (wire truth wins over polish). permission_settled/compaction/microcompact
 * copy already names outcome+cause: kept.
 */
const TOAST_REWRITES: ReadonlyArray<{ kind: ToastKind; match: string; text: string }> = [
  {
    kind: "mode_change_rejected",
    match: "cannot change mode during an active turn",
    text: "Mode change rejected — finish the running turn first.",
  },
  {
    kind: "turn_rejected",
    match: "Message rejected: the agent is still running the current turn.",
    text: "Message not sent — stop the running turn or wait for it to finish.",
  },
  {
    kind: "turn_rejected",
    match: "Message rejected: the host is not ready yet.",
    text: "Message not sent — still connecting. Try again in a moment.",
  },
  {
    kind: "permission_settled",
    match: "Permission request timed out — denied.",
    text: "Permission request timed out — the tool was denied. Run the turn again to retry.",
  },
];

export function rewriteToastText(kind: ToastKind, text: string): string {
  const hit = TOAST_REWRITES.find((r) => r.kind === kind && r.match === text);
  return hit ? hit.text : text;
}

/**
 * A later notice that makes an earlier one moot: compaction_end retires a
 * still-visible compaction_start ("compacting…" must not outlive
 * "compacted"). Same-kind repeats are handled by coalescing in enqueueToast,
 * not here.
 */
const TOAST_SUPERSEDES: Partial<Readonly<Record<ToastKind, ToastKind>>> = {
  compaction_end: "compaction_start",
};

/**
 * Queue insert, newest first. Three laws, applied in order:
 *  1. COALESCE — if a live (non-leaving) toast of the same kind exists, the
 *     arrival replaces its text in place and bumps `revision` (restarting its
 *     auto-hide) instead of stacking: stream_retry attempts 1..N and a
 *     hammered Enter produce ONE mutating toast, not three clones. Position
 *     and id are kept (calm: no reshuffle).
 *  2. SUPERSEDE — marks live toasts of the superseded kind as leaving.
 *  3. CAP — live entries beyond TOAST_CAP (oldest first, i.e. array tail)
 *     are marked leaving, never dropped instantly: eviction gets the same
 *     exit motion as dismissal. Leaving entries never count toward the cap
 *     and are never coalesce targets.
 */
export function enqueueToast(
  list: readonly Toast[],
  input: { id: number; kind: ToastKind; text: string },
): readonly Toast[] {
  const coalesceTarget = list.find((t) => !t.leaving && t.kind === input.kind);
  let next: Toast[];
  if (coalesceTarget) {
    next = list.map((t) =>
      t === coalesceTarget ? { ...t, text: input.text, revision: t.revision + 1 } : t,
    );
  } else {
    next = [{ id: input.id, kind: input.kind, text: input.text, leaving: false, revision: 0 }, ...list];
  }
  const superseded = TOAST_SUPERSEDES[input.kind];
  if (superseded !== undefined) {
    next = next.map((t) => (!t.leaving && t.kind === superseded ? { ...t, leaving: true } : t));
  }
  let liveSeen = 0;
  return next.map((t) => {
    if (t.leaving) {
      return t;
    }
    liveSeen += 1;
    return liveSeen > TOAST_CAP ? { ...t, leaving: true } : t;
  });
}

/** Begin exit motion (X click, auto-hide expiry, or programmatic). Idempotent; unknown id is a no-op. */
export function beginToastExit(list: readonly Toast[], id: number): readonly Toast[] {
  return list.map((t) => (t.id === id && !t.leaving ? { ...t, leaving: true } : t));
}

/** Final removal — called by the component on the exit animation's animationend. Unknown id is a no-op. */
export function removeToast(list: readonly Toast[], id: number): readonly Toast[] {
  return list.filter((t) => t.id !== id);
}
