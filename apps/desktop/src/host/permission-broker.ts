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
 * Deny reasons for the two "nobody answered" paths (TASK.138). These strings are
 * read by a MODEL, not by a human: the dispatcher hands the deny reason back as
 * the tool result. The previous wording ("permission request timed out after
 * 120000ms") read like an infrastructure hiccup, and a live run showed what that
 * costs — the model retried four spellings of the same command and then started
 * debugging its PATH, burning 120 s per attempt. So both texts state three things
 * explicitly: the refusal is not on the merits, the command itself did not fail,
 * and rephrasing it will not help.
 */
function unansweredDenyReason(toolName: string, timeoutMs: number): string {
  return (
    `${toolName}: no one answered the approval request (it expired after ${timeoutMs}ms). ` +
    `This is NOT a refusal on the merits and NOT a failure of the command — there is no human at the screen. ` +
    `Retrying this command, or a rephrased equivalent, will be denied the same way. ` +
    `Continue with work that needs no approval, or stop and report exactly what is blocked.`
  );
}

function unattendedDenyReason(toolName: string): string {
  return (
    `${toolName}: denied without asking — an earlier approval request in this session expired unanswered, ` +
    `so the session is treated as unattended. This is NOT a refusal on the merits and NOT a failure of the command. ` +
    `Asking resumes as soon as a human interacts with the session. ` +
    `Continue with work that needs no approval, or stop and report exactly what is blocked.`
  );
}

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

  /**
   * "Nobody is at the screen" latch (TASK.138). Armed by the first ask that
   * expires unanswered, disarmed by a deliberate human act — answering a
   * permission prompt or typing a message. A UI merely attaching is NOT such a
   * proof: a renderer re-attaching on its own would disarm the latch on a run
   * nobody is actually watching. While armed, an ask is denied
   * immediately instead of being presented: waiting a second full deadline for
   * an answer that already failed to arrive buys nothing and costs the run its
   * wall clock — the observed failure mode was four serial asks burning 120 s
   * each, and a subagent losing its whole 600 s budget to unanswered asks.
   *
   * Fail-closed either way: the latch only ever turns a slow deny into a fast
   * one, never an ask into an allow.
   */
  private unattended = false;

  constructor(
    private readonly emit: (message: HostToUiMessage) => void,
    private readonly timeoutMs: number = PERMISSION_ASK_TIMEOUT_MS,
  ) {}

  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.unattended) {
      return Promise.resolve({
        behavior: "deny",
        reason: unattendedDenyReason(request.toolName),
      });
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
    // A click is proof of a human — disarm before settling, and do it even for an
    // unknown/already-settled requestId, since the click happened either way.
    this.noteHumanPresent();
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

  /**
   * Disarms the unattended latch (TASK.138). Called on a deliberate human act —
   * answering a permission prompt (below) or typing a message (session.ts).
   * Idempotent and safe to call when the latch was never armed.
   */
  noteHumanPresent(): void {
    this.unattended = false;
  }

  /** Whether asks are currently short-circuited because nobody answered (diagnostics / tests). */
  get isUnattended(): boolean {
    return this.unattended;
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
      // An expired ask is evidence that nobody is watching; every later ask in
      // this session is denied outright until a human proves otherwise.
      this.unattended = true;
      this.settle(
        requestId,
        {
          behavior: "deny",
          reason: unansweredDenyReason(entry.request.toolName, timeoutMs),
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
