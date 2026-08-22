/**
 * Interactive permission broker (design §4, §2.12). Replaces the core's
 * DenyPermissionBroker with a round-trip over the UI wire: an "ask" ruling from
 * ModePermissionEngine escalates here, which posts a `permission_request` to the
 * renderer and parks a Promise until the UI answers, a timeout fires, or the
 * session force-denies (turn cancel / disconnect / shutdown).
 *
 * Fail-closed invariant (same as DenyPermissionBroker, made dynamic): whenever
 * there is no live interactive client to answer, every ask resolves to DENY.
 *
 *   | Event                         | Result                                    |
 *   |-------------------------------|-------------------------------------------|
 *   | always-allow rule matches     | allow, never parked, no UI event          |
 *   | UI allow/deny                 | that decision, origin "ui"                |
 *   | timeout PERMISSION_ASK_TIMEOUT| deny, origin "timeout"                    |
 *   | turn cancel (session.denyAll) | deny, origin "turn_cancelled"             |
 *   | port closed (session.denyAll) | deny, origin "disconnect"                 |
 *   | shutdown (session.denyAll)    | deny, origin "shutdown"                   |
 *   | unknown / repeated requestId  | ignored (first response wins)             |
 *   | garbage response              | ignored -> eventually times out -> deny   |
 *

 * so the session owns the turn AbortController and calls denyAll() on abort to
 * release any parked asks; the dispatcher then observes the denied outcome and
 * the loop finishes the turn as cancelled.
 *
 * FIFO presentation queue (design §2.12, R7): the core contract tolerates
 * concurrent `requestPermission` calls (parallel read-only tool batches can
 * escalate several asks at once, design §2.7) but the MVP renderer only has a
 * one-slot modal (`store.permission`, a single object, not a list) — sending a
 * second `permission_request` before the first settles would clobber that
 * slot and strand the first ask's resolve until it times out. So at most one
 * `permission_request` is ever in flight to the UI: every ask is parked in
 * `pending` immediately (so denyAll/handleResponse can always address it by
 * id), but only the head of a FIFO `queue` is actually presented — the rest
 * wait, un-timed, until `presentNext()` pops them in arrival order after the
 * shown request settles. The 120s deadline is therefore armed in `present()`,
 * i.e. at the moment the request is actually sent to the UI, not when
 * `requestPermission` is called — a request stuck behind others in the queue
 * cannot time out before a human ever sees it. `denyAll` drains both: queued
 * asks are settled directly (never presented, since they'd just be denied
 * immediately after), then the shown request (if any) is settled without
 * triggering `presentNext()` (there is nothing left worth showing).
 */

import { randomUUID } from "node:crypto";
import type {
  PermissionBroker,
  PermissionDecision,
  PermissionRequest,
  ToolMetadata,
} from "@anycode/core";
import type { HostToUiMessage, WireToolMeta } from "../shared/protocol.js";

/** Ask deadline; a request with no answer by then is denied (fail-closed). */
export const PERMISSION_ASK_TIMEOUT_MS = 120_000;

/**
 * Deadline for an ExitPlanMode ask (TASK.27). The generic 120 s suits a
 * one-glance "allow this command?"; an ExitPlanMode ask is a human READING a
 * complete implementation plan, and a fail-closed deny mid-read would be
 * reported to the model as a rejected plan. Still fail-closed, just on a human
 * reading timescale.
 */
export const PLAN_APPROVAL_ASK_TIMEOUT_MS = 900_000;

/**
 * Per-tool ask deadline. Only ExitPlanMode differs, and only ever upward —
 * `Math.max` makes the plan deadline a FLOOR, so a host (or test) configured
 * with a longer generic deadline keeps it and no configuration can shorten a
 * plan review below the reading budget.
 */
export function resolveAskTimeoutMs(toolName: string, defaultTimeoutMs: number): number {
  return toolName === "ExitPlanMode"
    ? Math.max(defaultTimeoutMs, PLAN_APPROVAL_ASK_TIMEOUT_MS)
    : defaultTimeoutMs;
}

/** Reason a parked ask was settled, surfaced to the UI in permission_settled. */
export type SettleOrigin = "ui" | "timeout" | "turn_cancelled" | "disconnect" | "shutdown";

