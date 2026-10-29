/**
 * Pure W0-fixture-driven projection from Codex app-server notifications into
 * existing AgentEvent variants. It does not decide approvals, invoke tools, or
 * interpret unobserved protocol families.
 */

import type { AgentEvent, CodexRateLimitsWire, FinishReason, ToolCallOutcome, ToolCallStatus } from "@anycode/core";
import type { JsonRpcNotification } from "./protocol.js";
import type { TurnItemIndex } from "./turn-item-index.js";
import { CollabAgentCardIndex } from "./collab-agent-index.js";

/** One sub-tool-call a single native item projects to — a `fileChange` with N files projects to N of these. */
type ToolProjection = { toolCallId: string; toolName: string; input: unknown };

/** TASK.95: the ONE honest, non-inferred persona label for a Codex collab child. Never refined from model/path. */
const CODEX_SUBAGENT_PERSONA = "codex subagent";
/** The outer Agent tool card's renderer tool name. */
const AGENT_TOOL_NAME = "Agent";
/** Bound for a single DISPLAYED generic field value (never applied to the dedicated spawn prompt). */
const GENERIC_VALUE_MAX = 2000;
const GENERIC_TRUNCATION_MARKER = " \u2026[truncated]";
/** Up to eight actual scalar fields reach a generic card (explicit counter — never `input.size`). */
const GENERIC_FIELD_LIMIT = 8;
const COLLAB_TOOL_TYPE = "collabAgentToolCall";
const SUBAGENT_ACTIVITY_TYPE = "subAgentActivity";

/**
 * Known conversation/plan/review/context bookkeeping surfaces and bridge-owned
 * dynamic tool calls: none of these may become a generic tool card. Centralized
 * so dedicated collab/activity handling can never be mistaken for generic
 * recovery (TASK.95 §3).
 */
const EXCLUDED_ITEM_TYPES = new Set<string>([
  "userMessage",
  "hookPrompt",
  "agentMessage",
  "reasoning",
  "plan",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
  "dynamicToolCall",
  COLLAB_TOOL_TYPE,
  SUBAGENT_ACTIVITY_TYPE,
]);

/**
 * Generic cards for the handful of non-family item types with a KNOWN display
 * field set. Explicit order both keeps the card readable and, for `imageView`,
 * refuses to inline a raw base64 `image` field (only the actual `path`).
 */
const DEDICATED_GENERIC_FIELDS: Record<string, readonly string[]> = {
  imageView: ["path"],
  sleep: ["durationMs"],
  imageGeneration: ["savedPath", "revisedPrompt", "status", "result"],
};

function boundGenericString(value: string): string {
  return value.length > GENERIC_VALUE_MAX ? value.slice(0, GENERIC_VALUE_MAX) + GENERIC_TRUNCATION_MARKER : value;
}

/**
 * Extracts up to {@link GENERIC_FIELD_LIMIT} ACTUAL scalar input fields from an
 * item (excluding `id`/`type`), bounding displayed strings. Missing/nested
 * values are skipped — never invented.
 */
function genericInput(item: Record<string, unknown>, order?: readonly string[]): Record<string, unknown> {
  const keys = order ?? Object.keys(item);
  const input: Record<string, unknown> = {};
  let count = 0;
  for (const key of keys) {
    if (key === "id" || key === "type") continue;
    const value = item[key];
    if (value === null || value === undefined) continue;
    const kind = typeof value;
    if (kind === "string") input[key] = boundGenericString(value as string);
    else if (kind === "number" || kind === "boolean") input[key] = value;
    else continue;
    count += 1;
    if (count >= GENERIC_FIELD_LIMIT) break;
  }
  return input;
}

/**
 * Generic operation completion status: only EXPLICIT failure/denial/
 * cancellation markers map away from success. A missing or unfamiliar
 * free-form status is NEVER turned into a fabricated error — it stays a
 * "receipt of item/completed" success with the raw value carried visibly
 * (TASK.95 §4).
 */
function genericStatusFor(itemStatus: unknown): ToolCallStatus {
  if (itemStatus === "failed" || itemStatus === "error") return "error";
  if (itemStatus === "declined" || itemStatus === "denied") return "denied";
  if (itemStatus === "interrupted" || itemStatus === "cancelled") return "cancelled";
  return "success";
}

function isDedupedFamily(itemType: unknown): boolean {
  return isToolFamily(itemType) || itemType === COLLAB_TOOL_TYPE || itemType === SUBAGENT_ACTIVITY_TYPE;
}

/** Non-empty string members of a wire array, in wire order. */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Decodes a collab `agentsStates` map into observations. Entries without a
 * string `status` are dropped (never invented); the optional `message` is kept
 * only when it is an actual non-empty string.
 */
function normalizeStates(raw: unknown): Record<string, { status: string; message?: string }> {
  const value = record(raw);
  if (value === null) return {};
  const states: Record<string, { status: string; message?: string }> = {};
  for (const [receiver, rawState] of Object.entries(value)) {
    const state = record(rawState);
    if (state === null || typeof state.status !== "string") continue;
    const message = typeof state.message === "string" && state.message.length > 0 ? state.message : undefined;
    states[receiver] = { status: state.status, ...(message !== undefined ? { message } : {}) };
  }
  return states;
}

function stateSummary(observation: { status: string; message?: string }): string {
  return observation.message !== undefined ? `${observation.status}: ${observation.message}` : observation.status;
}

/** Real `subAgentActivity` fields only — kind/path/thread, never invented. */
function activitySummary(item: Record<string, unknown>): string {
  const kind = typeof item.kind === "string" ? item.kind : "activity";
  const path = typeof item.agentPath === "string" && item.agentPath.length > 0 ? item.agentPath : undefined;
  const thread = typeof item.agentThreadId === "string" && item.agentThreadId.length > 0 ? item.agentThreadId : undefined;
  return [kind, path, thread].filter((part): part is string => part !== undefined).join(" · ");
}

/**
 * The engine-owned quota tracker's narrow face (quota.ts `CodexQuotaTracker`,
 * codex-profiles cut §6.3): folds one `account/rateLimits/updated` push into
 * the session's merged snapshot via the frozen sparse-merge and returns that
 * MERGED snapshot — or null for an undecodable push. The translator only ever
 * APPLIES this seam; it never assembles a quota snapshot itself (a from-scratch
 * snapshot is exactly the "sparse null wipes known data" defect §6.3 forbids).
 */
