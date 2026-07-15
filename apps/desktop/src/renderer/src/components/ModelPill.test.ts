/**
 * Pure-logic tests for ModelPill (design slice-P7.15-cut.md §2.2/§2.4). Like
 * ModeMenu.test.ts/Composer.test.ts, this is `.test.ts` under a node
 * (no-jsdom) vitest env — every piece of interaction logic is exported as a
 * plain function and covered directly rather than DOM-rendering the popover.
 */
import { describe, expect, it } from "vitest";
import {
  buildConnectionUpdate,
  chainWrite,
  modelDisplayName,
  modelMenuItems,
  modelPickDisabled,
  pillLabel,
  resolvePid,
  shouldPersistOnAck,
} from "./ModelPill.js";

describe("resolvePid", () => {
  it("falls back to \"custom\" when provider.id is unset (legacy/free-text config)", () => {
    expect(resolvePid(undefined)).toBe("custom");
  });

  it("passes through a catalog provider id unchanged", () => {
    expect(resolvePid("z-ai")).toBe("z-ai");
  });
});

describe("modelDisplayName", () => {
  it("uses the catalog entry's name when the id matches", () => {
    expect(modelDisplayName("glm-5.2", [{ id: "glm-5.2", name: "GLM-5.2" }])).toBe("GLM-5.2");
  });

  it("falls back to the raw id when there is no catalog match (free-text/env-boot model)", () => {
    expect(modelDisplayName("some-custom-model", [{ id: "glm-5.2", name: "GLM-5.2" }])).toBe("some-custom-model");
  });

  it("falls back to the raw id for an undefined/empty catalog", () => {
    expect(modelDisplayName("glm-5.2", undefined)).toBe("glm-5.2");
    expect(modelDisplayName("glm-5.2", [])).toBe("glm-5.2");
  });

  it("falls back to the raw id when the catalog entry has no name", () => {
    expect(modelDisplayName("glm-5.2", [{ id: "glm-5.2" }])).toBe("glm-5.2");
  });
});

describe("pillLabel", () => {
  it("appends the effort label for a reasoning-capable model, including the 'No thinking' state", () => {
    expect(pillLabel("GLM-5.2", "off", ["off", "high", "max"])).toBe("GLM-5.2 · No thinking");
    expect(pillLabel("GLM-5.2", "high", ["off", "high", "max"])).toBe("GLM-5.2 · High");
  });

  it("omits the effort segment entirely for a non-reasoning model", () => {
    expect(pillLabel("GLM-4.6", "off", undefined)).toBe("GLM-4.6");
  });
});

describe("modelMenuItems (design §2.2 model list)", () => {
  const catalog = [
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-4.6", name: "GLM-4.6" },
  ];

  it("lists the catalog models for the current provider", () => {
    expect(modelMenuItems("glm-5.2", catalog)).toEqual([
      { id: "glm-5.2", name: "GLM-5.2" },
      { id: "glm-4.6", name: "GLM-4.6" },
    ]);
  });

  it("appends the current model when it isn't already in the catalog (free-text/env-boot model)", () => {
    expect(modelMenuItems("some-custom-model", catalog)).toEqual([
      { id: "glm-5.2", name: "GLM-5.2" },
      { id: "glm-4.6", name: "GLM-4.6" },
      { id: "some-custom-model", name: "some-custom-model" },
    ]);
  });

  it("holds just the current model for an empty/undefined catalog (custom provider)", () => {
    expect(modelMenuItems("some-custom-model", [])).toEqual([{ id: "some-custom-model", name: "some-custom-model" }]);
    expect(modelMenuItems("some-custom-model", undefined)).toEqual([
      { id: "some-custom-model", name: "some-custom-model" },
    ]);
  });

  it("does not duplicate an entry already present in the catalog", () => {
    expect(modelMenuItems("glm-5.2", catalog)).toHaveLength(2);
  });
});

describe("modelPickDisabled (client-side mirror of the host between-turns guard)", () => {
  const IN_FLIGHT = { requestId: "r1", item: { id: "i1", text: "x", images: [] } } as const;

  it("is enabled ONLY when truly idle AND ready", () => {
    expect(modelPickDisabled("idle", null, true)).toBe(false);
  });

  it("is disabled while a turn is running, regardless of readiness", () => {
    expect(modelPickDisabled("running", null, true)).toBe(true);
  });

  it("is disabled during the queue in-flight window (turn momentarily idle but a drained item is still in flight)", () => {
    expect(modelPickDisabled("idle", IN_FLIGHT, true)).toBe(true);
  });

  it("is disabled whenever the connection isn't ready, even with an idle turn and no in-flight item", () => {
    expect(modelPickDisabled("idle", null, false)).toBe(true);
  });
});

