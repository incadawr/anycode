/**
 * Tool-call transcript card (design §5). Renders the proposed -> running ->
 * terminal-outcome status chain and a human-readable summary of the tool
 * input. Write/Edit get a mount-point for the real diff view, which is
 * MVP.5's job (jsdiff + Shiki) — this component only reserves the slot so
 * the eventual integration (MVP.6) doesn't need to restructure the card.
 *
 * Task 3.1.4 (design/phase-3.md §3.3/§4.2) adds the Agent tool's sub-status
 * region (`SubagentStatus` below): a spinner + live turn/tool-call counters
 * while the child subagent loop runs, swapping to a settled label once
 * `subagent_end` lands. The spinner glyph is the shared `Spinner` icon
 * (icons.tsx) paired with the shared `.icon-spin` rotation utility
 * (app.css, R2 motion foundation) — no component-scoped styling.
 *
 * Task 3.4.5 (design/slice-3.4-cut.md §2.3/§6) adds the Workflow tool's
 * mirror region (`WorkflowStatus` below): a spinner + "step i/N · <id> ·
 * turn/tool-call counters" line for the currently-running step while the DAG
 * run progresses, swapping to a settled "<status> · completed/total steps ·
 * duration" label once `workflow_end` lands. Grafted onto this card's ledger
 * structure and re-skinned to share `SubagentStatus`'s Spinner-icon posture
 * (the shared `.icon-spin` utility, not a component-scoped keyframe).
 *
 * Slice R4 (ui-roadmap §4-R4): settled non-failure cards auto-collapse to a
 * one-line ledger row (caret · name · flattened input summary · badge) and
 * expand on click/Enter; results are capped at RESULT_VISIBLE_LINES with a
 * "Show N more lines" expander. Disclosure state is "default unless
 * user-overrode": the default is DERIVED from status every render (so an
 * untouched card follows running -> settled automatically, with no effect),
 * while a manual toggle sticks for the card's mount lifetime. No duration is
 * shown anywhere: ToolCallBlock carries no per-call timestamps (core-track
 * note) — the only real duration in this card is subagent.final.durationMs,
 * already rendered by formatSubagentCounters when expanded.
 */
import { useContext, useEffect, useId, useRef, useState } from "react";
import type { TokenUsage } from "@anycode/core";
import type { SubagentSubStatus, ToolCallBlock, WorkflowStepStatus, WorkflowSubStatus } from "../store.js";
import { TabContext } from "../tab-context.js";
import { isPreviewableDocPath } from "../../../shared/previewable.js";
import { useTabsStore } from "../tabs-store.js";
import { childBadgeKind, childLayoutStore, type ChildBadgeKind } from "../child-layout.js";
import { childRelationStore, hasOpenableChild } from "../child-sessions.js";
import { DiffView } from "./DiffView.js";
import { Check, Chevron, Minus, Spinner, Warning, X } from "./icons.js";
import { Markdown } from "./Markdown.js";

const STATUS_LABELS: Record<ToolCallBlock["status"], string> = {
  proposed: "Proposed",
  running: "Running",
  success: "Success",
  error: "Error",
  invalid_input: "Invalid input",
  denied: "Denied",
  timed_out: "Timed out",
  max_turns: "Max turns reached",
  cancelled: "Cancelled",
};

const SUBAGENT_FINAL_LABELS: Record<NonNullable<SubagentSubStatus["final"]>["status"], string> = {
  completed: "Completed",
  max_turns: "Max turns reached",
  cancelled: "Cancelled",
  error: "Error",
};

/**
 * TASK.102 CUT-S2 §2.5 (slice S2c C3): the session-tier child badge's label,
 * one per `childBadgeKind` outcome. `waiting_permission` is the badge's whole
 * reason to exist — `block.status` (the outer Agent tool_call's own status,
 * STATUS_LABELS above) stays "Running" the entire time a child session is
 * blocked on its own permission ask, so nothing else on this card can show
 * that state.
 */
const CHILD_BADGE_LABELS: Record<ChildBadgeKind, string> = {
  waiting_permission: "Waiting for permission",
  running: "Running",
  error: "Error",
  done: "Done",
};

/**
 * TASK.120: whether the session-child badge is an ACTION (a real `<button>`
 * firing `onOpen`, the same handler the Open button uses) rather than a
 * static status chip. Only `waiting_permission` is actionable — the other
 * three kinds are outcomes, and their card already carries the Open button.
 * The affordance exists ONLY together with an `onOpen` handler: with
 * `onOpen === undefined` the badge renders exactly as before this task (no
 * cursor, no hover state, no button in the markup), whatever its kind.
 * Exported for direct unit testing (same pure-logic-only rationale as
 * `formatSubagentCounters` above).
 */
export function isClickableChildBadge(badge: ChildBadgeKind, onOpen: (() => void) | undefined): boolean {
  return badge === "waiting_permission" && onOpen !== undefined;
}

/** Badge title when it acts as the TASK.120 open-on-request action; states the
 *  effect of the click, since the visible label itself carries only state. */
const CHILD_BADGE_ACTION_TITLE = "Open the subagent session on its permission request";

/**
 * The session-child badge's single render site for both mounts (the
 * always-visible header row and `SubagentStatus`'s expanded child row):
 * `isClickableChildBadge` decides the element. Non-actionable states render
 * the plain `<span>` byte-identical to pre-TASK.120 markup; the actionable
 * state renders a real `<button>` on the same `onOpen` the Open button uses.
 * The `-action` modifier class carries ONLY the interactive affordances
 * (cursor, hover) so the static form keeps none of them.
 */
function ChildBadge({ badge, onOpen }: { badge: ChildBadgeKind; onOpen?: () => void }) {
  if (!isClickableChildBadge(badge, onOpen)) {
    return <span className={`tool-call-child-badge tool-call-child-badge-${badge}`}>{CHILD_BADGE_LABELS[badge]}</span>;
  }
  return (
    <button
      type="button"
      className={`tool-call-child-badge tool-call-child-badge-${badge} tool-call-child-badge-action`}
      title={CHILD_BADGE_ACTION_TITLE}
      onClick={onOpen}
    >
      {CHILD_BADGE_LABELS[badge]}
    </button>
  );
}

/**
 * Pure formatter for the sub-status counter line, exported for direct unit
 * testing (this package's renderer tests are pure-logic only — no jsdom, see
 * ToolCallCard.test.ts).
 *
 * Engine-aware (TASK.97 R5, wave2-cut §1.4): `subagent.engine` is null for
 * an in-process child AND for a legacy transcript replayed from before
 * `subagent_start` carried the field — both render exactly as before this
 * slice (byte-identical, no prefix, turns segment always present). While
 * running, a named engine gets an `"<engine> · "` prefix and — because Codex
 * reports no model-round marker (engine-children.ts header note) — its
 * `turn N · ` segment is OMITTED rather than shown as a fabricated count.
 * Once settled there is no engine prefix at all (only the `N turn(s) · `
 * segment is omitted for codex); Claude's settled line is therefore
 * byte-identical to the legacy/in-process one too.
 *
 * While running (`final === null`): `[<engine> · ]turn N · M tool
 * call(s)[ · lastTool]`, turn segment omitted for codex. Once settled:
 * `<label> · [N turn(s) · ]D.Ds`, turn segment omitted for codex.
 */
export function formatSubagentCounters(subagent: SubagentSubStatus): string {
  const prefix = subagent.engine ? `${subagent.engine} · ` : "";
  if (subagent.final === null) {
    const toolCalls = `${subagent.toolCalls} tool call${subagent.toolCalls === 1 ? "" : "s"}`;
    const lastTool = subagent.lastTool ? ` · ${subagent.lastTool}` : "";
    const turnSegment = subagent.engine === "codex" ? "" : `turn ${subagent.turns} · `;
    return `${prefix}${turnSegment}${toolCalls}${lastTool}`;
  }
  const seconds = (subagent.final.durationMs / 1000).toFixed(1);
  const label = SUBAGENT_FINAL_LABELS[subagent.final.status];
  if (subagent.engine === "codex") {
    return `${label} · ${seconds}s`;
  }
  const turns = `${subagent.turns} turn${subagent.turns === 1 ? "" : "s"}`;
  return `${label} · ${turns} · ${seconds}s`;
}

