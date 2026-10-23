/**
 * Supervisor idle watchdog (taskana 4181). Watches the ONE state of the
 * no-polling detach loop (TASK.145/148/218) that previously sat silent
 * forever: the supervisor's turn has ENDED, there are ZERO live detached
 * children, and the turn's final assistant text carries no terminal marker
 * (READY/BLOCKED/DONE/ACCEPT) — i.e. the chain is neither working nor closed,
 * and nothing will ever wake it (the fix's premise is the model never polls;
 * the HOST must notice instead).
 *
 * Mirrors `SubagentStallClock`'s shape (packages/core/src/subagents/
 * stall-clock.ts) on purpose: a pure, host-process-owned observer that only
 * REPORTS via the injected callback — never kills, never aborts, never ends
 * the loop, never touches the child machinery. Timer discipline is the same
 * re-arm pattern: ONE setTimeout at a time, cleared on every disarm/dispose,
 * unref'd so an armed reminder can never keep the host process alive.
 *
 * The three disarm/re-arm sources, in lifecycle order:
 *  - `noteTurnSettled(lastPublicText)`: the turn's final text. A terminal
 *    marker present anywhere in it means the supervisor CLOSED the task —
 *    disarm permanently until the next settle. Otherwise arm `firstAfterMs`.
 *  - `noteTurnStarted()`: any new turn start disarms the pending reminder (a
 *    reminder racing through anyway is held harmlessly by the busy
 *    child_report queue). The counter survives, so a reminder's own turn
 *    that again ends without a marker continues the chain.
 *  - `noteBackgroundChildrenChanged(n)`: live detached children going
 *    non-empty disarms (work is in flight; the per-child SubagentStallClock
 *    owns that regime); returning to empty re-arms a FRESH `firstAfterMs`.
 *
 * Supervision gate: the watchdog only arms for a session that has had a
 * live detached child since its last terminal marker — an ordinary chat
 * (every root session carries the seam) is never nagged.
 *
 * Reminder cadence: the first reminder fires after `firstAfterMs`; every
 * subsequent one after `repeatEveryMs`, with `reminderCount` 1, 2, 3, … The
 * text swap at escalation is the CALLER's job — the report just carries
 * `escalated: true` once `reminderCount > escalateAfter`. The escalated
 * reminder is the last one until real progress (marker or child dispatch).
 */

export interface SupervisorIdleFacts {
  /**
   * Terminal marker the supervisor's final assistant text must carry to count
   * as "closed". Matched as whole words anywhere in the text; a marker only
   * ever DISARMS this watchdog (never gates anything else), so a false
   * positive costs one reminder, nothing more.
   */
  terminalMarkers: readonly string[];
  /** Silence threshold before the FIRST reminder. Default SUPERVISOR_IDLE_FIRST_MS. */
  firstAfterMs: number;
  /** Threshold for every SUBSEQUENT reminder (same text) before escalating. */
  repeatEveryMs: number;
  /** After this many repeats, the reminder text switches to the OWNER variant. */
  escalateAfter: number;
}

export interface SupervisorIdleReport {
  /** Wall-clock ms the supervisor has been idle (since the arm that fired). */
  idleMs: number;
  /** 1 for the first reminder, +1 per repeat. */
  reminderCount: number;
  /** True strictly after `escalateAfter` ignored reminders. */
  escalated: boolean;
}

export const SUPERVISOR_IDLE_TERMINAL_MARKERS: readonly string[] = ["READY", "BLOCKED", "DONE", "ACCEPT"];

/**
 * Resolves the first-reminder threshold from the host process env
 * (ANYCODE_SUPERVISOR_IDLE_MS, taskana 4181) — the same knob core's
 * loadEnvConfig surfaces as `supervisorIdleMs`, read here directly because a
 * codex/claude boot deliberately never constructs a CoreEnvConfig. Parse
 * discipline mirrors env.ts's `readOptionalInteger`: absent/blank -> default;
 * a non-integer is ignored with a warning (a typo must not kill a boot for a
 * watch-only observer's threshold).
 */
export function resolveSupervisorIdleFirstMs(env: NodeJS.ProcessEnv, defaultMs: number): number {
  const raw = env.ANYCODE_SUPERVISOR_IDLE_MS;
  if (raw === undefined || raw.trim() === "") {
    return defaultMs;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    console.warn(`Invalid ANYCODE_SUPERVISOR_IDLE_MS: "${raw}" is not an integer — ignoring`);
    return defaultMs;
  }
  return parsed;
}

