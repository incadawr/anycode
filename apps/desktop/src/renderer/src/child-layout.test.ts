/**
 * child-layout.ts tests (TASK.102 CUT-S2 §2.5, slice S2c C1): the view
 * reducer trio, the badge-priority collapse, and the breadcrumb VM — in
 * isolation from the store (store.ts's own subagent_attention sequences are
 * covered separately, store.test.ts §10.1) and from the JSX layer (C3).
 */
import { describe, expect, it } from "vitest";
import {
  buildChildBreadcrumb,
  childBadgeKind,
  closeChild,
  createChildLayoutStore,
  MASTER_VIEW,
  openChild,
  type ChildLayoutView,
} from "./child-layout.js";
import type { SubagentSubStatus } from "./store.js";

describe("child-layout view reducer (openChild / closeChild)", () => {
  it("master -> child -> master: openChild switches the pane onto the given child, closeChild returns it to master", () => {
    let view: ChildLayoutView = MASTER_VIEW;
    expect(view).toEqual({ kind: "master" });

    view = openChild(view, "call-1");
    expect(view).toEqual({ kind: "child", spawnToolCallId: "call-1" });

    view = closeChild(view);
    expect(view).toEqual({ kind: "master" });
  });

  it("openChild retargets the pane when a DIFFERENT child is opened while one is already showing (one surface at a time, not a stack)", () => {
    let view: ChildLayoutView = openChild(MASTER_VIEW, "call-1");
    view = openChild(view, "call-2");
    expect(view).toEqual({ kind: "child", spawnToolCallId: "call-2" });
  });

  it("closeChild is a no-op shape-wise when already on master (idempotent)", () => {
    expect(closeChild(MASTER_VIEW)).toEqual({ kind: "master" });
  });
});

describe("childBadgeKind (priority: waiting_permission > running > error/done)", () => {
  function card(waiting: true | undefined, final: SubagentSubStatus["final"]): Pick<SubagentSubStatus, "waiting" | "final"> {
    return waiting === undefined ? { final } : { waiting, final };
  }

  it("waiting:true + final:null -> waiting_permission", () => {
    expect(childBadgeKind(card(true, null))).toBe("waiting_permission");
  });

  it("waiting:true OUTRANKS a terminal final — discriminates a facade that checks `final` before `waiting` (defensive: production settle always strips `waiting` first, but this function's OWN priority must not depend on that upstream invariant)", () => {
    expect(childBadgeKind(card(true, { status: "completed", durationMs: 100 }))).toBe("waiting_permission");
    expect(childBadgeKind(card(true, { status: "error", durationMs: 100 }))).toBe("waiting_permission");
  });

  it("no waiting + final:null -> running", () => {
    expect(childBadgeKind(card(undefined, null))).toBe("running");
  });

  it("no waiting + final completed/max_turns/cancelled -> done", () => {
    expect(childBadgeKind(card(undefined, { status: "completed", durationMs: 1 }))).toBe("done");
    expect(childBadgeKind(card(undefined, { status: "max_turns", durationMs: 1 }))).toBe("done");
    expect(childBadgeKind(card(undefined, { status: "cancelled", durationMs: 1 }))).toBe("done");
  });

  it("no waiting + final error -> error (NOT lumped into done)", () => {
    expect(childBadgeKind(card(undefined, { status: "error", durationMs: 1 }))).toBe("error");
  });
});