const WORKFLOW_FINAL_LABELS: Record<NonNullable<WorkflowSubStatus["final"]>["status"], string> = {
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Pure formatter for the workflow sub-status counter line, exported for
 * direct unit testing (mirror of `formatSubagentCounters`). While running
 * (`final === null`): "step i/N · <id> · turn T · M tool call(s)[ · lastTool]"
 * for the most-recently-started step still ACTUALLY RUNNING, or just
 * "step i/N" if every started step has already settled (between DAG waves)
 * or is merely queued behind the shared semaphore. Once settled:
 * "<label> · completed/total steps · D.Ds".
 *
 * TASK.191 slice S3: `steps` is now prefilled with every step of the run
 * (pending ones included) rather than only the ones that have started, so
 * `steps.length` can no longer stand in for "how many have started" — `i`
 * counts the `started` flag instead, and the in-flight lookup additionally
 * requires `running` (a queued step also has `final === null` now, but it
 * is not the one to report as "in flight").
 */
export function formatWorkflowCounters(workflow: WorkflowSubStatus): string {
  if (workflow.final === null) {
    const stepsStarted = workflow.steps.filter((step) => step.started).length;
    const running = [...workflow.steps].reverse().find((step) => step.running && step.final === null);
    if (!running) {
      return `step ${stepsStarted}/${workflow.totalSteps}`;
    }
    const toolCalls = `${running.toolCalls} tool call${running.toolCalls === 1 ? "" : "s"}`;
    const lastTool = running.lastTool ? ` · ${running.lastTool}` : "";
    return `step ${stepsStarted}/${workflow.totalSteps} · ${running.stepId} · turn ${running.turns} · ${toolCalls}${lastTool}`;
  }
  const seconds = (workflow.final.durationMs / 1000).toFixed(1);
  return `${WORKFLOW_FINAL_LABELS[workflow.final.status]} · ${workflow.final.completedSteps}/${workflow.totalSteps} steps · ${seconds}s`;
}

/**
 * Union of every sub-status outcome across subagent/step/run vocabularies,
 * plus synthetic "running". `queued`/`pending` (TASK.191 slice S3) exist ONLY
 * for a workflow STEP row (`workflowStepKind`) — a run's own status and a
 * subagent's never produce them, since `substatusKind` below can only ever
 * return one of the wire's settled statuses or "running".
 */
export type SubStatusKind =
  | "running"
  | "queued"
  | "pending"
  | "completed"
  | "max_turns"
  | "cancelled"
  | "error"
  | "skipped"
  | "failed";

/** null → "running"; otherwise the wire status verbatim. Drives both the glyph
 *  and the `substatus-*` class. Accepts any of the three vocabularies' `final`
 *  (all subsets of the union above). */
export function substatusKind(final: { status: Exclude<SubStatusKind, "running"> } | null): SubStatusKind {
  return final === null ? "running" : final.status;
}

/**
 * Phase for one workflow step row (TASK.191 slice S3): "pending" before its
 * `workflow_step_start` lands (blocked on `dependsOn`, or launches are frozen
 * by fail-fast/cancellation and it will never start), "queued" once
 * `step_start` lands but `step_running` hasn't (parked behind the shared
 * subagent semaphore — engine.ts's launchStep emits step_start BEFORE ever
 * calling subagents.run, so a step can sit here for real wall-clock time,
 * §B7), "running" once `step_running` lands, else the terminal wire status. A
 * terminal `final` always wins even over a stale `running`/`started` flag.
 */
export function workflowStepKind(step: WorkflowStepStatus): SubStatusKind {
  if (step.final !== null) return step.final.status;
  if (step.running) return "running";
  if (step.started) return "queued";
  return "pending";
}

/** Header line 2. final !== null → formatWorkflowCounters(workflow) (delegation
 *  keeps the frozen export rendered); else `step ${started}/${totalSteps}` —
 *  the bare aggregate, so the header never duplicates the per-step ticker
 *  rendered in the row directly below it. TASK.191 slice S3: `started` counts
 *  the `started` flag, not `steps.length` — prefilled pending steps must not
 *  inflate this count (see formatWorkflowCounters's own note). */
export function workflowRunLabel(workflow: WorkflowSubStatus): string {
  if (workflow.final !== null) {
    return formatWorkflowCounters(workflow);
  }
  const started = workflow.steps.filter((step) => step.started).length;
  return `step ${started}/${workflow.totalSteps}`;
}

/** Settled worded outcomes for step rows — reuses the subagent wording so the
 *  app speaks one status vocabulary. completed (duration only) and skipped
 *  (word only, no duration) are handled inline, so only these three live here. */
const WORKFLOW_STEP_FINAL_LABELS: Record<"error" | "max_turns" | "cancelled", string> = {
  error: "Error",
  max_turns: "Max turns reached",
  cancelled: "Cancelled",
};

/** Step row right zone. Running: live ticker, same grammar as
 *  formatSubagentCounters' running branch (pluralized tool calls, lastTool
 *  suffix omitted when null — re-implemented inline, frozen body untouched).
 *  Settled: completed → duration only; error/max_turns/cancelled → "<label> ·
 *  D.Ds"; skipped → "Skipped" (durationMs of a skipped step is scheduling
 *  noise — omitted). TASK.191 slice S3: a `final === null` step is no longer
 *  necessarily running — "Not started"/"Queued" cover the two phases the
 *  prefilled graph can now sit in before it ever reaches the ticker. */
export function workflowStepMeta(step: WorkflowStepStatus): string {
  if (step.final === null) {
    if (!step.started) {
      return "Not started";
    }
    if (!step.running) {
      return "Queued";
    }
    const toolCalls = `${step.toolCalls} tool call${step.toolCalls === 1 ? "" : "s"}`;
    const lastTool = step.lastTool ? ` · ${step.lastTool}` : "";
    return `turn ${step.turns} · ${toolCalls}${lastTool}`;
  }
  if (step.final.status === "skipped") {
    return "Skipped";
  }
  const seconds = (step.final.durationMs / 1000).toFixed(1);
  if (step.final.status === "completed") {
    return `${seconds}s`;
  }
  return `${WORKFLOW_STEP_FINAL_LABELS[step.final.status]} · ${seconds}s`;
}

/** Full row sentence for the li's aria-label (the glyph is the only visual
 *  status carrier on completed/running rows — AT must not lose it). Running
 *  and completed inject the status word; every other case (settled
 *  error/max_turns/cancelled/skipped, TASK.191 slice S3's not-started/queued)
 *  relies on `workflowStepMeta` already leading with the label. */
export function workflowStepAria(step: WorkflowStepStatus): string {
  const meta = workflowStepMeta(step);
  if (step.final === null && step.running) {
    return `${step.stepId} · ${step.agentType} · Running · ${meta}`;
  }
  if (step.final?.status === "completed") {
    return `${step.stepId} · ${step.agentType} · Completed · ${meta}`;
  }
  return `${step.stepId} · ${step.agentType} · ${meta}`;
}

/**
 * Orders workflow steps for display by dependency level rather than the raw
 * array order the store holds (TASK.191 slice S3). `WorkflowStepStatus`'s own
 * doc comment carries the warning this fixes: post-prefill the array is
 * `workflow_start`'s DEFINITION order, and a definition is free to declare a
 * step before the steps it depends on — schema.ts's structural pass rejects
 * cycles and unknown refs, never declaration order — so trusting raw array
 * order can put a dependent above its own dependency. A step becomes
 * eligible once every id in its `dependsOn` has already been placed; ties
 * keep their relative array order. A `dependsOn` id absent from `steps` is
 * unreachable past schema.ts validation on any real definition — treated as
 * already-satisfied so a malformed fixture degrades to array order instead
 * of hanging.
 *
 * A flat REORDERED list: dependency order without connector lines. The
 * connector graph the plan calls for on expand is NOT this function's job —
 * it is `layoutWorkflowMap`/`WorkflowMap` below (slice S6), which renders
 * beside this list rather than replacing it, because the two carry different
 * facts: this list carries ORDER, the map carries DEPENDENCY.
 *
 * [CORRECTED] An earlier revision of this comment claimed the plan left
 * "strip vs. graph" to the builder. It did not: `task191/PLAN.md` §S3 states
 * "раскрытие — граф по уровням зависимостей" as a requirement and leaves open
 * only WHICH OF THE TWO IS THE DEFAULT. Slice S6 is therefore the repair of an
 * under-delivered S3, not an extra. (Slice S4 turned each row into a real
 * `<button>` that filters the activity lane below — see `WorkflowStepsBody`;
 * R14's "ledger lines, not a control surface" applies to the visual layout
 * only, not to clickability.)
 */
export function orderStepsByDependency(steps: readonly WorkflowStepStatus[]): WorkflowStepStatus[] {
  const known = new Set(steps.map((step) => step.stepId));
  const placed = new Set<string>();
  const remaining = [...steps];
  const ordered: WorkflowStepStatus[] = [];
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((step) =>
      step.dependsOn.every((dep) => placed.has(dep) || !known.has(dep)),
    );
    const index = readyIndex === -1 ? 0 : readyIndex;
    const [step] = remaining.splice(index, 1) as [WorkflowStepStatus];
    ordered.push(step);
    placed.add(step.stepId);
  }
  return ordered;
}

/* ── Run map (TASK.191 slice S6) ──────────────────────────────────────────
 * Owner 30.08, asked twice: "а где красивый граф?". The flat reordered list
 * above stays — it is the record — and the map is a second VIEW of the same
 * steps and the same selection, opened on demand.
 *
 * Geometry is pure and measurement-free: a node's column is its dependency
 * LEVEL and its row is its position within that column, so the SVG needs no
 * refs, no ResizeObserver and no layout effect. That is not a stylistic
 * preference — a rehydrated card renders from persisted data into a DOM that
 * has never been measured, and a layout that depended on measurement would
 * differ between the live and the restored view of the same run.
 */

const MAP_NODE_W = 132;
const MAP_NODE_H = 28;
const MAP_COL_GAP = 46;
const MAP_ROW_GAP = 10;
const MAP_PAD = 10;

export interface WorkflowMapNode {
  stepId: string;
  kind: SubStatusKind;
  x: number;
  y: number;
}

export interface WorkflowMapEdge {
  from: string;
  to: string;
  /** SVG cubic path, dependency's right edge -> dependent's left edge. */
  path: string;
}

export interface WorkflowMapLayout {
  nodes: readonly WorkflowMapNode[];
  edges: readonly WorkflowMapEdge[];
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
}

/** Halves round to 1dp so a layout assertion pins a number, not a float tail. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Column index per step: 0 with no known dependency, else 1 + the deepest
 * known dependency. Same eligibility rule `orderStepsByDependency` walks, read
 * as a column instead of a sort key — steps that may run at the same time
 * share a column, which is exactly the fact the flat list cannot show.
 *
 * Resolved by bounded relaxation rather than recursion: schema.ts rejects
 * cycles, but a malformed fixture must still TERMINATE rather than blow the
 * stack, so the pass count is capped by the step count. A `dependsOn` id
 * absent from `steps` is treated as already-satisfied (same degradation as the
 * ordering function). Anything still unresolved after the cap — reachable only
 * past a cycle schema.ts would have refused — is parked in column 0 rather
 * than dropped: a node the user can see and click beats a silently missing box.
 */
