/**
 * tab-status-store tests (slice-R10-cut §4.1): the cross-tab coarse-status
 * mirror's pure surface — the storm guard (a repeat tuple never changes the
 * map identity), the live-gate that suppresses phantom-attention on host
 * exit/respawn, the sticky-attention semantics, and the three total-function
 * projections (`isTurnCompletion`/`deriveCoarse`/`rowStatusKind`). Isolated
 * `createTabStatusStore()` per case, the same isolation discipline as
 * tabs-store.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  createTabStatusStore,
  deriveCoarse,
  isTurnCompletion,
  rowStatusKind,
  type CoarseStatus,
  type TabStatus,
} from "./tab-status-store.js";
import type { DesktopState, TurnState } from "./store.js";

/** Shorthand for a CoarseStatus tuple: `coarse(turn, needsApproval, live)`. */
function coarse(turn: TurnState["status"], needsApproval: boolean, live: boolean): CoarseStatus {
  return { turn, needsApproval, live };
}

/** Builds a deriveCoarse input (a slice of DesktopState) from primitives. */
function deriveInput(
  turn: TurnState["status"],
  connection: DesktopState["connection"],
  permission: DesktopState["permission"],
): Pick<DesktopState, "turn" | "connection" | "permission"> {
  return { turn: { status: turn, turnId: null, requestId: null }, connection, permission };
}

/** A stand-in non-null permission request — deriveCoarse only checks `!== null`. */
const SOME_PERMISSION = {} as unknown as NonNullable<DesktopState["permission"]>;

describe("tab-status-store — applyCoarse / clearAttention / remove", () => {
  it("1. seed: applies an all-false entry to an empty store and changes the map identity", () => {
    const store = createTabStatusStore();
    const before = store.getState().statuses;

    store.getState().applyCoarse("t1", coarse("idle", false, false), true);

    expect(store.getState().statuses.get("t1")).toEqual({ running: false, needsApproval: false, attention: false });
    expect(store.getState().statuses).not.toBe(before);
  });

  it("2. storm guard: a repeated identical coarse call leaves the map identity untouched", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("idle", false, false), true);
    const afterSeed = store.getState().statuses;

    // Exact repeat of the seed → bail, same identity.
    store.getState().applyCoarse("t1", coarse("idle", false, false), true);
    expect(store.getState().statuses).toBe(afterSeed);

    // A real flip changes identity; repeating THAT flip bails again.
    store.getState().applyCoarse("t1", coarse("running", false, true), false);
    const afterFlip = store.getState().statuses;
    expect(afterFlip).not.toBe(afterSeed);
    store.getState().applyCoarse("t1", coarse("running", false, true), false);
    expect(store.getState().statuses).toBe(afterFlip);
  });

  it("3. running: a live running turn sets running:true with a new identity", () => {
    const store = createTabStatusStore();
    const before = store.getState().statuses;

    store.getState().applyCoarse("t1", coarse("running", false, true), false);

    expect(store.getState().statuses.get("t1")).toEqual({ running: true, needsApproval: false, attention: false });
    expect(store.getState().statuses).not.toBe(before);
  });

  it("4. co-occurrence: permission does not cancel running in the data; settling clears only needsApproval", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);

    store.getState().applyCoarse("t1", coarse("running", true, true), false);
    expect(store.getState().statuses.get("t1")).toEqual({ running: true, needsApproval: true, attention: false });

    store.getState().applyCoarse("t1", coarse("running", false, true), false);
    expect(store.getState().statuses.get("t1")).toEqual({ running: true, needsApproval: false, attention: false });
  });

  it("5. background completion sets attention", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);

    store.getState().applyCoarse("t1", coarse("idle", false, true), /* background */ true);

    expect(store.getState().statuses.get("t1")).toEqual({ running: false, needsApproval: false, attention: true });
  });

  it("6. active completion does NOT set attention", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);

    store.getState().applyCoarse("t1", coarse("idle", false, true), /* background */ false);

    expect(store.getState().statuses.get("t1")).toEqual({ running: false, needsApproval: false, attention: false });
  });

  it("7. attention is sticky across a non-flip: an identical idle coarse bails and attention stays true", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);
    store.getState().applyCoarse("t1", coarse("idle", false, true), true);
    const withAttention = store.getState().statuses;
    expect(withAttention.get("t1")?.attention).toBe(true);

    store.getState().applyCoarse("t1", coarse("idle", false, true), true);
    expect(store.getState().statuses).toBe(withAttention);
    expect(store.getState().statuses.get("t1")?.attention).toBe(true);
  });

  it("8. a new turn clears attention", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);
    store.getState().applyCoarse("t1", coarse("idle", false, true), true);
    expect(store.getState().statuses.get("t1")?.attention).toBe(true);

    store.getState().applyCoarse("t1", coarse("running", false, true), false);
    expect(store.getState().statuses.get("t1")).toEqual({ running: true, needsApproval: false, attention: false });
  });

  it("9. live gate: a host exit mid-turn writes running:false but mints no attention", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);

    // Host dies: turn.status frozen at "running", connection no longer ready.
    store.getState().applyCoarse("t1", coarse("running", false, /* live */ false), true);

    expect(store.getState().statuses.get("t1")).toEqual({ running: false, needsApproval: false, attention: false });
  });

  it("10. live gate: a respawn reset mints no attention and the ready re-settle bails", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);
    store.getState().applyCoarse("t1", coarse("running", false, false), true); // host exit
    store.getState().applyCoarse("t1", coarse("idle", false, false), true); // respawn reset (still not live)
    expect(store.getState().statuses.get("t1")?.attention).toBe(false);

    const beforeReady = store.getState().statuses;
    store.getState().applyCoarse("t1", coarse("idle", false, true), true); // connection→ready, all-false already
    expect(store.getState().statuses).toBe(beforeReady);
    expect(store.getState().statuses.get("t1")?.attention).toBe(false);
  });

  it("11. dead-host permission is masked in the data (live gate)", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", true, /* live */ false), false);
    expect(store.getState().statuses.get("t1")).toEqual({ running: false, needsApproval: false, attention: false });
  });

  it("12. clearAttention: clears when set, no-op when already clear, no-op for an unknown tabId", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);
    store.getState().applyCoarse("t1", coarse("idle", false, true), true);
    const withAttention = store.getState().statuses;
    expect(withAttention.get("t1")?.attention).toBe(true);

    store.getState().clearAttention("t1");
    expect(store.getState().statuses).not.toBe(withAttention);
    expect(store.getState().statuses.get("t1")?.attention).toBe(false);

    // Already clear → same identity.
    const cleared = store.getState().statuses;
    store.getState().clearAttention("t1");
    expect(store.getState().statuses).toBe(cleared);

    // Unknown tabId → same identity.
    store.getState().clearAttention("ghost");
    expect(store.getState().statuses).toBe(cleared);
  });

  it("13. remove: deletes the entry with a new identity, no-op for an unknown tabId", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);
    const before = store.getState().statuses;

    store.getState().remove("t1");
    expect(store.getState().statuses).not.toBe(before);
    expect(store.getState().statuses.has("t1")).toBe(false);

    const afterRemove = store.getState().statuses;
    store.getState().remove("ghost");
    expect(store.getState().statuses).toBe(afterRemove);
  });

  it("14. two tabs are independent: a flip on one never touches the other's entry", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("idle", false, true), false);
    store.getState().applyCoarse("t2", coarse("idle", false, true), false);
    const t2Entry = store.getState().statuses.get("t2");

    store.getState().applyCoarse("t1", coarse("running", false, true), false);
    expect(store.getState().statuses.get("t2")).toBe(t2Entry);

    const t1Entry = store.getState().statuses.get("t1");
    store.getState().applyCoarse("t2", coarse("running", false, true), false);
    expect(store.getState().statuses.get("t1")).toBe(t1Entry);
  });
});