describe("shouldPersistOnAck (design §2.4 ack-gating)", () => {
  it("persists when the ack matches the pending pick's kind and value", () => {
    expect(shouldPersistOnAck({ kind: "model", value: "glm-4.6" }, "model", "glm-4.6")).toBe(true);
    expect(shouldPersistOnAck({ kind: "effort", value: "high" }, "effort", "high")).toBe(true);
  });

  it("does NOT persist when there is no pending pick (host_ready/boot values, or a click with no ack yet)", () => {
    expect(shouldPersistOnAck(null, "model", "glm-4.6")).toBe(false);
  });

  it("does NOT persist when the ack is of the other kind (a model pick's incidental reasoningEffort recompute must not fire the effort persist, and vice versa)", () => {
    expect(shouldPersistOnAck({ kind: "model", value: "glm-4.6" }, "effort", "off")).toBe(false);
    expect(shouldPersistOnAck({ kind: "effort", value: "high" }, "model", "glm-5.2")).toBe(false);
  });

  it("does NOT persist when the value doesn't match (a busy-rejected pick never lands the picked value, or a stale pending pick from a superseded request)", () => {
    expect(shouldPersistOnAck({ kind: "model", value: "glm-4.6" }, "model", "glm-5.2")).toBe(false);
  });
});

describe("buildConnectionUpdate (TASK.45 W10 connection-update write)", () => {
  it("writes id + model + effort on a model pick", () => {
    expect(buildConnectionUpdate("conn-1", true, "glm-4.6", "off")).toEqual({
      id: "conn-1",
      model: "glm-4.6",
      reasoningEffort: "off",
    });
  });

  it("writes ONLY id + effort on an effort pick (the model is left untouched)", () => {
    expect(buildConnectionUpdate("conn-1", false, "glm-5.2", "high")).toEqual({
      id: "conn-1",
      reasoningEffort: "high",
    });
  });

  it("targets the given connection id verbatim", () => {
    expect(buildConnectionUpdate("conn-custom", true, "some-model", "max")).toEqual({
      id: "conn-custom",
      model: "some-model",
      reasoningEffort: "max",
    });
  });
});

// Ack-gated persist end-to-end (the exact sequence ModelPill's effects run):
// a pick records a pending value; only a matching ack turns that into
// exactly one patch; a click without any ack yet produces none.
describe("ack-gated persist sequence (design §2.4 clobber-race closure)", () => {
  function simulate(pick: { kind: "model" | "effort"; value: string }, ackKind: "model" | "effort", ackValue: string) {
    const pending: typeof pick | null = pick;
    const patches: string[] = [];
    if (shouldPersistOnAck(pending, ackKind, ackValue)) {
      patches.push(ackValue);
    }
    return patches;
  }

  it("a model_changed ack matching the pending pick triggers exactly one persist", () => {
    expect(simulate({ kind: "model", value: "glm-4.6" }, "model", "glm-4.6")).toEqual(["glm-4.6"]);
  });

  it("a click with no ack yet (simulated as no pending pick) produces zero persists", () => {
    const patches: string[] = [];
    if (shouldPersistOnAck(null, "model", "glm-4.6")) {
      patches.push("glm-4.6");
    }
    expect(patches).toEqual([]);
  });
});


