/**
 * TASK.218 (supervisor correction 4): the split panel's CONTINUATION
 * projection, tested through the real seam — `projectChildSplitRows` fed by
 * the REAL relation store (driven the way `registerPort` drives it:
 * `registerChild` per delivered child port) and a real master transcript.
 * No fake DOM fixture displaying manually supplied expectations: the rows
 * here are exactly what App.tsx would paint.
 *
 * Correction 5's counter discipline is pinned here too: a resumed child's
 * LIVE transcript is cumulative (never summed with prior per-call cards —
 * withLiveChildCounters' max semantics), while the no-live-store settled
 * path sums per-call settled counters; a running continuation stays
 * final:null even when a prior sibling completed; unknown duration stays
 * unknown.
 */
import { describe, expect, it } from "vitest";
import { createChildRelationStore, spawnToolCallIdForChild, childRelationKey, type ChildRelation } from "./child-sessions.js";
import { buildChildStackHead, mergeContinuationCards, openChild, rememberLiveChildCard } from "./child-layout.js";
import { projectChildSplitRows, type ChildSplitProjectionDeps } from "./child-split-projection.js";
import type { SubagentSubStatus, TranscriptBlock } from "./store.js";
import { formatSubagentCounters } from "./components/ToolCallCard.js";

const PARENT = "parent-1";

function agentBlock(toolCallId: string, card: SubagentSubStatus | null, input: unknown = {}): TranscriptBlock {
  return {
    kind: "tool_call",
    id: `b-${toolCallId}`,
    toolCallId,
    toolName: "Agent",
    input: input as object,
    status: card?.final !== null && card?.final !== undefined ? "success" : "running",
    modelText: null,
    snapshots: { before: null, after: null },
    subagent: card,
    workflow: null,
  };
}

const baseCard = (overrides: Partial<SubagentSubStatus>): SubagentSubStatus => ({
  agentType: "glm-lead",
  description: "d",
  model: null,
  engine: null,
  turns: 0,
  toolCalls: 0,
  lastTool: null,
  activity: [],
  activityDropped: 0,
  final: null,
  ...overrides,
});

function deps(relations: ReadonlyMap<string, ChildRelation>, transcript: readonly TranscriptBlock[]): ChildSplitProjectionDeps {
  return { parentSessionId: PARENT, relations, transcript, liveChildStores: new Map() };
}