/** Projects the core ToolMetadata down to the UI-safe flat subset (no schemas/handlers). */
export function toWireToolMeta(metadata: ToolMetadata): WireToolMeta {
  return {
    name: metadata.name,
    description: metadata.description,
    readOnly: metadata.readOnly,
    destructive: metadata.destructive,
    riskLevel: metadata.riskLevel,
    sideEffectScope: metadata.sideEffectScope,
  };
}

/**
 * The always-allow store, as the one method this broker needs (TASK.144).
 * Structurally satisfied by core's `SessionPermissionRules`; kept as a narrow
 * interface so the broker never imports the class, mirroring the
 * `SessionPersistence`/`GitUiBridge` narrow-seam posture elsewhere in the host.
 *
 * WHO PASSES ONE, AND WHO MUST NOT:
 *
 *  - **Engine boots (codex, claude) DO.** `supportsCorePermissions` is false
 *    for both (claude-engine.ts / codex-engine.ts), so their approval bridges
 *    call `requestPermission` DIRECTLY — core's permission engine, and with it
 *    `RuleAwarePermissionEngine`, is not in the path at all. Without this seam
 *    a persisted `alwaysAllow` rule cannot reach an engine session by
 *    construction, which is the whole defect TASK.144 names.
 *  - **The core boot does NOT**, and this is load-bearing rather than an
 *    omission. On the core path a rule has already been applied upstream
 *    (`RuleAware(SafeCommand(Mode))`, host/index.ts), so re-checking here would
 *    be redundant for every ordinary call — but NOT inert: the dispatcher
 *    merges the engine ruling with a PreToolUse hook's by DECISION_RANK
 *    (dispatch/dispatcher.ts), so a hook may raise an already-rule-allowed call
 *    back up to `ask`. That upgrade is exactly the documented invariant "a
 *    PreToolUse hook can still ask/deny regardless of a session rule"
 *    (permissions/rules.ts header). A broker-side check would silently undo it.
 */
export interface PermissionRuleMatcher {
  matches(toolName: string, input: unknown): boolean;
}

interface PendingAsk {
  resolve: (decision: PermissionDecision) => void;
  request: PermissionRequest;
  /** Armed only once `present()` sends the request to the UI; null while queued. */
  timer: ReturnType<typeof setTimeout> | null;
}

export class IpcPermissionBroker implements PermissionBroker {
  /** Every parked ask, queued or shown — the single source of truth for denyAll/handleResponse addressing. */
  private readonly pending = new Map<string, PendingAsk>();
  /** requestIds waiting their turn, in arrival order; the head is presented once the shown request settles. */
  private readonly queue: string[] = [];
  /** requestId of the single `permission_request` currently in front of the UI, or null when the slot is free. */
  private current: string | null = null;

