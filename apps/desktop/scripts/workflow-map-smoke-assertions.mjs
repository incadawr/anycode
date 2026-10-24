/**
 * Pure assertion helpers for `workflow-map-smoke.mjs` (Taskana 4161).
 *
 * Every "does the run's shape look right" judgement the live smoke makes on
 * the workflow map/ticks probe bodies (`automation/README.md`'s Taskana-4161
 * routes) lives HERE, dependency-free and data-in/verdict-out, so vitest can
 * pin the logic itself (`src/main/workflow-map-smoke-assertions.test.ts`)
 * even where a live Electron run is impossible (the smoke's own
 * sandbox/headless limitation — see the smoke header's RUN NOTE). The smoke
 * script imports these and only adds I/O: fetch the probe, feed the body in,
 * throw on a red verdict.
 *
 * Contract of each helper: returns an array of problem strings — EMPTY means
 * green. Never throws; a caller that prefers exceptions wraps. Deliberately
 * mirrors how the facade's own unit tests speak (expect.toEqual on shapes)
 * without dragging vitest into the runtime script.
 */

/**
 * The `substatus-*` kinds a tick/node may legally carry at the moments this
 * smoke samples (workflowStepKind's full vocabulary — a live run can be
 * observed at ANY point, so every kind is legal SOMEWHERE in the run; which
 * mix is expected depends on WHEN the sample is taken, which is the caller's
 * `expectMixed` argument's job, not this list's).
 */
export const KNOWN_STEP_KINDS = new Set([
  "running",
  "queued",
  "pending",
  "completed",
  "max_turns",
  "cancelled",
  "error",
  "skipped",
]);

/** Kinds that mean a step reached a terminal state (`workflowStepKind`'s terminal wire statuses). */
export const TERMINAL_STEP_KINDS = new Set(["completed", "max_turns", "cancelled", "error", "skipped"]);

/**
 * Step 3's mid-run reading of `GET …/workflow-ticks`: the strip must be
 * PRESENT with a non-empty label, one kind per step, every kind in the known
 * vocabulary, and — the whole point of the tick strip — a MIXED bag: at least
 * one kind that has settled and one that has not. The workflow definition the
 * smoke plants is a 3-step diamond (2 parallel sources -> 1 sink), and the
 * sample is taken after the FIRST step_end lands but before workflow_end, so
 * the honest reading is some settled + some not; an all-terminal reading
 * there means the sample raced past the run (caller-side bug, not a product
 * one), and an all-unsettled reading means the wait-for-first-terminal poll
 * never actually waited.
 */
export function checkTicksMidRun(ticks, { stepCount, expectMixed = true }) {
  const problems = [];
  if (ticks?.ok !== true) {
    return [`ticks body is not ok:true: ${JSON.stringify(ticks)}`];
  }
  if (ticks.present !== true) {
    problems.push(`expected present:true (card collapsed, run has steps), got ${JSON.stringify(ticks)}`);
    return problems;
  }
  if (typeof ticks.label !== "string" || ticks.label.trim() === "") {
    problems.push(`expected a non-empty aria-label aggregate, got ${JSON.stringify(ticks.label)}`);
  }
  if (!Array.isArray(ticks.kinds)) {
    problems.push(`expected kinds to be an array, got ${JSON.stringify(ticks.kinds)}`);
    return problems;
  }
  if (stepCount !== undefined && ticks.kinds.length !== stepCount) {
    problems.push(`expected exactly ${stepCount} ticks (one per step), got ${ticks.kinds.length}: ${JSON.stringify(ticks.kinds)}`);
  }
  const unknown = ticks.kinds.filter((kind) => !KNOWN_STEP_KINDS.has(kind));
  if (unknown.length > 0) {
    problems.push(`unknown substatus kinds on ticks: ${JSON.stringify(unknown)}`);
  }
  if (expectMixed) {
    const settled = ticks.kinds.filter((kind) => TERMINAL_STEP_KINDS.has(kind)).length;
    const unsettled = ticks.kinds.length - settled;
    if (settled === 0 || unsettled === 0) {
      problems.push(
        `expected a MIXED tick strip mid-run (>=1 settled and >=1 not), got settled=${settled}, unsettled=${unsettled}: ${JSON.stringify(ticks.kinds)}`,
      );
    }
  }
  return problems;
}

