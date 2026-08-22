/**
 * Turn-ceiling decision ladder (TASK.124 cut-1). The turn cap stops being a
 * wall and becomes a DECISION POINT: when a loop reaches it, one structured
 * model call decides whether the run may continue, and each granted extension
 * is strictly smaller than the last (N/2, N/4, N/8), capped at
 * MAX_CEILING_ROUNDS rounds per session and at a total that never exceeds the
 * configured budget.
 *
 * The verdict is STRUCTURAL, never parsed prose: the call declares exactly one
 * tool (`ceiling_verdict`) and the arguments of that tool call are validated by
 * the hand-written checker below against the declared schema. Anything else —
 * no tool call, a differently-named call, arguments off the schema, an SDK
 * parse failure, a timeout, a throw — is a refusal. Fail-closed is the only
 * safe default here: a ladder that grants on a verdict it could not read is a
 * runaway loop with extra steps.
 *
 * The call runs OUTSIDE the AgentLoop, straight against the loop's ModelPort
 * (same shape as the subagent wrap-up call in subagents/runner.ts): there is no
 * dispatcher on this path, so a tool call the model proposes has nothing to
 * execute it, and the loop's history is READ, never written — the transcript
 * stays exactly as the loop left it.
 */

import type { ChatMessage } from "../types/history.js";
import type { ModelPort } from "../ports/model.js";
import type { ToolDeclaration } from "../types/tools.js";
import type { ReasoningEffort } from "../types/config.js";
import { CEILING_DECISION_TIMEOUT_MS, CEILING_MIN_WINDOW_MS } from "../types/config.js";
import { linkAbortSignal } from "../util/abort.js";

/** Ladder configuration for one AgentLoop (design §1.4). */
export interface CeilingConfig {
  /** False disables the ladder entirely — the turn cap is a wall again. */
  enabled?: boolean;
  /** Window for ONE decision call, ms. CEILING_DECISION_TIMEOUT_MS when omitted. */
  decisionTimeoutMs?: number;
  /**
   * Cap on the SUM of turns the ladder may hand out over the whole session.
   * Defaults to the loop's own maxTurns: the ladder can at most double the
   * configured budget, never more.
   */
  maxGrantedTurns?: number;
  /**
   * Overall turn ceiling INCLUDING grants (children only): the runner passes
   * SUBAGENT_MAX_TURNS_CEILING so a child's total overrun stays under the same
   * runaway guard that bounds its explicit budget.
   */
  maxTurnsCeiling?: number;
  /**
   * Absolute epoch-ms by which the caller must have the outcome (children
   * only): the decision window is clamped to the remainder, and below
   * CEILING_MIN_WINDOW_MS the call is not made at all.
   */
  outcomeDeadlineAt?: number;
}

/** The structured verdict, exactly as the model called it. */
export interface CeilingVerdict {
  /** True when the model declares the user's request fully satisfied. */
  done: boolean;
  /** Concrete unfinished items; empty when done. */
  remaining: string[];
  /** The single next step when not done; absent/blank counts as missing. */
  nextAction?: string;
}

export const CEILING_VERDICT_TOOL_NAME = "ceiling_verdict";

/** Schema bound on `remaining`; a longer list is a refusal, not a truncation. */
export const CEILING_REMAINING_MAX_ITEMS = 20;

/**
 * The ONE declaration handed to the decision call. Its JSON schema is the
 * contract the checker below enforces byte-for-byte, `additionalProperties`
 * included: an argument object carrying a field the schema does not declare is
 * not a verdict this ladder can trust.
 */
export const CEILING_VERDICT_DECLARATION: ToolDeclaration = {
  name: CEILING_VERDICT_TOOL_NAME,
  description:
    "Report whether the user's request is fully satisfied and, when it is not, exactly what remains.",
  inputJsonSchema: {
    type: "object",
    additionalProperties: false,
    required: ["done", "remaining"],
    properties: {
      done: { type: "boolean" },
      remaining: {
        type: "array",
        items: { type: "string", minLength: 1 },
        maxItems: CEILING_REMAINING_MAX_ITEMS,
      },
      next_action: { type: "string" },
    },
  },
};

