/**
 * Tests for the plugins update scheduler (Taskana 4732 S1-B): jittered
 * startup delay, ~24h periodic re-arm with re-rolled jitter, gates
 * evaluated at every fire, fail-soft on a throwing pass, manual runs not
 * disturbing the cadence, stop() cancelling timers. Deterministic via
 * injected random/setTimer.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERIODIC_INTERVAL_RANGE_MS,
  DEFAULT_STARTUP_DELAY_RANGE_MS,
  createPluginsScheduler,
  type PluginsSchedulerDeps,
} from "./scheduler.js";

interface Timer {
  fn: () => void;
  ms: number;
  fired: boolean;
}

function makeClock() {
  const timers = new Set<Timer>();
  const setTimer = (fn: () => void, ms: number): Timer => {
    const timer: Timer = { fn, ms, fired: false };
    timers.add(timer);
    return timer;
  };
  const clearTimer = (handle: unknown): void => {
    timers.delete(handle as Timer);
  };
  const fireAll = async (): Promise<void> => {
    const pending = [...timers];
    for (const timer of pending) {
      timer.fired = true;
      timers.delete(timer);
      await timer.fn();
    }
  };
  return { timers, setTimer, clearTimer, fireAll };
}

function makeDeps(overrides: Partial<PluginsSchedulerDeps> = {}) {
  const passes: number[] = [];
  const clock = makeClock();
  const deps: PluginsSchedulerDeps = {
    runPass: async () => {
      passes.push(passes.length);
      return { installed: [], needsApproval: [], status: "ok" };
    },
    shouldRun: () => true,
    ...overrides,
  };
  return { deps: { ...deps, schedule: { setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...(overrides.schedule ?? {}) } }, passes, clock };
}

describe("createPluginsScheduler", () => {
  it("arms a startup-delayed first check within the 0–2 min jitter range", () => {
    const { deps, clock } = makeDeps({ schedule: { random: () => 0.5 } });
    const scheduler = createPluginsScheduler(deps);
    scheduler.start();
    const timer = [...clock.timers][0]!;
    expect(timer.ms).toBeGreaterThanOrEqual(DEFAULT_STARTUP_DELAY_RANGE_MS[0]);
    expect(timer.ms).toBeLessThanOrEqual(DEFAULT_STARTUP_DELAY_RANGE_MS[1]);
  });

  it("runs the pass on fire and re-arms at the ~24h interval with re-rolled jitter", async () => {
    let roll = 0.2;
    const { deps, clock, passes } = makeDeps({ schedule: { random: () => roll } });
    const scheduler = createPluginsScheduler(deps);
    scheduler.start();
    await clock.fireAll();
    expect(passes.length).toBe(1);
    const periodic = [...clock.timers][0]!;
    expect(periodic.ms).toBeGreaterThanOrEqual(DEFAULT_PERIODIC_INTERVAL_RANGE_MS[0]);
    expect(periodic.ms).toBeLessThanOrEqual(DEFAULT_PERIODIC_INTERVAL_RANGE_MS[1]);
    // re-roll the jitter on the next arm
    roll = 0.9;
    await clock.fireAll();
    expect(passes.length).toBe(2);
    const next = [...clock.timers][0]!;
    expect(next.ms).toBeGreaterThan(periodic.ms);
  });

  it("skips the pass but keeps the cadence when a gate turns false", async () => {
    let allowed = false;
    const { deps, clock, passes } = makeDeps({ shouldRun: () => allowed });
    const scheduler = createPluginsScheduler(deps);
    scheduler.start();
    await clock.fireAll();
    expect(passes.length).toBe(0); // gated off
    expect(clock.timers.size).toBe(1); // but re-armed
    allowed = true;
    await clock.fireAll();
    expect(passes.length).toBe(1);
  });

  it("fail-soft: a throwing pass logs and the next check still arms", async () => {
    const warnings: string[] = [];
    const { deps, clock } = makeDeps({
      runPass: async () => {
        throw new Error("network down");
      },
      logger: { warn: (msg) => warnings.push(msg), info: () => undefined },
    });
    const scheduler = createPluginsScheduler(deps);
    scheduler.start();
    await clock.fireAll();
    expect(warnings.some((w) => w.includes("periodic check failed"))).toBe(true);
    expect(clock.timers.size).toBe(1);
  });

  it("runManual runs immediately without consuming the schedule", async () => {
    const { deps, passes } = makeDeps();
    const scheduler = createPluginsScheduler(deps);
    scheduler.start();
    const result = await scheduler.runManual();
    expect(result.status).toBe("ok");
    expect(passes.length).toBe(1);
    expect(scheduler.isArmed()).toBe(true);
  });

  it("stop() cancels the pending timer; start() is idempotent", async () => {
    const { deps, clock, passes } = makeDeps();
    const scheduler = createPluginsScheduler(deps);
    scheduler.start();
    scheduler.start(); // no second timer
    expect(clock.timers.size).toBe(1);
    scheduler.stop();
    expect(scheduler.isArmed()).toBe(false);
    expect(clock.timers.size).toBe(0);
    await clock.fireAll(); // nothing armed, nothing fires
    expect(passes.length).toBe(0);
  });
});
