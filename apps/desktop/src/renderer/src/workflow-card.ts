/**
 * Persisted workflow card decode + projection (TASK.191 slice S5). Mirror of
 * subagent-card.ts's decode/project pair, adapted for a DAG run rather than
 * one child: two pure functions, no I/O.
 *
 * - `decodeWorkflowCardSnapshot` is the LAST line of defense on the read
 *   path: `loadHistory` parses persisted JSON with an unchecked `JSON.parse`
 *   (sqlite-persistence.ts), so a `presentation.workflow` blob reaching this
 *   function can be anything — a stale/foreign shape, a future writer's
 *   version, or outright garbage. It NEVER throws; any structural mismatch
 *   decodes to `null` (fail-soft), while an oversized-but-well-typed payload
 *   is normalized (sliced/ring-capped) rather than rejected, mirroring
 *   `packages/core/src/workflow/card-snapshot.ts`'s write-side reducer.
 * - `projectWorkflowCard` is a straight field mapping onto the existing
 *   renderer `WorkflowSubStatus` shape (store.ts) — the same shape the LIVE
 *   `workflow_*` event patches already populate, so a hydrated card renders
 *   through the SAME `WorkflowStepsBody`/`WorkflowActivityFeed` atoms
 *   (ToolCallCard.tsx) with no component changes.
 *
 * Types are type-only imports from `@anycode/core` (subagent-card.ts's own
 * precedent): all renderer PRODUCTION code imports core type-only, never as
 * a value — a value import pulls the whole core module graph (node
 * dependencies included) into the browser bundle.
 *
 * Only `WorkflowCardSnapshotV1` itself is imported by name: unlike the
 * subagent side (`SubagentCardActivityEntry`/`SubagentCardFinalStatus`/
 * `SubagentCardTarget` are each individually exported from `@anycode/core`'s
 * curated barrel), core's `types/index.ts` and `package.json` `exports` map
 * do not re-export `WorkflowCardStep`/`WorkflowCardStepResult`/
 * `WorkflowCardActivityEntry`/`WorkflowCardRunStatus`/`WorkflowCardStepStatus`/
 * `WorkflowCardTokenUsage` (packages/core/src/types/workflow-card.ts) under
 * ANY path — confirmed by reading types/index.ts's curated `config.js`
 * re-export list and package.json's `exports` allowlist, neither of which
 * carries them (only `WORKFLOW_OUTPUT_MAX_BYTES` and friends, the
 * *definition-time* workflow constants, made that list — not the S5 card
 * constants below, nor the nested card types). The nested shapes are
 * therefore derived locally via indexed-access types off the one exported
 * interface (`WorkflowCardStepT` etc. below) rather than imported by name.
 * This is a gap in TASK.191 S5's core half, not a design choice here — see
 * this file's sibling test for the parity coverage this gap leaves out.
 *
 * The five cap constants below are re-declared locally for the same
 * value-import-forbidden reason as subagent-card.ts's own five; their
 * parity with the real values is asserted where a real value CAN be
 * reached — see workflow-card.test.ts's parity-test block and its own note
 * on the two constants that cannot be checked this way.
 */
import type { WorkflowCardSnapshotV1 } from "@anycode/core";
import type { WorkflowSubStatus } from "./store.js";

type WorkflowCardStepT = WorkflowCardSnapshotV1["steps"][number];
type WorkflowCardActivityT = WorkflowCardSnapshotV1["activity"];
type WorkflowCardActivityEntryT = WorkflowCardActivityT["entries"][number];
type WorkflowCardFinalT = WorkflowCardSnapshotV1["final"];
type WorkflowCardRunStatusT = WorkflowCardFinalT["status"];
type WorkflowCardStepResultT = NonNullable<WorkflowCardStepT["result"]>;
type WorkflowCardStepStatusT = WorkflowCardStepResultT["status"];
type WorkflowCardTokenUsageT = NonNullable<WorkflowCardStepResultT["usage"]>;

// Local mirrors of packages/core/src/types/config.ts's WORKFLOW_CARD_*
// constants (types/config.ts:388-390, read directly — not importable, see
// the module doc comment above). MUST stay numerically equal to the real
// exports; workflow-card.test.ts pins what it can reach.
export const WORKFLOW_CARD_ACTIVITY_RING = 200;
export const WORKFLOW_CARD_ACTIVITY_MAX_BYTES = 65_536;