/**
 * Step 4's reading of `GET …/workflow-map` on the expanded card mid-run: the
 * toggle must be present (a 3-step run has a shape — `mapWorthOffering`) and
 * open (the map defaults open), every step of the definition must have
 * exactly one node carrying its id, every node kind must be in the known
 * vocabulary, and every declared `from`→`to` dependency must have exactly
 * one edge. `dependencies` is the smoke's OWN definition (what it planted in
 * the workspace), so this doubles as an end-to-end check that the graph the
 * card renders is the graph that was declared — the map's `data-from`/
 * `data-to`/`data-step-id` hooks read straight off the DOM, never re-derived.
 */
export function checkMapMidRun(map, { stepIds, dependencies }) {
  const problems = [];
  if (map?.ok !== true) {
    return [`map body is not ok:true: ${JSON.stringify(map)}`];
  }
  if (map.togglePresent !== true) {
    problems.push(`expected togglePresent:true (multi-step run has a shape), got ${JSON.stringify(map)}`);
    return problems;
  }
  if (map.open !== true) {
    problems.push(`expected open:true (map defaults open), got open=${JSON.stringify(map.open)}`);
  }
  if (!Array.isArray(map.nodes) || !Array.isArray(map.edges)) {
    problems.push(`expected nodes/edges arrays, got ${JSON.stringify(map)}`);
    return problems;
  }
  for (const stepId of stepIds) {
    const matches = map.nodes.filter((node) => node.stepId === stepId);
    if (matches.length !== 1) {
      problems.push(`expected exactly one map node for step "${stepId}", got ${matches.length}`);
    }
  }
  const unknownNodes = map.nodes.filter((node) => !KNOWN_STEP_KINDS.has(node.kind));
  if (unknownNodes.length > 0) {
    problems.push(`unknown substatus kinds on map nodes: ${JSON.stringify(unknownNodes)}`);
  }
  for (const node of map.nodes) {
    if (typeof node.selected !== "boolean") {
      problems.push(`node "${node.stepId}" carries a non-boolean selected: ${JSON.stringify(node)}`);
    }
  }
  // One edge per declared dependency, exactly once each direction.
  const expectedPairs = dependencies.map((dep) => `${dep.from}->${dep.to}`);
  const actualPairs = map.edges.map((edge) => `${edge.from}->${edge.to}`);
  for (const pair of expectedPairs) {
    const count = actualPairs.filter((p) => p === pair).length;
    if (count !== 1) {
      problems.push(`expected exactly one edge ${pair}, found ${count} (edges=${JSON.stringify(actualPairs)})`);
    }
  }
  const surplus = actualPairs.filter((pair) => !expectedPairs.includes(pair));
  if (surplus.length > 0) {
    problems.push(`map carries edges no dependency declares: ${JSON.stringify(surplus)}`);
  }
  return problems;
}

/**
 * Step 6's terminal reading of the map: every node must carry a terminal
 * `substatus-*` kind. The smoke's definition uses `general-purpose` steps
 * that only read files, so on an honest green run every kind is "completed"
 * — but the assertion the task's DoD names is "every node reached a
 * TERMINAL state", not "every step completed": a live-model hiccup on one
 * step legitimately paints error/skipped and the run's own outcome is
 * asserted separately off the transcript. Terminal here therefore means the
 * five wire terminals, same set `TERMINAL_STEP_KINDS` holds.
 */
export function checkMapTerminal(map) {
  const problems = [];
  if (map?.ok !== true) {
    return [`map body is not ok:true: ${JSON.stringify(map)}`];
  }
  if (!Array.isArray(map.nodes) || map.nodes.length === 0) {
    problems.push(`expected a non-empty nodes array, got ${JSON.stringify(map)}`);
    return problems;
  }
  const nonTerminal = map.nodes.filter((node) => !TERMINAL_STEP_KINDS.has(node.kind));
  if (nonTerminal.length > 0) {
    problems.push(`non-terminal map nodes after workflow_end: ${JSON.stringify(nonTerminal)}`);
  }
  return problems;
}

/**
 * The PASS/FAIL table row list the smoke prints at the end: one row per
 * step id with its recorded verdict. `rows` is the smoke's own ledger
 * (pushed as steps settle); this helper only formats it so the script and
 * its unit test agree on the shape.
 */
export function formatVerdictTable(rows) {
  const header = "step | verdict | detail";
  const lines = rows.map((row) => `${String(row.step).padEnd(4)} | ${row.verdict.padEnd(6)} | ${row.detail ?? ""}`.trimEnd());
  const failed = rows.filter((row) => row.verdict === "FAIL").length;
  const skipped = rows.filter((row) => row.verdict === "SKIP").length;
  const summary = `${rows.length - failed} of ${rows.length} steps green${skipped > 0 ? ` (${skipped} documented SKIP)` : ""}`;
  return { header, lines, summary, failed, skipped, exitCode: failed > 0 ? 1 : 0 };
}
