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
  onChildGone,
  openChild,
  type ChildLayoutView,
} from "./child-layout.js";
import type { SubagentSubStatus } from "./store.js";

describe("child-layout view reducer (openChild / closeChild / onChildGone)", () => {
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

  it("onChildGone from a child-view returns to master when the gone child IS the one showing (the child-host-exit path)", () => {
    const view = openChild(MASTER_VIEW, "call-1");
    expect(onChildGone(view, "call-1")).toEqual({ kind: "master" });
  });

  it("onChildGone leaves the view UNCHANGED when a DIFFERENT (background) child goes away — discriminates a facade that reverts to master on any child-gone signal regardless of which child it names", () => {
    const view = openChild(MASTER_VIEW, "call-1");
    const result = onChildGone(view, "call-2");
    expect(result).toEqual({ kind: "child", spawnToolCallId: "call-1" });
    expect(result).toBe(view); // same reference: a true no-op, not a re-equal rebuild
  });

  it("onChildGone on the master view is a no-op regardless of which child is named", () => {
    expect(onChildGone(MASTER_VIEW, "call-1")).toBe(MASTER_VIEW);
  });

  it("full sequence: master -> open(A) -> child(A) unaffected by gone(B) -> gone(A) -> master (exercises the trio together, mirrors the S2d 'Open on a bg child then close it' smoke path)", () => {
    let view: ChildLayoutView = MASTER_VIEW;
    view = openChild(view, "call-A");
    expect(view).toEqual({ kind: "child", spawnToolCallId: "call-A" });

    view = onChildGone(view, "call-B");
    expect(view).toEqual({ kind: "child", spawnToolCallId: "call-A" });

    view = onChildGone(view, "call-A");
    expect(view).toEqual({ kind: "master" });
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

  it("childGone(rootTabId, id) reverts that root tab to master ONLY when it was showing exactly that child — a DIFFERENT tab's own child-view is untouched", () => {
    const api = createChildLayoutStore();
    api.getState().open("tab-root", "call-1");
    api.getState().open("tab-other", "call-2");

    api.getState().childGone("tab-root", "call-OTHER");
    expect(api.getState().view("tab-root")).toEqual({ kind: "child", spawnToolCallId: "call-1" });

    api.getState().childGone("tab-root", "call-1");
    expect(api.getState().view("tab-root")).toEqual({ kind: "master" });
    expect(api.getState().view("tab-other")).toEqual({ kind: "child", spawnToolCallId: "call-2" });
  });

  it("childGone is a true no-op (no Map rebuild) when the named root tab is already on master", () => {
    const api = createChildLayoutStore();
    const before = api.getState().views;
    api.getState().childGone("tab-root", "call-1");
    expect(api.getState().views).toBe(before);
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