describe("buildChildBreadcrumb", () => {
  it("builds the frozen '{masterTitle} › {agentType}' text from the master title and the card's agentType", () => {
    const vm = buildChildBreadcrumb("Fix the flaky test", { agentType: "general-purpose", description: "investigate CI" });
    expect(vm.text).toBe("Fix the flaky test › general-purpose");
    expect(vm.masterTitle).toBe("Fix the flaky test");
    expect(vm.agentType).toBe("general-purpose");
    expect(vm.description).toBe("investigate CI");
  });

  it("never renders the child session's own name into the breadcrumb — there is no name-typed input at all, only masterTitle + the card's agentType/description", () => {
    const vm = buildChildBreadcrumb("Master session", { agentType: "explore", description: "anything" });
    // The only strings text can be composed from are masterTitle and agentType;
    // a leaked child-session identifier (e.g. a childSessionId/childTabId) would
    // have to ride in through one of THESE two fields to reach `text`, and
    // neither is sourced from the relation-store's child ids anywhere in this
    // module (child-sessions.ts is not even imported here).
    expect(vm.text).toBe("Master session › explore");
  });

  it("different agentType/description pairs produce distinct text (not a constant/stub)", () => {
    const a = buildChildBreadcrumb("Task A", { agentType: "general-purpose", description: "d1" });
    const b = buildChildBreadcrumb("Task B", { agentType: "explore", description: "d2" });
    expect(a.text).not.toBe(b.text);
  });
});

describe("child-layout store (per-root-tab view persistence, TASK.102 CUT-S2 §2.5 C3)", () => {
  it("view() defaults to MASTER_VIEW for a root tab the store has never heard from", () => {
    const api = createChildLayoutStore();
    expect(api.getState().view("tab-root")).toEqual({ kind: "master" });
  });

  it("open() then close() round-trips a root tab through child and back to master", () => {
    const api = createChildLayoutStore();
    api.getState().open("tab-root", "call-1");
    expect(api.getState().view("tab-root")).toEqual({ kind: "child", spawnToolCallId: "call-1" });

    api.getState().close("tab-root");
    expect(api.getState().view("tab-root")).toEqual({ kind: "master" });
  });

  it("open() retargets the SAME root tab's pane onto a different child (mirrors the pure reducer's own 'one surface at a time' test)", () => {
    const api = createChildLayoutStore();
    api.getState().open("tab-root", "call-1");
    api.getState().open("tab-root", "call-2");
    expect(api.getState().view("tab-root")).toEqual({ kind: "child", spawnToolCallId: "call-2" });
  });

  it("keeps distinct views for two DIFFERENT root tabs without cross-contamination", () => {
    const api = createChildLayoutStore();
    api.getState().open("tab-A", "call-A1");
    api.getState().open("tab-B", "call-B1");
    expect(api.getState().view("tab-A")).toEqual({ kind: "child", spawnToolCallId: "call-A1" });
    expect(api.getState().view("tab-B")).toEqual({ kind: "child", spawnToolCallId: "call-B1" });
  });

  it("close() on an already-master tab is a true no-op (no Map rebuild)", () => {
    const api = createChildLayoutStore();
    const before = api.getState().views;
    api.getState().close("tab-root");
    expect(api.getState().views).toBe(before);
  });

  it("reset() clears every root tab's view", () => {
    const api = createChildLayoutStore();
    api.getState().open("tab-A", "call-1");
    api.getState().open("tab-B", "call-2");
    api.getState().reset();
    expect(api.getState().views.size).toBe(0);
  });
});

// F12 (review wave R): the self-heal-bounce mechanic this module's `onChildGone`/
// `childGone` implemented was RATIFIED-SUPERSEDED by CUT-S2 §10.8.1 point 3
// ("Self-heal-bounce C3 ... заменяется этой веткой" — replaced by the C4
// read-only branch: a shown child going non-live now stays shown, read-only,
// instead of bouncing the pane back to master). Nothing in App.tsx/
// ToolCallCard.tsx/tab-registry.ts ever called either symbol (verified by
// repo-wide grep) — this is dead code whose own docstring claimed a live
// "App.tsx's self-heal effect" wiring that was never built, because the
// design that would have required it was retracted. Per the track's law
// ("либо код зовётся, либо функция и докстринг уходят"), the code goes.
describe("F12: the retracted self-heal-bounce mechanic is fully removed, not left dead", () => {
  it("does not export onChildGone", async () => {
    const mod: Record<string, unknown> = await import("./child-layout.js");
    expect("onChildGone" in mod).toBe(false);
  });

  it("the store no longer exposes a childGone method", () => {
    const api = createChildLayoutStore();
    expect("childGone" in api.getState()).toBe(false);
  });
});