export interface QuotaUpdateSink {
  applyUpdate(params: unknown): CodexRateLimitsWire | null;
}

export interface TurnTranslatorOptions {
  threadId: string;
  turnId: string;
  turn: number;
  onUsage?: (usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; totalTokens?: number }) => void;
  /**
   * Approval-correlation index for this turn (cut §2(l)). Every `item/started`
   * of the turn is recorded here — including item types this renderer adapter
   * does not project — because an approval request names only an `itemId` and
   * the modal has to describe what is being approved.
   */
  items?: TurnItemIndex;
  /** Session-lifetime quota tracker (codex-profiles cut §6); absent -> quota pushes are silently dropped. */
  quota?: QuotaUpdateSink;
  /**
   * Engine-owned SESSION-lifetime collab correlation index (TASK.95). The
   * engine constructs exactly ONE of these and passes it to every per-turn
   * translator, so a `wait`/`sendInput`/`resumeAgent`/`closeAgent` (or a bare
   * `subAgentActivity`) observed in a LATER parent turn can still patch the
   * spawn card created earlier. Absent in direct unit tests -> the translator
   * falls back to a translator-local index so its behavior stays isolated.
   */
  collab?: CollabAgentCardIndex;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function matchingTurn(params: unknown, threadId: string, turnId: string): Record<string, unknown> | null {
  const value = record(params);
  return value?.threadId === threadId && value.turnId === turnId ? value : null;
}

function statusFor(itemStatus: unknown): ToolCallStatus {
  if (itemStatus === "completed") return "success";
  // The user's own deny must never read as a malfunction (C0 review Medium,
  // history-projection.ts's sibling fix — same defect, live side).
  if (itemStatus === "declined") return "denied";
  if (itemStatus === "cancelled" || itemStatus === "interrupted") return "cancelled";
  return "error";
}

function isToolFamily(itemType: unknown): boolean {
  return (
    itemType === "commandExecution" || itemType === "command_execution" ||
    itemType === "fileChange" || itemType === "file_change" ||
    itemType === "mcpToolCall" || itemType === "mcp_tool_call" ||
    itemType === "webSearch" || itemType === "web_search"
  );
}

/**
 * `commandExecution` -> one projection; `fileChange` -> one projection PER changed file (multi-file, cut §2(i)).
 * camelCase types are the pinned-contract shapes; snake_case aliases are an
 * explicit TASK.181 compatibility requirement, not shapes claimed observed in
 * pinned fixtures.
 */
function projectTools(item: Record<string, unknown>): ToolProjection[] {
  const itemId = typeof item.id === "string" ? item.id : "";
  if ((item.type === "commandExecution" || item.type === "command_execution") && typeof item.command === "string") {
    return [{
      toolCallId: itemId,
      toolName: "Bash",
      input: { command: item.command, ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}) },
    }];
  }
  // Recognized command execution with a missing/empty payload: keep one
  // fallback projection keyed by item id so an actual execution does not
  // silently disappear. Never fabricate command contents.
  if (item.type === "commandExecution" || item.type === "command_execution") {
    const input: Record<string, unknown> = {};
    if (typeof item.cwd === "string") input.cwd = item.cwd;
    return [{ toolCallId: itemId, toolName: "Bash", input }];
  }
  if ((item.type === "fileChange" || item.type === "file_change") && Array.isArray(item.changes) && item.changes.length > 0) {
    const projections: ToolProjection[] = [];
    item.changes.forEach((raw, index) => {
      const change = record(raw);
      if (change === null || typeof change.path !== "string") return;
      projections.push({
        toolCallId: `${itemId}:${index}`,
        toolName: "Write",
        input: { file_path: change.path, ...(typeof change.diff === "string" ? { content: change.diff } : {}) },
      });
    });
    return projections;
  }
  // Recognized file change with a missing/empty payload: one fallback Write
  // projection keyed by item id (available input fields only).
  if (item.type === "fileChange" || item.type === "file_change") {
    return [{ toolCallId: itemId, toolName: "Write", input: {} }];
  }
  if (item.type === "mcpToolCall" || item.type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "unknown";
    const tool = typeof item.tool === "string" ? item.tool : "unknown";
    return [{
      toolCallId: itemId,
      toolName: `mcp__${server}__${tool}`,
      input: item.arguments ?? item.input ?? {},
    }];
  }
  if (item.type === "webSearch" || item.type === "web_search") {
    return [{
      toolCallId: itemId,
      toolName: "WebSearch",
      input: typeof item.query === "string" ? { query: item.query } : {},
    }];
  }
  // TASK.95 dedicated generic cards for the non-family types with a KNOWN
  // display field set. Only ACTUAL fields are read; a raw base64 image field
  // is never inlined. Their status (imageGeneration's is free-form) rides the
  // generic outcome path, displayed rather than guessed.
  if (typeof item.type === "string" && item.type in DEDICATED_GENERIC_FIELDS) {
    return [{ toolCallId: itemId, toolName: `codex:${item.type}`, input: genericInput(item, DEDICATED_GENERIC_FIELDS[item.type]) }];
  }
  // Intentional exclusions: userMessage, hookPrompt, agentMessage (handled as
  // text separately), reasoning, plan, enteredReviewMode, exitedReviewMode and
  // contextCompaction are conversation/plan/review/context bookkeeping
  // surfaces, not tool executions. dynamicToolCall is excluded because
  // dynamic-tool-bridge.ts already emits call/start/result for bridge-owned
  // calls (projecting here would double-count). collabAgentToolCall and
  // subAgentActivity have DEDICATED handlers in TurnTranslator and must never
  // fall through to generic recovery.
  if (typeof item.type !== "string" || EXCLUDED_ITEM_TYPES.has(item.type)) return [];
  // TASK.95 PLAN RULE: any OTHER non-excluded string type is a future/unknown
  // family. It surfaces as an honest generic card rather than vanishing — an
  // unknown execution must never be silently dropped. Logged for diagnostics.
  // eslint-disable-next-line no-console
  console.warn(`[codex] unobserved item type projected as a generic card: ${item.type}`);
  return [{ toolCallId: itemId, toolName: `codex:${item.type}`, input: genericInput(item) }];
}

/** The renderer-side tool name whose card the TodoPanel projects (core's TodoWrite). */
const TODO_TOOL_NAME = "TodoWrite";

