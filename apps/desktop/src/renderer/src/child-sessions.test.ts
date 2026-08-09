/**
 * child-sessions.ts tests (TASK.102 CUT-S2 §2.5, slice S2c C1): the
 * envelope classifier and the child relation-store, in isolation from
 * tab-registry.ts (C2) and the JSX layer (C3).
 */
import { describe, expect, it } from "vitest";
import { childRelationKey, classifyPortEnvelope, createChildRelationStore, hasOpenableChild } from "./child-sessions.js";
import type { PortEnvelope } from "../../shared/envelopes.js";

/** A realistic root-tab envelope (no `child` field) — today's only shape, unchanged. */
const ROOT_ENVELOPE: Pick<PortEnvelope, "child"> = {};

/** A realistic child-tab envelope, matching `deliverTabPort`'s stamped shape (§2.5). */
const CHILD_ENVELOPE: Pick<PortEnvelope, "child"> = {
  child: {
    parentTabId: "tab-master",
    parentSessionId: "session-master",
    spawnToolCallId: "call-1",
    childSessionId: "session-child-1",
  },
};

describe("classifyPortEnvelope", () => {
  it("classifies an envelope carrying `child` as a child — NOT root (CUT-S2 §5.3's facade: today ANY port takes the root addTab path)", () => {
    expect(classifyPortEnvelope(CHILD_ENVELOPE)).toBe("child");
  });

  it("classifies an envelope with no `child` field as root — the reverse direction, so a facade that always answers \"child\" is caught too", () => {
    expect(classifyPortEnvelope(ROOT_ENVELOPE)).toBe("root");
  });

  it("treats `child: undefined` explicitly present on the object the same as an absent key (root)", () => {
    expect(classifyPortEnvelope({ child: undefined })).toBe("root");
  });
});

describe("childRelationKey", () => {
  it("joins parentSessionId and spawnToolCallId into one key, distinct pairs never colliding", () => {
    const a = childRelationKey("session-1", "call-1");
    const b = childRelationKey("session-1", "call-2");
    const c = childRelationKey("session-2", "call-1");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("is stable/deterministic for the same pair", () => {
    expect(childRelationKey("session-1", "call-1")).toBe(childRelationKey("session-1", "call-1"));
  });
});

describe("child relation-store", () => {
  it("getRelation on an empty store returns undefined for any pair", () => {
    const api = createChildRelationStore();
    expect(api.getState().getRelation("session-1", "call-1")).toBeUndefined();
  });

  it("registerChild seeds a relation with live:true, retrievable by the exact (parentSessionId, spawnToolCallId) pair", () => {
    const api = createChildRelationStore();
    api.getState().registerChild("session-master", "call-1", "tab-child-1", "session-child-1");
    expect(api.getState().getRelation("session-master", "call-1")).toEqual({
      childTabId: "tab-child-1",
      childSessionId: "session-child-1",
      live: true,
    });
  });

  it("keeps distinct relations for two children of the SAME parent (up to the 3/parent admission cap) without cross-contamination", () => {
    const api = createChildRelationStore();
    api.getState().registerChild("session-master", "call-1", "tab-child-1", "session-child-1");
    api.getState().registerChild("session-master", "call-2", "tab-child-2", "session-child-2");
    expect(api.getState().getRelation("session-master", "call-1")?.childTabId).toBe("tab-child-1");
    expect(api.getState().getRelation("session-master", "call-2")?.childTabId).toBe("tab-child-2");
  });

  it("markChildGone flips live to false for the relation with the matching childTabId — the OTHER sibling relation is untouched (correlates by tabId, not by any id in a payload, per §2.3's header)", () => {
    const api = createChildRelationStore();
    api.getState().registerChild("session-master", "call-1", "tab-child-1", "session-child-1");
    api.getState().registerChild("session-master", "call-2", "tab-child-2", "session-child-2");

    api.getState().markChildGone("tab-child-1");

    expect(api.getState().getRelation("session-master", "call-1")).toEqual({
      childTabId: "tab-child-1",
      childSessionId: "session-child-1",
      live: false,
    });
    expect(api.getState().getRelation("session-master", "call-2")?.live).toBe(true);
  });

  it("markChildGone for an unknown childTabId is a no-op — does not throw, does not create a phantom entry, does not touch the map identity", () => {
    const api = createChildRelationStore();
    api.getState().registerChild("session-master", "call-1", "tab-child-1", "session-child-1");
    const before = api.getState().relations;

    expect(() => api.getState().markChildGone("tab-unknown")).not.toThrow();

    expect(api.getState().relations).toBe(before);
    expect(api.getState().relations.size).toBe(1);
  });

  it("markChildGone is idempotent — a second call on an already-gone relation does not change the map identity", () => {
    const api = createChildRelationStore();
    api.getState().registerChild("session-master", "call-1", "tab-child-1", "session-child-1");
    api.getState().markChildGone("tab-child-1");
    const afterFirst = api.getState().relations;

    api.getState().markChildGone("tab-child-1");

    expect(api.getState().relations).toBe(afterFirst);
  });

  it("re-registering an existing (parentSessionId, spawnToolCallId) resets live to true — a fresh port delivery for a known child means it is live again", () => {
    const api = createChildRelationStore();
    api.getState().registerChild("session-master", "call-1", "tab-child-1", "session-child-1");
    api.getState().markChildGone("tab-child-1");
    expect(api.getState().getRelation("session-master", "call-1")?.live).toBe(false);

    api.getState().registerChild("session-master", "call-1", "tab-child-1", "session-child-1");

    expect(api.getState().getRelation("session-master", "call-1")?.live).toBe(true);
  });

  it("reset clears every relation", () => {
    const api = createChildRelationStore();
    api.getState().registerChild("session-master", "call-1", "tab-child-1", "session-child-1");
    api.getState().registerChild("session-master", "call-2", "tab-child-2", "session-child-2");

    api.getState().reset();

    expect(api.getState().relations.size).toBe(0);
  });
});

describe("hasOpenableChild (TASK.102 CUT-S2 §2.5/§10.8.1: ToolCallCard's Open button/badge gate)", () => {
  it("false when no relation has ever been recorded and the card was never hydrated as a session child — the inline-subagent default", () => {
    expect(hasOpenableChild(undefined, false)).toBe(false);
  });

  it("§10.8.1 c, the restart-Open case: no relation (fresh renderer process) but the hydrated S1 snapshot says sessionChild — TRUE, the second branch of §2.5 come alive", () => {
    expect(hasOpenableChild(undefined, true)).toBe(true);
  });

  it("true once a relation exists and is still live, regardless of the hydrated marker (a live card hasn't settled yet, so it never carries one)", () => {
    expect(hasOpenableChild({ childTabId: "tab-child-1", childSessionId: "session-child-1", live: true }, false)).toBe(true);
  });

  it("STAYS true after the relation flips live:false — the BADGE remains visible for an already-gone child (its settled status is still honest); ToolCallCard.tsx's Open action is unconditional once visibility is true (C4 builds the read-only surface for exactly this case)", () => {
    expect(hasOpenableChild({ childTabId: "tab-child-1", childSessionId: "session-child-1", live: false }, false)).toBe(true);
  });
});
