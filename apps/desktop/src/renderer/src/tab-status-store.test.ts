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
import { createDesktopStore, type DesktopState, type TurnState } from "./store.js";

/** Shorthand for a CoarseStatus tuple: `coarse(turn, needsApproval, live)`. */
function coarse(
  turn: TurnState["status"],
  needsApproval: boolean,
  live: boolean,
  backgroundAgents = 0,
  backgroundAgentsAbandoned = false,
): CoarseStatus {
  return { turn, needsApproval, live, backgroundAgents, backgroundAgentsAbandoned };
}

/** Builds a deriveCoarse input (a slice of DesktopState) from primitives. `waitingSubagents` defaults to empty (regression: an ordinary tab with no children). */
function deriveInput(
  turn: TurnState["status"],
  connection: DesktopState["connection"],
  permission: DesktopState["permission"],
  waitingSubagents: ReadonlySet<string> = new Set(),
  engineBackgroundAgents: DesktopState["engineBackgroundAgents"] = { count: 0, abandoned: false },
  backgroundChildren: DesktopState["backgroundChildren"] = [],
): Pick<
  DesktopState,
  "turn" | "connection" | "permission" | "waitingSubagents" | "liveSubagents" | "engineBackgroundAgents" | "backgroundChildren"
> {
  return {
    turn: { status: turn, turnId: null, requestId: null },
    connection,
    permission,
    waitingSubagents,
    liveSubagents: new Set<string>(),
    engineBackgroundAgents,
    backgroundChildren,
  };
}

/** A stand-in non-null permission request — deriveCoarse only checks `!== null`. */
const SOME_PERMISSION = {} as unknown as NonNullable<DesktopState["permission"]>;

describe("tab-status-store — applyCoarse / clearAttention / remove", () => {
  it("1. seed: applies an all-false entry to an empty store and changes the map identity", () => {
    const store = createTabStatusStore();
    const before = store.getState().statuses;

    store.getState().applyCoarse("t1", coarse("idle", false, false), true);

    expect(store.getState().statuses.get("t1")).toEqual({ running: false, needsApproval: false, attention: false, backgroundAgents: 0 });
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

    expect(store.getState().statuses.get("t1")).toEqual({ running: true, needsApproval: false, attention: false, backgroundAgents: 0 });
    expect(store.getState().statuses).not.toBe(before);
  });

  it("4. co-occurrence: permission does not cancel running in the data; settling clears only needsApproval", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);

    store.getState().applyCoarse("t1", coarse("running", true, true), false);
    expect(store.getState().statuses.get("t1")).toEqual({ running: true, needsApproval: true, attention: false, backgroundAgents: 0 });

    store.getState().applyCoarse("t1", coarse("running", false, true), false);
    expect(store.getState().statuses.get("t1")).toEqual({ running: true, needsApproval: false, attention: false, backgroundAgents: 0 });
  });

  it("5. background completion sets attention", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);

    store.getState().applyCoarse("t1", coarse("idle", false, true), /* background */ true);

    expect(store.getState().statuses.get("t1")).toEqual({ running: false, needsApproval: false, attention: true, backgroundAgents: 0 });
  });

  it("6. active completion does NOT set attention", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);

    store.getState().applyCoarse("t1", coarse("idle", false, true), /* background */ false);

    expect(store.getState().statuses.get("t1")).toEqual({ running: false, needsApproval: false, attention: false, backgroundAgents: 0 });
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
    expect(store.getState().statuses.get("t1")).toEqual({ running: true, needsApproval: false, attention: false, backgroundAgents: 0 });
  });

  it("9. live gate: a host exit mid-turn writes running:false but mints no attention", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("running", false, true), false);

    // Host dies: turn.status frozen at "running", connection no longer ready.
    store.getState().applyCoarse("t1", coarse("running", false, /* live */ false), true);

    expect(store.getState().statuses.get("t1")).toEqual({ running: false, needsApproval: false, attention: false, backgroundAgents: 0 });
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
    expect(store.getState().statuses.get("t1")).toEqual({ running: false, needsApproval: false, attention: false, backgroundAgents: 0 });
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
      backgroundAgents: 0,
      backgroundAgentsAbandoned: false,
    });
    expect(deriveCoarse(deriveInput("running", "host_exited", null)).live).toBe(false);
    expect(deriveCoarse(deriveInput("idle", "awaiting_host_ready", null)).live).toBe(false);
    expect(deriveCoarse(deriveInput("idle", "ready", null)).needsApproval).toBe(false);
  });

  it("shows activity after the parent finishes and marks completion only after the last child settles", () => {
    const store = createTabStatusStore();
    const idle = deriveInput("idle", "ready", null);
    const child = { childSessionId: "child", agentType: "test", description: "test", startedAt: 1 };
    for (const state of [
      { ...idle, liveSubagents: new Set(["native"]), backgroundChildren: [child] },
      { ...idle, backgroundChildren: [child] },
    ]) {
      store.getState().applyCoarse("tab", deriveCoarse(state), true);
      expect(store.getState().statuses.get("tab")).toMatchObject({ running: true, attention: false });
    }
    store.getState().applyCoarse("tab", deriveCoarse(idle), true);
    expect(store.getState().statuses.get("tab")).toMatchObject({ running: false, attention: true });
  });

  it("16b. S1: deriveCoarse.needsApproval is true from a waiting CHILD alone, with the tab's own permission null", () => {
    expect(deriveCoarse(deriveInput("running", "ready", null, new Set(["call-1"]))).needsApproval).toBe(true);
  });

  it("16c. S1: deriveCoarse.needsApproval goes false once the last waiting child clears (empty Set, not just non-null check)", () => {
    expect(deriveCoarse(deriveInput("idle", "ready", null, new Set())).needsApproval).toBe(false);
  });

  it("16d. S1 regression: a tab with no children (deriveInput's default empty Set) keeps the pre-existing own-permission-only projection", () => {
    expect(deriveCoarse(deriveInput("idle", "ready", SOME_PERMISSION)).needsApproval).toBe(true);
    expect(deriveCoarse(deriveInput("idle", "ready", null)).needsApproval).toBe(false);
  });

  it("17. rowStatusKind: precedence host-exited > permission > running > attention > null", () => {
    const fullTrue: TabStatus = { running: true, needsApproval: true, attention: true, backgroundAgents: 0 };
    expect(rowStatusKind(fullTrue, true)).toBe("host-exited");
    expect(rowStatusKind({ running: true, needsApproval: true, attention: false, backgroundAgents: 0 }, false)).toBe("permission");
    expect(rowStatusKind({ running: true, needsApproval: false, attention: false, backgroundAgents: 0 }, false)).toBe("running");
    expect(rowStatusKind({ running: false, needsApproval: false, attention: true, backgroundAgents: 0 }, false)).toBe("attention");
    expect(rowStatusKind({ running: false, needsApproval: false, attention: false, backgroundAgents: 0 }, false)).toBeNull();
    expect(rowStatusKind(undefined, true)).toBe("host-exited");
    expect(rowStatusKind(undefined, false)).toBeNull();
  });
});

