/**
 * child-layout.ts tests (TASK.102 CUT-S2 §2.5, slice S2c C1): the view
 * reducer trio, the badge-priority collapse, and the breadcrumb VM — in
 * isolation from the store (store.ts's own subagent_attention sequences are
 * covered separately, store.test.ts §10.1) and from the JSX layer (C3).
 */
import { describe, expect, it } from "vitest";
import {
  buildChildBreadcrumb,
  buildChildStackHead,
  CHILD_SPLIT_MAX_ROWS,
  childBadgeKind,
  closeChild,
  createChildLayoutStore,
  enterSplit,
  expandRow,
  exitSplit,
  MASTER_VIEW,
  openChild,
  type ChildBadgeKind,
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

describe("openChild: split branches (CUT-S3 §2.2)", () => {
  function split(order: string[], expandedId: string): ChildLayoutView {
    return { kind: "split", order, expandedId };
  }

  it("expands an existing collapsed row in place — order untouched, only expandedId moves", () => {
    const view = split(["a", "b", "c"], "a");
    expect(openChild(view, "b")).toEqual({ kind: "split", order: ["a", "b", "c"], expandedId: "b" });
  });

  it("idempotent on the already-expanded id — returns the SAME reference (no-op)", () => {
    const view = split(["a", "b"], "a");
    expect(openChild(view, "a")).toBe(view);
  });

  it("appends and expands a brand-new id when the stack has room", () => {
    const view = split(["a"], "a");
    expect(openChild(view, "b")).toEqual({ kind: "split", order: ["a", "b"], expandedId: "b" });
  });

  it("appends the THIRD row (reaches CHILD_SPLIT_MAX_ROWS) without evicting", () => {
    const view = split(["a", "b"], "b");
    const next = openChild(view, "c");
    expect(next).toEqual({ kind: "split", order: ["a", "b", "c"], expandedId: "c" });
  });

  it("evicts the FIRST collapsed row when the stack is full — the expanded row always survives (I2)", () => {
    // order = [a, b, c], expanded = b -> first collapsed row is "a".
    const view = split(["a", "b", "c"], "b");
    expect(openChild(view, "d")).toEqual({ kind: "split", order: ["b", "c", "d"], expandedId: "d" });
  });

  it("eviction never touches the expanded row even when it sits first in insertion order", () => {
    // order = [a, b, c], expanded = a -> first COLLAPSED row is "b" (not "a").
    const view = split(["a", "b", "c"], "a");
    expect(openChild(view, "d")).toEqual({ kind: "split", order: ["a", "c", "d"], expandedId: "d" });
  });

  it("a full stack's eviction result is itself a valid split view (I1): 3 unique rows, expandedId among them", () => {
    const view = split(["a", "b", "c"], "b");
    const next = openChild(view, "d");
    expect(next.kind).toBe("split");
    if (next.kind === "split") {
      expect(next.order).toHaveLength(CHILD_SPLIT_MAX_ROWS);
      expect(new Set(next.order).size).toBe(CHILD_SPLIT_MAX_ROWS);
      expect(next.order).toContain(next.expandedId);
    }
  });
});

describe("openChild: master/child branches stay byte-identical under CUT-S3 (regression pin, §5.1 item 2)", () => {
  it("master -> child, unconditionally", () => {
    expect(openChild(MASTER_VIEW, "call-1")).toEqual({ kind: "child", spawnToolCallId: "call-1" });
  });

  it("child -> retargets onto a DIFFERENT child, unconditionally (still one surface at a time)", () => {
    const view: ChildLayoutView = { kind: "child", spawnToolCallId: "call-1" };
    expect(openChild(view, "call-2")).toEqual({ kind: "child", spawnToolCallId: "call-2" });
  });
});

describe("enterSplit (CUT-S3 §2.2)", () => {
  it("child -> a one-row stack holding that same child, expanded", () => {
    const view: ChildLayoutView = { kind: "child", spawnToolCallId: "call-1" };
    expect(enterSplit(view)).toEqual({ kind: "split", order: ["call-1"], expandedId: "call-1" });
  });

  it("master -> the SAME reference (no-op)", () => {
    expect(enterSplit(MASTER_VIEW)).toBe(MASTER_VIEW);
  });

  it("split -> the SAME reference (no-op, already split)", () => {
    const view: ChildLayoutView = { kind: "split", order: ["a"], expandedId: "a" };
    expect(enterSplit(view)).toBe(view);
  });
});

describe("exitSplit (CUT-S3 §2.2)", () => {
  it("split -> layout B on the expanded child", () => {
    const view: ChildLayoutView = { kind: "split", order: ["a", "b"], expandedId: "b" };
    expect(exitSplit(view)).toEqual({ kind: "child", spawnToolCallId: "b" });
  });

  it("master -> the SAME reference (no-op)", () => {
    expect(exitSplit(MASTER_VIEW)).toBe(MASTER_VIEW);
  });

  it("child -> the SAME reference (no-op)", () => {
    const view: ChildLayoutView = { kind: "child", spawnToolCallId: "a" };
    expect(exitSplit(view)).toBe(view);
  });
});

describe("expandRow (CUT-S3 §2.2)", () => {
  it("switches the expanded row within the stack — order untouched", () => {
    const view: ChildLayoutView = { kind: "split", order: ["a", "b", "c"], expandedId: "a" };
    expect(expandRow(view, "c")).toEqual({ kind: "split", order: ["a", "b", "c"], expandedId: "c" });
  });

  it("id NOT in order -> the SAME reference (no-op)", () => {
    const view: ChildLayoutView = { kind: "split", order: ["a", "b"], expandedId: "a" };
    expect(expandRow(view, "z")).toBe(view);
  });

  it("id already expanded -> the SAME reference (no-op)", () => {
    const view: ChildLayoutView = { kind: "split", order: ["a", "b"], expandedId: "a" };
    expect(expandRow(view, "a")).toBe(view);
  });

  it("master/child -> the SAME reference (no-op)", () => {
    expect(expandRow(MASTER_VIEW, "a")).toBe(MASTER_VIEW);
    const child: ChildLayoutView = { kind: "child", spawnToolCallId: "a" };
    expect(expandRow(child, "a")).toBe(child);
  });
});

describe("I3 round-trip (CUT-S3 §2.5)", () => {
  it("exitSplit(enterSplit(v)) deep-equals v for any v.kind === 'child'", () => {
    const v: ChildLayoutView = { kind: "child", spawnToolCallId: "call-1" };
    expect(exitSplit(enterSplit(v))).toEqual(v);
  });

  it("the REVERSE direction is declared lossy: enterSplit(exitSplit(s)) forgets the collapsed rows — pinned, not a bug to fix", () => {
    const s: ChildLayoutView = { kind: "split", order: ["a", "b", "c"], expandedId: "b" };
    expect(enterSplit(exitSplit(s))).toEqual({ kind: "split", order: ["b"], expandedId: "b" });
  });
});

describe("child-layout store: split methods (CUT-S3 §2.3, mirrors close()'s 'no Map rebuild' discipline)", () => {
  it("enterSplit(): child -> one-row stack; no Map rebuild on a no-op (already split)", () => {
    const api = createChildLayoutStore();
    api.getState().open("tab-root", "call-1");
    api.getState().enterSplit("tab-root");
    expect(api.getState().view("tab-root")).toEqual({ kind: "split", order: ["call-1"], expandedId: "call-1" });

    const before = api.getState().views;
    api.getState().enterSplit("tab-root");
    expect(api.getState().views).toBe(before);
  });

  it("exitSplit(): split -> child(expandedId); no Map rebuild on a no-op (already child)", () => {
    const api = createChildLayoutStore();
    api.getState().open("tab-root", "call-1");
    api.getState().enterSplit("tab-root");
    api.getState().exitSplit("tab-root");
    expect(api.getState().view("tab-root")).toEqual({ kind: "child", spawnToolCallId: "call-1" });

    const before = api.getState().views;
    api.getState().exitSplit("tab-root");
    expect(api.getState().views).toBe(before);
  });

  it("expandRow(): switches the expanded row; no Map rebuild on a no-op (unknown id)", () => {
    const api = createChildLayoutStore();
    api.getState().open("tab-root", "call-1");
    api.getState().enterSplit("tab-root");
    api.getState().open("tab-root", "call-2");
    api.getState().expandRow("tab-root", "call-1");
    expect(api.getState().view("tab-root")).toEqual({ kind: "split", order: ["call-1", "call-2"], expandedId: "call-1" });

    const before = api.getState().views;
    api.getState().expandRow("tab-root", "unknown-id");
    expect(api.getState().views).toBe(before);
  });

  it("no Map rebuild on a NEVER-SEEN root tab either, for every split method", () => {
    const api = createChildLayoutStore();
    const before = api.getState().views;
    api.getState().enterSplit("tab-never-seen");
    expect(api.getState().views).toBe(before);
    api.getState().exitSplit("tab-never-seen");
    expect(api.getState().views).toBe(before);
    api.getState().expandRow("tab-never-seen", "x");
    expect(api.getState().views).toBe(before);
  });
});

describe("buildChildStackHead (CUT-S3 §2.4)", () => {
  function row(spawnToolCallId: string, badge: ChildBadgeKind): { spawnToolCallId: string; badge: ChildBadgeKind } {
    return { spawnToolCallId, badge };
  }

  it("N=1 -> single, naming that row's id", () => {
    expect(buildChildStackHead([row("a", "running")])).toEqual({ kind: "single", spawnToolCallId: "a" });
  });

  it("N=2 -> roster", () => {
    expect(buildChildStackHead([row("a", "running"), row("b", "done")]).kind).toBe("roster");
  });

  it("N=3 -> roster", () => {
    expect(buildChildStackHead([row("a", "running"), row("b", "done"), row("c", "error")]).kind).toBe("roster");
  });

  it("running count includes waiting_permission — a blocked child is still alive, not 'done'", () => {
    const head = buildChildStackHead([row("a", "running"), row("b", "waiting_permission"), row("c", "done")]);
    expect(head).toEqual({ kind: "roster", total: 3, running: 2 });
  });

  it("running count excludes done/error", () => {
    const head = buildChildStackHead([row("a", "done"), row("b", "error")]);
    expect(head).toEqual({ kind: "roster", total: 2, running: 0 });
  });

  it("total/running are computed from the actual rows, not a hardcoded constant", () => {
    const a = buildChildStackHead([row("a", "running"), row("b", "running")]);
    const b = buildChildStackHead([row("a", "running"), row("b", "running"), row("c", "running")]);
    expect(a).not.toEqual(b);
  });
});

describe("I1 validity — every reducer returns a valid view on any valid input (CUT-S3 §2.5, matrix)", () => {
  function isValidView(view: ChildLayoutView): boolean {
    if (view.kind !== "split") {
      return true;
    }
    const { order, expandedId } = view;
    return (
      order.length >= 1 &&
      order.length <= CHILD_SPLIT_MAX_ROWS &&
      new Set(order).size === order.length &&
      order.includes(expandedId)
    );
  }

  const sampleViews: ChildLayoutView[] = [
    MASTER_VIEW,
    { kind: "child", spawnToolCallId: "call-1" },
    { kind: "split", order: ["a"], expandedId: "a" },
    { kind: "split", order: ["a", "b"], expandedId: "a" },
    { kind: "split", order: ["a", "b"], expandedId: "b" },
    { kind: "split", order: ["a", "b", "c"], expandedId: "a" },
    { kind: "split", order: ["a", "b", "c"], expandedId: "b" },
    { kind: "split", order: ["a", "b", "c"], expandedId: "c" },
  ];
  const sampleIds = ["a", "b", "c", "d", "new-id"];

  it("every sample input starts valid (sanity check on the fixture itself)", () => {
    for (const view of sampleViews) {
      expect(isValidView(view)).toBe(true);
    }
  });

  it("openChild(view, id) is valid for every (view, id) combination in the matrix", () => {
    for (const view of sampleViews) {
      for (const id of sampleIds) {
        expect(isValidView(openChild(view, id))).toBe(true);
      }
    }
  });

  it("closeChild/enterSplit/exitSplit are valid for every sample view", () => {
    for (const view of sampleViews) {
      expect(isValidView(closeChild(view))).toBe(true);
      expect(isValidView(enterSplit(view))).toBe(true);
      expect(isValidView(exitSplit(view))).toBe(true);
    }
  });

  it("expandRow(view, id) is valid for every (view, id) combination in the matrix", () => {
    for (const view of sampleViews) {
      for (const id of sampleIds) {
        expect(isValidView(expandRow(view, id))).toBe(true);
      }
    }
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
