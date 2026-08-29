/**
 * SubagentStallClock tests (TASK.148 slice 1). Hermetic: no ModelPort, no
 * dispatcher — the class only ever sees noteProgress()/pause()/resume()/
 * dispose() calls and Date/setTimeout, so vi.useFakeTimers() (the FULL fake,
 * not the codebase's usual `toFake:["Date"]}` deadline-check style — this
 * detector genuinely needs a firing timer, not a synchronous boundary check)
 * drives every scenario deterministically.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentStallClock, type SubagentStallReport } from "./stall-clock.js";

const TIMEOUT_MS = 600_000;

function recorder(): { reports: SubagentStallReport[]; onStall: (r: SubagentStallReport) => void } {
  const reports: SubagentStallReport[] = [];
  return { reports, onStall: (r) => reports.push(r) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SubagentStallClock (TASK.148 slice 1)", () => {
  it("reports exactly one stall notice once silence passes the threshold", async () => {
    vi.useFakeTimers();
    const { reports, onStall } = recorder();
    const clock = new SubagentStallClock({
      agentType: "general-purpose",
      description: "child task",
      timeoutMs: TIMEOUT_MS,
      onStall,
    });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(reports).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      agentType: "general-purpose",
      description: "child task",
      waitingForApproval: false,
    });
    expect(reports[0]!.silentMs).toBeGreaterThanOrEqual(TIMEOUT_MS);

    // Silence continuing past the first notice must not produce a second one.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    expect(reports).toHaveLength(1);

    clock.dispose();
  });

  it("a sign of life resets the clock — a child that keeps working never stalls", async () => {
    vi.useFakeTimers();
    const { reports, onStall } = recorder();
    const clock = new SubagentStallClock({
      agentType: "general-purpose",
      description: "child task",
      timeoutMs: TIMEOUT_MS,
      onStall,
    });

    // Ten ticks at 90% of the threshold, each preceded by a sign of life:
    // total elapsed time (9 * 0.9 * TIMEOUT) far exceeds TIMEOUT_MS, but the
    // clock must never see an UNBROKEN silent stretch that long.
    for (let i = 0; i < 10; i += 1) {
      clock.noteProgress(`tool-${i}`);
      await vi.advanceTimersByTimeAsync(Math.floor(TIMEOUT_MS * 0.9));
    }
    expect(reports).toHaveLength(0);

    clock.dispose();
  });

  it("pause suppresses the notice for a wait longer than the threshold; resume continues from where it paused, not from a fresh cycle", async () => {
    vi.useFakeTimers();
    const { reports, onStall } = recorder();
    const clock = new SubagentStallClock({
      agentType: "general-purpose",
      description: "child task",
      timeoutMs: TIMEOUT_MS,
      onStall,
    });

    // Some real silence accrues before the ask starts.
    await vi.advanceTimersByTimeAsync(200_000);
    clock.pause();

    // Blocked far longer than the whole threshold: must produce nothing.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 50_000);
    expect(reports).toHaveLength(0);

    clock.resume();
    // Only ~400_000ms of budget remained (600_000 - 200_000) when it paused;
    // a FRESH cycle would need another 600_000ms from here. Prove it is not
    // a fresh cycle: fire well before that.
    await vi.advanceTimersByTimeAsync(450_000);
    expect(reports).toHaveLength(1);

    clock.dispose();
  });

  it("re-arms: silence -> notice -> sign of life -> silence again -> a second notice", async () => {
    vi.useFakeTimers();
    const { reports, onStall } = recorder();
    const clock = new SubagentStallClock({
      agentType: "general-purpose",
      description: "child task",
      timeoutMs: TIMEOUT_MS,
      onStall,
    });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(reports).toHaveLength(1);

    clock.noteProgress("tool-x");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reports).toHaveLength(2);

    clock.dispose();
  });

  it("dispose stops the clock: no further notice fires even past the threshold", async () => {
    vi.useFakeTimers();
    const { reports, onStall } = recorder();
    const clock = new SubagentStallClock({
      agentType: "general-purpose",
      description: "child task",
      timeoutMs: TIMEOUT_MS,
      onStall,
    });

    clock.dispose();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 2);
    expect(reports).toHaveLength(0);
  });

  it("timeoutMs <= 0 disables the clock entirely", async () => {
    vi.useFakeTimers();
    const { reports, onStall } = recorder();
    const clock = new SubagentStallClock({
      agentType: "general-purpose",
      description: "child task",
      timeoutMs: 0,
      onStall,
    });

    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(reports).toHaveLength(0);
    clock.dispose();
  });
});