/** `TurnPlanStepStatus` (wire, camelCase) -> the TodoWrite status vocabulary the renderer speaks. */
const PLAN_STATUS: Record<string, "pending" | "in_progress" | "completed"> = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed",
};

/**
 * `turn/plan/updated` -> the `{todos:[{content,status}]}` input the renderer's
 * TodoPanel already reads off a settled `TodoWrite` card (TodoPanel.ts's
 * `selectCurrentTodos`/`parseTodos`). Projecting into that existing vocabulary
 * rather than a new event type is what makes the panel, the collapsed-card
 * summary and the jump-to-block affordance work for Codex for free.
 *
 * All-or-nothing, mirroring `parseTodos`' own contract: one malformed step
 * rejects the whole revision rather than silently shrinking the plan's N/M
 * counters. `null` therefore also covers an empty/absent plan — a synthetic
 * zero-todo card would be a permanently blank transcript entry whose only
 * effect is to hide the panel.
 *
 * An unknown `status` degrades to `pending` instead of rejecting: a status
 * enum widened by a future codex-cli must not blank a plan that is otherwise
 * perfectly readable.
 */
function projectPlanTodos(plan: unknown): { todos: { content: string; status: string }[] } | null {
  if (!Array.isArray(plan) || plan.length === 0) return null;
  const todos: { content: string; status: string }[] = [];
  for (const raw of plan) {
    const step = record(raw);
    if (step === null || typeof step.step !== "string" || step.step.length === 0) return null;
    const status = typeof step.status === "string" ? PLAN_STATUS[step.status] ?? "pending" : "pending";
    todos.push({ content: step.step, status });
  }
  return { todos };
}

/** A one-turn translator; callers must construct a fresh one for every native turn. */
export function decodeCodexContextUsage(params: unknown): Extract<AgentEvent, { type: "context_usage" }> | null {
  const usage = record(record(params)?.tokenUsage);
  const tokens = record(usage?.last)?.totalTokens;
  const window = usage?.modelContextWindow;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 &&
    typeof window === "number" && Number.isFinite(window) && window > 0
    ? { type: "context_usage", estimatedTokens: tokens, budgetTokens: window, source: "provider" } : null;
}

export class TurnTranslator {
  private readonly openText = new Set<string>();
  /**
   * Every native item id this translator has ever seen via `item/started`
   * (W18, external review MEDIUM — REAL post-W17): a native `item/started`
   * can be redelivered for an id already started. Pre-W17 that redelivery
   * was a harmless no-op (`onItemStarted` never created a block at all);
   * post-W17 it would append a SECOND `text_start`/`tool_call` for the same
   * id, and every later patch keyed by that id
   * (`text_delta`/`text_end`/`tool_execution_start`/`tool_result`) updates
   * ALL blocks sharing it — a live duplicate card, not merely a wasted
   * event. Never cleared: a completed item redelivering `item/started`
   * afterwards must stay a no-op too.
   */
  private readonly startedItemIds = new Set<string>();
  /** Keyed by the SUB toolCallId (`itemId` for commandExecution, `itemId:index` for each fileChange file). */
  private readonly tools = new Map<string, ToolProjection>();
  /** One native item can own several sub-tool-calls (multi-file fileChange) — tracked to close them all together. */
  private readonly itemToolCallIds = new Map<string, string[]>();
  /**
   * TASK.181: sub toolCallIds that have already produced a real tool_result
   * (paired OR completed-only recovered). Distinct from startedItemIds so a
   * repeated completion or a late `item/started` after completion never
   * creates an extra tool lifecycle or count.
   */
  private readonly completedToolCallIds = new Set<string>();
  /**
   * TASK.181: native item ids that have already produced a real tool_result
   * (paired OR completed-only recovered). ITEM-level, not projection-level:
   * a redelivered completion can carry a different payload shape than the
   * first (e.g. populated start `fc:0`, sparse redelivery projecting bare
   * `fc`), so deduplicating by projection id alone would let one completed
   * native item recover a SECOND lifecycle under a different id. Distinct
   * from startedItemIds so a late `item/started` after completion never
   * resurrects a lifecycle either.
   */
  private readonly completedItemIds = new Set<string>();
  /** Accumulated `item/commandExecution/outputDelta` text per itemId (cut §2(i) live command-output deltas). */
  private readonly commandOutputBuffers = new Map<string, string>();
  /**
   * TASK.95 collab correlation. Production passes the ENGINE-owned instance;
   * absent (direct unit tests) the translator-local fallback keeps each
   * translator's behavior isolated.
   */
  private readonly collab: CollabAgentCardIndex;
  /** Native `subAgentActivity` ids already rendered as a mapped activity ROW, so start+complete yields one row. */
  private readonly activityRowIds = new Set<string>();
  private lastUsageKey: string | null = null;
  private finished = false;
  /** Monotonic per-turn suffix for synthetic plan-card ids (`turn/plan/updated` carries no item id of its own). */
  private planRevision = 0;
  /** Serialized todos of the last EMITTED plan card — dedupes an unchanged plan redelivery. */
  private lastPlanKey: string | null = null;
  /** Latches the ONE terminal `{type:"error"}` event a turn may ever emit (cut §2(i)) — a live `error` notification and a fallback in `finish()` must never double-report the same failure. */
  private errorEmitted = false;

  constructor(private readonly options: TurnTranslatorOptions) {
    this.collab = options.collab ?? new CollabAgentCardIndex();
  }

  onNotification(notification: JsonRpcNotification): AgentEvent[] {
    if (this.finished) return [];
    if (notification.method === "turn/completed") {
      const completed = record(notification.params);
      const turn = record(completed?.turn);
      if (completed?.threadId !== this.options.threadId || turn?.id !== this.options.turnId) return [];
      return this.finish(completed);
    }
    // `warning` notifications (cut §2(i)) are thread-scoped, not turn-scoped
    // (no `turnId` field on the wire) — they cannot pass `matchingTurn` below.
    if (notification.method === "warning") return this.onWarning(notification.params);
    // `account/rateLimits/updated` (codex-profiles cut §6.1) is ACCOUNT-scoped:
    // the wire carries neither threadId nor turnId, so like `warning` it is
    // handled before `matchingTurn` would discard it as foreign.
    if (notification.method === "account/rateLimits/updated") return this.onQuotaUpdated(notification.params);

    const params = matchingTurn(notification.params, this.options.threadId, this.options.turnId);
    if (params === null) return [];

    switch (notification.method) {
      case "item/started":
        return this.onItemStarted(params);
      case "item/agentMessage/delta":
        return this.onAgentMessageDelta(params);
      case "item/commandExecution/outputDelta":
        return this.onCommandOutputDelta(params);
      case "item/completed":
        return this.onItemCompleted(params);
      case "turn/plan/updated":
        return this.onPlanUpdated(params);
      case "thread/tokenUsage/updated":
        return this.onTokenUsage(params);
      case "error":
        return this.onError(params);
      default:
        // Requests (including approvals) and every unobserved notification are
        // deliberately not projected by this pure renderer adapter.
        return [];
    }
  }

