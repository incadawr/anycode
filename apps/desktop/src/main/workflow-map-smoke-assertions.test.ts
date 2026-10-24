import { describe, expect, it } from "vitest";
// @ts-expect-error node harness helper is deliberately JavaScript
import { checkMapMidRun, checkMapTerminal, checkTicksMidRun, formatVerdictTable, KNOWN_STEP_KINDS, TERMINAL_STEP_KINDS } from "../../scripts/workflow-map-smoke-assertions.mjs";

/**
 * Unit coverage for `workflow-map-smoke.mjs`'s assertion helpers (Taskana
 * 4161) — the shapes mirror the workflowMapState/workflowTicksState facade
 * ok-shapes exactly (`renderer/src/automation.ts`, pinned by
 * automation.test.ts), so this test pins the LIVE smoke's own judgement
 * logic: which readings are green, which are red, and which words each
 * failure carries (a smoke's failure output is its UI — a vague problem
 * string is a debugging tax on every future red run).
 */

const STEP_IDS = ["gather-berries", "gather-nuts", "report"];
const DEPENDENCIES = [
  { from: "gather-berries", to: "report" },
  { from: "gather-nuts", to: "report" },
];

function mapBody(overrides = {}) {
  return {
    ok: true,
    togglePresent: true,
    open: true,
    nodes: [
      { stepId: "gather-berries", kind: "completed", selected: false },
      { stepId: "gather-nuts", kind: "running", selected: false },
      { stepId: "report", kind: "pending", selected: false },
    ],
    edges: DEPENDENCIES,
    ...overrides,
  };
}

