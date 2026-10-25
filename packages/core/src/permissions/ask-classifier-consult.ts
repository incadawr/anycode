/**
 * Taskana 4730 (4702 remainder): the ONE shared ask-zone classifier consultation
 * — eligibility, input assembly, the fail-closed call and the
 * `permission_auto_decided` journal event. Extracted verbatim from the
 * dispatcher's tryAutoDecideAsk (dispatcher output stays byte-identical: the
 * dispatcher now delegates here) so the ENGINE-SESSION broker decorator
 * (apps/desktop/src/host/classifying-broker.ts) emits the same event shape for
 * Codex/Claude approvals that the core dispatcher emits for its own asks.
 *
 * Same invariants as Stage 1: consulted only on an ask the deterministic layer
 * already produced, never on allow/deny, never on a hook-escalated ask; the
 * classifier can only turn the ask into allow; every failure is an ask.
 */

import type { AgentEvent } from "../types/events.js";
import type { ToolEmittedEvent } from "../types/tools.js";
import {
  classifyAsk,
  isClassifiableAsk,
  type AskClassifier,
  type AskClassifierInput,
} from "./ask-classifier.js";
import type { PermissionRequest, PermissionRuling } from "../types/permissions.js";

export interface AskClassifierConsultConfig {
  classifier: AskClassifier;
  timeoutMs?: number;
  /** Human recent turns, newest last; never assistant text or tool output. */
  userContext(): string[];
}

export interface AskClassifierConsultation {
  /** True only for a valid allow verdict: the broker is skipped. */
  autoAllowed: boolean;
  /** The journal event to emit for every CONSULTED ask (allow or ask). */
  event: ToolEmittedEvent;
}

/**
 * Runs one classification for a request the caller already ruled "ask".
 * NEVER throws: any throw inside resolves to autoAllowed=false with no event
 * (the caller's catch semantics from Stage 1 — nothing was consulted).
 * `toolCallId` falls back to "" when the request carries none (engine bridges
 * construct requests without one); the event still identifies toolName.
 */
export async function consultAskClassifier(
  config: AskClassifierConsultConfig,
  request: PermissionRequest,
  ruling: PermissionRuling,
  opts: {
    cwd: string;
    toolCallId: string;
    hookEscalated: boolean;
    signal?: AbortSignal;
  },
): Promise<AskClassifierConsultation | null> {
  const eligibility = isClassifiableAsk(request, ruling, opts.hookEscalated);
  if (!eligibility.eligible) return null;
  const command = (request.input as { command?: unknown }).command;
  if (typeof command !== "string") return null;
  const input: AskClassifierInput = {
    toolName: "Bash",
    command,
    segments: eligibility.segments,
    cwd: opts.cwd,
    userContext: config.userContext(),
  };
  const consulted = await classifyAsk(config.classifier, input, {
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const autoAllowed = consulted.verdict.decision === "allow" && consulted.error === undefined;
  const event: ToolEmittedEvent = {
    type: "permission_auto_decided",
    toolCallId: opts.toolCallId,
    toolName: request.toolName,
    classifier: config.classifier.id,
    decision: autoAllowed ? "allow" : "ask",
    reason: consulted.verdict.reason,
    ...(consulted.verdict.score !== undefined ? { score: consulted.verdict.score } : {}),
    latencyMs: consulted.latencyMs,
    ...(consulted.error !== undefined ? { error: consulted.error } : {}),
  };
  return { autoAllowed, event };
}

/** Narrows an AgentEvent to the permission_auto_decided journal variant. */
export function isPermissionAutoDecidedEvent(
  event: AgentEvent,
): event is Extract<ToolEmittedEvent, { type: "permission_auto_decided" }> {
  return event.type === "permission_auto_decided";
}