  finishTerminal(reason: "cancelled" | "error"): AgentEvent[] {
    if (this.finished) return [];
    return this.finish({ turn: { status: reason === "cancelled" ? "interrupted" : "failed" } });
  }

  private onItemStarted(params: Record<string, unknown>): AgentEvent[] {
    const item = record(params.item);
    if (item === null || typeof item.id !== "string") return [];
    this.options.items?.record(item);
    // Idempotency guard: a redelivered item/started for an id already
    // started must create zero new blocks (see startedItemIds' own comment).
    if (this.startedItemIds.has(item.id)) return [];
    this.startedItemIds.add(item.id);
    // TASK.181 + TASK.95: a late item/started for an item id that already
    // completed (paired or completed-only recovered) must never resurrect a
    // lifecycle — extended to collab/activity, which live outside isToolFamily.
    if (isDedupedFamily(item.type) && this.completedItemIds.has(item.id)) return [];
    if (item.type === "agentMessage") {
      this.openText.add(item.id);
      return [{ type: "text_start", id: item.id }];
    }
    // Dedicated collab/activity dispatch — BEFORE generic projection, so a
    // spawn is never mistaken for a generic recovery and neither is dropped.
    if (item.type === COLLAB_TOOL_TYPE) return this.onCollabStarted(item);
    if (item.type === SUBAGENT_ACTIVITY_TYPE) return this.onActivityStarted(item);
    const projections = projectTools(item);
    if (projections.length === 0) return [];
    // Defensive: never reopen projections that already produced a tool_result.
    if (projections.every((projection) => this.completedToolCallIds.has(projection.toolCallId))) return [];
    return this.startProjections(item.id, projections);
  }

  /**
   * Shared start routine for every projection (family + generic): records the
   * item -> sub-id mapping, opens the renderer-required `tool_call` block and
   * its `tool_execution_start`. Renderer contract (store.ts): a tool_call block
   * is created ONLY on `{type:"tool_call"}` — tool_execution_start/tool_result
   * are patch-only, silent no-ops without it (W17 fix: this emission was
   * missing, so a live turn's real commands/file-changes never rendered any
   * card at all, allow/deny/cancel alike).
   */
  private startProjections(itemId: string, projections: ToolProjection[]): AgentEvent[] {
    this.itemToolCallIds.set(itemId, projections.map((projection) => projection.toolCallId));
    const events: AgentEvent[] = [];
    for (const projection of projections) {
      this.tools.set(projection.toolCallId, projection);
      events.push({
        type: "tool_call",
        toolCall: { id: projection.toolCallId, name: projection.toolName, input: projection.input },
      });
      events.push({ type: "tool_execution_start", toolCallId: projection.toolCallId, toolName: projection.toolName, input: projection.input });
    }
    return events;
  }

  /**
   * Codex's own todo list. Unlike every other projection here this one has no
   * native item to key on (`turn/plan/updated` is turn-scoped, carrying
   * neither an `itemId` nor a lifecycle), so each accepted revision becomes a
   * self-contained, already-settled synthetic tool call: created and closed in
   * the same batch, with an id of its own so a later revision APPENDS a card
   * instead of patching the previous one (store.ts keys blocks by
   * `toolCallId`, and the panel's last-wins selection needs the newest card to
   * be the newest block).
   */
  private onPlanUpdated(params: Record<string, unknown>): AgentEvent[] {
    const input = projectPlanTodos(params.plan);
    if (input === null) return [];
    // Codex re-sends an unchanged plan alongside other turn activity; a card
    // per redelivery would bury the transcript under identical todo lists.
    const key = JSON.stringify(input.todos);
    if (key === this.lastPlanKey) return [];
    this.lastPlanKey = key;
    const toolCallId = `${this.options.turnId}:plan:${this.planRevision}`;
    this.planRevision += 1;
    return [
      { type: "tool_call", toolCall: { id: toolCallId, name: TODO_TOOL_NAME, input } },
      { type: "tool_execution_start", toolCallId, toolName: TODO_TOOL_NAME, input },
      {
        type: "tool_result",
        outcome: {
          toolCallId,
          toolName: TODO_TOOL_NAME,
          status: "success",
          modelText: "",
          durationMs: 0,
          result: { ok: true, output: "" },
        },
      },
    ];
  }

  private onAgentMessageDelta(params: Record<string, unknown>): AgentEvent[] {
    if (typeof params.itemId !== "string" || typeof params.delta !== "string") return [];
    const events: AgentEvent[] = [];
    if (!this.openText.has(params.itemId)) {
      this.openText.add(params.itemId);
      events.push({ type: "text_start", id: params.itemId });
    }
    events.push({ type: "text_delta", id: params.itemId, text: params.delta });
    return events;
  }

  /**
   * `item/commandExecution/outputDelta` (schema-evidenced: `codex app-server
   * generate-json-schema` against the installed codex-cli 0.144.3 — no W0/W1
   * fixture ever captured one, every probed command completed inside a
   * single chunk). No dedicated live wire event exists for partial tool
   * output (cut §2(i) — zero new AgentEvent fields), so the accumulated text
   * is consumed as a fallback in `toolOutcome` below: the terminal item's own
   * `aggregatedOutput` still wins when present, but a command whose
   * completion snapshot is unexpectedly empty never loses output that WAS
   * streamed live. File changes deliberately do NOT get this treatment
   * (`item/fileChange/outputDelta`/`patchUpdated` exist in the same schema
   * but are never consumed) — a documented choice, not an oversight: a file
   * diff is only ever meaningful once complete.
   */
  private onCommandOutputDelta(params: Record<string, unknown>): AgentEvent[] {
    if (typeof params.itemId !== "string" || typeof params.delta !== "string") return [];
    const buffered = this.commandOutputBuffers.get(params.itemId) ?? "";
    this.commandOutputBuffers.set(params.itemId, buffered + params.delta);
    return [];
  }

