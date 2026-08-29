/**
 * Subagent stall detector (TASK.148 slice 1). Measures SILENCE — time since the
 * child last showed a sign of life — never total wall-clock work time; reports
 * once past the threshold and keeps running, never kills, never aborts, never
 * ends the loop. Shared by both subagent tiers: the inline runner
 * (subagents/runner.ts) drives one directly against its own AgentLoop's
 * progress callbacks; the desktop session tier (host/child-session-port.ts)
 * drives one against the coarse ChildRunEvent stream it already receives from
 * main. Neither tier's transport changes — this is a pure observer bolted onto
 * an existing progress feed.
 *
 * NOT the per-attempt HTTP stream stall watchdog (ANYCODE_STALL_TIMEOUT_MS /
 * DEFAULT_STREAM_STALL_TIMEOUT_MS, provider/retry.ts): that one guards a single
 * provider request against a dead connection. This one guards a whole child RUN
 * (which may span many requests, tool calls and — on the session tier — an
 * entire separate process) against going quiet with nobody told.
 *
 * "Waiting for a human" is deliberately NOT silence: pause()/resume() freeze
 * and thaw the countdown like a stopwatch, so an unanswered permission ask
 * never itself trips the detector — inheriting exactly that defect (a subagent
 * losing its whole wall-clock budget to an ask nobody could answer) is the
 * bug this instrument exists to remove. `remainingMs` carries the unconsumed
 * budget across a pause; a resumed clock fires after what was LEFT when it
 * paused, not after a fresh full timeout.
 */

export interface SubagentStallReport {
  agentType: string;
  description: string;
  /**
   * Wall-clock ms since the child's last sign of life. This DOES include any
   * interval spent waiting for a human: the pause only governs WHEN the notice
   * fires, not what it reports. Reporting the unpaused figure instead would be
   * useless — it always equals the threshold exactly — whereas the wall-clock
   * number is what tells a reader how long the child has actually been quiet.
   */
  silentMs: number;
  /** Last tool name / activity label the clock was told about, if any. */
  lastActivity?: string;
  /**
   * Whether the child is currently blocked on an unanswered permission ask.
   * Always false as reported by THIS class: a report is only ever produced
   * while unpaused (see the pause()/resume() contract above) — the field
   * rides the report anyway so a consumer never has to special-case its
   * absence, and so the shape matches the AgentEvent it feeds.
   */
  waitingForApproval: boolean;
}

export interface SubagentStallClockOptions {
  agentType: string;
  description: string;
  /** Silence threshold in ms; <= 0 disables the clock (it never fires). */
  timeoutMs: number;
  /** Fired at most once per silent stretch; re-armed by the next noteProgress(). */
  onStall: (report: SubagentStallReport) => void;
}

export class SubagentStallClock {
  private readonly agentType: string;
  private readonly description: string;
  private readonly timeoutMs: number;
  private readonly onStall: (report: SubagentStallReport) => void;

  /** Wall-clock moment of the last confirmed sign of life; used only to compute the reported silentMs. */
  private lastSignOfLifeAt: number;
  private lastActivity: string | undefined;
  /** Ms remaining on the current countdown, consulted by schedule()/pause(). */
  private remainingMs: number;
  /** Wall-clock moment the currently-armed timer was (re)started, for computing elapsed-since-arm on pause(). */
  private armedAt: number;
  /** Non-null while paused (waiting for a human) — the countdown is frozen. */
  private pausedAt: number | null = null;
  /** True once a notice has fired for the current silent stretch; cleared by the next noteProgress(). */
  private reported = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: SubagentStallClockOptions) {
    this.agentType = options.agentType;
    this.description = options.description;
    this.timeoutMs = options.timeoutMs;
    this.onStall = options.onStall;
    const now = Date.now();
    this.lastSignOfLifeAt = now;
    this.armedAt = now;
    this.remainingMs = this.timeoutMs;
    this.schedule();
  }

  /** (Re)arms the timer for `remainingMs` unless paused/reported/disabled/disposed. */
  private schedule(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.disposed || this.pausedAt !== null || this.reported || this.timeoutMs <= 0) {
      return;
    }
    this.armedAt = Date.now();
    const wait = Math.max(0, this.remainingMs);
    this.timer = setTimeout(() => this.fire(), wait);
    // Never itself keeps the process alive — this is an observer, not work.
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = null;
    if (this.disposed || this.pausedAt !== null || this.reported) {
      return;
    }
    this.reported = true;
    const silentMs = Date.now() - this.lastSignOfLifeAt;
    this.onStall({
      agentType: this.agentType,
      description: this.description,
      silentMs,
      lastActivity: this.lastActivity,
      waitingForApproval: false,
    });
  }

  /**
   * A sign of life from the child (a progress/activity signal on either
   * tier). Clears any already-reported notice and re-arms a full countdown —
   * this is the single re-arm point that lets a later silent stretch report
   * again. Also clears a stale pause: a genuine sign of life proves the child
   * is not (or no longer) blocked on a human.
   */
  noteProgress(activity?: string): void {
    if (this.disposed) {
      return;
    }
    if (activity !== undefined) {
      this.lastActivity = activity;
    }
    this.lastSignOfLifeAt = Date.now();
    this.remainingMs = this.timeoutMs;
    this.reported = false;
    this.pausedAt = null;
    this.schedule();
  }

  /**
   * Child is blocked on an unanswered permission ask: freezes the countdown
   * at whatever budget remains. Idempotent — a second pause() while already
   * paused is a no-op.
   */
  pause(): void {
    if (this.disposed || this.pausedAt !== null) {
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const elapsedSinceArm = Date.now() - this.armedAt;
    this.remainingMs = Math.max(0, this.remainingMs - elapsedSinceArm);
    this.pausedAt = Date.now();
  }

  /**
   * The ask was answered: thaws the countdown, resuming from the budget that
   * remained at pause() — never a fresh full timeout. Idempotent — a resume()
   * while not paused is a no-op.
   */
  resume(): void {
    if (this.disposed || this.pausedAt === null) {
      return;
    }
    this.pausedAt = null;
    this.schedule();
  }

  /** Stops the clock permanently — no further notice can ever fire. Call once the run ends. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