/**
 * The user frame appended to the loop's own history for the decision call
 * (design §1.14). Round 2+ additionally states the previous remaining count and
 * the shortening rule, because that is the gate the answer is measured against.
 */
export function buildCeilingDecisionPrompt(
  round: number,
  maxRounds: number,
  previousRemaining?: number,
): string {
  const lines = [
    "You have reached the configured turn limit. Call `ceiling_verdict` exactly once with:",
    "- done — is the user's request fully satisfied;",
    "- remaining — concrete unfinished items (empty when done);",
    "- next_action — the single next step when not done.",
    `Round ${round} of ${maxRounds}.`,
  ];
  if (previousRemaining !== undefined) {
    lines.push(
      `Previous remaining count: ${previousRemaining}. You must shorten remaining to continue.`,
    );
  }
  return lines.join("\n");
}

/**
 * Turns granted for one round: half of the budget, then a quarter, then an
 * eighth — each round is strictly less useful than the last, so a run that
 * cannot finish converges instead of drifting. Rounds 1-2 are floored at 1 so
 * a small budget still produces a meaningful (if tiny) grant rather than a
 * silent zero; round 3 is floored at 5 per the owner's table (TASK.124.md
 * "круг 3 → N/8, но не меньше 5") — the last extension is not allowed to
 * shrink to a token amount even when N/8 rounds down to nothing. The SUM
 * clamps in ceilingGrant() are what actually bound the total regardless.
 */
export function grantForRound(round: number, maxTurns: number): number {
  const floor = round >= 3 ? 5 : 1;
  return Math.max(floor, Math.floor(maxTurns / 2 ** round));
}

/**
 * The grant actually issued for a round: the decreasing raw grant, clamped by
 * the session's total-grant budget (default = maxTurns, so the ladder can at
 * most double the configured budget) and, for a child, by the absolute
 * maxTurnsCeiling. Zero means "no room left" — the caller must refuse without
 * ever making the decision call.
 */
export function ceilingGrant(
  round: number,
  maxTurns: number,
  alreadyGranted: number,
  config?: CeilingConfig,
): number {
  const totalBudget = config?.maxGrantedTurns ?? maxTurns;
  let grant = Math.min(grantForRound(round, maxTurns), totalBudget - alreadyGranted);
  if (config?.maxTurnsCeiling !== undefined) {
    grant = Math.min(grant, config.maxTurnsCeiling - maxTurns - alreadyGranted);
  }
  return Math.max(0, grant);
}

/**
 * The decision window for one round, or null when the call must be skipped
 * entirely. A child's window is clamped by the remainder of its outcome
 * deadline: a verdict that cannot come back before the caller gives up is worth
 * less than the stop it would delay (design §1.11).
 */
export function ceilingWindowMs(config: CeilingConfig | undefined, now: number): number | null {
  const configured = config?.decisionTimeoutMs ?? CEILING_DECISION_TIMEOUT_MS;
  const window =
    config?.outcomeDeadlineAt !== undefined
      ? Math.min(configured, config.outcomeDeadlineAt - now)
      : configured;
  return window >= CEILING_MIN_WINDOW_MS ? window : null;
}

/**
 * The ladder's gate on a verdict, per round (design §1.5/§1.13, spec p.4/p.6):
 *
 *  - every round: the model must say the work is NOT done and name at least one
 *    concrete remaining item — "done" or a blank list means there is nothing to
 *    grant turns for;
 *  - round 2+: the round just spent must contain at least one SUCCESSFUL tool
 *    call (a round of pure talk earns nothing) AND the remaining list must be
 *    strictly shorter than the previous round's (progress, not restatement);
 *  - round 3: additionally a non-blank next_action — the last extension is only
 *    for a run that can name what it will do with it.
 */