  private onItemCompleted(params: Record<string, unknown>): AgentEvent[] {
    const item = record(params.item);
    if (item === null || typeof item.id !== "string") return [];
    if (item.type === "agentMessage" && this.openText.delete(item.id)) {
      return [{ type: "text_end", id: item.id }];
    }
    // TASK.181 + TASK.95 ITEM-level dedup: a repeated completion — even with a
    // different payload shape (sparse vs populated fileChange changes) — must
    // never recover a second lifecycle under different projection ids.
    // Extended to collab/activity, which live outside isToolFamily.
    if (isDedupedFamily(item.type) && this.completedItemIds.has(item.id)) return [];
    // Dedicated collab/activity completion — never a generic recovery.
    if (item.type === COLLAB_TOOL_TYPE) {
      this.completedItemIds.add(item.id);
      return this.onCollabCompleted(item);
    }
    if (item.type === SUBAGENT_ACTIVITY_TYPE) {
      this.completedItemIds.add(item.id);
      return this.onActivityCompleted(item);
    }
    const toolCallIds = this.itemToolCallIds.get(item.id);
    if (toolCallIds === undefined) {
      // Completed-only recovery: a completion of a projectable item whose
      // item/started never arrived (or produced no projection) must not
      // silently disappear. Emit the full renderer-required lifecycle
      // (tool_call -> tool_execution_start -> tool_result) here. A previously
      // seen start with no projection must not block recovery.
      const projections = projectTools(item).filter((projection) => !this.completedToolCallIds.has(projection.toolCallId));
      if (projections.length === 0) return [];
      // Mark completion only once a real tool_result will actually be produced.
      this.completedItemIds.add(item.id);
      return this.finishProjectionsCompletedOnly(item, projections);
    }
    this.itemToolCallIds.delete(item.id);
    this.completedItemIds.add(item.id);
    return this.finishProjectionsPaired(item, toolCallIds);
  }

