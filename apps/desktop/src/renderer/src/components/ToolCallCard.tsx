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
import { useEffect, useId, useRef, useState } from "react";
import type { SubagentSubStatus, ToolCallBlock, WorkflowStepStatus, WorkflowSubStatus } from "../store.js";
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
  cancelled: "Cancelled",
};

const SUBAGENT_FINAL_LABELS: Record<NonNullable<SubagentSubStatus["final"]>["status"], string> = {
  completed: "Completed",
  max_turns: "Max turns reached",
  cancelled: "Cancelled",
  error: "Error",
};

/**
 * Pure formatter for the sub-status counter line, exported for direct unit
 * testing (this package's renderer tests are pure-logic only — no jsdom, see
 * ToolCallCard.test.ts). While running (`final === null`): "turn N · M tool
 * call(s)[ · lastTool]". Once settled: "<label> · N turn(s) · D.Ds".
 */
export function formatSubagentCounters(subagent: SubagentSubStatus): string {
  if (subagent.final === null) {
    const toolCalls = `${subagent.toolCalls} tool call${subagent.toolCalls === 1 ? "" : "s"}`;
    const lastTool = subagent.lastTool ? ` · ${subagent.lastTool}` : "";
    return `turn ${subagent.turns} · ${toolCalls}${lastTool}`;
  }
  const turns = `${subagent.turns} turn${subagent.turns === 1 ? "" : "s"}`;
  const seconds = (subagent.final.durationMs / 1000).toFixed(1);
  return `${SUBAGENT_FINAL_LABELS[subagent.final.status]} · ${turns} · ${seconds}s`;
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
 * for the most-recently-started step still in flight, or just "step i/N" if
 * every started step has already settled (between DAG waves — a step is
 * "ready" but its `workflow_step_start` hasn't landed yet). Once settled:
 * "<label> · completed/total steps · D.Ds".
 */
export function formatWorkflowCounters(workflow: WorkflowSubStatus): string {
  if (workflow.final === null) {
    const stepsStarted = workflow.steps.length;
    const running = [...workflow.steps].reverse().find((step) => step.final === null);
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

/** Union of every sub-status outcome across subagent/step/run vocabularies, plus synthetic "running". */
export type SubStatusKind =
  | "running"
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

/** Header line 2. final !== null → formatWorkflowCounters(workflow) (delegation
 *  keeps the frozen export rendered); else `step ${steps.length}/${totalSteps}`
 *  — the bare aggregate, so the header never duplicates the per-step ticker
 *  rendered in the row directly below it. */
export function workflowRunLabel(workflow: WorkflowSubStatus): string {
  if (workflow.final !== null) {
    return formatWorkflowCounters(workflow);
  }
  return `step ${workflow.steps.length}/${workflow.totalSteps}`;
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
 *  noise — omitted). */
export function workflowStepMeta(step: WorkflowStepStatus): string {
  if (step.final === null) {
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
 *  status carrier on completed/running rows — AT must not lose it). running and
 *  completed inject the status word; other settled states rely on the meta
 *  string already leading with the label. */
export function workflowStepAria(step: WorkflowStepStatus): string {
  const meta = workflowStepMeta(step);
  if (step.final === null) {
    return `${step.stepId} · ${step.agentType} · Running · ${meta}`;
  }
  if (step.final.status === "completed") {
    return `${step.stepId} · ${step.agentType} · Completed · ${meta}`;
  }
  return `${step.stepId} · ${step.agentType} · ${meta}`;
}

/** Pending aggregate. n = totalSteps − steps.length; n <= 0 → null (hostile
 *  over-delivery guarded). Renders live AND post-final (explains why
 *  completedSteps < totalSteps after a failed/cancelled run). */
export function pendingStepsLabel(workflow: WorkflowSubStatus): string | null {
  const n = workflow.totalSteps - workflow.steps.length;
  if (n <= 0) {
    return null;
  }
  return `${n} step${n === 1 ? "" : "s"} not started`;
}

/** Human status word for the SR-only span beside a step's glyph (R17 a11y):
 *  the glyph is the only visual status carrier and the li's aria-label has
 *  spotty SR support, so the word rides inline as real (visually-hidden) text. */
const SUBSTATUS_WORD: Record<SubStatusKind, string> = {
  running: "Running",
  completed: "Completed",
  max_turns: "Max turns reached",
  cancelled: "Cancelled",
  error: "Error",
  skipped: "Skipped",
  failed: "Failed",
};

/** Shared status glyph cell: one shape per outcome, color supplied by the
 *  parent's `substatus-*` class (error/failed/cancelled all fall through to X).
 *  Private — the pure formatters carry the test surface. */
function StatusGlyph({ kind }: { kind: SubStatusKind }) {
  return (
    <span className="substatus-glyph">
      {kind === "running" ? (
        <Spinner className="icon-spin" />
      ) : kind === "completed" ? (
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

/** Sub-status region mounted below the input summary when `block.workflow` is
 *  set (Workflow tool only). A run header (glyph · workflow name · aggregate)
 *  above a flat vertical checklist of started steps + one honest pending line. */
function WorkflowStatus({ workflow }: { workflow: WorkflowSubStatus }) {
  const runKind = substatusKind(workflow.final);
  const pending = pendingStepsLabel(workflow);
  return (
    <div className="tool-call-workflow">
      <div className={`tool-call-workflow-line substatus-${runKind}`}>
        <StatusGlyph kind={runKind} />
        <span className="tool-call-workflow-label">{workflow.workflow}</span>
      </div>
      <div className="tool-call-workflow-counters">{workflowRunLabel(workflow)}</div>
      {(workflow.steps.length > 0 || pending !== null) && (
        <ul className="workflow-steps">
          {workflow.steps.map((step) => {
            const kind = substatusKind(step.final);
            return (
              <li
                key={step.stepId}
                className={`workflow-step substatus-${kind}`}
                aria-label={workflowStepAria(step)}
              >
                <StatusGlyph kind={kind} />
                <span className="visually-hidden">{SUBSTATUS_WORD[kind]}</span>
                <span className="workflow-step-id">{step.stepId}</span>
                <span className="workflow-step-agent">{step.agentType}</span>
                <span className="workflow-step-meta">{workflowStepMeta(step)}</span>
              </li>
            );
          })}
          {pending !== null && (
            <li className="workflow-step workflow-step-pending">
              <span className="substatus-glyph" aria-hidden="true" />
              {pending}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Sub-status region mounted below the input summary when `block.subagent` is
 *  set (Agent tool only). A flat two-line panel sharing the row atoms: glyph ·
 *  persona (mono anchor) · description, then the frozen counters line. */
function SubagentStatus({ subagent }: { subagent: SubagentSubStatus }) {
  const kind = substatusKind(subagent.final);
  return (
    <div className="tool-call-subagent">
      <div className={`tool-call-subagent-line substatus-${kind}`}>
        <StatusGlyph kind={kind} />
        <span className="tool-call-subagent-persona">{subagent.agentType}</span>
        <span className="tool-call-subagent-desc">{subagent.description}</span>
      </div>
      <div className="tool-call-subagent-counters">{formatSubagentCounters(subagent)}</div>
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
}: {
  block: ToolCallBlock;
  promptExpanded: boolean;
  onTogglePrompt: () => void;
}) {
  const resultText = agentResultText(block);
  const prompt = agentPromptText(block.input);
  const strip = prompt !== null ? promptStripText(prompt) : null;
  return (
    <>
      {block.subagent && <SubagentStatus subagent={block.subagent} />}
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
 * Consonance rule: auto-collapse ⟺ the status badge is not danger-tinted
 * (app.css tints error/invalid_input/denied/timed_out danger — failures
 * deserve attention and stay open). cancelled is user-initiated and carries
 * no diagnostic payload, so it folds. proposed/running are not settled.
 * Unknown future statuses fall through to false: fail-visible. */
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
      <button
        type="button"
        className="tool-call-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setUserExpanded(!expanded)}
      >
        <span className="tool-call-caret" aria-hidden="true">
          <Chevron />
        </span>
        {isAgent && !expanded ? (
          <span className="subagent-collapsed-line">
            <BotIcon />
            <span className="subagent-name">SubAgent</span>
            {block.subagent && <span className="subagent-persona">{block.subagent.agentType}</span>}
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
        <span className="tool-call-status-badge">{STATUS_LABELS[block.status]}</span>
        {isAgent && !expanded && block.subagent && block.subagent.final === null && (
          <span className="subagent-collapsed-progress">
            <Spinner className="icon-spin" />
            {formatSubagentCounters(block.subagent)}
          </span>
        )}
      </button>
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