/** Escapes regex metacharacters so a marker literal matches only itself. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class SupervisorIdleWatchdog {
  private readonly facts: SupervisorIdleFacts;
  private readonly onIdle: (report: SupervisorIdleReport) => void;

  /** Wall-clock moment of the arm that started the current silent stretch. */
  private idleSince: number;
  private reminderCount = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /**
   * True once this session has had a live detached child since its last
   * terminal marker — i.e. it is actually SUPERVISING. Every root session
   * carries the seam (codex and core), so without this gate an ordinary chat
   * whose answer happens to lack a marker word would get a system reminder
   * turn every 15 minutes. Cleared by a terminal marker (the chain closed).
   */
  private supervising = false;
  /**
   * True after the escalated (owner) reminder fired: the chain stays silent
   * until real progress (a marker, or a child dispatch) — the reminders are
   * themselves paid turns and must not repeat forever on an unattended night.
   */
  private exhausted = false;

  constructor(facts: SupervisorIdleFacts, onIdle: (report: SupervisorIdleReport) => void) {
    this.facts = facts;
    this.onIdle = onIdle;
    this.idleSince = Date.now();
  }

  /**
   * Called when the session's turn settles. `lastPublicText` = the turn's
   * final assistant text: a terminal marker anywhere in it → disarm and end
   * supervision. Otherwise (only while supervising): the first settle of a
   * silent stretch arms `firstAfterMs`; a settle that follows a reminder
   * (the reminder's own turn, still no marker) keeps the counter and arms
   * `repeatEveryMs`, so the chain does escalate instead of restarting at 1.
   */
  noteTurnSettled(lastPublicText: string): void {
    if (this.disposed) {
      return;
    }
    if (this.hasTerminalMarker(lastPublicText)) {
      this.disarm();
      this.reminderCount = 0;
      this.supervising = false;
      this.exhausted = false;
      return;
    }
    if (!this.supervising || this.exhausted) {
      return;
    }
    if (this.reminderCount > 0) {
      this.schedule(this.facts.repeatEveryMs);
      return;
    }
    this.armFresh();
  }

  /** Any new turn start disarms the pending reminder (the supervisor is awake). */
  noteTurnStarted(): void {
    if (this.disposed) {
      return;
    }
    this.disarm();
  }

  /**
   * Live detached children changed: non-empty → this session supervises;
   * disarm and reset (work in flight, the per-child stall clock owns that
   * regime); empty again → re-arm a FRESH `firstAfterMs`.
   */
  noteBackgroundChildrenChanged(liveChildren: number): void {
    if (this.disposed) {
      return;
    }
    if (liveChildren > 0) {
      this.supervising = true;
      this.exhausted = false;
      this.reminderCount = 0;
      this.disarm();
    } else if (this.supervising && !this.exhausted) {
      this.armFresh();
    }
  }

  /** Stops everything permanently — no further reminder can ever fire. */
  dispose(): void {
    this.disposed = true;
    this.disarm();
  }

  private hasTerminalMarker(text: string): boolean {
    return this.facts.terminalMarkers.some((marker) => new RegExp(`\\b${escapeRegExp(marker)}\\b`).test(text));
  }

  /** Starts a fresh silent stretch: resets the counter, arms the first reminder. */
  private armFresh(): void {
    this.reminderCount = 0;
    this.idleSince = Date.now();
    this.schedule(this.facts.firstAfterMs);
  }

  /** Cancels the pending reminder. */
  private disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(waitMs: number): void {
    this.disarm();
    this.timer = setTimeout(() => this.fire(), Math.max(0, waitMs));
    // Never itself keeps the host process alive — this is an observer, not work.
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = null;
    if (this.disposed) {
      return;
    }
    this.reminderCount += 1;
    const escalated = this.reminderCount > this.facts.escalateAfter;
    this.onIdle({
      idleMs: Date.now() - this.idleSince,
      reminderCount: this.reminderCount,
      escalated,
    });
    if (escalated) {
      // The owner variant is the last word: no further reminder until progress.
      this.exhausted = true;
      return;
    }
    this.schedule(this.facts.repeatEveryMs);
  }
}
