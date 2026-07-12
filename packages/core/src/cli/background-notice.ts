/**
 * Background-task completion notices (Phase 5 slice 5.5, design

 * I/O, no state, appending a structural tag to the user's next prompt so the
 * model — which has no other way to learn a background task finished between
 * turns (design §1's "no mid-turn wake", R4) — sees the update as part of its
 * own conversation history (honest about what the model actually saw,
 * plan.ts's precedent). The tag is `<system-reminder>`, already reserved in
 * PAIRED_REMINDER_TAGS (context/session-title.ts) for exactly this convention
 * — this is its first producer — so the title-derivation sanitizer strips it
 * with zero changes to session-title.ts or agent-loop.ts. Re-exported on the
 * core barrel (slice 6.DP-2) so the desktop host's Session injects
 * byte-identical notice blocks.
 */

import type { BackgroundTaskNotice } from "../ports/tasks.js";

/**

 * code, duration — deliberately WITHOUT any of the task's output; a model
 * that needs the output calls BashOutput itself). One line per notice,
 * joined with "\n"; an empty notices array formats to the empty string.
 */
export function formatTaskNotices(notices: readonly BackgroundTaskNotice[]): string {
  return notices.map(formatOneNotice).join("\n");
}

function formatOneNotice(notice: BackgroundTaskNotice): string {
  const exit = notice.exitCode !== null ? String(notice.exitCode) : "none";
  return `${notice.taskId} (\`${notice.command}\`): ${notice.status}, exit ${exit}, ${formatDuration(notice.durationMs)}`;
}

/** Whole-second duration, rounded (design §2's example: "34s") — no sub-second precision needed for a token-cheap notice. */
function formatDuration(durationMs: number): string {
  return `${Math.round(durationMs / 1000)}s`;
}

/**
 * Appends a `<system-reminder>` block listing every notice to the user's raw
 * prompt (design §2.C1, mirror of withPlanModeReminder). Called by the REPL
 * ONLY when `notices.length > 0` (main.ts's turn-input wiring) — a turn with
 * no completed background tasks never calls this, keeping that turn's input
 * byte-identical to pre-5.5 (design §1 DoD / L-invariant). This function
 * itself does not special-case an empty array; the call-site guard is what
 * keeps the byte-identity promise, not this function's own behavior.
 */
export function withBackgroundTaskNotices(userInput: string, notices: readonly BackgroundTaskNotice[]): string {
  return `${userInput}\n<system-reminder>\nBackground task update:\n${formatTaskNotices(notices)}\n</system-reminder>`;
}