describe("projectChildSplitRows — continuation follows the existing row (TASK.218)", () => {
  it("registration-time latest-ID selection: a continuation's port registration makes the ONE row follow it — no second Open, running status, cumulative counters", () => {
    const relationStore = createChildRelationStore();
    // The real registration path registerPort performs for each delivered child port.
    relationStore.getState().registerChild(PARENT, "tc-1", "tab-c1", "child-9");
    const transcript: TranscriptBlock[] = [
      agentBlock("tc-1", baseCard({ turns: 1, final: { status: "completed", durationMs: 6400 } })),
    ];
    // One row open on the split stack.
    const order = ["tc-1"];

    // BEFORE the continuation registers: one row, completed.
    let rows = projectChildSplitRows(order, deps(relationStore.getState().relations, transcript));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.badge).toBe("done");
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: 6400 });

    // The continuation's port registers (same childSessionId, NEW spawn id)…
    relationStore.getState().registerChild(PARENT, "tc-2", "tab-c2", "child-9");
    // …and its per-call Agent card arrives with final:null (running).
    transcript.push(agentBlock("tc-2", baseCard({ turns: 0, final: null })));

    // The panel follows the effective id AUTOMATICALLY — still ONE row for
    // the view id "tc-1", now running, with prior turns carried.
    rows = projectChildSplitRows(order, deps(relationStore.getState().relations, transcript));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spawnToolCallId).toBe("tc-1"); // displayed row id frozen
    expect(rows[0]!.badge).toBe("running");
    expect(rows[0]!.card.turns).toBe(1); // 0 (running) + 1 (prior settled)
    // N=1 head is 'single', naming the row id.
    expect(buildChildStackHead(rows.map((row) => ({ spawnToolCallId: row.spawnToolCallId, badge: row.badge })))).toEqual({
      kind: "single",
      spawnToolCallId: "tc-1",
    });

    // The continuation settles: completed, 2 turns, 14400ms summed.
    transcript[1] = agentBlock("tc-2", baseCard({ turns: 1, final: { status: "completed", durationMs: 8000 } }));
    rows = projectChildSplitRows(order, deps(relationStore.getState().relations, transcript));
    expect(rows[0]!.badge).toBe("done");
    expect(rows[0]!.card.turns).toBe(2);
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: 14400 });
    expect(formatSubagentCounters(rows[0]!.card)).toContain("2 turns");
    expect(formatSubagentCounters(rows[0]!.card)).toContain("14.4s");
  });

  it("a NEW logical child (child-8) adds a row when opened through the existing flow", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "tc-1", "tab-c1", "child-9");
    relationStore.getState().registerChild(PARENT, "tc-2", "tab-c2", "child-9");
    relationStore.getState().registerChild(PARENT, "tc-3", "tab-c3", "child-8");
    const transcript: TranscriptBlock[] = [
      agentBlock("tc-1", baseCard({ turns: 1, final: { status: "completed", durationMs: 6400 } })),
      agentBlock("tc-2", baseCard({ turns: 1, final: { status: "completed", durationMs: 8000 } })),
      agentBlock("tc-3", baseCard({ final: null })),
    ];
    const order = ["tc-1", "tc-3"]; // the user opened the new child too
    const rows = projectChildSplitRows(order, deps(relationStore.getState().relations, transcript));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.spawnToolCallId)).toEqual(["tc-1", "tc-3"]);
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: 14400 });
    expect(rows[1]!.badge).toBe("running");
    expect(buildChildStackHead(rows.map((row) => ({ spawnToolCallId: row.spawnToolCallId, badge: row.badge })))).toEqual({
      kind: "roster",
      total: 2,
      running: 1,
    });
  });
});

describe("Open-path fold through the real automation seam (TASK.218)", () => {
  it("childOpen on a continuation spawn folds onto the existing row — no duplicate logical child rows", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "tc-1", "tab-c1", "child-9");
    relationStore.getState().registerChild(PARENT, "tc-2", "tab-c2", "child-9");
    const relations = relationStore.getState().relations;

    // Split open with tc-1 (layout B -> split is not needed for the fold
    // itself; drive the reducer the facade's childOpen drives, WITH the
    // predicate automation.ts now derives from the relation store).
    const cs = relations.get(childRelationKey(PARENT, "tc-2")) !== undefined ? "child-9" : undefined;
    expect(cs).toBe("child-9");
    const isSameChild = (id: string) =>
      relations.get(childRelationKey(PARENT, id))?.childSessionId === "child-9";
    let view = openChild({ kind: "master" }, "tc-1");
    view = openChild({ kind: "split", order: ["tc-1"], expandedId: "tc-1" }, "tc-2", isSameChild);
    expect(view).toEqual({ kind: "split", order: ["tc-2"], expandedId: "tc-2" });
    // Latest registration wins:
    expect(spawnToolCallIdForChild(relations, PARENT, "child-9")).toBe("tc-2");
  });
});