describe("tab-status-store — background agents", () => {
  it("deriveCoarse sums Claude agents and running detached children", () => {
    const running = { childSessionId: "a" } as DesktopState["backgroundChildren"][number];
    const failed = { childSessionId: "b", endedAt: 5 } as DesktopState["backgroundChildren"][number];
    const derived = deriveCoarse(
      deriveInput("idle", "ready", null, new Set(), { count: 2, abandoned: true }, [running, failed]),
    );
    expect(derived.backgroundAgents).toBe(3);
    expect(derived.backgroundAgentsAbandoned).toBe(true);
  });

  it("shows the count on a live host", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("idle", false, true, 2), true);
    expect(store.getState().statuses.get("t1")?.backgroundAgents).toBe(2);
  });

  it("shows 0 when the host is not live", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("idle", false, false, 2), true);
    expect(store.getState().statuses.get("t1")?.backgroundAgents).toBe(0);
  });

  it("a drop to 0 on an unseen tab raises attention", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("idle", false, true, 2), true);
    store.getState().applyCoarse("t1", coarse("idle", false, true, 0), true);
    expect(store.getState().statuses.get("t1")).toEqual({
      running: false,
      needsApproval: false,
      attention: true,
      backgroundAgents: 0,
    });
  });

  it("on the active tab it does not", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("idle", false, true, 2), false);
    store.getState().applyCoarse("t1", coarse("idle", false, true, 0), false);
    expect(store.getState().statuses.get("t1")?.attention).toBe(false);
  });

  it("abandoned drop is not a completion", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("idle", false, true, 2), true);
    store.getState().applyCoarse("t1", coarse("idle", false, true, 0, true), true);
    expect(store.getState().statuses.get("t1")?.attention).toBe(false);
  });

  it("a live tab with count going not-live raises no attention", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("idle", false, true, 2), true);
    store.getState().applyCoarse("t1", coarse("idle", false, false, 0), true);
    expect(store.getState().statuses.get("t1")?.attention).toBe(false);
  });

  it("a stale abandoned flag does not swallow a later AnyCode child drop to 0", () => {
    const desktop = createDesktopStore();
    const mirror = createTabStatusStore();
    const send = (message: object) => desktop.getState().applyHostMessage(message as never);
    const apply = () => mirror.getState().applyCoarse("t1", deriveCoarse(desktop.getState()), true);
    send({ type: "host_ready", workspace: "/ws", mode: "build", model: "m", sessionId: "s" });
    const child = { childSessionId: "c1" };
    send({ type: "agent_event", turnId: "detached-subagent", event: { type: "engine_background_agents", count: 2, abandoned: false } });
    send({ type: "background_children", children: [child] });
    apply();
    expect(mirror.getState().statuses.get("t1")?.backgroundAgents).toBe(3);
    send({ type: "agent_event", turnId: "detached-subagent", event: { type: "engine_background_agents", count: 0, abandoned: true } });
    apply();
    expect(mirror.getState().statuses.get("t1")).toMatchObject({ backgroundAgents: 1, attention: false });
    send({ type: "background_children", children: [] });
    apply();
    expect(mirror.getState().statuses.get("t1")).toMatchObject({ backgroundAgents: 0, attention: true });
  });

  it("agents settling during a running turn do not raise attention", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("idle", false, true, 2), true);
    store.getState().applyCoarse("t1", coarse("running", false, true, 0), true);
    expect(store.getState().statuses.get("t1")?.attention).toBe(false);
  });

  it("a count change re-renders, an identical snapshot does not", () => {
    const store = createTabStatusStore();
    store.getState().applyCoarse("t1", coarse("idle", false, true, 1), false);
    const first = store.getState().statuses;
    store.getState().applyCoarse("t1", coarse("idle", false, true, 1), false);
    expect(store.getState().statuses).toBe(first);
    store.getState().applyCoarse("t1", coarse("idle", false, true, 2), false);
    expect(store.getState().statuses).not.toBe(first);
  });
});
