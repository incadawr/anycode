/**
 * SupervisorIdleWatchdog tests (taskana 4181). Hermetic: pure logic + injected
 * thresholds, no session, no queue, no env reads — the class only ever sees
 * note*() calls and setTimeout, so the FULL vi.useFakeTimers() fake (not the
 * codebase's usual `toFake:["Date"]}` style) drives every scenario
 * deterministically, exactly like the SubagentStallClock tests it mirrors.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUPERVISOR_IDLE_TERMINAL_MARKERS,
  SupervisorIdleWatchdog,
  resolveSupervisorIdleFirstMs,
  type SupervisorIdleFacts,
  type SupervisorIdleReport,
} from "./supervisor-idle-watchdog.js";
import {
  SUPERVISOR_IDLE_ESCALATE_AFTER,
  SUPERVISOR_IDLE_FIRST_MS,
  SUPERVISOR_IDLE_REPEAT_MS,
} from "@anycode/core";

const FIRST_MS = 15 * 60_000;
const REPEAT_MS = 10 * 60_000;
const ESCALATE_AFTER = 2;

function facts(): SupervisorIdleFacts {
  return {
    terminalMarkers: ["READY", "BLOCKED", "DONE", "ACCEPT"],
    firstAfterMs: FIRST_MS,
    repeatEveryMs: REPEAT_MS,
    escalateAfter: ESCALATE_AFTER,
  };
}

function recorder(): { reports: SupervisorIdleReport[]; onIdle: (r: SupervisorIdleReport) => void } {
  const reports: SupervisorIdleReport[] = [];
  return { reports, onIdle: (r) => reports.push(r) };
}

/**
 * Puts the watchdog in supervising-but-currently-idle mode: a detached child
 * went live and has since finished (the real host feed pushes transitions in
 * pairs — spawn → n>0, terminal → 0 — so a past dispatch is modeled by both).
 */