describe("detached continuation counters (supervisor correction 5, defect 1/2/3)", () => {
  // NOTE (honest coverage): the remembered-card cache (`lastLiveChildCard`)
  // is module-level and renderer-lifetime BY DESIGN, with no public clear.
  // Each test below therefore seeds the cache explicitly for the exact ids
  // it asserts on; where a test must observe "nothing remembered", it uses
  // fresh ids no earlier test touched (id sets are disjoint per test).

  /** A minimal live DesktopStoreApi fake: cumulative transcript + modelTurns + turn status. */
  function fakeLiveStore(state: { transcript: TranscriptBlock[]; modelTurns: number; running: boolean }) {
    const listeners = new Set<() => void>();
    const snapshot = {
      transcript: state.transcript,
      modelTurns: state.modelTurns,
      turn: { status: (state.running ? "running" : "idle") as "running" | "idle", turnId: null, requestId: null },
    };
    return {
      getState: () => snapshot,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as import("./tab-registry.js").DesktopStoreApi;
  }

  /** A child-transcript tool_call block (the child's OWN transcript, not the parent's). */
  function childToolCall(id: string): TranscriptBlock {
    return {
      kind: "tool_call",
      id,
      toolCallId: id,
      toolName: "Read",
      input: {},
      status: "success",
      modelText: null,
      snapshots: { before: null, after: null },
      subagent: null,
      workflow: null,
    };
  }

  it("defect 1: prior REMEMBERED counters are resolved when the parent cards carry no progress (native detached calls)", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "tc-1", "tab-c1", "child-9");
    relationStore.getState().registerChild(PARENT, "tc-2", "tab-c2", "child-9");
    // Both detached Agent blocks have NO subagent card. The prior run's
    // counters live ONLY in the remembered cache (seen live before the host
    // was reaped).
    rememberLiveChildCard("tc-1", baseCard({ turns: 1, toolCalls: 2, final: { status: "completed", durationMs: 6400 } }));
    const transcript: TranscriptBlock[] = [
      agentBlock("tc-1", null, { detach: true }),
      agentBlock("tc-2", null, { detach: true }),
    ];
    const rows = projectChildSplitRows(["tc-1"], deps(relationStore.getState().relations, transcript));
    expect(rows[0]!.badge).toBe("running"); // latest tc-2 card is a zero-fallback, running
    expect(rows[0]!.card.turns).toBe(1); // prior remembered 1 turn carried — NOT lost to 0
    expect(rows[0]!.card.toolCalls).toBe(2);
  });

  it("a resumed child's LIVE transcript is already cumulative — never summed with prior per-run cards", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "tc-1", "tab-c1", "child-9");
    relationStore.getState().registerChild(PARENT, "tc-2", "tab-c2", "child-9");
    // Prior per-call card: 1 turn. The resumed child's live transcript is
    // CUMULATIVE (its own history replayed + the new run): 3 turns total,
    // 2 tool calls, still running.
    const live = fakeLiveStore({
      transcript: [childToolCall("k-1"), childToolCall("k-2")],
      modelTurns: 3,
      running: true,
    });
    const transcript: TranscriptBlock[] = [
      agentBlock("tc-1", baseCard({ turns: 1, final: { status: "completed", durationMs: 6400 } }), { detach: true }),
      agentBlock("tc-2", null, { detach: true }),
    ];
    const stores = new Map([[ "tc-2", live ]]);
    const rows = projectChildSplitRows(["tc-1"], {
      parentSessionId: PARENT,
      relations: relationStore.getState().relations,
      transcript,
      liveChildStores: stores,
    });
    // Cumulative live wins via max semantics: 3 turns, 2 tool calls — the
    // prior run's 1 turn is NOT added on top (no 4).
    expect(rows[0]!.card.turns).toBe(3);
    expect(rows[0]!.card.toolCalls).toBe(2);
    expect(rows[0]!.badge).toBe("running");
  });

  it("after the host/store is gone, the cumulative remembered snapshot is preserved (no re-sum, no loss)", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "tc-1", "tab-c1", "child-9");
    relationStore.getState().registerChild(PARENT, "tc-2", "tab-c2", "child-9");
    const transcript: TranscriptBlock[] = [
      agentBlock("tc-1", baseCard({ turns: 1, final: { status: "completed", durationMs: 6400 } }), { detach: true }),
      agentBlock("tc-2", null, { detach: true }),
    ];
    // The resumed child ran live with a CUMULATIVE transcript (4 turns,
    // settled at 9s total via its own loop_end), then the host was reaped —
    // the remembered card is what remains, already cumulative.
    rememberLiveChildCard("tc-2", baseCard({ turns: 4, final: { status: "completed", durationMs: 9000 } }));
    const rows = projectChildSplitRows(["tc-1"], deps(relationStore.getState().relations, transcript));
    // The remembered CUMULATIVE snapshot supplies the totals — the prior
    // per-run card's 1 turn/6400ms is inside it already and must NOT be
    // added (no 5 turns / 15400ms).
    expect(rows[0]!.card.turns).toBe(4);
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: 9000 });
  });

  it("defect 2: notification-only latest duration stays UNKNOWN even when the prior run's duration is known", () => {
    const relationStore = createChildRelationStore();
    // Fresh ids ("d2-*"): nothing remembered from earlier tests — the latest
    // run genuinely ended unseen, only its notification arrived.
    relationStore.getState().registerChild(PARENT, "d2-tc-1", "tab-c1", "child-9");
    relationStore.getState().registerChild(PARENT, "d2-tc-2", "tab-c2", "child-9");
    // Prior run settled with a known 6400ms; the latest detached run ended
    // before this renderer saw any duration — only its <status>completed</status>
    // notification arrived. The WHOLE-SESSION total is unknown (-1), not 6400.
    const transcript: TranscriptBlock[] = [
      agentBlock("d2-tc-1", baseCard({ turns: 1, final: { status: "completed", durationMs: 6400 } }), { detach: true }),
      agentBlock("d2-tc-2", null, { detach: true }),
      {
        kind: "user_text",
        id: "u1",
        text: "<task-notification>\n  <tool-use-id>d2-tc-2</tool-use-id>\n  <status>completed</status>\n</task-notification>",
      } as TranscriptBlock,
    ];
    const rows = projectChildSplitRows(["d2-tc-1"], deps(relationStore.getState().relations, transcript));
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: -1 });
    expect(rows[0]!.card.turns).toBe(1); // prior's 1 turn; the unseen run's turns are unknown-but-nonnegative → carried, not invented
  });

  it("mergeContinuationCards pins (pure per-run helper): unknown anywhere -> unknown; all-known -> exact sum", () => {
    expect(
      mergeContinuationCards([
        baseCard({ turns: 1, final: { status: "completed", durationMs: -1 } }),
        baseCard({ turns: 1, final: { status: "completed", durationMs: 6400 } }),
      ]).final,
    ).toEqual({ status: "completed", durationMs: -1 });
    // And the settled sum stays exact when everything is known:
    expect(
      mergeContinuationCards([
        baseCard({ turns: 1, final: { status: "completed", durationMs: 6400 } }),
        baseCard({ turns: 1, final: { status: "completed", durationMs: 8000 } }),
      ]).final,
    ).toEqual({ status: "completed", durationMs: 14400 });
  });

  it("pure-merge pin only: a running last card stays final:null beside a completed prior (projection status is covered by the running-continuation tests above)", () => {
    expect(
      mergeContinuationCards([
        baseCard({ turns: 1, final: { status: "completed", durationMs: 6400 } }),
        baseCard({ turns: 0, final: null }),
      ]).final,
    ).toBeNull();
  });
});