export function layoutWorkflowMap(steps: readonly WorkflowStepStatus[]): WorkflowMapLayout {
  if (steps.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0, nodeWidth: MAP_NODE_W, nodeHeight: MAP_NODE_H };
  }
  const known = new Set(steps.map((step) => step.stepId));
  const level = new Map<string, number>();
  for (let pass = 0; pass < steps.length; pass += 1) {
    let changed = false;
    for (const step of steps) {
      const deps = step.dependsOn.filter((dep) => known.has(dep));
      if (!deps.every((dep) => level.has(dep))) {
        continue;
      }
      const next = deps.reduce((deepest, dep) => Math.max(deepest, (level.get(dep) ?? 0) + 1), 0);
      if (level.get(step.stepId) !== next) {
        level.set(step.stepId, next);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  const byColumn = new Map<number, WorkflowStepStatus[]>();
  for (const step of steps) {
    const column = level.get(step.stepId) ?? 0;
    const bucket = byColumn.get(column);
    if (bucket === undefined) {
      byColumn.set(column, [step]);
    } else {
      bucket.push(step);
    }
  }
  // Compacted so a hole in the level numbering (impossible past the rule
  // above, but cheap to survive) never renders as an empty gap column.
  const columns = [...byColumn.keys()].sort((a, b) => a - b).map((key) => byColumn.get(key) ?? []);

  const tallest = columns.reduce((most, column) => Math.max(most, column.length), 1);
  const width = MAP_PAD * 2 + columns.length * MAP_NODE_W + (columns.length - 1) * MAP_COL_GAP;
  const height = MAP_PAD * 2 + tallest * MAP_NODE_H + (tallest - 1) * MAP_ROW_GAP;

  const nodes: WorkflowMapNode[] = [];
  const placed = new Map<string, WorkflowMapNode>();
  columns.forEach((column, columnIndex) => {
    // Each column is centred against the tallest one, so a fan reads as a fan
    // rather than as a top-aligned staircase.
    const columnHeight = column.length * MAP_NODE_H + (column.length - 1) * MAP_ROW_GAP;
    const top = round1((height - columnHeight) / 2);
    column.forEach((step, rowIndex) => {
      const node: WorkflowMapNode = {
        stepId: step.stepId,
        kind: workflowStepKind(step),
        x: MAP_PAD + columnIndex * (MAP_NODE_W + MAP_COL_GAP),
        y: round1(top + rowIndex * (MAP_NODE_H + MAP_ROW_GAP)),
      };
      nodes.push(node);
      placed.set(step.stepId, node);
    });
  });

  const edges: WorkflowMapEdge[] = [];
  for (const step of steps) {
    const to = placed.get(step.stepId);
    if (to === undefined) {
      continue;
    }
    for (const dep of step.dependsOn) {
      const from = placed.get(dep);
      if (from === undefined) {
        continue;
      }
      const x1 = from.x + MAP_NODE_W;
      const y1 = round1(from.y + MAP_NODE_H / 2);
      const x2 = to.x;
      const y2 = round1(to.y + MAP_NODE_H / 2);
      const mid = round1((x1 + x2) / 2);
      edges.push({ from: dep, to: step.stepId, path: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` });
    }
  }

  return { nodes, edges, width, height, nodeWidth: MAP_NODE_W, nodeHeight: MAP_NODE_H };
}

/** Node caption. Long ids are clipped rather than shrunk: a smaller font on
 *  one box would read as a status difference it does not carry. */
export function workflowMapLabel(stepId: string): string {
  return stepId.length <= 16 ? stepId : `${stepId.slice(0, 15)}\u2026`;
}

/** Human status word for the SR-only span beside a step's glyph (R17 a11y):
 *  the glyph is the only visual status carrier and the li's aria-label has
 *  spotty SR support, so the word rides inline as real (visually-hidden) text. */
const SUBSTATUS_WORD: Record<SubStatusKind, string> = {
  running: "Running",
  queued: "Queued",
  pending: "Not started",
  completed: "Completed",
  max_turns: "Max turns reached",
  cancelled: "Cancelled",
  error: "Error",
  skipped: "Skipped",
  failed: "Failed",
};

/** Shared status glyph cell: one shape per outcome, color supplied by the
 *  parent's `substatus-*` class (error/failed/cancelled all fall through to X).
 *  `queued` (TASK.191 slice S3) reuses the Spinner shape WITHOUT `.icon-spin`
 *  — a paused version of "about to run", distinct from both the spinning
 *  "running" glyph and the empty "pending" cell. `pending` renders no icon at
 *  all (nothing has happened yet) — same empty-cell posture the old
 *  "N steps not started" summary row used before this slice replaced it with
 *  real per-step rows. Private — the pure formatters carry the test surface. */
function StatusGlyph({ kind }: { kind: SubStatusKind }) {
  return (
    <span className="substatus-glyph">
      {kind === "running" ? (
        <Spinner className="icon-spin" />
      ) : kind === "queued" ? (
        <Spinner />
      ) : kind === "pending" ? null : kind === "completed" ? (
        <Check />
      ) : kind === "max_turns" ? (
        <Warning />
      ) : kind === "skipped" ? (
        <Minus />
      ) : (
        <X />
      )}
    </span>
  );
}

/**
 * The run's total token spend (TASK.191 slice S2): the sum over the steps the
 * card is already holding, computed on read rather than stored. A second
 * mutable aggregate beside `steps` would be a second source of truth that a
 * dropped or reordered event could desynchronize; a selector cannot drift from
 * the rows it is derived from.
 *
 * A field absent from EVERY step stays absent in the sum — "no tier reported
 * this" must not become a zero the card would then display as fact. Returns
 * null when no step reported spend at all.
 */
export function workflowRunUsage(workflow: WorkflowSubStatus): TokenUsage | null {
  let total: TokenUsage | null = null;
  for (const step of workflow.steps) {
    if (step.usage === null) continue;
    const merged: TokenUsage = { ...total };
    for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"] as const) {
      const value = step.usage[key];
      if (value !== undefined) {
        merged[key] = (merged[key] ?? 0) + value;
      }
    }
    total = merged;
  }
  return total;
}

/**
 * The owner's requested shape, absolute numbers rather than a bar:
 * `in X · cached Y (N%) · out Z · total T`.
 *
 * The percentage is of INPUT, not of the total, because cached tokens are a
 * SUBSET of input (`TokenUsage.cachedInputTokens` — "included in inputTokens"),
 * which is also how the composer's own cache readout computes it. Computing it
 * against the total would silently understate every cache hit.
 *
 * Each segment appears only if its field was reported; the whole line is null
 * when nothing was. Absent is rendered as absent, never as `0` — a zero here
 * would be a claim about the provider that we are not in a position to make.
 */
export function formatWorkflowUsage(usage: TokenUsage | null): string | null {
  if (usage === null) return null;
  const segments: string[] = [];
  if (usage.inputTokens !== undefined) {
    segments.push(`in ${usage.inputTokens}`);
  }
  if (usage.cachedInputTokens !== undefined) {
    // The percentage is omitted rather than shown as 0% or NaN when there is no
    // input to divide by — a cache ratio against nothing is not a fact.
    const share =
      usage.inputTokens !== undefined && usage.inputTokens > 0
        ? ` (${Math.round((usage.cachedInputTokens / usage.inputTokens) * 100)}%)`
        : "";
    segments.push(`cached ${usage.cachedInputTokens}${share}`);
  }
  if (usage.outputTokens !== undefined) {
    segments.push(`out ${usage.outputTokens}`);
  }
  if (usage.totalTokens !== undefined) {
    segments.push(`total ${usage.totalTokens}`);
  }
  return segments.length > 0 ? segments.join(" · ") : null;
}

/**
 * Row list for the workflow run's single activity lane (TASK.191 slice S1) —
 * `activityRows`' sibling, same honest-overflow leading row, same oldest-first
 * order. The one difference is the `stepId` prefix on every row: this lane is
 * shared by every concurrent step of the DAG, so without it a reader cannot
 * tell which step produced a line. The prefix costs nothing on the wire —
 * `stepId` has to ride along anyway for the store to attribute the row.
 *
 * TASK.191 slice S4: `selectedStepId` filters the lane to one step's rows
 * (clicking a step row in `WorkflowStepsBody`). `activityDropped` is a
 * RUN-WIDE count — a dropped row carried no surviving `stepId` once evicted
 * from the ring, so which step(s) it belonged to is genuinely unknown. Two
 * honesty guards follow from that:
 *  - With matches: the leading row is reworded "(run-wide)" rather than the
 *    unfiltered "+N earlier", so it never reads as "N of THIS step's rows
 *    were dropped" — a claim this data cannot support.
 *  - With zero matches: an empty list would read as "this step made no
 *    calls", which is a different (and possibly false) claim from "some of
 *    this step's rows may be among the ones the ring already dropped". The
 *    two are told apart by a dedicated row, present only when
 *    `activityDropped > 0` — the true-empty case (`activityDropped === 0`)
 *    still returns `[]`, same as the unfiltered lane with no activity.
 */
export function workflowActivityRows(workflow: WorkflowSubStatus, selectedStepId?: string | null): ActivityRowView[] {
  const filtering = selectedStepId !== undefined && selectedStepId !== null;
  const matched = filtering ? workflow.activity.filter((entry) => entry.stepId === selectedStepId) : workflow.activity;
  const rows: ActivityRowView[] = [];
  if (workflow.activityDropped > 0) {
    if (!filtering) {
      rows.push({ key: "dropped", text: `+${workflow.activityDropped} earlier`, leading: true });
    } else if (matched.length > 0) {
      rows.push({ key: "dropped-filtered", text: `+${workflow.activityDropped} earlier (run-wide)`, leading: true });
    } else {
      rows.push({
        key: "dropped-unknown",
        text: `This step's earlier activity may be among the ${workflow.activityDropped} row(s) dropped run-wide`,
        leading: true,
      });
    }
  }
  matched.forEach((entry, index) => {
    rows.push({ key: `activity-${index}`, text: `${entry.stepId} · ${activityRowText(entry)}` });
  });
  return rows;
}

/** The workflow run's live activity lane — same well, same auto-scroll
 *  behaviour and same CSS as the Agent card's `ActivityFeed`, reading the
 *  run-wide ring instead of one child's. Rendered while running and after
 *  settle: the trail is the post-mortem, not just the live view. TASK.191
 *  slice S4: `selectedStepId` threads straight through to
 *  `workflowActivityRows` — this component owns no selection state itself,
 *  `WorkflowStatus` does. */
function WorkflowActivityFeed({ workflow, selectedStepId }: { workflow: WorkflowSubStatus; selectedStepId: string | null }) {
  const rows = workflowActivityRows(workflow, selectedStepId);
  const listRef = useRef<HTMLUListElement>(null);
  const running = workflow.final === null;
  useEffect(() => {
    if (running && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [rows.length, running]);
  if (rows.length === 0) {
    return null;
  }
  return (
    <ul className="subagent-activity-feed workflow-activity-feed" ref={listRef}>
      {rows.map((row) => (
        <li
          key={row.key}
          className={`subagent-activity-row${row.leading === true ? " subagent-activity-row-dropped" : ""}`}
        >
          {row.text}
        </li>
      ))}
    </ul>
  );
}

/**
 * Pure toggle for the step-selection click (TASK.191 slice S4): re-clicking
 * the already-selected step clears the selection rather than being a one-way
 * ratchet. Without this, once a step is examined the only way back to the
 * unfiltered view would be picking a DIFFERENT step — a state with no exit of
 * its own. Exported for direct unit testing (same pure-logic-only rationale
 * as this file's other exported formatters).
 */
export function toggleWorkflowStepSelection(current: string | null, stepId: string): string | null {
  return current === stepId ? null : stepId;
}

/**
 * The checklist + activity lane, given an explicit `selectedStepId` rather
 * than owning the selection itself (TASK.191 slice S4). Split out of
 * `WorkflowStatus` — which owns the real `useState` — so
 * ToolCallCard.test.ts can render the "step selected" markup directly via
 * `renderToStaticMarkup`: a real click can't be simulated under SSR, but a
 * controlled prop can be passed in already-selected (same rationale as
 * `AgentCardBody` being split out of `ToolCallCard` itself).
 *
 * Each row's content moved from the `<li>` straight into a `<button>` (owner
 * ask: "а кликнуть в них нельзя будет?") — a real button gives keyboard
 * focus, Enter/Space activation, and an implicit role for free, none of which
 * a `<li onClick>` would carry. `aria-label` rides on the button now (it used
 * to sit on the `<li>`).
 *
 * `substatus-<kind>` is deliberately duplicated onto BOTH the `<li>` and the
 * `<button>`, not moved. The `<li>` keeps it because
 * `.workflow-step.substatus-running .workflow-step-id` (app.css) needs
 * `workflow-step` and `substatus-*` on the SAME element. The button also
 * needs it because `StatusGlyph`'s whole color map (app.css's shared R14
 * atoms, `.substatus-<kind> > .substatus-glyph`) is written with a CHILD
 * combinator — it colors the glyph only when the status class sits on the
 * glyph's own immediate parent. Before this button existed that parent was
 * the `<li>`; wrapping the row's content in a button without repeating the
 * class here would silently detune every glyph to its ghost default (a real
 * regression this slice shipped once and a coordinator review caught: the
 * S3 "queued vs. not-started" distinction depends on this color, and a green
 * gate cannot see a CSS selector stop matching).
 */
/**
 * The run map: one SVG, geometry straight from `layoutWorkflowMap`. Nodes are
 * real buttons driving the SAME `onSelectStep` the ledger rows drive — the map
 * is a second view of one selection, never a second selection of its own, so
 * clicking a box and clicking its row are indistinguishable downstream.
 *
 * The SVG carries no intrinsic width/height, only a viewBox: the card is a
 * flexible column and a fixed pixel width would either overflow it on a narrow
 * window or refuse to use a wide one. Status travels on the group's
 * `substatus-*` class, the same vocabulary the rows use, so a status can never
 * mean one thing in the list and another in the map.
 */
function WorkflowMap({
  workflow,
  selectedStepId,
  onSelectStep,
}: {
  workflow: WorkflowSubStatus;
  selectedStepId: string | null;
  onSelectStep: (stepId: string) => void;
}) {
  const layout = layoutWorkflowMap(workflow.steps);
  if (layout.nodes.length === 0) {
    return null;
  }
  const byId = new Map(workflow.steps.map((step) => [step.stepId, step]));
  return (
    <div className="workflow-map">
      <svg
        className="workflow-map-svg"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        style={{ maxWidth: `${layout.width}px` }}
        aria-hidden={false}
        role="group"
        aria-label="Workflow run map"
      >
        {layout.edges.map((edge) => (
          <path key={`${edge.from}->${edge.to}`} className="workflow-map-edge" d={edge.path} />
        ))}
        {layout.nodes.map((node) => {
          const step = byId.get(node.stepId);
          const selected = node.stepId === selectedStepId;
          return (
            <g
              key={node.stepId}
              className={`workflow-map-node substatus-${node.kind}${selected ? " is-selected" : ""}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={step !== undefined ? workflowStepAria(step) : node.stepId}
              onClick={() => onSelectStep(node.stepId)}
              onKeyDown={(event) => {
                // Space/Enter must act here: an SVG <g> gets no implicit button
                // activation from the platform, so without this the map is
                // keyboard-reachable but keyboard-DEAD.
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectStep(node.stepId);
                }
              }}
            >
              <rect
                className="workflow-map-box"
                x={node.x}
                y={node.y}
                width={layout.nodeWidth}
                height={layout.nodeHeight}
                rx={6}
              />
              <text
                className="workflow-map-label"
                x={node.x + layout.nodeWidth / 2}
                y={node.y + layout.nodeHeight / 2}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {workflowMapLabel(node.stepId)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function WorkflowStepsBody({
  workflow,
  selectedStepId,
  onSelectStep,
}: {
  workflow: WorkflowSubStatus;
  selectedStepId: string | null;
  onSelectStep: (stepId: string) => void;
}) {
  const orderedSteps = orderStepsByDependency(workflow.steps);
  // Closed by default: the map answers "what is the SHAPE of this run", a
  // question a one-step or straight-line run does not raise, and the card must
  // not grow for every reader who never asks it.
  // Open by default: the map answers "what waits on what", which the ordered
  // checklist above cannot express at all (it carries order, not dependency).
  // That makes it the view worth arriving at, not one to be discovered behind
  // a control; the toggle stays for collapsing it back.
  const [mapOpen, setMapOpen] = useState(true);
  // A map is only worth offering once there is a shape to see — a single step
  // has none, so the toggle stays absent rather than opening onto one box.
  const mapWorthOffering = workflow.steps.length > 1;
  return (
    <>
      {orderedSteps.length > 0 && (
        <ul className="workflow-steps">
          {orderedSteps.map((step) => {
            const kind = workflowStepKind(step);
            const selected = step.stepId === selectedStepId;
            return (
              <li key={step.stepId} className={`workflow-step substatus-${kind}`}>
                <button
                  type="button"
                  className={`workflow-step-button substatus-${kind}`}
                  aria-pressed={selected}
                  aria-label={workflowStepAria(step)}
                  onClick={() => onSelectStep(step.stepId)}
                >
                  <StatusGlyph kind={kind} />
                  <span className="visually-hidden">{SUBSTATUS_WORD[kind]}</span>
                  <span className="workflow-step-id">{step.stepId}</span>
                  <span className="workflow-step-agent">{step.agentType}</span>
                  <span className="workflow-step-meta">{workflowStepMeta(step)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {mapWorthOffering && mapOpen && (
        <WorkflowMap workflow={workflow} selectedStepId={selectedStepId} onSelectStep={onSelectStep} />
      )}
      {mapWorthOffering && (
        <button
          type="button"
          className="workflow-map-toggle"
          aria-expanded={mapOpen}
          onClick={() => setMapOpen((open) => !open)}
        >
          {mapOpen ? "Hide map" : "Show map"}
        </button>
      )}
      <WorkflowActivityFeed workflow={workflow} selectedStepId={selectedStepId} />
    </>
  );
}

/**
 * Sub-status region mounted below the input summary when `block.workflow` is
 * set (Workflow tool only). A run header (glyph · workflow name · aggregate)
 * above a flat vertical checklist, with the run-wide activity lane (TASK.191
 * slice S1) below both.
 *
 * TASK.191 slice S3: the checklist now renders EVERY step of the run's graph
 * — `workflow_start` prefills all N of them, so there is no longer a
 * separate lump "N steps not started" trailer row; each not-yet-started step
 * is a real row with its own id/agentType, honestly labeled "Not started" or
 * "Queued" (`workflowStepKind`/`workflowStepMeta`). Ordered by
 * `orderStepsByDependency`, not raw store order.
 *
 * TASK.191 slice S4: owns the selected-step `useState` — view-only state that
 * lives and dies with this card's mount, never the store (a dropped or
 * reordered event cannot desync something the store never held). The
 * checklist/feed rendering itself lives in `WorkflowStepsBody` above.
 */
function WorkflowStatus({ workflow }: { workflow: WorkflowSubStatus }) {
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const runKind = substatusKind(workflow.final);
  const usageLine = formatWorkflowUsage(workflowRunUsage(workflow));
  return (
    <div className="tool-call-workflow">
      <div className={`tool-call-workflow-line substatus-${runKind}`}>
        <StatusGlyph kind={runKind} />
        <span className="tool-call-workflow-label">{workflow.workflow}</span>
      </div>
      <div className="tool-call-workflow-counters">{workflowRunLabel(workflow)}</div>
      {usageLine !== null && <div className="tool-call-workflow-usage">{usageLine}</div>}
      <WorkflowStepsBody
        workflow={workflow}
        selectedStepId={selectedStepId}
        onSelectStep={(stepId) => setSelectedStepId((current) => toggleWorkflowStepSelection(current, stepId))}
      />
    </div>
  );
}

/**
 * TASK.102 CUT-S2 §2.5 (slice S2c C3), Open-gate widened by §10.8.1
 * (slice C4): an Agent card's session-child badge + Open action, or
 * `undefined` for every card that isn't one — inline subagents (the
 * overwhelming common case), every non-Agent tool, and any Agent card
 * rendered with no `<TabContext.Provider>` above it (this file's own SSR
 * tests, ToolCallCard.test.ts, mount `ToolCallCard`/`AgentCardBody` bare).
 * Self-contained: reads TabContext plus the two C1 relation/layout stores
 * directly, so MessageList.tsx needs no new prop to thread through —
 * `useContext`/the two store hooks are called UNCONDITIONALLY (React's rules
 * of hooks) even for a non-Agent block; only the RETURN is gated on
 * `isAgentCard`, so a Bash/Read/Grep card's selectors always resolve to a
 * stable `undefined` and never re-render off child-store churn.
 *
 * The actual DECISION here is `hasOpenableChild`'s two-argument presence
 * check (child-sessions.ts, tested — `relation !== undefined ||
 * block.subagent.sessionChild === true`, the restart-Open case included)
 * plus `childBadgeKind` (child-layout.ts, tested) — this hook is plumbing
 * (TabContext -> parentSessionId -> relation), not a new branch to
 * discriminate.
 *
 * `onOpen` is now UNCONDITIONAL once `hasOpenableChild` is true (§10.8.1
 * point 3: "the dead click stops existing") — C4 built a read-only surface
 * for a non-live/never-live-in-this-renderer child, so ActiveTabBody always
 * has SOMETHING to show for a click here, live relation or not.
 */
function useChildSessionAction(
  block: ToolCallBlock,
): { badge: ChildBadgeKind; onOpen: (() => void) | undefined } | undefined {
  const ctx = useContext(TabContext);
  const isAgentCard = block.toolName === "Agent";
  const parentSessionId = useTabsStore((state) =>
    isAgentCard && ctx !== null ? state.tabs.find((tab) => tab.tabId === ctx.tabId)?.sessionId : undefined,
  );
  const relation = childRelationStore((state) =>
    isAgentCard && parentSessionId !== null && parentSessionId !== undefined
      ? state.getRelation(parentSessionId, block.toolCallId)
      : undefined,
  );
  const hydratedSessionChild = block.subagent?.sessionChild === true;
  if (!isAgentCard || ctx === null || block.subagent === null || !hasOpenableChild(relation, hydratedSessionChild)) {
    return undefined;
  }
  const rootTabId = ctx.tabId;
  const spawnToolCallId = block.toolCallId;
  return {
    badge: childBadgeKind(block.subagent),
    onOpen: () => childLayoutStore.getState().open(rootTabId, spawnToolCallId),
  };
}

/**
 * Pure projection of the provider's response-model claim onto a display note
 * (TASK.161 slice C1). `null` when no claim was ever observed — absence
 * renders as absence, never a fallback to the requested model (a filled
 * field that is really a guess would look sighted). `mismatch: true` is the
 * only informative case: the provider echoed an id different from what was
 * requested. A MATCH proves nothing beyond "the provider accepted the id" —
 * it is deliberately not styled as a success/confirmation. The word "served"
 * never appears: this is the provider's CLAIM, not proof of serving.
 */
export function subagentResponseModelNote(sub: {
  model: string | null;
  final: { responseModel?: string } | null;
}): { text: string; mismatch: boolean } | null {
  const responseModel = sub.final?.responseModel;
  if (responseModel === undefined) {
    return null;
  }
  return { text: `provider reported: ${responseModel}`, mismatch: sub.model !== null && sub.model !== responseModel };
}

/** Sub-status region mounted below the input summary when `block.subagent` is
 *  set (Agent tool only). A flat two-line panel sharing the row atoms: glyph ·
 *  persona (mono anchor) · model (only when the child ran on its own) ·
 *  description, then the frozen counters line. A THIRD line — the session-
 *  child badge (+ Open button, only when the child is still live) — mounts
 *  only when `child` is set (TASK.102 CUT-S2 §2.5 C3); every inline-subagent
 *  card (the default `child` prop, `undefined`) renders byte-identically to
 *  before this slice. TASK.120: while the child waits on a permission ask the
 *  badge itself is an action (ChildBadge) firing the same `onOpen` as the
 *  Open button beside it. */
function SubagentStatus({
  subagent,
  child,
}: {
  subagent: SubagentSubStatus;
  child?: { badge: ChildBadgeKind; onOpen: (() => void) | undefined };
}) {
  const kind = substatusKind(subagent.final);
  const responseModelNote = subagentResponseModelNote(subagent);
  return (
    <div className="tool-call-subagent">
      <div className={`tool-call-subagent-line substatus-${kind}`}>
        <StatusGlyph kind={kind} />
        <span className="tool-call-subagent-persona">{subagent.agentType}</span>
        {/* Absent model = inherited the parent's, which the composer already
            shows — a pill on every card would be noise, so only a genuinely
            different child model is labelled. */}
        {subagent.model !== null && (
          <span className="tool-call-subagent-model" title={`Child model: ${subagent.model}`}>
            {subagent.model}
          </span>
        )}
        {responseModelNote !== null && (
          <span
            className={`tool-call-subagent-response-model${responseModelNote.mismatch ? " tool-call-subagent-response-model--mismatch" : ""}`}
            title={
              responseModelNote.mismatch
                ? "The provider's response claimed a different model than requested — a claim, not proof of serving."
                : "Provider-reported model on the raw wire response — a claim, not proof of serving."
            }
          >
            {responseModelNote.text}
          </span>
        )}
        <span className="tool-call-subagent-desc">{subagent.description}</span>
      </div>
      <div className="tool-call-subagent-counters">{formatSubagentCounters(subagent)}</div>
      {child !== undefined && (
        <div className="tool-call-subagent-child-row">
          <ChildBadge badge={child.badge} onOpen={child.onOpen} />
          {child.onOpen !== undefined && (
            <button type="button" className="tool-call-subagent-open-button" onClick={child.onOpen}>
              Open
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Verb word shown before an activity row's subject (design
 * slice-P7.18-cut.md §1 invariant 2: "Ran <cmd>" / "Read <file>" / "Todo
 * <subject> 0/7"). Unknown/future child tools fall back to the raw tool
 * name so a new tool never renders a blank verb — same fail-visible posture
 * as `summarizeChildToolCall`'s own tool-name-alone fallback on the core
 * side (packages/core/src/subagents/summarize-tool.ts).
 */
const ACTIVITY_VERBS: Record<string, string> = {
  Bash: "Ran",
  Read: "Read",
  Write: "Wrote",
  Edit: "Edited",
  Grep: "Grep",
  Glob: "Glob",
  TodoWrite: "Todo",
  Agent: "Agent",
};

export function activityVerb(toolName: string): string {
  return ACTIVITY_VERBS[toolName] ?? toolName;
}

/** "<verb> <subject>" row text; falls back to the bare verb when the core's
 * summary is empty (its own documented fallback for a tool with no
 * per-call subject, e.g. an unrecognized child tool). */
export function activityRowText(entry: { toolName: string; summary: string }): string {
  const verb = activityVerb(entry.toolName);
  return entry.summary.length > 0 ? `${verb} ${entry.summary}` : verb;
}

/** One rendered activity-feed row. `leading` marks the synthetic "+N
 * earlier" row minted when the ring has dropped rows (design §4 W3 point
 * 3) — it is not a real activity entry, so it carries no `toolName`. */
export interface ActivityRowView {
  key: string;
  text: string;
  leading?: true;
}

/**
 * Full row list for the live activity feed: the honest-overflow leading row
 * (only when `activityDropped > 0`) followed by every ring-held entry,
 * oldest first. The DOM carries the whole list — CSS caps the visible
 * height to ~6 rows and `ActivityFeed`'s auto-scroll effect is what keeps
 * only the newest rows in view while running (design §4 W3 point 3).
 */
export function activityRows(subagent: SubagentSubStatus): ActivityRowView[] {
  const rows: ActivityRowView[] = [];
  if (subagent.activityDropped > 0) {
    rows.push({ key: "dropped", text: `+${subagent.activityDropped} earlier`, leading: true });
  }
  subagent.activity.forEach((entry, index) => {
    rows.push({ key: `activity-${index}`, text: activityRowText(entry) });
  });
  return rows;
}

/**
 * Agent-card RESULT slot text (design §4 W3 point 2): settled-only — a
 * proposed/running call has nothing to show yet, the activity feed carries
 * the live state — and Agent-only, so every other tool keeps its existing
 * raw `<pre>` result path untouched. `tools/agent.ts`'s
 * `formatResultForModel` already writes the error text into `modelText` on
 * failure (`result.error ?? "Agent: the subagent failed."`), so a
 * `status: "error"` card needs no separate error field: same slot, same
 * text, rendered the same way as a successful result.
 */
export function agentResultText(block: Pick<ToolCallBlock, "toolName" | "status" | "modelText">): string | null {
  if (block.toolName !== "Agent") {
    return null;
  }
  if (block.status === "proposed" || block.status === "running") {
    return null;
  }
  return block.modelText;
}

/** Line cap for the collapsed PROMPT plaque (design §4 W3 point 4) — far
 * tighter than RESULT_VISIBLE_LINES: the plaque is a secondary strip, not a
 * reading surface. */
export const PROMPT_STRIP_LINES = 2;

/** Char budget for the PROMPT plaque's collapsed strip, on top of the
 * PROMPT_STRIP_LINES line cap — a long unwrapped single line (no `\n`)
 * would otherwise sail through the line cap untouched. Same "cap the actual
 * DOM text, don't just rely on CSS to clip it" posture as SUMMARY_MAX_CHARS
 * below (same numeric value; declared standalone — SUMMARY_MAX_CHARS is
 * defined later in this module and a top-level const can't forward-reference
 * it without a temporal-dead-zone crash at load time). */
export const PROMPT_STRIP_MAX_CHARS = 200;

/**
 * Two-level PROMPT plaque strip text (design §4 W3 point 4): caps by BOTH
 * line count (multi-line prompts) and char count (one long unwrapped
 * line) — whichever is tighter wins, so the collapsed strip's DOM text is
 * always genuinely short, never merely CSS-clipped. The whole plaque is the
 * click target for the level-2 expand to the untruncated prompt text
 * (never the reverse — the full prompt must never be in the DOM before that
 * click). `truncated` is exposed for callers that want to know whether the
 * plaque has anything more to reveal.
 */
export function promptStripText(prompt: string): { visible: string; truncated: boolean } {
  const byLines = capLines(prompt, PROMPT_STRIP_LINES);
  const visible =
    byLines.visible.length > PROMPT_STRIP_MAX_CHARS
      ? `${byLines.visible.slice(0, PROMPT_STRIP_MAX_CHARS)}…`
      : byLines.visible;
  return { visible, truncated: visible !== prompt };
}

/** Live per-child-tool activity feed (design §4 W3 point 3 / §1 invariant
 * 2): one muted "<verb> <subject>" row per child tool call, store-driven —
 * `subagent.activity` is a ring the store reducer already appends to live,
 * no polling here. Rendered both while running and after settle (the trail
 * stays visible post-mortem, not just live). The list itself is never
 * truncated in the DOM; CSS caps the visible height to ~6 rows and this
 * effect keeps a running card scrolled to the newest row — nothing to
 * auto-scroll once settled, the list has stopped growing. */
function ActivityFeed({ subagent }: { subagent: SubagentSubStatus }) {
  const rows = activityRows(subagent);
  const listRef = useRef<HTMLUListElement>(null);
  const running = subagent.final === null;
  useEffect(() => {
    if (running && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [rows.length, running]);
  if (rows.length === 0) {
    return null;
  }
  return (
    <ul className="subagent-activity-feed" ref={listRef}>
      {rows.map((row) => (
        <li
          key={row.key}
          className={`subagent-activity-row${row.leading === true ? " subagent-activity-row-dropped" : ""}`}
        >
          {row.text}
        </li>
      ))}
    </ul>
  );
}

/**
 * Expanded Agent-card body (design slice-P7.18-cut.md §4 W3): the owner's
 * exact 4-item hierarchy, Agent-only branch — the generic non-Agent body
 * (ToolCallCard, below) is untouched. 1) header + counters (SubagentStatus,
 * F16, unchanged) 2) RESULT, settled-only, Markdown-rendered (same slot
 * carries the error text on `status: "error"`) 3) live per-child-tool
 * activity feed 4) PROMPT plaque, two-level collapse. Every section is
 * conditional on having something to show — a still-proposed Agent card (no
 * subagent yet) renders just the prompt plaque, an honest reflection of
 * what has landed so far rather than placeholder chrome.
 *
 * Exported (unlike the sibling SubagentStatus/WorkflowStatus) so
 * ToolCallCard.test.ts can render it directly via react-dom/server: the
 * parent ToolCallCard only mounts this body once the card is user-expanded,
 * and Agent cards default to collapsed in every status (design/slice-P7.4-
 * cut.md §3.2, untouched by this slice) — there is no prop path to reach an
 * expanded Agent body from ToolCallCard's own public props alone.
 */
export function AgentCardBody({
  block,
  promptExpanded,
  onTogglePrompt,
  child,
}: {
  block: ToolCallBlock;
  promptExpanded: boolean;
  onTogglePrompt: () => void;
  /** TASK.102 CUT-S2 §2.5 (C3): passed straight through to SubagentStatus — see its own doc comment. Omitted by ToolCallCard.test.ts's direct SSR renders, same as today. */
  child?: { badge: ChildBadgeKind; onOpen: (() => void) | undefined };
}) {
  const resultText = agentResultText(block);
  const prompt = agentPromptText(block.input);
  const strip = prompt !== null ? promptStripText(prompt) : null;
  return (
    <>
      {block.subagent && <SubagentStatus subagent={block.subagent} child={child} />}
      {resultText !== null && (
        <div className="tool-call-agent-result message-markdown">
          <Markdown text={resultText} />
        </div>
      )}
      {block.subagent && <ActivityFeed subagent={block.subagent} />}
      {prompt !== null && strip !== null && (
        <div className="subagent-prompt">
          <button
            type="button"
            className="subagent-prompt-plaque"
            aria-expanded={promptExpanded}
            onClick={onTogglePrompt}
          >
            <span className="subagent-prompt-label">Prompt</span>
            <span className="subagent-prompt-text">{promptExpanded ? prompt : strip.visible}</span>
          </button>
        </div>
      )}
    </>
  );
}

/** Settled, non-failure statuses fold to the one-line ledger row (design §1.B).
 * Consonance rule: auto-collapse ⟺ the status badge is not danger/warning-tinted
 * (app.css tints error/invalid_input/denied/timed_out danger and max_turns
 * warning — failures and incompletes deserve attention and stay open). cancelled
 * is user-initiated and carries no diagnostic payload, so it folds. proposed/
 * running are not settled. Unknown future statuses fall through to false:
 * fail-visible. */
export function shouldAutoCollapse(status: ToolCallBlock["status"]): boolean {
  return status === "success" || status === "cancelled";
}

/** Default disclosure state per tool (design/slice-P7.4-cut.md §3.2): the
 * Agent card stays collapsed-by-default in every status, including
 * proposed/running (the owner reference's core ask — the live progress
 * sub-line keeps a running card honest without the full panel). Every other
 * tool keeps the existing status-derived default verbatim. */
export function defaultExpanded(toolName: string, status: ToolCallBlock["status"]): boolean {
  if (toolName === "Agent") {
    return false;
  }
  return !shouldAutoCollapse(status);
}

/** One TodoWrite item, validated (design/slice-P7.4-cut.md §3.1). */
export interface TodoItemView {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** Fail-soft validator for TodoWrite's replace-all `input.todos` (F1 DoD):
 * anything that doesn't match the schema exactly (non-array, missing/empty
 * content, unknown status, junk elements) returns null so the card falls
 * back to the existing generic JSON path. An empty array is a valid,
 * honest replace-all and returns `[]`, not null. Unknown extra keys on an
 * item are accepted (forward-compat) — only `content`/`status` are read. */
export function parseTodos(input: unknown): TodoItemView[] | null {
  if (input === null || typeof input !== "object") {
    return null;
  }
  const todos = (input as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) {
    return null;
  }
  const result: TodoItemView[] = [];
  for (const item of todos) {
    if (item === null || typeof item !== "object") {
      return null;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.content !== "string" || record.content.length === 0) {
      return null;
    }
    if (typeof record.status !== "string" || !TODO_STATUSES.has(record.status)) {
      return null;
    }
    result.push({ content: record.content, status: record.status as TodoItemView["status"] });
  }
  return result;
}

/** Collapsed-row summary: "<done>/<total>[ · <first in_progress content>]"
 * (design §3.1 — matches F2's future composer-widget grammar so the app
 * speaks one plan-vocabulary). */
export function todoSummary(todos: TodoItemView[]): string {
  const done = todos.filter((todo) => todo.status === "completed").length;
  const inProgress = todos.find((todo) => todo.status === "in_progress");
  return inProgress ? `${done}/${todos.length} · ${inProgress.content}` : `${done}/${todos.length}`;
}

/** DOM-hygiene cap for the collapsed summary — CSS ellipsis is the visual
 * truncator; this only keeps multi-KB inputs out of the DOM. */
export const SUMMARY_MAX_CHARS = 200;

/** One-line form of a (possibly multi-line) input summary for the collapsed
 * row: whitespace runs collapse to single spaces, then a hard char cap. */
export function flattenSummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS)}…` : flat;
}

/** Expanded results show at most this many source lines before the expander
 * (design §1.D: readable head — a test-failure header or an ls listing —
 * while staying under half a laptop transcript viewport at mono 13px). */
export const RESULT_VISIBLE_LINES = 14;

/** Head-cap on \n-delimited lines. Trailing whitespace/newlines are trimmed
 * BEFORE counting so they never mint a phantom "Show 1 more line"; text at
 * or under the cap is returned verbatim (render exactly what we have). */
export function capLines(text: string, cap: number): { visible: string; hiddenCount: number } {
  const lines = text.trimEnd().split("\n");
  if (lines.length <= cap) {
    return { visible: text, hiddenCount: 0 };
  }
  return { visible: lines.slice(0, cap).join("\n"), hiddenCount: lines.length - cap };
}

/** "Show 24 more lines" / "Show 1 more line" — §6.9 sanctioned copy. */
export function moreLinesLabel(hiddenCount: number): string {
  return `Show ${hiddenCount} more line${hiddenCount === 1 ? "" : "s"}`;
}

/**
 * Best-effort human-readable summary of a tool's raw input, keyed off the
 * Phase 0 tool field names (packages/core/src/tools/schemas.ts): Bash.command,
 * Read/Write/Edit.file_path, Grep.pattern(+path). Falls back to a compact
 * JSON dump for anything else (e.g. Phase 1 tools this card doesn't know
 * about yet) rather than guessing wrong field names.
 * R4: exported for unit coverage; Agent summarizes to its description (the
 * human line of the app's signature orchestration surface — full grammar is
 * R14's). EVERY branch guards `JSON.stringify(undefined) === undefined` with
 * `?? ""` so the `: string` return type holds for any `input` (incl. an
 * `undefined` field dropped by JSON hydration) — the collapsed row's
 * `flattenSummary` consumer calls `.replace()` and would throw on undefined.
 */
export function summarizeInput(toolName: string, input: unknown): string {
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  switch (toolName) {
    case "Bash":
      return typeof record.command === "string" ? record.command : (JSON.stringify(input) ?? "");
    case "Read":
    case "Write":
    case "Edit":
      return typeof record.file_path === "string" ? record.file_path : (JSON.stringify(input) ?? "");
    case "Grep": {
      const pattern = typeof record.pattern === "string" ? record.pattern : null;
      if (!pattern) {
        return JSON.stringify(input) ?? "";
      }
      const path = typeof record.path === "string" ? record.path : null;
      return path ? `${pattern} in ${path}` : pattern;
    }
    case "Agent":
      return typeof record.description === "string" ? record.description : (JSON.stringify(input) ?? "");
    case "TodoWrite": {
      const todos = parseTodos(input);
      return todos !== null ? todoSummary(todos) : (JSON.stringify(input) ?? "");
    }
    default:
      return JSON.stringify(input) ?? "";
  }
}

/**
 * TASK.112: `Read`/`Write`/`Edit`'s `file_path` when it names a document the
 * PreviewHost window can render, else `null`. This card is the ONE place in
 * the transcript where the path of a file the agent just touched is known
 * machine-side; the other click-to-open affordance (a markdown link in the
 * answer) is born only if the model happened to write `[text](path)` in its
 * prose, so a path stated plainly — the common case — used to offer nothing.
 * Every other tool and every non-document extension returns `null` and the
 * card renders exactly as it did before.
 */
export function previewablePathOf(toolName: string, input: unknown): string | null {
  if (toolName !== "Read" && toolName !== "Write" && toolName !== "Edit") {
    return null;
  }
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const path = typeof record.file_path === "string" ? record.file_path : null;
  return path !== null && isPreviewableDocPath(path) ? path : null;
}

/** A resolved open-in-preview action for this card's file path — `null` when the card has nothing to offer. */
export interface ArtifactPreviewAction {
  path: string;
  open: () => void;
  /** Main's refusal reason from the last attempt (containment, missing file), rendered beside the control; `null` while nothing has failed. */
  error: string | null;
}

/**
 * Resolves the card's open-in-preview action, or `null` when there is nothing
 * to offer: a non-document tool/extension, a card mounted with no
 * `TabContext` above it (this file's own SSR tests), or no preload bridge.
 * The tabId is required — main resolves a workspace-relative `file_path`
 * against the tab's own workspace.
 *
 * The click goes through the SAME `artifacts.preview` channel a markdown-link
 * click already uses, so main re-runs `handleArtifactPreview`'s containment
 * check on every call: this entry point widens WHERE nothing, only WHO can
 * ask. Hooks are called unconditionally (React's rules of hooks); only the
 * RETURN is gated.
 */
function useArtifactPreviewAction(path: string | null): ArtifactPreviewAction | null {
  const ctx = useContext(TabContext);
  const [error, setError] = useState<string | null>(null);
  const api = typeof window !== "undefined" ? window.anycode?.artifacts : undefined;
  if (path === null || ctx === null || api === undefined) {
    return null;
  }
  const tabId = ctx.tabId;
  return {
    path,
    error,
    open: () => {
      void api.preview(tabId, path).then((result) => {
        setError(result.ok ? null : result.error);
      });
    },
  };
}

/** Local pending-todo glyph (design §9.5 — icons.tsx locked this slice,
 * BrainIcon/P7.2 precedent for a local inline SVG). Stroke-only circle,
 * matching the shared icons' 16px viewBox / currentColor-stroke posture. */
function CircleIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  );
}

/** Local subagent glyph (design §9.5 — icons.tsx locked this slice). A small
 * robot/bot mark: antenna + head + two eyes, currentColor stroke/fill. */
function BotIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="6" width="10" height="7" rx="2" />
      <path d="M8 6V3.5" />
      <circle cx="8" cy="2.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="6" cy="9.5" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="10" cy="9.5" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

const TODO_STATUS_WORD: Record<TodoItemView["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
};

/** Replace-all checklist rendered in place of the generic `.tool-call-input`
 * JSON line for a well-formed TodoWrite call (design §3.1). Each row's glyph
 * is the sole visual status carrier; a `visually-hidden` word rides beside it
 * (R17 a11y precedent). An empty list renders an honest "No items" row rather
 * than falling back to the generic path (a valid empty replace-all). */
function TodoChecklist({ todos }: { todos: TodoItemView[] }) {
  return (
    <ul className="todo-checklist">
      {todos.length === 0 ? (
        <li className="todo-item">No items</li>
      ) : (
        todos.map((todo, index) => (
          <li key={index} className={`todo-item todo-item-status-${todo.status}`}>
            <span className="todo-glyph">
              {todo.status === "completed" ? (
                <Check />
              ) : todo.status === "in_progress" ? (
                <Spinner className="icon-spin" />
              ) : (
                <CircleIcon />
              )}
            </span>
            <span className="visually-hidden">{TODO_STATUS_WORD[todo.status]}</span>
            <span className="todo-content">{todo.content}</span>
          </li>
        ))
      )}
    </ul>
  );
}

/** Extracts a non-empty string `input.prompt` for the Agent PROMPT
 * disclosure (design §3.2); missing/non-string/empty → null (fail-soft,
 * no crash — no block rendered). */
function agentPromptText(input: unknown): string | null {
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return typeof record.prompt === "string" && record.prompt.length > 0 ? record.prompt : null;
}

/** Extracts the file_path for the diff header/language detection; falls back to the tool name when absent. */
function diffPath(block: ToolCallBlock): string {
  const record = block.input !== null && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
  return typeof record.file_path === "string" ? record.file_path : block.toolName;
}

/* ── Collapsed tick strip (TASK.191 slice S7) ────────────────────────
 * The plan's collapsed state, `task191/PLAN.md:184` verbatim: "Свёрнутое
 * состояние — полоса засечек по числу шагов, карточка не растёт против
 * сегодняшней". One tick per step, in dependency order, coloured from the same
 * `substatus-<kind>` vocabulary the checklist rows and the map already speak.
 *
 * "Collapsed" is NOT a synonym for "running" here: `defaultExpanded` keeps a
 * running Workflow card OPEN and auto-collapses it only on success/cancel
 * (`shouldAutoCollapse`). So this strip serves a SETTLED run scrolled past in
 * the transcript, plus any card the reader folded by hand mid-run — which is
 * why it has to carry terminal states legibly, not just a progress fraction.
 */

/** Failure statuses a STEP can actually settle to. The run-level vocabulary's
 *  "failed" is deliberately absent: `workflowStepKind` can never return it
 *  (a step's wire `final.status` has no such member), so counting it here
 *  would be a branch no fixture could ever reach. */
const WORKFLOW_STEP_FAILURE_KINDS: readonly SubStatusKind[] = ["error", "max_turns", "cancelled"];

/**
 * The strip's spoken form. It is ONE `role="img"` with a summarising label
 * rather than N announced nodes, because a screen reader walking 12 nameless
 * ticks learns nothing: the fact lives in the aggregate, not in the elements.
 *
 * Colour is precisely what a reader of this label cannot see, so the label
 * carries what the colours encode — including the failures, which a bare
 * "N of M done" would hide inside the unstated remainder. Running/queued/
 * pending stay unstated on purpose: they are the "not finished yet" rest, and
 * naming all six phases turns a glance into a sentence.
 */
export function workflowTickLabel(workflow: WorkflowSubStatus): string {
  const kinds = workflow.steps.map(workflowStepKind);
  const done = kinds.filter((kind) => kind === "completed").length;
  const failed = kinds.filter((kind) => WORKFLOW_STEP_FAILURE_KINDS.includes(kind)).length;
  const skipped = kinds.filter((kind) => kind === "skipped").length;
  // Counted against steps.length — the ticks actually drawn — not against
  // `totalSteps`. After slice S3's prefill the two agree, but if they ever
  // diverge the label must describe the strip the reader is looking at.
  const parts = [`${done} of ${kinds.length} steps done`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${workflow.workflow}: ${parts.join(", ")}`;
}

export function WorkflowCollapsedTicks({ workflow }: { workflow: WorkflowSubStatus }) {
  return (
    <span className="workflow-ticks" role="img" aria-label={workflowTickLabel(workflow)}>
      {/* Dependency order, not `steps` order: `steps` arrives in the run's
          DEFINITION order, so an unordered strip would reshuffle against the
          checklist the instant the card is expanded — the same tick would
          point at a different step in the two states. */}
      {orderStepsByDependency(workflow.steps).map((step) => (
        // Both classes on ONE node, deliberately: app.css's shared status->
        // colour map is written `.substatus-<kind> > .substatus-glyph`, a
        // CHILD combinator, so a tick that reused `.substatus-glyph` (or
        // leaned on an ancestor's class) would lose its colour silently the
        // moment this markup gained a level — the regression that already
        // killed the step rows' colour once. `.workflow-tick.substatus-<kind>`
        // is immune to depth, the form the map's nodes already use.
        <span key={step.stepId} className={`workflow-tick substatus-${workflowStepKind(step)}`} />
      ))}
    </span>
  );
}

/**
 * The card's header row (TASK.120): the disclosure toggle, plus — while a
 * session-tier child is blocked on a permission ask — the actionable child
 * badge riding BESIDE the toggle (a `<button>` cannot nest in the toggle
 * `<button>`). Every non-actionable card renders exactly one child here (the
 * toggle itself, width:100%), so the row is a layout pass-through for it.
 *
 * Exported (same rationale as `AgentCardBody` above) so ToolCallCard.test.ts
 * can render the row directly via react-dom/server: the badge mounts only
 * when `useChildSessionAction` resolves a child, and that hook reads the
 * tabs + child-relation zustand stores, whose server snapshot (SSR) is
 * frozen at the INITIAL state — `renderToStaticMarkup` cannot see any seed,
 * so there is no path from ToolCallCard's own props to the actionable-badge
 * markup in a static render. The row takes the resolved `childAction` as a
 * plain prop instead.
 */
export function ToolCallHeaderRow({
  block,
  expanded,
  bodyId,
  onToggleExpanded,
  childAction,
  previewAction,
}: {
  block: ToolCallBlock;
  expanded: boolean;
  bodyId: string;
  onToggleExpanded: () => void;
  childAction?: { badge: ChildBadgeKind; onOpen: (() => void) | undefined };
  /** TASK.112: resolved by ToolCallCard, passed as a plain prop for the same reason `childAction` is — a static render can see a prop, never a hook. */
  previewAction?: ArtifactPreviewAction;
}) {
  const isAgent = block.toolName === "Agent";
  // TASK.120: an actionable badge (waiting for permission + onOpen) cannot
  // render inside the toggle <button> — nested buttons are invalid HTML — so
  // it is hoisted out into this row wrapper; every other kind keeps its
  // original in-toggle placement, byte-identical markup.
  const headerBadgeActionable =
    childAction !== undefined && isClickableChildBadge(childAction.badge, childAction.onOpen);
  return (
    <div className="tool-call-toggle-row">
      <button
        type="button"
        className="tool-call-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggleExpanded}
      >
        <span className="tool-call-caret" aria-hidden="true">
          <Chevron />
        </span>
        {isAgent && !expanded ? (
          <span className="subagent-collapsed-line">
            <BotIcon />
            <span className="subagent-name">SubAgent</span>
            {block.subagent && <span className="subagent-persona">{block.subagent.agentType}</span>}
            {/* The collapsed row is the DEFAULT state, so a model that only
                showed once expanded would be invisible in practice. */}
            {block.subagent?.model != null && (
              <span className="subagent-collapsed-model">{block.subagent.model}</span>
            )}
            <span className="tool-call-summary">{flattenSummary(summarizeInput(block.toolName, block.input))}</span>
          </span>
        ) : (
          <>
            <span className="tool-call-name">{block.toolName}</span>
            {!expanded && (
              <span className="tool-call-summary">{flattenSummary(summarizeInput(block.toolName, block.input))}</span>
            )}
          </>
        )}
        {/* TASK.191 slice S7: the run's shape while the card is folded. Guarded
            on a non-empty `steps` so a card seeded before `workflow_start`
            lands renders no empty strip. */}
        {block.workflow !== null && !expanded && block.workflow.steps.length > 0 && (
          <WorkflowCollapsedTicks workflow={block.workflow} />
        )}
        <span className="tool-call-status-badge">{STATUS_LABELS[block.status]}</span>
        {/* TASK.102 CUT-S2 §2.5 (C3): the session-child badge lives in the
            ALWAYS-visible toggle row, not just the expanded body below — an
            Agent card defaults to COLLAPSED in every status
            (defaultExpanded above), so a "waiting for permission" signal
            that only showed once expanded would be invisible in practice
            (the owner's live-smoke checklist, CUT-S2 §8 point 4, checks the
            badge on the — by default collapsed — master card). TASK.120:
            while the child is blocked on a permission ask the badge is
            hoisted out of this button (see headerBadgeActionable above). */}
        {childAction !== undefined && !headerBadgeActionable && (
          <ChildBadge badge={childAction.badge} onOpen={undefined} />
        )}
        {isAgent && !expanded && block.subagent && block.subagent.final === null && (
          <span className="subagent-collapsed-progress">
            <Spinner className="icon-spin" />
            {formatSubagentCounters(block.subagent)}
          </span>
        )}
      </button>
      {/* TASK.120: the actionable badge — same onOpen as the Open button,
          riding at the row's end, clear of the toggle's own click target. */}
      {childAction !== undefined && headerBadgeActionable && (
        <ChildBadge badge={childAction.badge} onOpen={childAction.onOpen} />
      )}
      {/* TASK.112: the open-in-preview control for a document this card
          wrote/read. It rides HERE, in the always-visible row, and not on the
          path text itself, for two reasons: the path lives inside the toggle
          <button> (nested buttons are invalid HTML — the same constraint that
          hoisted the actionable badge above), and a settled card auto-
          collapses, so a control that only appeared once expanded would be
          invisible in the common case. One control only: a second one in the
          expanded body would repeat this exact `artifacts.preview` call,
          which is the redundancy the night-track smoke already removed once
          from the artifact chip. */}
      {previewAction !== undefined && (
        <>
          <button
            type="button"
            className="tool-call-open"
            title={`Open ${previewAction.path} in the preview window`}
            onClick={previewAction.open}
          >
            Open
          </button>
          {previewAction.error !== null && <span className="tool-call-open-error">{previewAction.error}</span>}
        </>
      )}
    </div>
  );
}

export function ToolCallCard({ block, enter = false }: { block: ToolCallBlock; enter?: boolean }) {
  // Default-unless-user-overrode disclosure (design §1.A): the default is
  // derived from status every render, so an untouched card auto-collapses on
  // settle with no effect/resync; a manual toggle sticks for this mount.
  // Pure derivation — StrictMode-safe. onClick negates the DERIVED value:
  // the first click always flips away from whatever the default shows.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? defaultExpanded(block.toolName, block.status);
  // Result cap (design §1.D) — survives card collapse/expand cycles because
  // it lives here, not in the unmounting body.
  const [resultExpanded, setResultExpanded] = useState(false);
  // Agent PROMPT plaque level-2 expand (design slice-P7.18-cut.md §4 W3
  // point 4) — independent of `resultExpanded` above; hoisted here (not
  // inside AgentCardBody) so it survives the card's own collapse/expand
  // cycles, same rationale as `resultExpanded`.
  const [promptExpanded, setPromptExpanded] = useState(false);
  // R17 a11y: bind the disclosure toggle to the body it controls.
  const bodyId = useId();
  // TASK.102 CUT-S2 §2.5 (C3): undefined for every card but a session-tier
  // child's — see the hook's own doc comment.
  const childAction = useChildSessionAction(block);
  const previewAction = useArtifactPreviewAction(previewablePathOf(block.toolName, block.input));

  const isDiffable = block.toolName === "Write" || block.toolName === "Edit";
  const hasSnapshot = block.snapshots.before !== null || block.snapshots.after !== null;
  const isAgent = block.toolName === "Agent";
  // Only cap when the body is shown: a folded card must not re-split its full
  // modelText on every sibling re-render (the slice's "keep giant-output cost
  // out while folded" thesis). The body's `capped !== null` guard keeps this
  // type-safe — capped is only read inside the `expanded` branch.
  const capped =
    expanded && !isAgent && block.modelText !== null ? capLines(block.modelText, RESULT_VISIBLE_LINES) : null;
  const parsedTodos = block.toolName === "TodoWrite" ? parseTodos(block.input) : null;

  return (
    // `data-tool-call-id` (design/slice-P7.18-cut.md §4 W4): the sole DOM hook
    // `agentCardState`'s automation probe uses to locate THIS card inside the
    // active tab's mounted transcript — same "tag the real node, no mirrored
    // state" discipline as MessageList's own `data-tab-id` (automation.ts's
    // `realTranscriptDom`).
    <div
      className={`tool-call-card tool-call-status-${block.status}${enter ? " message-enter" : ""}`}
      data-tool-call-id={block.toolCallId}
    >
      {/* TASK.120: the toggle gains a row wrapper because an actionable child
          badge rides BESIDE it, not inside it — a <button> cannot nest in the
          toggle <button>. Every non-actionable card renders exactly one child
          here (the toggle itself), so its layout is unchanged. */}
      <ToolCallHeaderRow
        block={block}
        expanded={expanded}
        bodyId={bodyId}
        onToggleExpanded={() => setUserExpanded(!expanded)}
        childAction={childAction}
        previewAction={previewAction ?? undefined}
      />
      {expanded && (
        // aria-live="off" (design §1.9): a user-driven expand must not dump
        // the body into the polite column's announcement queue; the badge in
        // the always-mounted toggle row remains the SR outcome signal.
        // .disclosure-open only when the expansion was user-driven — initial
        // mounts (running card streaming in) animate once via message-enter,
        // never twice.
        <div id={bodyId} className={`tool-call-body${userExpanded === true ? " disclosure-open" : ""}`} aria-live="off">
          {isAgent ? (
            // Agent-only 4-item hierarchy (design slice-P7.18-cut.md §4 W3):
            // header+counters / RESULT / activity feed / PROMPT plaque. The
            // generic path below (todos/input/workflow/diff/raw result) is
            // untouched for every other tool.
            <AgentCardBody
              block={block}
              promptExpanded={promptExpanded}
              onTogglePrompt={() => setPromptExpanded((value) => !value)}
              child={childAction}
            />
          ) : (
            <>
              {parsedTodos !== null ? (
                <TodoChecklist todos={parsedTodos} />
              ) : (
                <div className="tool-call-input">{summarizeInput(block.toolName, block.input)}</div>
              )}
              {block.workflow && <WorkflowStatus workflow={block.workflow} />}
              {isDiffable && hasSnapshot && (
                <div className="tool-call-diff-slot">
                  <DiffView before={block.snapshots.before} after={block.snapshots.after} path={diffPath(block)} />
                </div>
              )}
              {block.modelText !== null && capped !== null && (
                <>
                  <pre className="tool-call-result">{resultExpanded ? block.modelText : capped.visible}</pre>
                  {capped.hiddenCount > 0 && (
                    <button
                      type="button"
                      className="tool-call-result-expander"
                      aria-expanded={resultExpanded}
                      onClick={() => setResultExpanded((value) => !value)}
                    >
                      {resultExpanded ? "Show fewer lines" : moreLinesLabel(capped.hiddenCount)}
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