function supervising(watchdog: SupervisorIdleWatchdog): SupervisorIdleWatchdog {
  watchdog.noteBackgroundChildrenChanged(1);
  watchdog.noteBackgroundChildrenChanged(0);
  return watchdog;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SupervisorIdleWatchdog (taskana 4181)", () => {
  it("fires the first reminder exactly at firstAfterMs when a turn settles with no marker and no live children", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = supervising(new SupervisorIdleWatchdog(facts(), onIdle));

    watchdog.noteTurnSettled("Investigating the failing build, will report back.");

    await vi.advanceTimersByTimeAsync(FIRST_MS - 1);
    expect(reports).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({ idleMs: FIRST_MS, reminderCount: 1, escalated: false });

    watchdog.dispose();
  });

  it("never fires when the settled text carries a terminal marker (anywhere in the text)", async () => {
    for (const text of [
      "All steps verified. READY",
      "ACCEPT — evidence in the transcript, tests 40/40.",
      "Cannot proceed without credentials. BLOCKED by the environment.",
      "Nothing to do here: DONE.",
    ]) {
      vi.useFakeTimers();
      const { reports, onIdle } = recorder();
      const watchdog = supervising(new SupervisorIdleWatchdog(facts(), onIdle));

      watchdog.noteTurnSettled(text);
      // Advance past EVERY threshold (first + several repeats): must stay silent.
      await vi.advanceTimersByTimeAsync(FIRST_MS + REPEAT_MS * 5);
      expect(reports).toHaveLength(0);

      watchdog.dispose();
      vi.useRealTimers();
    }
  });

  it("a marker word inside a larger word does not disarm (word-boundary match)", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = supervising(new SupervisorIdleWatchdog(facts(), onIdle));

    // "READINESS" contains READY but is not the marker; "unACCEPTable" likewise.
    watchdog.noteTurnSettled("Still gathering READINESS context; the wait is unACCEPTable.");
    await vi.advanceTimersByTimeAsync(FIRST_MS);
    expect(reports).toHaveLength(1);

    watchdog.dispose();
  });

  it("noteTurnStarted disarms; settling again without a marker re-arms", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = supervising(new SupervisorIdleWatchdog(facts(), onIdle));

    watchdog.noteTurnSettled("no marker yet");
    await vi.advanceTimersByTimeAsync(FIRST_MS - 1);
    watchdog.noteTurnStarted(); // supervisor woke on its own, one tick before firing
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 3);
    expect(reports).toHaveLength(0);

    // Settles again WITHOUT a marker: re-armed, fresh full firstAfterMs.
    watchdog.noteTurnSettled("still no marker");
    await vi.advanceTimersByTimeAsync(FIRST_MS - 1);
    expect(reports).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.reminderCount).toBe(1);

    watchdog.dispose();
  });

  it("live children disarm the watchdog; children empty again re-arms a fresh firstAfterMs", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = supervising(new SupervisorIdleWatchdog(facts(), onIdle));

    watchdog.noteTurnSettled("no marker");
    await vi.advanceTimersByTimeAsync(FIRST_MS - 1);

    watchdog.noteBackgroundChildrenChanged(1); // a detached child goes live
    await vi.advanceTimersByTimeAsync(FIRST_MS + REPEAT_MS * 3);
    expect(reports).toHaveLength(0);

    watchdog.noteBackgroundChildrenChanged(0); // child finished; fresh window
    await vi.advanceTimersByTimeAsync(FIRST_MS - 1);
    expect(reports).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.reminderCount).toBe(1);

    watchdog.dispose();
  });

  it("repeats follow repeatEveryMs cadence; reminderCount increments; escalated strictly after escalateAfter", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = supervising(new SupervisorIdleWatchdog(facts(), onIdle));

    watchdog.noteTurnSettled("no marker");

    await vi.advanceTimersByTimeAsync(FIRST_MS);
    expect(reports.map((r) => r.reminderCount)).toEqual([1]);
    expect(reports[0]!.escalated).toBe(false);

    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(reports.map((r) => r.reminderCount)).toEqual([1, 2]);
    expect(reports[1]!.escalated).toBe(false); // 2 is NOT > escalateAfter (2)

    await vi.advanceTimersByTimeAsync(REPEAT_MS);
    expect(reports.map((r) => r.reminderCount)).toEqual([1, 2, 3]);
    expect(reports[2]!.escalated).toBe(true); // 3 > 2

    // The escalated reminder is the last one until progress.
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 5);
    expect(reports.map((r) => r.reminderCount)).toEqual([1, 2, 3]);

    // idleMs keeps counting from the arm: first at FIRST_MS, then +REPEAT_MS each.
    expect(reports[0]!.idleMs).toBe(FIRST_MS);
    expect(reports[1]!.idleMs).toBe(FIRST_MS + REPEAT_MS);
    expect(reports[2]!.idleMs).toBe(FIRST_MS + REPEAT_MS * 2);

    watchdog.dispose();
  });

  it("repeats stop while children are live and resume on the next idle settle — never while work is in flight", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = supervising(new SupervisorIdleWatchdog(facts(), onIdle));

    watchdog.noteTurnSettled("no marker");
    await vi.advanceTimersByTimeAsync(FIRST_MS); // reminder 1 fires
    expect(reports).toHaveLength(1);

    watchdog.noteBackgroundChildrenChanged(2); // work arrives before reminder 2
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 4);
    expect(reports).toHaveLength(1); // repeats suppressed while children live

    watchdog.noteBackgroundChildrenChanged(0); // fresh idle window
    await vi.advanceTimersByTimeAsync(FIRST_MS);
    expect(reports).toHaveLength(2);
    expect(reports[1]!.reminderCount).toBe(1); // counter RESET on the fresh arm

    watchdog.dispose();
  });

  it("a turn settling while children are LIVE never arms — zero reminders for a long-running child (4181 D1)", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = new SupervisorIdleWatchdog(facts(), onIdle);
    watchdog.noteBackgroundChildrenChanged(1); // child live, no past dispatch

    // The detach loop's own shape: child goes live, supervisor's turn ends
    // "Dispatched, awaiting report." (no marker — correct, work is running).
    // Settling here must NOT start a reminder timer: the child is in flight.
    watchdog.noteTurnSettled("Dispatched GLM, awaiting report.");
    await vi.advanceTimersByTimeAsync(FIRST_MS + REPEAT_MS * 2);
    expect(reports).toHaveLength(0);

    // Stays silent however long the child runs (the card's own 24-minute run).
    watchdog.noteTurnSettled("Still waiting on the child.");
    await vi.advanceTimersByTimeAsync(FIRST_MS + REPEAT_MS * 2);
    expect(reports).toHaveLength(0);

    // The children->empty transition arms the fresh window exactly once.
    watchdog.noteBackgroundChildrenChanged(0);
    await vi.advanceTimersByTimeAsync(FIRST_MS - 1);
    expect(reports).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports.map((r) => r.reminderCount)).toEqual([1]);

    watchdog.dispose();
  });

  it("the reminder chain pauses on a live child mid-chain and resumes from the settle after it empties", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = supervising(new SupervisorIdleWatchdog(facts(), onIdle));

    watchdog.noteTurnSettled("no marker");
    await vi.advanceTimersByTimeAsync(FIRST_MS); // reminder 1 fires
    expect(reports).toHaveLength(1);

    // Reminder 1's own turn settles while a NEW child is already running:
    // the repeat arm must be suppressed (live child), not scheduled.
    watchdog.noteBackgroundChildrenChanged(1);
    watchdog.noteTurnStarted();
    watchdog.noteTurnSettled("Child 2 dispatched, awaiting report.");
    await vi.advanceTimersByTimeAsync(REPEAT_MS * 5);
    expect(reports).toHaveLength(1);

    watchdog.dispose();
  });

  it("an ordinary chat that never had a live detached child is never reminded", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = new SupervisorIdleWatchdog(facts(), onIdle);

    watchdog.noteTurnSettled("Here is the refactor you asked for.");
    watchdog.noteBackgroundChildrenChanged(0);
    await vi.advanceTimersByTimeAsync(FIRST_MS + REPEAT_MS * 5);
    expect(reports).toHaveLength(0);

    watchdog.dispose();
  });

  it("the reminder's own marker-less turns continue the chain: escalation is reached, then silence", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = supervising(new SupervisorIdleWatchdog(facts(), onIdle));
    watchdog.noteBackgroundChildrenChanged(0);
    watchdog.noteTurnStarted(); // the child's report turn
    watchdog.noteTurnSettled("Reviewed the report.");

    await vi.advanceTimersByTimeAsync(FIRST_MS);
    for (let i = 0; i < 3; i += 1) {
      // Each reminder is delivered as a system turn that again ends without a marker.
      watchdog.noteTurnStarted();
      watchdog.noteTurnSettled("Hmm, let me think.");
      await vi.advanceTimersByTimeAsync(REPEAT_MS);
    }
    expect(reports.map((r) => [r.reminderCount, r.escalated])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    await vi.advanceTimersByTimeAsync(FIRST_MS + REPEAT_MS * 5);
    expect(reports).toHaveLength(3);

    // A new dispatch is progress: the chain starts over.
    watchdog.noteBackgroundChildrenChanged(1);
    watchdog.noteBackgroundChildrenChanged(0);
    await vi.advanceTimersByTimeAsync(FIRST_MS);
    expect(reports).toHaveLength(4);
    expect(reports[3]!.reminderCount).toBe(1);

    watchdog.dispose();
  });

  it("a terminal marker ends supervision: later marker-less chat settles never arm", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = supervising(new SupervisorIdleWatchdog(facts(), onIdle));
    watchdog.noteBackgroundChildrenChanged(0);
    watchdog.noteTurnSettled("ACCEPT — all green.");
    watchdog.noteTurnSettled("Sure, here is an unrelated answer.");
    await vi.advanceTimersByTimeAsync(FIRST_MS + REPEAT_MS * 5);
    expect(reports).toHaveLength(0);

    watchdog.dispose();
  });

  it("dispose() stops everything", async () => {
    vi.useFakeTimers();
    const { reports, onIdle } = recorder();
    const watchdog = supervising(new SupervisorIdleWatchdog(facts(), onIdle));

    watchdog.noteTurnSettled("no marker");
    watchdog.dispose();
    await vi.advanceTimersByTimeAsync(FIRST_MS + REPEAT_MS * 5);
    expect(reports).toHaveLength(0);

    // Post-dispose notes are no-ops too.
    watchdog.noteTurnSettled("no marker");
    watchdog.noteTurnStarted();
    watchdog.noteBackgroundChildrenChanged(0);
    await vi.advanceTimersByTimeAsync(FIRST_MS + REPEAT_MS * 5);
    expect(reports).toHaveLength(0);
  });

  it("default facts exported from config are sane", () => {
    expect(SUPERVISOR_IDLE_FIRST_MS).toBe(15 * 60_000);
    expect(SUPERVISOR_IDLE_REPEAT_MS).toBe(10 * 60_000);
    expect(SUPERVISOR_IDLE_ESCALATE_AFTER).toBe(2);
    expect(SUPERVISOR_IDLE_TERMINAL_MARKERS).toEqual(["READY", "BLOCKED", "DONE", "ACCEPT"]);
  });

  it("resolveSupervisorIdleFirstMs: default on absent/blank, value on valid, warn+default on non-integer and negative (P4)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(resolveSupervisorIdleFirstMs({}, 900_000)).toBe(900_000);
    expect(resolveSupervisorIdleFirstMs({ ANYCODE_SUPERVISOR_IDLE_MS: "   " }, 900_000)).toBe(900_000);
    expect(resolveSupervisorIdleFirstMs({ ANYCODE_SUPERVISOR_IDLE_MS: "45000" }, 900_000)).toBe(45_000);

    expect(resolveSupervisorIdleFirstMs({ ANYCODE_SUPERVISOR_IDLE_MS: "yes" }, 900_000)).toBe(900_000);
    expect(resolveSupervisorIdleFirstMs({ ANYCODE_SUPERVISOR_IDLE_MS: "-5" }, 900_000)).toBe(900_000);
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });
});