  /**
   * Completed-only recovery lifecycle for projections whose start never
   * registered. Synthetic completed-only tools must never linger in the maps
   * for finish() to count again — itemToolCallIds was never set for them, and
   * the tools map stays untouched.
   */
  private finishProjectionsCompletedOnly(item: Record<string, unknown>, projections: ToolProjection[]): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const projection of projections) {
      events.push({
        type: "tool_call",
        toolCall: { id: projection.toolCallId, name: projection.toolName, input: projection.input },
      });
      events.push({ type: "tool_execution_start", toolCallId: projection.toolCallId, toolName: projection.toolName, input: projection.input });
      events.push({ type: "tool_result", outcome: this.outcomeFor(projection.toolCallId, projection, item) });
      this.completedToolCallIds.add(projection.toolCallId);
    }
    return events;
  }

  /** Paired completion: closes each projection opened by a matching start. */
  private finishProjectionsPaired(item: Record<string, unknown>, toolCallIds: readonly string[]): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const toolCallId of toolCallIds) {
      const projection = this.tools.get(toolCallId);
      if (projection === undefined) continue;
      this.tools.delete(toolCallId);
      if (this.completedToolCallIds.has(toolCallId)) continue;
      this.completedToolCallIds.add(toolCallId);
      events.push({ type: "tool_result", outcome: this.outcomeFor(toolCallId, projection, item) });
    }
    return events;
  }

  /** Family outcomes keep their exact semantics; every other type uses the honest generic outcome. */
  private outcomeFor(toolCallId: string, projection: ToolProjection, item: Record<string, unknown>): ToolCallOutcome {
    return isToolFamily(item.type)
      ? this.toolOutcome(toolCallId, projection, item)
      : this.genericOutcome(toolCallId, projection, item);
  }

  private toolOutcome(toolCallId: string, projection: ToolProjection, item: Record<string, unknown>): ToolCallOutcome {
    // TASK.181: status-less webSearch/web_search completions are successes;
    // every other status keeps the explicit completion/error/denial/
    // cancellation mapping below. Counting depends on completion EVENTS, so
    // failed/declined/interrupted/unfamiliar statuses still produce exactly
    // one tool_result.
    const webSearch = item.type === "webSearch" || item.type === "web_search";
    const status = item.status === undefined && webSearch ? "success" : statusFor(item.status);
    const aggregatedRaw = item.aggregatedOutput !== undefined ? item.aggregatedOutput : item.aggregated_output;
    const aggregated = typeof aggregatedRaw === "string" ? aggregatedRaw : undefined;
    const buffered = this.commandOutputBuffers.get(toolCallId);
    this.commandOutputBuffers.delete(toolCallId);
    const modelText = aggregated ?? buffered ?? "";
    const durationRaw = item.durationMs !== undefined ? item.durationMs : item.duration_ms;
    return {
      toolCallId,
      toolName: projection.toolName,
      status,
      modelText,
      durationMs: typeof durationRaw === "number" && durationRaw >= 0 ? durationRaw : 0,
      ...(status === "success" ? { result: { ok: true, output: modelText } } : { result: { ok: false, error: "Codex tool did not complete" } }),
    };
  }

  /**
   * Generic (non-family) completion outcome. `success` here means ONLY "the
   * item/completed receipt arrived" — it never asserts semantic child/task
   * success. Explicit failed/error, declined/denied and interrupted/cancelled
   * map to error/denied/cancelled. A missing or unfamiliar free-form status is
   * NOT a fabricated error: the raw value is carried in the visible
   * text and the observation is labelled as item completion. Real output/
   * message/duration fields are used when present; nothing is invented.
   */
  private genericOutcome(toolCallId: string, projection: ToolProjection, item: Record<string, unknown>): ToolCallOutcome {
    const rawStatus = item.status;
    const status = genericStatusFor(rawStatus);
    const detail = [item.output, item.message, item.text, item.result].find((value): value is string => typeof value === "string" && value.length > 0);
    const notes: string[] = [];
    if (typeof rawStatus === "string" && rawStatus.length > 0) notes.push(`status: ${rawStatus}`);
    if (status === "success") notes.push("operation item completed");
    const modelText = [detail !== undefined ? boundGenericString(detail) : "", notes.join(" · ")].filter((part) => part.length > 0).join("\n");
    const durationRaw = item.durationMs !== undefined ? item.durationMs : item.duration_ms;
    return {
      toolCallId,
      toolName: projection.toolName,
      status,
      modelText,
      durationMs: typeof durationRaw === "number" && durationRaw >= 0 ? durationRaw : 0,
      ...(status === "success"
        ? { result: { ok: true, output: modelText } }
        : { result: { ok: false, error: modelText.length > 0 ? modelText : "Codex operation did not complete" } }),
    };
  }

  // ── TASK.95 collab (Agent) + sub-agent activity ───────────────────────────

  private onCollabStarted(item: Record<string, unknown>): AgentEvent[] {
    if (item.tool === "spawnAgent") return this.onSpawnStarted(item);
    return this.onCollabOperationStarted(item);
  }

  private onCollabCompleted(item: Record<string, unknown>): AgentEvent[] {
    if (item.tool === "spawnAgent") return this.onSpawnCompleted(item);
    return this.onCollabOperationCompleted(item);
  }

  /**
   * A spawn CALL start. Registers the card/receivers BEFORE applying any
   * `agentsStates` from the snapshot, opens the outer Agent card, seeds the
   * subagent region, and only THEN appends the state observations. The prompt
   * and the REQUESTED model ride verbatim; persona is the explicit neutral
   * label — never inferred from model/path.
   */
  private onSpawnStarted(item: Record<string, unknown>): AgentEvent[] {
    const cardId = item.id as string;
    const promptText = typeof item.prompt === "string" ? item.prompt : "";
    const model = typeof item.model === "string" && item.model.length > 0 ? item.model : null;
    const receivers = stringArray(item.receiverThreadIds);
    this.collab.register(cardId, {
      prompt: promptText.length > 0 ? promptText : null,
      model,
      receiverThreadIds: receivers,
    });
    const input: Record<string, unknown> = { prompt: promptText, ...(model !== null ? { model } : {}) };
    // Outer CALL tracking: finish()'s cancelled sweep must be able to close a
    // still-open spawn CALL — but it never touches the child region.
    this.tools.set(cardId, { toolCallId: cardId, toolName: AGENT_TOOL_NAME, input });
    const events: AgentEvent[] = [
      { type: "tool_call", toolCall: { id: cardId, name: AGENT_TOOL_NAME, input } },
      { type: "tool_execution_start", toolCallId: cardId, toolName: AGENT_TOOL_NAME, input },
      {
        type: "subagent_start",
        toolCallId: cardId,
        agentType: CODEX_SUBAGENT_PERSONA,
        description: promptText,
        ...(model !== null ? { model } : {}),
        engine: "codex",
      },
    ];
    events.push(...this.applyStates(item));
    return events;
  }

  /**
   * A spawn CALL completion. Paired and completed-only share this recovery
   * path: an unseeded completion emits the full three-event start sequence
   * from the completing snapshot; a seeded one merges receivers/sparse
   * metadata. Actual states are applied, the CALL settles exactly once with a
   * tool_result, and the per-turn outer-tool tracking is removed — child
   * correlation is preserved across turns. A FAILED call with no child ever
   * observed closes the region once with an explicit failure activity so it
   * cannot spin forever; a failed call WITH an observed child is left to those
   * observations (never a fabricated cancellation).
   */
  private onSpawnCompleted(item: Record<string, unknown>): AgentEvent[] {
    const cardId = item.id as string;
    const promptText = typeof item.prompt === "string" ? item.prompt : "";
    const model = typeof item.model === "string" && item.model.length > 0 ? item.model : null;
    const receivers = stringArray(item.receiverThreadIds);
    const events: AgentEvent[] = [];
    const existing = this.collab.get(cardId);
    if (existing === undefined) {
      this.collab.register(cardId, {
        prompt: promptText.length > 0 ? promptText : null,
        model,
        receiverThreadIds: receivers,
      });
      const input: Record<string, unknown> = { prompt: promptText, ...(model !== null ? { model } : {}) };
      this.tools.set(cardId, { toolCallId: cardId, toolName: AGENT_TOOL_NAME, input });
      events.push({ type: "tool_call", toolCall: { id: cardId, name: AGENT_TOOL_NAME, input } });
      events.push({ type: "tool_execution_start", toolCallId: cardId, toolName: AGENT_TOOL_NAME, input });
      events.push({
        type: "subagent_start",
        toolCallId: cardId,
        agentType: CODEX_SUBAGENT_PERSONA,
        description: promptText,
        ...(model !== null ? { model } : {}),
        engine: "codex",
      });
    } else {
      this.collab.merge(cardId, {
        prompt: promptText.length > 0 ? promptText : null,
        model,
        receiverThreadIds: receivers,
      });
    }
    events.push(...this.applyStates(item));
    // A failed spawn CALL whose child was NEVER observed must not leave the
    // region spinning: close it once, honestly, with a failure note. A failed
    // call whose child WAS observed keeps those observations (no fabrication).
    if (item.status === "failed" && !this.collab.hasObservedChild(cardId) && !this.collab.hasTerminal(cardId)) {
      events.push({
        type: "subagent_activity",
        toolCallId: cardId,
        toolName: CODEX_SUBAGENT_PERSONA,
        summary: "spawn call failed before any child was observed",
      });
      this.collab.markTerminal(cardId);
      const card = this.collab.get(cardId);
      events.push({
        type: "subagent_end",
        toolCallId: cardId,
        status: "error",
        turns: 0,
        durationMs: -1,
        ...(card?.model !== null && card?.model !== undefined ? { model: card.model } : {}),
      });
    }
    // Settle the outer CALL once and drop only the per-turn outer tracking.
    this.tools.delete(cardId);
    events.push({ type: "tool_result", outcome: this.collabCallOutcome(cardId, item) });
    return events;
  }

  /**
   * Non-spawn verbs (wait/sendInput/resumeAgent/closeAgent, and any unfamiliar
   * `tool`): an honest `codex:collab:<verb>` generic operation card. Never a
   * phantom Agent card. `agentsStates` are applied to already mapped children.
   */
  private onCollabOperationStarted(item: Record<string, unknown>): AgentEvent[] {
    const projections = [this.collabOperationProjection(item)];
    return [...this.startProjections(item.id as string, projections), ...this.applyStates(item)];
  }

  private onCollabOperationCompleted(item: Record<string, unknown>): AgentEvent[] {
    const projection = this.collabOperationProjection(item);
    const toolCallIds = this.itemToolCallIds.get(item.id as string);
    let events: AgentEvent[];
    if (toolCallIds === undefined) {
      events = this.finishProjectionsCompletedOnly(item, [projection]);
    } else {
      this.itemToolCallIds.delete(item.id as string);
      events = this.finishProjectionsPaired(item, toolCallIds);
    }
    return [...events, ...this.applyStates(item)];
  }

  private collabOperationProjection(item: Record<string, unknown>): ToolProjection {
    const verb = typeof item.tool === "string" && item.tool.length > 0 ? item.tool : "unknown";
    const input: Record<string, unknown> = {};
    if (typeof item.status === "string") input.status = item.status;
    const receivers = stringArray(item.receiverThreadIds);
    if (receivers.length > 0) input.receiverThreadIds = receivers;
    if (typeof item.prompt === "string" && item.prompt.length > 0) input.prompt = boundGenericString(item.prompt);
    if (typeof item.model === "string" && item.model.length > 0) input.model = item.model;
    return { toolCallId: item.id as string, toolName: `codex:collab:${verb}`, input };
  }

  private collabCallOutcome(cardId: string, item: Record<string, unknown>): ToolCallOutcome {
    const status: ToolCallStatus = item.status === "failed" ? "error" : "success";
    const modelText = status === "success" ? "" : "Codex spawn call failed";
    return {
      toolCallId: cardId,
      toolName: AGENT_TOOL_NAME,
      status,
      modelText,
      durationMs: 0,
      result: status === "success" ? { ok: true, output: "" } : { ok: false, error: modelText },
    };
  }

  /**
   * Folds `agentsStates` observations onto their owning spawn cards. Only
   * fields actually reported are stored; an unrecognized receiver we never saw
   * is skipped (no phantom card). A repeated identical observation adds
   * nothing. When EVERY known receiver of a card has reached a known terminal
   * state, ONE aggregate `subagent_end` is emitted (precedence error >
   * cancelled > completed) and the card is latched — so a later duplicate can
   * never resurrect or re-settle it. Non-terminal states (including
   * interrupted/pendingInit/notFound/unknown) stay visible as activity and
   * keep the correlation.
   */
  private applyStates(item: Record<string, unknown>): AgentEvent[] {
    const states = normalizeStates(item.agentsStates);
    const events: AgentEvent[] = [];
    for (const [receiver, observation] of Object.entries(states)) {
      const cardId = this.collab.cardFor(receiver);
      if (cardId === undefined) continue;
      const previous = this.collab.stateFor(cardId, receiver);
      if (previous !== undefined && previous.status === observation.status && (previous.message ?? "") === (observation.message ?? "")) continue;
      this.collab.observeStates(cardId, { [receiver]: observation });
      events.push({
        type: "subagent_activity",
        toolCallId: cardId,
        toolName: CODEX_SUBAGENT_PERSONA,
        summary: boundGenericString(stateSummary(observation)),
      });
      if (!this.collab.hasTerminal(cardId)) {
        const terminal = this.collab.terminalFor(cardId);
        if (terminal !== null) {
          this.collab.markTerminal(cardId);
          const card = this.collab.get(cardId);
          events.push({
            type: "subagent_end",
            toolCallId: cardId,
            status: terminal,
            // turns:0 is a transport placeholder (never a measured count) and
            // durationMs:-1 means "unknown" — rendering suppresses the time.
            turns: 0,
            durationMs: -1,
            ...(card?.model !== null && card?.model !== undefined ? { model: card.model } : {}),
          });
        }
      }
    }
    return events;
  }

  private onActivityStarted(item: Record<string, unknown>): AgentEvent[] {
    const activityId = item.id as string;
    const receiver = typeof item.agentThreadId === "string" ? item.agentThreadId : "";
    const cardId = receiver.length > 0 ? this.collab.cardFor(receiver) : undefined;
    if (cardId !== undefined && !this.collab.hasTerminal(cardId)) {
      if (this.activityRowIds.has(activityId)) return [];
      this.activityRowIds.add(activityId);
      return [{
        type: "subagent_activity",
        toolCallId: cardId,
        toolName: CODEX_SUBAGENT_PERSONA,
        summary: boundGenericString(activitySummary(item)),
      }];
    }
    // Unmapped or already-settled receiver: an honest generic marker card.
    return this.startProjections(activityId, [this.activityMarkerProjection(item)]);
  }

  private onActivityCompleted(item: Record<string, unknown>): AgentEvent[] {
    const activityId = item.id as string;
    const receiver = typeof item.agentThreadId === "string" ? item.agentThreadId : "";
    const cardId = receiver.length > 0 ? this.collab.cardFor(receiver) : undefined;
    if (cardId !== undefined && !this.collab.hasTerminal(cardId)) {
      if (this.activityRowIds.has(activityId)) return [];
      this.activityRowIds.add(activityId);
      return [{
        type: "subagent_activity",
        toolCallId: cardId,
        toolName: CODEX_SUBAGENT_PERSONA,
        summary: boundGenericString(activitySummary(item)),
      }];
    }
    const toolCallIds = this.itemToolCallIds.get(activityId);
    if (toolCallIds === undefined) {
      return this.finishProjectionsCompletedOnly(item, [this.activityMarkerProjection(item)]);
    }
    this.itemToolCallIds.delete(activityId);
    return this.finishProjectionsPaired(item, toolCallIds);
  }

  private activityMarkerProjection(item: Record<string, unknown>): ToolProjection {
    return {
      toolCallId: item.id as string,
      toolName: `codex:${SUBAGENT_ACTIVITY_TYPE}`,
      input: genericInput(item),
    };
  }

  private onTokenUsage(params: Record<string, unknown>): AgentEvent[] {
    const usage = record(params.tokenUsage);
    // W0 command fixture proves `total` is cumulative across updates, while
    // `last` is the current model request's usage and matches AgentEvent's
    // per-step context accounting semantics.
    const last = record(usage?.last);
    const events: AgentEvent[] = [];
    const context = decodeCodexContextUsage(params);
    if (context) events.push(context);
    // The native last value describes one request; total identifies redeliveries.
    const cumulative = record(usage?.total);
    if (last !== null && cumulative !== null) {
      const key = JSON.stringify(cumulative);
      if (key !== this.lastUsageKey) {
        this.lastUsageKey = key;
        const number = (value: unknown): number | undefined =>
          typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
        this.options.onUsage?.({ inputTokens: number(last.inputTokens), cachedInputTokens: number(last.cachedInputTokens), outputTokens: number(last.outputTokens), totalTokens: number(last.totalTokens) });
      }
    }
    const sessionTokens = this.sessionTokens(cumulative);
    if (sessionTokens !== null) events.push(sessionTokens);
    return events;
  }

  /**
   * `tokenUsage.total` -> `engine_session_tokens` (codex-profiles cut §5.3).
   * The wire's `total` breakdown is ALREADY cumulative across the thread's
   * updates, so the event carries it VERBATIM under REPLACE semantics — never
   * a per-update delta, and never a `finish`-shaped event (the store's finish
   * path SUMS via accumulateSessionTokens, which would multiply an
   * already-cumulative number; cut §3.4 froze a separate variant for exactly
   * this reason).
   */
  private sessionTokens(total: Record<string, unknown> | null): AgentEvent | null {
    if (total === null) return null;
    const input = total.inputTokens;
    const output = total.outputTokens;
    const grandTotal = total.totalTokens;
    if (
      typeof input !== "number" || !Number.isFinite(input) || input < 0 ||
      typeof output !== "number" || !Number.isFinite(output) || output < 0 ||
      typeof grandTotal !== "number" || !Number.isFinite(grandTotal) || grandTotal < 0
    ) return null;
    const cachedInput = total.cachedInputTokens;
    const reasoningOutput = total.reasoningOutputTokens;
    return {
      type: "engine_session_tokens",
      input,
      output,
      total: grandTotal,
      ...(typeof cachedInput === "number" && Number.isFinite(cachedInput) && cachedInput >= 0 ? { cachedInput } : {}),
      ...(typeof reasoningOutput === "number" && Number.isFinite(reasoningOutput) && reasoningOutput >= 0 ? { reasoningOutput } : {}),
    };
  }

  /**
   * `account/rateLimits/updated` (codex-profiles cut §6.1/§6.3): the sparse
   * push is folded into the ENGINE-owned tracker (which applies the frozen
   * shared/codex-quota.ts merge — null never wipes a known value) and the
   * MERGED snapshot rides out as `engine_quota`. Core's own loop never emits
   * this variant (cut §3.4, test-hazard #3). An undecodable push, or a
   * translator constructed without the tracker seam, emits nothing.
   */
  private onQuotaUpdated(params: unknown): AgentEvent[] {
    const quota = this.options.quota?.applyUpdate(params);
    return quota == null ? [] : [{ type: "engine_quota", quota }];
  }

  /**
   * `warning` notifications (cut §2(i)): thread-scoped, not turn-scoped —
   * routed to the additive `engine_notice` variation, never a terminal
   * `error`. Core's own loop never emits `engine_notice` (zero core wire
   * delta, cut test hazard #3).
   */
  private onWarning(params: unknown): AgentEvent[] {
    const value = record(params);
    if (value?.threadId !== this.options.threadId) return [];
    const message = typeof value.message === "string" && value.message.length > 0 ? value.message : "Codex reported a warning.";
    return [{ type: "engine_notice", level: "warning", message }];
  }

  /**
   * `error` notifications (cut §2(i)): `willRetry` is the discriminator
   * between a retry (routed to `engine_notice`, level "retry" — the turn
   * keeps running) and a terminal error (the ORIGINAL safe message from
   * Codex — auth/quota/network/sandbox stay distinguishable — surfaced as
   * `{type:"error"}`, followed by `finish()`'s honest `turn_end`/`loop_end`
   * once `turn/completed` arrives; never a faceless `loop_end:"error"` alone).
   */
  private onError(params: Record<string, unknown>): AgentEvent[] {
    const errorValue = record(params.error);
    const message = typeof errorValue?.message === "string" && errorValue.message.length > 0 ? errorValue.message : "Codex reported an error.";
    if (params.willRetry === true) {
      return [{ type: "engine_notice", level: "retry", message }];
    }
    if (this.errorEmitted) return [];
    this.errorEmitted = true;
    return [{ type: "error", error: new Error(message) }];
  }

  private finish(params: Record<string, unknown>): AgentEvent[] {
    if (this.finished) return [];
    this.finished = true;
    if (this.lastUsageKey === null) this.options.onUsage?.({});
    const turn = record(params.turn);
    const status = turn?.status;
    const loopReason = status === "completed" ? "completed" : status === "interrupted" ? "cancelled" : "error";
    const finishReason: FinishReason = status === "completed" ? "stop" : status === "interrupted" ? "other" : "error";
    const events: AgentEvent[] = [];
    // A terminal failure surfaces with its ORIGINAL safe message even when no
    // separate `error` notification preceded `turn/completed` (cut §2(i)) —
    // never just a faceless loop_end:"error". `errorEmitted` prevents a
    // double-report when the live `error` notification already fired.
    if (loopReason === "error" && !this.errorEmitted) {
      const turnError = record(turn?.error);
      const message = typeof turnError?.message === "string" && turnError.message.length > 0
        ? turnError.message
        : status === "failed" ? "Codex turn failed." : "Codex protocol returned an unsupported turn status.";
      this.errorEmitted = true;
      events.push({ type: "error", error: new Error(message) });
    }
    for (const id of this.openText) events.push({ type: "text_end", id });
    this.openText.clear();
    // The sweep cancels still-open TOOL CALLS only. It deliberately emits NO
    // inferred `subagent_end`: a child is not the call, and the end of a parent
    // turn (completed, interrupted or failed) is no evidence about a child
    // still running. The engine-owned collab correlation is NOT cleared here —
    // later turns keep patching the same card. Completed calls were already
    // removed from `tools`/`itemToolCallIds` by their completion, so they can
    // never produce a second result here.
    for (const [id, projection] of this.tools) {
      events.push({
        type: "tool_result",
        outcome: {
          toolCallId: id,
          toolName: projection.toolName,
          status: "cancelled",
          modelText: "Codex turn ended before this tool completed",
          durationMs: 0,
          result: { ok: false, error: "Codex turn ended before this tool completed", errorKind: "cancelled" },
        },
      });
    }
    this.tools.clear();
    this.itemToolCallIds.clear();
    events.push({ type: "turn_end", turn: this.options.turn, finishReason });
    events.push({ type: "loop_end", reason: loopReason, turns: this.options.turn });
    return events;
  }
}
