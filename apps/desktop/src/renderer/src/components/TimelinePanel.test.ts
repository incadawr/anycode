import { describe, expect, it } from "vitest";
import type { WireCheckpointMeta } from "../../../shared/protocol.js";
import { buildRewindRequest, formatCheckpointReason, sortCheckpointsNewestFirst } from "./TimelinePanel.js";

describe("TimelinePanel pure helpers", () => {
  it("formats checkpoint reasons for the badge", () => {
    expect(formatCheckpointReason("auto")).toBe("Auto");
    expect(formatCheckpointReason("pre-rewind")).toBe("Pre-rewind");
  });
});

function checkpoint(overrides: Partial<WireCheckpointMeta> = {}): WireCheckpointMeta {
  return {
    id: "cp-1",
    label: "turn 1",
    createdAt: 1_000,
    reason: "auto",
    ...overrides,
  };
}

describe("sortCheckpointsNewestFirst", () => {
  it("returns an empty array for an empty list", () => {
    expect(sortCheckpointsNewestFirst([])).toEqual([]);
  });

  it("orders newest createdAt first regardless of input order", () => {
    const oldest = checkpoint({ id: "a", createdAt: 100 });
    const middle = checkpoint({ id: "b", createdAt: 200 });
    const newest = checkpoint({ id: "c", createdAt: 300 });
    expect(sortCheckpointsNewestFirst([oldest, newest, middle])).toEqual([newest, middle, oldest]);
  });

  it("does not mutate the input array", () => {
    const list = [checkpoint({ id: "a", createdAt: 100 }), checkpoint({ id: "b", createdAt: 200 })];
    const original = [...list];
    sortCheckpointsNewestFirst(list);
    expect(list).toEqual(original);
  });
});

describe("buildRewindRequest", () => {
  it("builds a scope:both rewind_request carrying the given checkpoint/requestId (v1 has no scope toggle, design §4)", () => {
    expect(buildRewindRequest("cp-42", "req-7")).toEqual({
      type: "rewind_request",
      requestId: "req-7",
      checkpointId: "cp-42",
      scope: "both",
    });
  });
});
