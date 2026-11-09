import { describe, expect, it } from "vitest";
import type { WireBackgroundChild } from "../../shared/protocol.js";
import {
  DISMISSED_FAILED_REPORT_LIMIT,
  FAILED_BACKGROUND_CHILD_LIMIT,
  dismissFailedChild,
  recordFailedChild,
} from "./failed-background-children.js";

function child(n: number, extra: Partial<WireBackgroundChild> = {}): WireBackgroundChild {
  return { childSessionId: `child-${n}`, spawnToolCallId: `spawn-${n}`, agentType: "worker", description: `task ${n}`, startedAt: 1_000 * n, ...extra };
}

const terminal = (n: number, durationMs?: number) => ({ reportId: `spawn-${n}`, failureReason: `boom ${n}`, durationMs });

describe("recordFailedChild", () => {
  it("copies description and startedAt from the retained snapshot and freezes endedAt from durationMs", () => {
    const next = recordFailedChild([], [], [child(1, { turns: 3 })], terminal(1, 250), 99_999);
    expect(next).toEqual([{ ...child(1, { turns: 3 }), failureReason: "boom 1", endedAt: 1_250 }]);
  });

  it("clamps a negative duration to zero", () => {
    expect(recordFailedChild([], [], [child(1)], terminal(1, -50), 9)?.[0]?.endedAt).toBe(1_000);
  });

  it("freezes at the receipt time when the terminal has no usable duration", () => {
    expect(recordFailedChild([], [], [child(1)], terminal(1), 7_777)?.[0]?.endedAt).toBe(7_777);
    expect(recordFailedChild([], [], [child(1)], terminal(1, Number.NaN), 7_778)?.[0]?.endedAt).toBe(7_778);
  });

  it("a duplicate report does not reset endedAt or the reason", () => {
    const first = recordFailedChild([], [], [child(1)], terminal(1, 250), 5)!;
    const again = recordFailedChild(first, [], [child(1)], { reportId: "spawn-1", failureReason: "other", durationMs: 9_000 }, 50_000)!;
    expect(again).toEqual(first);
  });

  it("keeps an existing row when the snapshot is gone, and records nothing without any snapshot", () => {
    const first = recordFailedChild([], [], [child(1)], terminal(1, 250), 5)!;
    expect(recordFailedChild(first, [], [], terminal(1, 250), 6)).toEqual(first);
    expect(recordFailedChild([], [], [], terminal(2, 250), 6)).toBeNull();
  });

  it("keeps the 20-row bound, dropping the oldest", () => {
    let failed: WireBackgroundChild[] = [];
    const all = Array.from({ length: FAILED_BACKGROUND_CHILD_LIMIT + 2 }, (_, i) => child(i + 1));
    for (let i = 0; i < all.length; i++) failed = recordFailedChild(failed, [], all, terminal(i + 1, 1), 0)!;
    expect(failed).toHaveLength(FAILED_BACKGROUND_CHILD_LIMIT);
    expect(failed[0]?.childSessionId).toBe("child-3");
  });

  it("ignores a dismissed report identity, but a new identity still records", () => {
    const dismissed = ["spawn-1"];
    expect(recordFailedChild([], dismissed, [child(1)], terminal(1, 1), 0)).toBeNull();
    expect(recordFailedChild([], dismissed, [child(1), child(2)], terminal(2, 1), 0)).toHaveLength(1);
  });
});

describe("dismissFailedChild", () => {
  it("removes only the named row and remembers its report identity", () => {
    const failed = [child(1, { failureReason: "a" }), child(2, { failureReason: "b" }), child(3, { failureReason: "c" })];
    const next = dismissFailedChild(failed, [], "child-2")!;
    expect(next.failed.map((c) => c.childSessionId)).toEqual(["child-1", "child-3"]);
    expect(next.dismissedReportIds).toEqual(["spawn-2"]);
  });

  it("falls back to the child session id when there is no spawn call id, and is a no-op for an unknown id", () => {
    const row = { ...child(1, { failureReason: "a" }), spawnToolCallId: undefined };
    expect(dismissFailedChild([row], [], "child-1")?.dismissedReportIds).toEqual(["child-1"]);
    expect(dismissFailedChild([row], [], "nope")).toBeNull();
  });

  it("bounds the remembered identities", () => {
    const seen = Array.from({ length: DISMISSED_FAILED_REPORT_LIMIT }, (_, i) => `old-${i}`);
    const next = dismissFailedChild([child(1, { failureReason: "a" })], seen, "child-1")!;
    expect(next.dismissedReportIds).toHaveLength(DISMISSED_FAILED_REPORT_LIMIT);
    expect(next.dismissedReportIds.at(-1)).toBe("spawn-1");
    expect(next.dismissedReportIds).not.toContain("old-0");
  });
});