describe("tab-status-store — pure projections", () => {
  it("15. isTurnCompletion: only running→idle is a completion", () => {
    expect(isTurnCompletion("running", "idle")).toBe(true);
    expect(isTurnCompletion("idle", "running")).toBe(false);
    expect(isTurnCompletion("idle", "idle")).toBe(false);
    expect(isTurnCompletion("running", "running")).toBe(false);
  });

  it("16. deriveCoarse: projects turn/permission/liveness from a DesktopState slice", () => {
    expect(deriveCoarse(deriveInput("running", "ready", SOME_PERMISSION))).toEqual({
      turn: "running",
      needsApproval: true,
      live: true,
    });
    expect(deriveCoarse(deriveInput("running", "host_exited", null)).live).toBe(false);
    expect(deriveCoarse(deriveInput("idle", "awaiting_host_ready", null)).live).toBe(false);
    expect(deriveCoarse(deriveInput("idle", "ready", null)).needsApproval).toBe(false);
  });

  it("17. rowStatusKind: precedence host-exited > permission > running > attention > null", () => {
    const fullTrue: TabStatus = { running: true, needsApproval: true, attention: true };
    expect(rowStatusKind(fullTrue, true)).toBe("host-exited");
    expect(rowStatusKind({ running: true, needsApproval: true, attention: false }, false)).toBe("permission");
    expect(rowStatusKind({ running: true, needsApproval: false, attention: false }, false)).toBe("running");
    expect(rowStatusKind({ running: false, needsApproval: false, attention: true }, false)).toBe("attention");
    expect(rowStatusKind({ running: false, needsApproval: false, attention: false }, false)).toBeNull();
    expect(rowStatusKind(undefined, true)).toBe("host-exited");
    expect(rowStatusKind(undefined, false)).toBeNull();
  });
});