  constructor(
    private readonly emit: (message: HostToUiMessage) => void,
    private readonly timeoutMs: number = PERMISSION_ASK_TIMEOUT_MS,
    private readonly rules: PermissionRuleMatcher | null = null,
  ) {}

  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    // Always-allow, engine edition (TASK.144). Answered here rather than parked,
    // and silently — a rule-allowed call produces no `permission_request`, so
    // the UI never sees a modal it would have to auto-dismiss. Mirrors
    // RuleAwarePermissionEngine's own posture exactly: `ask` -> `allow`, never
    // `deny` -> anything (a bridge that has already refused a call — Claude's
    // read-only ExitPlanMode / AskUserQuestion denials — answers without ever
    // reaching this method).
    if (this.rules !== null && this.rules.matches(request.toolName, request.input)) {
      return Promise.resolve({ behavior: "allow" });
    }
    const requestId = randomUUID();
    return new Promise<PermissionDecision>((resolve) => {
      const entry: PendingAsk = { resolve, request, timer: null };
      this.pending.set(requestId, entry);
      if (this.current === null) {
        this.present(requestId, entry);
      } else {
        this.queue.push(requestId);
      }
    });
  }

  /**
   * Applies a UI response. An unknown or already-settled requestId is ignored
   * (first response wins). `updatedInput` rides along on allow; the core
   * dispatcher re-validates it against the tool schema.
   */
  handleResponse(requestId: string, behavior: "allow" | "deny", updatedInput?: unknown): void {
    const decision: PermissionDecision =
      behavior === "allow"
        ? updatedInput !== undefined
          ? { behavior: "allow", updatedInput }
          : { behavior: "allow" }
        : { behavior: "deny", reason: "denied by user" };
    this.settle(requestId, decision, "ui");
  }

  /**
   * Force-denies every parked ask (turn cancel / disconnect / shutdown):
   * drains the queue directly (those were never shown, so there is nothing to
   * settle "in front of" the UI — presenting them now just to immediately
   * deny them would be pure churn), then denies whatever is currently shown,
   * if any, without presenting a replacement.
   */
  denyAll(reason: string, origin: SettleOrigin): void {
    const queued = this.queue.splice(0, this.queue.length);
    for (const requestId of queued) {
      const entry = this.pending.get(requestId);
      if (entry) {
        this.settleEntry(requestId, entry, { behavior: "deny", reason }, origin);
      }
    }
    if (this.current !== null) {
      const requestId = this.current;
      const entry = this.pending.get(requestId);
      this.current = null;
      if (entry) {
        this.settleEntry(requestId, entry, { behavior: "deny", reason }, origin);
      }
    }
  }

  /** Number of asks currently awaiting a decision — shown + queued (diagnostics / tests). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Read-only accessor for the `toolName` of a still-pending ask (slice 2.2.3,
   * design §5): Session reads this to resolve the toolName for a `remember`
   * rule BEFORE calling `handleResponse` (which settles and removes the entry).
   * Undefined for an unknown/already-settled requestId — same fail-quiet
   * posture as `handleResponse` itself.
   */
  pendingToolName(requestId: string): string | undefined {
    return this.pending.get(requestId)?.request.toolName;
  }

  /** Sends `entry`'s request to the UI and arms its timeout; marks it as the shown request. */
  private present(requestId: string, entry: PendingAsk): void {
    this.current = requestId;
    // Per-tool deadline (TASK.27): a plan review gets a reading budget instead
    // of the generic ask deadline. Resolved here, at presentation time, so a
    // queued ask still cannot start its clock before a human sees it.
    const timeoutMs = resolveAskTimeoutMs(entry.request.toolName, this.timeoutMs);
    entry.timer = setTimeout(() => {
      this.settle(
        requestId,
        {
          behavior: "deny",
          reason: `${entry.request.toolName}: permission request timed out after ${timeoutMs}ms`,
        },
        "timeout",
      );
    }, timeoutMs);
    this.emit({
      type: "permission_request",
      requestId,
      toolName: entry.request.toolName,
      input: entry.request.input,
      mode: entry.request.mode,
      metadata: toWireToolMeta(entry.request.metadata),
    });
  }

  /** Pops the next queued ask (if any) and presents it, freeing the shown slot for it. */
  private presentNext(): void {
    const nextId = this.queue.shift();
    if (nextId === undefined) {
      return;
    }
    const entry = this.pending.get(nextId);
    if (!entry) {
      // Defensive: settled-but-still-queued should never happen (settle()
      // always removes from the queue too), but don't stall the slot if it does.
      this.presentNext();
      return;
    }
    this.present(nextId, entry);
  }

  /**
   * Normal settle path (UI response / timeout): removes `requestId` from
   * whichever of {shown, queued} it occupies, resolves it, and — only when it
   * was the shown request — advances the queue to present the next one.
   */
  private settle(requestId: string, decision: PermissionDecision, origin: SettleOrigin): void {
    const entry = this.pending.get(requestId);
    if (!entry) {
      // Unknown or already-settled requestId: ignore (first response wins).
      return;
    }
    const wasShown = this.current === requestId;
    if (wasShown) {
      this.current = null;
    } else {
      const idx = this.queue.indexOf(requestId);
      if (idx !== -1) {
        this.queue.splice(idx, 1);
      }
    }
    this.settleEntry(requestId, entry, decision, origin);
    if (wasShown) {
      this.presentNext();
    }
  }

  /** Bare resolution: clears the timer (if armed), removes from `pending`, emits, resolves. No queue bookkeeping. */
  private settleEntry(
    requestId: string,
    entry: PendingAsk,
    decision: PermissionDecision,
    origin: SettleOrigin,
  ): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    this.pending.delete(requestId);
    this.emit({
      type: "permission_settled",
      requestId,
      behavior: decision.behavior,
      origin,
    });
    entry.resolve(decision);
  }
}