// codex P2 defect fixes (5aa97ed follow-up): pid captured with the pending
// pick (not recomputed from the settings snapshot at ack time), and
// ack-triggered persist writes serialized so fast back-to-back picks land
// in ack order rather than write-completion order.
describe("captured-connectionId persist (defect #1: id captured at pick time, not ack time)", () => {
  // Mirrors the shape ModelPill's own pendingPickRef holds post-W10: the
  // connection id is part of the pending record itself, set once at pick time.
  interface PendingPickWithConn {
    kind: "model" | "effort";
    value: string;
    connectionId?: string;
  }

  // Mirrors the exact ack-effect body in ModelPill.tsx: gate on
  // shouldPersistOnAck as before, but build the request from
  // `pending.connectionId` — the connection captured at pick time — never one
  // recomputed "now".
  function simulateAckPersist(
    pending: PendingPickWithConn | null,
    ackKind: "model" | "effort",
    ackValue: string,
    isModelPick: boolean,
    model: string,
    reasoningEffort: Parameters<typeof buildConnectionUpdate>[3],
  ) {
    if (pending && shouldPersistOnAck(pending, ackKind, ackValue) && pending.connectionId !== undefined) {
      return buildConnectionUpdate(pending.connectionId, isModelPick, model, reasoningEffort);
    }
    return null;
  }

  it("persists to the connection captured at pick time, even though the active connection changed before the ack arrived", () => {
    // User picked model "glm-4.6" while connection "conn-1" was active — it is
    // captured into the pending record right then. Before its model_changed ack
    // lands, the user switches the active connection in Settings to "conn-2".
    const pending: PendingPickWithConn = { kind: "model", value: "glm-4.6", connectionId: "conn-1" };

    const req = simulateAckPersist(pending, "model", "glm-4.6", true, "glm-4.6", "off");

    expect(req).toEqual({ id: "conn-1", model: "glm-4.6", reasoningEffort: "off" });
    // The corrupting outcome this defect produced: writing to the NOW-active
    // connection instead of the pick's own.
    expect(req?.id).not.toBe("conn-2");
  });

  it("does the same for an effort pick against a captured connection", () => {
    const pending: PendingPickWithConn = { kind: "effort", value: "high", connectionId: "conn-1" };

    const req = simulateAckPersist(pending, "effort", "high", false, "glm-4.6", "high");

    expect(req).toEqual({ id: "conn-1", reasoningEffort: "high" });
  });

  it("skips the write when no connection was active at pick time (env-override / fresh)", () => {
    const pending: PendingPickWithConn = { kind: "model", value: "glm-4.6", connectionId: undefined };
    expect(simulateAckPersist(pending, "model", "glm-4.6", true, "glm-4.6", "off")).toBeNull();
  });
});

/** Resolves/rejects a promise from outside its executor, for controlling write timing in tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("chainWrite (defect #2: fast A-then-B picks must not persist the older value)", () => {
  it("write-order: A queued before B, but A's write is slower — B is still the final persisted value", async () => {
    let persisted: string | undefined;
    const aGate = deferred<void>();
    let chain: Promise<unknown> = Promise.resolve();

    // Pick A's ack fires first and queues a slow write.
    chain = chainWrite(chain, async () => {
      await aGate.promise;
      persisted = "A";
    });
    // Pick B's ack fires shortly after (still queued behind A in the chain).
    chain = chainWrite(chain, async () => {
      persisted = "B";
    });

    // Flush a microtask turn: without serialization an unlocked write would
    // have already let B's (faster) write run here. With serialization, B's
    // write must not have started yet — it is still waiting on A.
    await Promise.resolve();
    await Promise.resolve();
    expect(persisted).toBeUndefined();

    // Now let A's slow write finish; B's write runs after, and must win.
    aGate.resolve();
    await chain;

    expect(persisted).toBe("B");
  });

  it("is fail-soft: a rejected write does not wedge the chain for the write queued after it", async () => {
    let persisted: string | undefined;
    let chain: Promise<unknown> = Promise.resolve();

    chain = chainWrite(chain, async () => {
      throw new Error("boom");
    });
    chain = chainWrite(chain, async () => {
      persisted = "ok";
    });

    await chain;

    expect(persisted).toBe("ok");
  });

  it("preserves order across three writes even when earlier ones are slower", async () => {
    const order: string[] = [];
    const gates = { a: deferred<void>(), b: deferred<void>() };
    let chain: Promise<unknown> = Promise.resolve();

    chain = chainWrite(chain, async () => {
      await gates.a.promise;
      order.push("A");
    });
    chain = chainWrite(chain, async () => {
      await gates.b.promise;
      order.push("B");
    });
    chain = chainWrite(chain, async () => {
      order.push("C");
    });

    // Release in reverse — even so, chained order must still be A, B, C.
    gates.b.resolve();
    await Promise.resolve();
    gates.a.resolve();
    await chain;

    expect(order).toEqual(["A", "B", "C"]);
  });
});