export function acceptCeilingVerdict(params: {
  verdict: CeilingVerdict;
  round: number;
  /** Length of the remaining list of the previous granted round; undefined on round 1. */
  previousRemaining?: number;
  /** Successful tool calls made since the previous grant. */
  successfulToolCalls: number;
}): boolean {
  const { verdict, round, previousRemaining, successfulToolCalls } = params;
  if (verdict.done || verdict.remaining.length === 0) {
    return false;
  }
  if (round >= 2) {
    if (successfulToolCalls <= 0) {
      return false;
    }
    if (previousRemaining === undefined || verdict.remaining.length >= previousRemaining) {
      return false;
    }
  }
  if (round >= 3 && (verdict.nextAction === undefined || verdict.nextAction.trim().length === 0)) {
    return false;
  }
  return true;
}

/**
 * Structural checker for the tool-call arguments — the ONLY way a verdict is
 * ever produced. Mirrors CEILING_VERDICT_DECLARATION exactly (required fields,
 * types, item bounds, no additional properties); anything else returns null,
 * which the caller reads as a refusal.
 */
export function parseCeilingVerdict(input: unknown): CeilingVerdict | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "done" && key !== "remaining" && key !== "next_action") {
      return null;
    }
  }
  const { done, remaining, next_action: nextAction } = record;
  if (typeof done !== "boolean") {
    return null;
  }
  if (!Array.isArray(remaining) || remaining.length > CEILING_REMAINING_MAX_ITEMS) {
    return null;
  }
  const items: string[] = [];
  for (const item of remaining) {
    if (typeof item !== "string" || item.length === 0) {
      return null;
    }
    items.push(item);
  }
  if (nextAction !== undefined && typeof nextAction !== "string") {
    return null;
  }
  return {
    done,
    remaining: items,
    ...(typeof nextAction === "string" ? { nextAction } : {}),
  };
}

export interface CeilingDecisionRequest {
  modelPort: ModelPort;
  /** The loop's own system prompt — the decision is asked of the same agent. */
  system?: string;
  /** The loop's history, read as-is; the instruction rides only in this request. */
  messages: ChatMessage[];
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  round: number;
  maxRounds: number;
  previousRemaining?: number;
  /** Hard window for this call; the controller is aborted when it elapses. */
  windowMs: number;
  /** The turn signal: the decision must not outlive a cancelled turn. */
  signal?: AbortSignal;
}

/**
 * Makes ONE decision call and returns the structural verdict, or null when the
 * ladder must refuse. Never throws: an aborted, timed-out, erroring or
 * unreadable call is a refusal like any other.
 *
 * Two tool calls in one reply are also a refusal — the instruction says
 * "exactly once", and a second call makes it ambiguous which one the model
 * meant. A stream_retry discards whatever the aborted attempt captured (mirror
 * of the loop's own accumulator reset).
 */
export async function requestCeilingVerdict(
  request: CeilingDecisionRequest,
): Promise<CeilingVerdict | null> {
  const controller = new AbortController();
  const dispose = request.signal ? linkAbortSignal(request.signal, controller) : () => {};
  const timer = setTimeout(() => controller.abort("ceiling-decision-timeout"), request.windowMs);
  try {
    let captured: unknown;
    let capturedCount = 0;
    let invalid = false;
    const stream = request.modelPort.streamText({
      system: request.system,
      messages: [
        ...request.messages,
        {
          role: "user",
          content: buildCeilingDecisionPrompt(
            request.round,
            request.maxRounds,
            request.previousRemaining,
          ),
        },
      ],
      tools: [CEILING_VERDICT_DECLARATION],
      maxOutputTokens: request.maxOutputTokens,
      reasoningEffort: request.reasoningEffort,
      abortSignal: controller.signal,
    });
    for await (const event of stream) {
      if (event.type === "tool_call") {
        capturedCount += 1;
        if (event.toolCall.name !== CEILING_VERDICT_TOOL_NAME || event.toolCall.invalid) {
          invalid = true;
        }
        captured = event.toolCall.input;
      } else if (event.type === "stream_retry") {
        captured = undefined;
        capturedCount = 0;
        invalid = false;
      }
    }
    if (invalid || capturedCount !== 1) {
      return null;
    }
    return parseCeilingVerdict(captured);
  } catch {
    // Fail-closed: an unreadable decision is a refusal, never a grant.
    return null;
  } finally {
    clearTimeout(timer);
    dispose();
  }
}
