/** Unit tests for the abort utilities: signal linking and timeout races. */

import { describe, expect, it, vi } from "vitest";
import { linkAbortSignal, raceWithTimeout } from "./abort.js";

describe("linkAbortSignal", () => {
  it("aborts the child synchronously when the parent is already aborted", () => {
    const parent = new AbortController();
    parent.abort("parent-reason");

    const child = new AbortController();
    const dispose = linkAbortSignal(parent.signal, child);

    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe("parent-reason");
    // disposer is safe to call even on the already-aborted path.
    expect(() => dispose()).not.toThrow();
  });

  it("propagates a later parent abort to the child and carries the reason", () => {
    const parent = new AbortController();
    const child = new AbortController();
    const dispose = linkAbortSignal(parent.signal, child);

    expect(child.signal.aborted).toBe(false);
    parent.abort("cancelled-later");
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe("cancelled-later");
    dispose();
  });

  it("disposer removes the listener so a later parent abort does not touch the child", () => {
    const parent = new AbortController();
    const child = new AbortController();

    const removeSpy = vi.spyOn(parent.signal, "removeEventListener");
    const dispose = linkAbortSignal(parent.signal, child);
    dispose();
    expect(removeSpy).toHaveBeenCalledTimes(1);

    parent.abort("too-late");
    // listener was removed before the abort, so the child stays untouched.
    expect(child.signal.aborted).toBe(false);
  });

  it("disposer is idempotent", () => {
    const parent = new AbortController();
    const child = new AbortController();
    const removeSpy = vi.spyOn(parent.signal, "removeEventListener");
    const dispose = linkAbortSignal(parent.signal, child);
    dispose();
    dispose();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("raceWithTimeout", () => {
  it("resolves with the operation value when it settles first and clears the timer", async () => {
    const controller = new AbortController();
    const result = await raceWithTimeout(Promise.resolve(42), 10_000, controller);

    expect(result).toEqual({ timedOut: false, value: 42 });
    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts the controller with reason 'timeout' when the operation is too slow", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const never = new Promise<number>(() => {});
      const racePromise = raceWithTimeout(never, 500, controller);

      await vi.advanceTimersByTimeAsync(500);
      const result = await racePromise;

      expect(result.timedOut).toBe(true);
      expect(result.value).toBeUndefined();
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates an operation rejection that arrives before the timeout", async () => {
    const controller = new AbortController();
    const boom = new Error("handler exploded");
    await expect(raceWithTimeout(Promise.reject(boom), 10_000, controller)).rejects.toBe(boom);
    expect(controller.signal.aborted).toBe(false);
  });

  it("swallows a rejection that arrives after the timeout already won", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const controller = new AbortController();
      let rejectLate: (e: unknown) => void = () => {};
      const late = new Promise<number>((_, reject) => {
        rejectLate = reject;
      });

      const racePromise = raceWithTimeout(late, 200, controller);
      await vi.advanceTimersByTimeAsync(200);
      const result = await racePromise;
      expect(result.timedOut).toBe(true);

      // operation rejects only after the race is already decided by the timeout.
      rejectLate(new Error("late failure"));
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      vi.useRealTimers();
    }
  });
});