// Mirrors of packages/core/src/types/config.ts's SUBAGENT_ACTIVITY_TOOL_NAME_MAX_CHARS
// (80) and packages/core/src/subagents/summarize-tool.ts's
// SUBAGENT_ACTIVITY_SUMMARY_MAX_CHARS (160) — the workflow activity lane's
// per-entry toolName/summary fields are sanitized at the same bridge
// discipline as the subagent lane (tools/agent.ts), so the same limits
// apply; both real constants ARE exported from `@anycode/core` (unlike the
// two ring/byte constants above), so the test file pins these for real.
export const ACTIVITY_TOOL_NAME_MAX_CHARS = 80;
export const ACTIVITY_SUMMARY_MAX_CHARS = 160;

/**
 * Cap on an activity entry's `stepId`. No core-side constant exists to
 * mirror (the write-side reducer, card-snapshot.ts, never caps `stepId`
 * individually — only the whole entry via the ring/byte caps above), so
 * this is a renderer-only defensive value, not a drift-checkable pin.
 * Grounded in the real ceiling on a step id: `NAME_RE` in
 * packages/core/src/workflow/schema.ts:51 accepts at most 64 characters
 * (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`), the same alphabet/length rule
 * `SKILL_NAME_MAX_CHARS` (types/config.ts:440) uses for the analogous
 * skill-name field — 64 is therefore already the true maximum a legally
 * authored step id can reach, this constant just hardens decode against a
 * corrupted/hostile payload claiming a longer one.
 */
export const ACTIVITY_STEP_ID_MAX_CHARS = 64;

const RUN_STATUSES: ReadonlySet<WorkflowCardRunStatusT> = new Set(["completed", "failed", "cancelled"]);
const STEP_STATUSES: ReadonlySet<WorkflowCardStepStatusT> = new Set([
  "completed",
  "max_turns",
  "cancelled",
  "error",
  "skipped",
]);
const USAGE_KEYS = ["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"] as const;

/** Caps `text` to `maxChars` CODE POINTS (never mid-surrogate-pair), truncating without an ellipsis marker. Mirrors card-snapshot.ts's write-side helper (and subagent-card.ts's own copy). */
function capCodePoints(text: string, maxChars: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= maxChars ? text : codePoints.slice(0, maxChars).join("");
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeStepResult(raw: unknown): WorkflowCardStepResultT | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const { status, turns, durationMs, usage: rawUsage } = raw;
  if (typeof status !== "string" || !STEP_STATUSES.has(status as WorkflowCardStepStatusT)) return null;
  if (!isNonNegativeSafeInteger(turns)) return null;
  if (!isNonNegativeSafeInteger(durationMs)) return null;

  let usage: WorkflowCardTokenUsageT | undefined;
  if (rawUsage !== undefined) {
    if (!isPlainObject(rawUsage)) return null;
    const decoded: WorkflowCardTokenUsageT = {};
    for (const key of USAGE_KEYS) {
      const value = rawUsage[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      decoded[key] = value;
    }
    usage = decoded;
  }

  return {
    status: status as WorkflowCardStepStatusT,
    turns,
    durationMs,
    ...(usage !== undefined ? { usage } : {}),
  };
}

function decodeStep(raw: unknown): WorkflowCardStepT | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const { id, agentType, dependsOn: rawDependsOn, result: rawResult } = raw;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof agentType !== "string") return null;

  let dependsOn: readonly string[] | undefined;
  if (rawDependsOn !== undefined) {
    if (!Array.isArray(rawDependsOn) || !rawDependsOn.every((entry): entry is string => typeof entry === "string")) {
      return null;
    }
    dependsOn = rawDependsOn;
  }

  let result: WorkflowCardStepResultT | undefined;
  if (rawResult !== undefined) {
    const decoded = decodeStepResult(rawResult);
    if (decoded === null) return null;
    result = decoded;
  }

  return {
    id,
    agentType,
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

/**
 * Normalizes the activity ring/byte caps exactly like
 * `reduceWorkflowCardEvent` (packages/core/src/workflow/card-snapshot.ts):
 * evicts the OLDEST surviving entry until both caps are satisfied, so the
 * tail (most recent activity, from whichever step produced it — this lane
 * is shared by every concurrent step of the run) always survives regardless
 * of which cap binds. Single backward pass for the same reason
 * subagent-card.ts's own `decodeActivity` uses one (a naive per-eviction
 * `shift()`/`slice(1)` is O(n²) on a large/corrupted payload); this is a
 * defensive hardening path (S5's own writer never exceeds these caps), so a
 * payload that DOES exceed them here only happens via corruption/tampering
 * — still honestly counted into `dropped` rather than silently shortened.
 */
function decodeActivity(raw: unknown): WorkflowCardActivityT | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const { entries: rawEntries, dropped } = raw;
  if (!Array.isArray(rawEntries)) return null;
  if (!isNonNegativeSafeInteger(dropped)) return null;

  const normalized: WorkflowCardActivityEntryT[] = [];
  for (const entry of rawEntries) {
    if (!isPlainObject(entry)) return null;
    const { stepId, toolName, summary } = entry;
    if (typeof stepId !== "string" || typeof toolName !== "string" || typeof summary !== "string") return null;
    normalized.push({
      stepId: capCodePoints(stepId, ACTIVITY_STEP_ID_MAX_CHARS),
      toolName: capCodePoints(toolName, ACTIVITY_TOOL_NAME_MAX_CHARS),
      summary: capCodePoints(summary, ACTIVITY_SUMMARY_MAX_CHARS),
    });
  }

  const n = normalized.length;
  let survivingCount = 0;
  let bytesAccum = 0;
  let startIndex = n;
  for (let i = n - 1; i >= 0; i--) {
    const entry = normalized[i];
    if (entry === undefined) break;
    const entryBytes = utf8ByteLength(entry.stepId) + utf8ByteLength(entry.toolName) + utf8ByteLength(entry.summary);
    if (survivingCount + 1 > WORKFLOW_CARD_ACTIVITY_RING || bytesAccum + entryBytes > WORKFLOW_CARD_ACTIVITY_MAX_BYTES) {
      break;
    }
    bytesAccum += entryBytes;
    survivingCount += 1;
    startIndex = i;
  }
  const entries = startIndex === 0 ? normalized : normalized.slice(startIndex);
  const extraDropped = n - survivingCount;

  return { entries, dropped: dropped + extraDropped };
}