describe("repeated continuations — cumulative supersede, per-run add (correction 5, defect round 3)", () => {
  it("third call, cardless running: TWO remembered cumulative snapshots do not inflate the totals (2 turns, not 3/4)", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "r3-a", "tab-1", "child-9");
    relationStore.getState().registerChild(PARENT, "r3-b", "tab-2", "child-9");
    relationStore.getState().registerChild(PARENT, "r3-c", "tab-3", "child-9");
    // First run remembered per its own run: 1 turn/6400ms. Second run's
    // remembered snapshot is CUMULATIVE (resumed child): 2 turns/14400ms —
    // it already CONTAINS the first run's 1 turn/6400ms.
    rememberLiveChildCard("r3-a", baseCard({ turns: 1, toolCalls: 1, final: { status: "completed", durationMs: 6400 } }));
    rememberLiveChildCard("r3-b", baseCard({ turns: 2, toolCalls: 3, final: { status: "completed", durationMs: 14400 } }));
    // Third call just registered, cardless detached, still running.
    const transcript: TranscriptBlock[] = [
      agentBlock("r3-a", null, { detach: true }),
      agentBlock("r3-b", null, { detach: true }),
      agentBlock("r3-c", null, { detach: true }),
    ];
    const rows = projectChildSplitRows(["r3-a"], deps(relationStore.getState().relations, transcript));
    expect(rows[0]!.badge).toBe("running");
    // The cumulative snapshot SUPERSEDES the first per-run card (no 1+2=3);
    // the running third adds 0 so far. Expected turns: 2, toolCalls: 3.
    expect(rows[0]!.card.turns).toBe(2);
    expect(rows[0]!.card.toolCalls).toBe(3);
  });

  it("third call SYNC with a per-run card: adds ON TOP of the superseded cumulative prefix — 3 turns / 19400ms, not 4 / 25800ms", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "r3-d", "tab-1", "child-9");
    relationStore.getState().registerChild(PARENT, "r3-e", "tab-2", "child-9");
    relationStore.getState().registerChild(PARENT, "r3-f", "tab-3", "child-9");
    rememberLiveChildCard("r3-d", baseCard({ turns: 1, toolCalls: 1, final: { status: "completed", durationMs: 6400 } }));
    rememberLiveChildCard("r3-e", baseCard({ turns: 2, toolCalls: 3, final: { status: "completed", durationMs: 14400 } }));
    // The third call is a SYNC (non-detached) call with a real per-run card:
    // 1 turn / 5000ms completed.
    const transcript: TranscriptBlock[] = [
      agentBlock("r3-d", null, { detach: true }),
      agentBlock("r3-e", null, { detach: true }),
      agentBlock("r3-f", baseCard({ turns: 1, toolCalls: 2, final: { status: "completed", durationMs: 5000 } })),
    ];
    const rows = projectChildSplitRows(["r3-d"], deps(relationStore.getState().relations, transcript));
    expect(rows[0]!.badge).toBe("done");
    // Cumulative prefix (2 turns/14400ms — contains run 1) + per-run third
    // (1 turn/5000ms): 3 turns / 19400ms. The old sum-everything bug gave
    // 4 turns / 25800ms.
    expect(rows[0]!.card.turns).toBe(3);
    expect(rows[0]!.card.toolCalls).toBe(5);
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: 19400 });
  });

  it("third AND fourth remembered cumulative snapshots: the later supersedes the earlier — no floor inflation", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "r3-g", "tab-1", "child-9");
    relationStore.getState().registerChild(PARENT, "r3-h", "tab-2", "child-9");
    relationStore.getState().registerChild(PARENT, "r3-i", "tab-3", "child-9");
    relationStore.getState().registerChild(PARENT, "r3-j", "tab-4", "child-9");
    // Prefix snapshots: per-run 1 turn/6400, cumulative 2/14400, cumulative
    // 3/21000. Latest (fourth) cumulative: 5 turns/30000ms — authoritative.
    rememberLiveChildCard("r3-g", baseCard({ turns: 1, toolCalls: 1, final: { status: "completed", durationMs: 6400 } }));
    rememberLiveChildCard("r3-h", baseCard({ turns: 2, toolCalls: 3, final: { status: "completed", durationMs: 14400 } }));
    rememberLiveChildCard("r3-i", baseCard({ turns: 3, toolCalls: 4, final: { status: "completed", durationMs: 21000 } }));
    rememberLiveChildCard("r3-j", baseCard({ turns: 5, toolCalls: 7, final: { status: "completed", durationMs: 30000 } }));
    const transcript: TranscriptBlock[] = [
      agentBlock("r3-g", null, { detach: true }),
      agentBlock("r3-h", null, { detach: true }),
      agentBlock("r3-i", null, { detach: true }),
      agentBlock("r3-j", null, { detach: true }),
    ];
    const rows = projectChildSplitRows(["r3-g"], deps(relationStore.getState().relations, transcript));
    expect(rows[0]!.badge).toBe("done");
    // The LATEST cumulative snapshot supersedes every overlapping prefix:
    // 5 turns / 30000ms — not 1+2+3+5=11 turns / 71800ms, and not floored
    // up by any earlier snapshot.
    expect(rows[0]!.card.turns).toBe(5);
    expect(rows[0]!.card.toolCalls).toBe(7);
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: 30000 });
  });

  it("a cumulative prefix with unknown latest per-run duration keeps the total unknown (-1)", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "r3-k", "tab-1", "child-9");
    relationStore.getState().registerChild(PARENT, "r3-l", "tab-2", "child-9");
    rememberLiveChildCard("r3-k", baseCard({ turns: 2, toolCalls: 3, final: { status: "completed", durationMs: 14400 } }));
    // Second call cardless detached, completed only via notification (its
    // own duration unseen): no authoritative cumulative snapshot covers it,
    // so the whole-session duration stays unknown.
    const transcript: TranscriptBlock[] = [
      agentBlock("r3-k", null, { detach: true }),
      agentBlock("r3-l", null, { detach: true }),
      {
        kind: "user_text",
        id: "u1",
        text: "<task-notification>\n  <tool-use-id>r3-l</tool-use-id>\n  <status>completed</status>\n</task-notification>",
      } as TranscriptBlock,
    ];
    const rows = projectChildSplitRows(["r3-k"], deps(relationStore.getState().relations, transcript));
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: -1 });
    // Turns are carried (cumulative 2 + the unseen run's unknown-but-present count is 0 on the fallback):
    expect(rows[0]!.card.turns).toBe(2);
  });

  it("an UNKNOWN cumulative snapshot after a known prefix does not inherit the prefix duration as exact total (defect 4)", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "r4-a", "tab-1", "child-9");
    relationStore.getState().registerChild(PARENT, "r4-b", "tab-2", "child-9");
    relationStore.getState().registerChild(PARENT, "r4-c", "tab-3", "child-9");
    // First run: cumulative 1 turn/6400ms KNOWN. Second run: cumulative
    // 2 turns (contains run 1) but its duration is UNKNOWN (-1) — the
    // snapshot covers MORE history than run 1's 6400ms, so that is not the
    // larger history's total. Third: sync per-run 1 turn/5000ms.
    rememberLiveChildCard("r4-a", baseCard({ turns: 1, toolCalls: 1, final: { status: "completed", durationMs: 6400 } }));
    rememberLiveChildCard("r4-b", baseCard({ turns: 2, toolCalls: 2, final: { status: "completed", durationMs: -1 } }));
    const transcript: TranscriptBlock[] = [
      agentBlock("r4-a", null, { detach: true }),
      agentBlock("r4-b", null, { detach: true }),
      agentBlock("r4-c", baseCard({ turns: 1, toolCalls: 1, final: { status: "completed", durationMs: 5000 } })),
    ];
    const rows = projectChildSplitRows(["r4-a"], deps(relationStore.getState().relations, transcript));
    expect(rows[0]!.badge).toBe("done");
    // turns: cumulative 2 (supersedes 1) + per-run 1 = 3; duration: UNKNOWN —
    // the old bug returned 6400+5000=11400.
    expect(rows[0]!.card.turns).toBe(3);
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: -1 });
  });

  it("latest remembered PARTIAL (final:null) + terminal notification: whole-session duration stays unknown, never the earlier prefix's 6400 (defect 4)", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "r4-d", "tab-1", "child-9");
    relationStore.getState().registerChild(PARENT, "r4-e", "tab-2", "child-9");
    // Run 1: cumulative known 1 turn/6400ms. Run 2: remembered while still
    // RUNNING (final:null, cumulative 2 turns so far), then the host was
    // reaped and only the terminal notification arrived.
    rememberLiveChildCard("r4-d", baseCard({ turns: 1, toolCalls: 1, final: { status: "completed", durationMs: 6400 } }));
    rememberLiveChildCard("r4-e", baseCard({ turns: 2, toolCalls: 3, final: null }));
    const transcript: TranscriptBlock[] = [
      agentBlock("r4-d", null, { detach: true }),
      agentBlock("r4-e", null, { detach: true }),
      {
        kind: "user_text",
        id: "u1",
        text: "<task-notification>\n  <tool-use-id>r4-e</tool-use-id>\n  <status>completed</status>\n</task-notification>",
      } as TranscriptBlock,
    ];
    const rows = projectChildSplitRows(["r4-d"], deps(relationStore.getState().relations, transcript));
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: -1 });
    // Turns/toolCalls preserved from the cumulative partial (2/3), floored by nothing.
    expect(rows[0]!.card.turns).toBe(2);
    expect(rows[0]!.card.toolCalls).toBe(3);
  });

  it("a later AUTHORITATIVE known cumulative total CURES an earlier unknown duration (defect 4, positive case)", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "r4-f", "tab-1", "child-9");
    relationStore.getState().registerChild(PARENT, "r4-g", "tab-2", "child-9");
    // Run 1: per-run card with UNKNOWN duration (-1). Run 2: cumulative
    // snapshot with a KNOWN total (30000ms) — authoritative for everything
    // up to itself, so the earlier unknown is cured.
    const transcript: TranscriptBlock[] = [
      agentBlock("r4-f", baseCard({ turns: 1, toolCalls: 1, final: { status: "completed", durationMs: -1 } }), { detach: true }),
      agentBlock("r4-g", null, { detach: true }),
    ];
    rememberLiveChildCard("r4-g", baseCard({ turns: 3, toolCalls: 5, final: { status: "completed", durationMs: 30000 } }));
    const rows = projectChildSplitRows(["r4-f"], deps(relationStore.getState().relations, transcript));
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: 30000 });
    expect(rows[0]!.card.turns).toBe(3);
    expect(rows[0]!.card.toolCalls).toBe(5);
  });

  it("known cumulative snapshot in the PREFIX cures an earlier unknown; following per-run adds — 35000ms, not -1 (defect 5)", () => {
    const relationStore = createChildRelationStore();
    relationStore.getState().registerChild(PARENT, "r5-a", "tab-1", "child-9");
    relationStore.getState().registerChild(PARENT, "r5-b", "tab-2", "child-9");
    relationStore.getState().registerChild(PARENT, "r5-c", "tab-3", "child-9");
    // Run 1: per-run completed, duration UNKNOWN (-1). Run 2: remembered
    // cumulative snapshot with KNOWN total 30000ms (contains run 1's
    // history). Run 3: sync per-run completed, 1 turn/5000ms.
    const transcript: TranscriptBlock[] = [
      agentBlock("r5-a", baseCard({ turns: 1, toolCalls: 1, final: { status: "completed", durationMs: -1 } }), { detach: true }),
      agentBlock("r5-b", null, { detach: true }),
      agentBlock("r5-c", baseCard({ turns: 1, toolCalls: 2, final: { status: "completed", durationMs: 5000 } })),
    ];
    rememberLiveChildCard("r5-b", baseCard({ turns: 3, toolCalls: 4, final: { status: "completed", durationMs: 30000 } }));
    const rows = projectChildSplitRows(["r5-a"], deps(relationStore.getState().relations, transcript));
    expect(rows[0]!.badge).toBe("done");
    // turns: cumulative 3 (supersedes run 1) + per-run 1 = 4; duration:
    // authoritative 30000 (run 1's unknown cured) + 5000 = 35000. The old
    // OR-forever bug returned -1.
    expect(rows[0]!.card.turns).toBe(4);
    expect(rows[0]!.card.toolCalls).toBe(6);
    expect(rows[0]!.card.final).toEqual({ status: "completed", durationMs: 35000 });
  });
});