describe("workflow-map-smoke assertions — checkTicksMidRun", () => {
  it("accepts a present mixed strip with the right tick count and a non-empty label", () => {
    const ticks = { ok: true, present: true, label: "smoke-map-flow: 1 of 3 steps done", kinds: ["completed", "running", "pending"] };
    expect(checkTicksMidRun(ticks, { stepCount: 3 })).toEqual([]);
  });

  it("flags a strip that is entirely unsettled (the mixed-window poll never waited)", () => {
    const ticks = { ok: true, present: true, label: "smoke-map-flow: 0 of 3 steps done", kinds: ["running", "pending", "queued"] };
    const problems = checkTicksMidRun(ticks, { stepCount: 3 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("MIXED");
    expect(problems[0]).toContain("settled=0");
  });

  it("flags a strip that is entirely settled when a mix was required", () => {
    const ticks = { ok: true, present: true, label: "smoke-map-flow: 3 of 3 steps done", kinds: ["completed", "completed", "completed"] };
    expect(checkTicksMidRun(ticks, { stepCount: 3 })).toHaveLength(1);
  });

  it("waives the mixed check on request (fast green run settled before a poll caught the window)", () => {
    const ticks = { ok: true, present: true, label: "smoke-map-flow: 3 of 3 steps done", kinds: ["completed", "completed", "completed"] };
    expect(checkTicksMidRun(ticks, { stepCount: 3, expectMixed: false })).toEqual([]);
  });

  it("flags a missing strip (present:false — card expanded or run without steps)", () => {
    const problems = checkTicksMidRun({ ok: true, present: false, label: "", kinds: [] }, { stepCount: 3 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("present:true");
  });

  it("flags a wrong tick count and unknown kinds", () => {
    const ticks = { ok: true, present: true, label: "x: 1 of 2 steps done", kinds: ["completed", "running"] };
    const countProblems = checkTicksMidRun(ticks, { stepCount: 3, expectMixed: false });
    expect(countProblems).toHaveLength(1);
    expect(countProblems[0]).toContain("expected exactly 3 ticks");

    const unknownProblems = checkTicksMidRun(
      { ok: true, present: true, label: "x", kinds: ["completed", "banana", "pending"] },
      { stepCount: 3, expectMixed: false },
    );
    expect(unknownProblems).toHaveLength(1);
    expect(unknownProblems[0]).toContain("banana");
  });

  it("flags a blank label and a non-ok body", () => {
    expect(checkTicksMidRun({ ok: true, present: true, label: "   ", kinds: ["completed", "running"] }, { stepCount: 2, expectMixed: false })).toHaveLength(1);
    expect(checkTicksMidRun({ ok: false, reason: "tab_not_active" }, { stepCount: 2 })).toEqual([
      expect.stringContaining("not ok:true"),
    ]);
  });
});

describe("workflow-map-smoke assertions — checkMapMidRun", () => {
  it("accepts a map that carries every step id once and every declared dependency edge once", () => {
    expect(checkMapMidRun(mapBody(), { stepIds: STEP_IDS, dependencies: DEPENDENCIES })).toEqual([]);
  });

  it("flags a missing toggle (single-step run shape) and a closed map", () => {
    expect(checkMapMidRun(mapBody({ togglePresent: false, open: false, nodes: [], edges: [] }), { stepIds: STEP_IDS, dependencies: DEPENDENCIES })).toEqual([
      expect.stringContaining("togglePresent:true"),
    ]);
    expect(checkMapMidRun(mapBody({ open: false }), { stepIds: STEP_IDS, dependencies: DEPENDENCIES })).toEqual([
      expect.stringContaining("open:true"),
    ]);
  });

  it("flags a duplicated and a missing step node", () => {
    const duplicated = mapBody({
      nodes: [
        { stepId: "gather-berries", kind: "completed", selected: false },
        { stepId: "gather-berries", kind: "completed", selected: false },
        { stepId: "gather-nuts", kind: "running", selected: false },
        { stepId: "report", kind: "pending", selected: false },
      ],
    });
    const dupProblems = checkMapMidRun(duplicated, { stepIds: STEP_IDS, dependencies: DEPENDENCIES });
    expect(dupProblems).toHaveLength(1);
    expect(dupProblems[0]).toContain('exactly one map node for step "gather-berries"');

    const missing = mapBody({ nodes: [{ stepId: "gather-nuts", kind: "running", selected: false }] });
    const missingProblems = checkMapMidRun(missing, { stepIds: STEP_IDS, dependencies: DEPENDENCIES });
    expect(missingProblems.filter((p: string) => p.includes("exactly one map node"))).toHaveLength(2);
  });

  it("flags a missing edge, a duplicated edge, and a surplus edge no dependency declares", () => {
    const missingEdge = mapBody({ edges: [{ from: "gather-berries", to: "report" }] });
    expect(checkMapMidRun(missingEdge, { stepIds: STEP_IDS, dependencies: DEPENDENCIES })).toEqual([
      expect.stringContaining('exactly one edge gather-nuts->report'),
    ]);

    const duplicatedEdge = mapBody({ edges: [...DEPENDENCIES, { from: "gather-nuts", to: "report" }] });
    expect(checkMapMidRun(duplicatedEdge, { stepIds: STEP_IDS, dependencies: DEPENDENCIES })).toEqual([
      expect.stringContaining("found 2"),
    ]);

    const surplusEdge = mapBody({ edges: [...DEPENDENCIES, { from: "gather-berries", to: "gather-nuts" }] });
    const surplusProblems = checkMapMidRun(surplusEdge, { stepIds: STEP_IDS, dependencies: DEPENDENCIES });
    expect(surplusProblems).toHaveLength(1);
    expect(surplusProblems[0]).toContain("edges no dependency declares");
    expect(surplusProblems[0]).toContain("gather-berries->gather-nuts");
  });

  it("flags unknown node kinds and non-boolean selected", () => {
    const bad = mapBody({
      nodes: [
        { stepId: "gather-berries", kind: "banana", selected: false },
        { stepId: "gather-nuts", kind: "running", selected: "yes" },
        { stepId: "report", kind: "pending", selected: false },
      ],
    });
    const problems = checkMapMidRun(bad, { stepIds: STEP_IDS, dependencies: DEPENDENCIES });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("banana");
    expect(problems[1]).toContain("non-boolean selected");
  });

  it("flags a non-ok body without touching the rest of the shape", () => {
    expect(checkMapMidRun({ ok: false, reason: "tab_not_active" }, { stepIds: STEP_IDS, dependencies: DEPENDENCIES })).toEqual([
      expect.stringContaining("not ok:true"),
    ]);
  });
});

describe("workflow-map-smoke assertions — checkMapTerminal", () => {
  it("accepts an all-terminal map (the green run)", () => {
    const map = mapBody({
      nodes: [
        { stepId: "gather-berries", kind: "completed", selected: false },
        { stepId: "gather-nuts", kind: "completed", selected: false },
        { stepId: "report", kind: "completed", selected: false },
      ],
    });
    expect(checkMapTerminal(map)).toEqual([]);
  });

  it("accepts every terminal kind — a live-model hiccup painting error/skipped is still a TERMINAL state", () => {
    const map = mapBody({
      nodes: [
        { stepId: "gather-berries", kind: "completed", selected: false },
        { stepId: "gather-nuts", kind: "error", selected: false },
        { stepId: "report", kind: "skipped", selected: false },
      ],
    });
    expect(checkMapTerminal(map)).toEqual([]);
  });

  it("flags any non-terminal node after workflow_end", () => {
    const map = mapBody({
      nodes: [
        { stepId: "gather-berries", kind: "completed", selected: false },
        { stepId: "gather-nuts", kind: "running", selected: false },
        { stepId: "report", kind: "pending", selected: false },
      ],
    });
    const problems = checkMapTerminal(map);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("non-terminal map nodes");
    expect(problems[0]).toContain("gather-nuts");
  });

  it("flags an empty nodes array and a non-ok body", () => {
    expect(checkMapTerminal({ ok: true, togglePresent: false, open: false, nodes: [], edges: [] })).toEqual([
      expect.stringContaining("non-empty nodes array"),
    ]);
    expect(checkMapTerminal({ ok: false, reason: "unknown_tab" })).toEqual([expect.stringContaining("not ok:true")]);
  });
});

describe("workflow-map-smoke assertions — kind vocabularies", () => {
  it("carries workflowStepKind's full vocabulary, terminal wire statuses included", () => {
    expect([...KNOWN_STEP_KINDS].sort()).toEqual(
      ["cancelled", "completed", "error", "max_turns", "pending", "queued", "running", "skipped"].sort(),
    );
    expect([...TERMINAL_STEP_KINDS].sort()).toEqual(["cancelled", "completed", "error", "max_turns", "skipped"].sort());
  });
});

describe("workflow-map-smoke assertions — formatVerdictTable", () => {
  it("renders one row per step, counts FAIL/SKIP, and derives the exit code", () => {
    const table = formatVerdictTable([
      { step: 1, verdict: "PASS", detail: "launched" },
      { step: 2, verdict: "PASS", detail: "dispatched" },
      { step: 3, verdict: "SKIP", detail: "documented SKIP" },
      { step: 4, verdict: "FAIL", detail: "map missing" },
    ]);
    expect(table.lines).toHaveLength(4);
    expect(table.lines[0]).toContain("1");
    expect(table.lines[0]).toContain("PASS");
    expect(table.lines[0]).toContain("launched");
    expect(table.failed).toBe(1);
    expect(table.skipped).toBe(1);
    expect(table.exitCode).toBe(1);
    expect(table.summary).toBe("3 of 4 steps green (1 documented SKIP)");
  });

  it("exit code 0 on an all-green ledger with no SKIP footnote", () => {
    const table = formatVerdictTable([{ step: 1, verdict: "PASS", detail: "ok" }]);
    expect(table.exitCode).toBe(0);
    expect(table.summary).toBe("1 of 1 steps green");
  });
});