function decodeFinal(raw: unknown): WorkflowCardFinalT | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const { status, durationMs } = raw;
  if (typeof status !== "string" || !RUN_STATUSES.has(status as WorkflowCardRunStatusT)) return null;
  if (!isNonNegativeSafeInteger(durationMs)) return null;
  return { status: status as WorkflowCardRunStatusT, durationMs };
}

/**
 * Decodes an untrusted `presentation.workflow` blob into a validated
 * `WorkflowCardSnapshotV1`, or `null` on ANY structural mismatch (fail-soft
 * — see module doc comment). `ctx.toolName` gates on the Workflow tool
 * specifically (a workflow presentation planted on a foreign tool's result
 * is ignored — same defense-in-depth as decodeSubagentCardSnapshot's `Agent`
 * gate). `ctx.toolCallId` is accepted for call-site signature parity with
 * `decodeSubagentCardSnapshot` (both decoders are invoked from the same
 * transcript-hydration call site) but is not otherwise used: unlike
 * `SubagentCardTarget`'s `session` variant, `WorkflowCardSnapshotV1` carries
 * no id that must correlate back to the paired tool call.
 */
export function decodeWorkflowCardSnapshot(
  value: unknown,
  ctx: { toolCallId: string; toolName: string },
): WorkflowCardSnapshotV1 | null {
  try {
    if (ctx.toolName !== "Workflow") return null;
    if (!isPlainObject(value)) return null;
    const {
      kind,
      version,
      workflow,
      totalSteps,
      steps: rawSteps,
      activity: rawActivity,
      final: rawFinal,
    } = value;
    if (kind !== "workflow") return null;
    if (version !== 1) return null;
    if (typeof workflow !== "string" || workflow.length === 0) return null;
    if (!isNonNegativeSafeInteger(totalSteps)) return null;
    if (!Array.isArray(rawSteps)) return null;

    const steps: WorkflowCardStepT[] = [];
    for (const rawStep of rawSteps) {
      const step = decodeStep(rawStep);
      if (step === null) return null;
      steps.push(step);
    }

    const activity = decodeActivity(rawActivity);
    if (activity === null) return null;

    // REQUIRED (mirror of SubagentCardSnapshotV1's `final`, CUT-S1 §0.4 —
    // workflow-card.ts's own doc comment carries the same rule for this
    // shape): a persisted snapshot without a terminal status is a
    // contradiction — `finalizeWorkflowCard` (core) never writes one.
    const final = decodeFinal(rawFinal);
    if (final === null) return null;

    return { kind: "workflow", version: 1, workflow, totalSteps, steps, activity, final };
  } catch {
    return null;
  }
}

