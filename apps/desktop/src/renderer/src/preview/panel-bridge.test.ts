/**
 * Pure-logic tests for the two coalescer factories (CUT.md §3 96-P2 test
 * list). Both `schedule` and `send` are injected so the tests control frame
 * boundaries deterministically — no real rAF/microtask timing involved. The
 * module-singleton wiring (real `window.anycode.previewPanel` calls, the
 * permanent overlay subscription, `usePanelMountState`) is untested per D16.
 */
import { describe, expect, it, vi } from "vitest";
import type { PreviewPanelBounds, PreviewPanelStatePayload } from "../../../shared/preview-panel.js";
import { createBoundsCoalescer, createStateCoalescer } from "./panel-bridge.js";

/** A controllable stand-in for rAF/queueMicrotask: `flush()` runs the single pending callback (if any), like one frame/tick elapsing. */
function manualScheduler() {
  let pending: (() => void) | null = null;
  return {
    schedule(flush: () => void): void {
      pending = flush;
    },
    flush(): void {
      const fn = pending;
      pending = null;
      fn?.();
    },
    isScheduled(): boolean {
      return pending !== null;
    },
  };
}

describe("createStateCoalescer", () => {
  it("does not send before the scheduled flush runs", () => {
    const scheduler = manualScheduler();
    const send = vi.fn();
    const coalescer = createStateCoalescer(scheduler.schedule, send);
    coalescer.push({ activeTabId: "t1", panelMounted: false, overlayOpen: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("last-write-wins: N pushes before flush send only the LAST payload, once", () => {
    const scheduler = manualScheduler();
    const send = vi.fn();
    const coalescer = createStateCoalescer(scheduler.schedule, send);
    const a: PreviewPanelStatePayload = { activeTabId: "t1", panelMounted: false, overlayOpen: false };
    const b: PreviewPanelStatePayload = { activeTabId: "t1", panelMounted: true, overlayOpen: false };
    const c: PreviewPanelStatePayload = { activeTabId: "t1", panelMounted: true, overlayOpen: true };
    coalescer.push(a);
    coalescer.push(b);
    coalescer.push(c);
    scheduler.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(c);
  });

  it("schedules again after a flush for the next push", () => {
    const scheduler = manualScheduler();
    const send = vi.fn();
    const coalescer = createStateCoalescer(scheduler.schedule, send);
    coalescer.push({ activeTabId: null, panelMounted: false, overlayOpen: false });
    scheduler.flush();
    expect(send).toHaveBeenCalledTimes(1);
    coalescer.push({ activeTabId: "t2", panelMounted: true, overlayOpen: true });
    expect(send).toHaveBeenCalledTimes(1);
    scheduler.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("createBoundsCoalescer", () => {
  const rectA: PreviewPanelBounds = { x: 0, y: 0, width: 100, height: 100 };
  const rectB: PreviewPanelBounds = { x: 0, y: 0, width: 200, height: 100 };

  it("N reports in one frame collapse into a single send of the LAST rect", () => {
    const scheduler = manualScheduler();
    const send = vi.fn();
    const coalescer = createBoundsCoalescer(scheduler.schedule, send);
    coalescer.report(rectA);
    coalescer.report(rectB);
    coalescer.report(rectA);
    expect(send).not.toHaveBeenCalled();
    scheduler.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(rectA);
  });

  it("an identical rect (by value) to the last SENT one produces zero sends", () => {
    const scheduler = manualScheduler();
    const send = vi.fn();
    const coalescer = createBoundsCoalescer(scheduler.schedule, send);
    coalescer.report(rectA);
    scheduler.flush();
    expect(send).toHaveBeenCalledTimes(1);
    coalescer.report({ ...rectA });
    scheduler.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a new frame with a genuinely different rect sends again", () => {
    const scheduler = manualScheduler();
    const send = vi.fn();
    const coalescer = createBoundsCoalescer(scheduler.schedule, send);
    coalescer.report(rectA);
    scheduler.flush();
    coalescer.report(rectB);
    scheduler.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(rectB);
  });

  it("does not schedule a second flush for reports arriving within the same pending frame", () => {
    const scheduler = manualScheduler();
    const send = vi.fn();
    const coalescer = createBoundsCoalescer(scheduler.schedule, send);
    coalescer.report(rectA);
    expect(scheduler.isScheduled()).toBe(true);
    coalescer.report(rectB);
    scheduler.flush();
    expect(scheduler.isScheduled()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