/**
 * Straight field mapping onto `WorkflowSubStatus` (store.ts). Rules below
 * are settled projection policy, each justified independently:
 *
 * - `workflow`/`totalSteps`/`activity`/`activityDropped` are direct
 *   transfers off the snapshot's own run-level fields.
 * - Per step, `dependsOn` defaults to `[]` (absent on the snapshot means "no
 *   dependencies", the same reading `WorkflowCardStep`'s own doc comment
 *   gives it) and `turns`/`usage` fall back to `0`/`null` when the step
 *   never got a `result` at all (absent-tier-report must render as absent,
 *   never a fabricated zero — `usage` mirrors that; `turns` has no
 *   "unreported" state in `WorkflowStepStatus`, so `0` is the only faithful
 *   value for a step with no result).
 * - `started` is `true` only when the step has a `result` AND that result's
 *   status is not `"skipped"`: `skipped` is engine.ts's own synthetic
 *   terminal for a step that never launched at all (fail-fast/cancellation
 *   froze it before its dependencies were ever satisfied), so it must read
 *   the same as "never started" — exactly what the live card already shows
 *   before `workflow_step_start` ever arrives (TASK.191 slice S3).
 * - `running` is always `false`: this snapshot is only ever written once
 *   the whole Workflow tool call has settled (see `final` below), so by
 *   construction nothing in it can still be executing.
 * - `toolCalls: 0` and `lastTool: null` are NOT a lossy "we don't know" —
 *   the snapshot never carries these counters at all (deliberate: see
 *   packages/core/src/workflow/card-snapshot.ts:102-110, the
 *   `workflow_step_progress` no-op branch), so there is no real value to
 *   recover. The zero is safe rather than a fabrication ONLY because every
 *   renderer read of `WorkflowStepStatus.toolCalls`/`.lastTool` is gated
 *   behind `step.final === null` (ToolCallCard.tsx:190-191's `running`
 *   lookup, itself only reached when `workflow.final === null`;
 *   ToolCallCard.tsx:279-280 inside `workflowStepMeta`, only reached when
 *   `step.final === null && step.started && step.running`) — and a
 *   hydrated card's steps ALWAYS have `final !== null` whenever they have a
 *   `result` (the branch above), with `started` false whenever `final` IS
 *   null (no `result` at all), which makes `workflowStepMeta`'s
 *   `!step.started` branch ("Not started") the one that fires instead — so
 *   the toolCalls/lastTool read is provably unreachable for any card this
 *   function produces. workflow-card.test.ts pins the invariant this relies
 *   on (`final !== null` whenever `result` was present) directly, so a
 *   future change that breaks it fails a test, not just this comment.
 * - Step `final` is `{ status, durationMs }` off `step.result` when present,
 *   else `null` — `WorkflowStepStatus["final"]` (store.ts) carries exactly
 *   those two fields, verified by reading the interface directly rather
 *   than assumed.
 * - Run `final.completedSteps` has no snapshot field to copy: `final` (run)
 *   only carries `status`/`durationMs` (WorkflowCardSnapshotV1's own type),
 *   so it is a derived count of steps whose own `result.status ===
 *   "completed"` — deliberately NOT `steps.length` (would count
 *   error/max_turns/cancelled/skipped steps as completed) and NOT a stored
 *   snapshot field (there isn't one). workflow-card.test.ts pins this
 *   derivation against a mixed-outcome fixture.
 */
export function projectWorkflowCard(snapshot: WorkflowCardSnapshotV1): WorkflowSubStatus {
  const completedSteps = snapshot.steps.filter((step) => step.result?.status === "completed").length;
  return {
    workflow: snapshot.workflow,
    totalSteps: snapshot.totalSteps,
    steps: snapshot.steps.map((step) => ({
      stepId: step.id,
      agentType: step.agentType,
      dependsOn: step.dependsOn ?? [],
      turns: step.result?.turns ?? 0,
      toolCalls: 0,
      lastTool: null,
      usage: step.result?.usage ?? null,
      started: step.result !== undefined && step.result.status !== "skipped",
      running: false,
      final: step.result !== undefined ? { status: step.result.status, durationMs: step.result.durationMs } : null,
    })),
    activity: snapshot.activity.entries.map((entry) => ({ ...entry })),
    activityDropped: snapshot.activity.dropped,
    final: { status: snapshot.final.status, completedSteps, durationMs: snapshot.final.durationMs },
  };
}
