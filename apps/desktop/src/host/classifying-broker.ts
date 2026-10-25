/**
 * Taskana 4730 (4702 remainder): a broker DECORATOR that extends ask-zone
 * classifier coverage to ENGINE-SESSION approval bridges (Codex/Claude). The
 * two bridges (engines/codex/approval-bridge.ts, engines/claude/approval-
 * bridge.ts) call `this.options.broker.requestPermission(request)` — this
 * decorator wraps THAT broker at the host wiring site, so the bridges'
 * own logic is untouched.
 *
 * Contract, mirroring the core dispatcher exactly:
 *   - consulted ONLY for a Bash-like command tool (isPlaqueCommandLineTool:
 *     Claude "Bash" and Codex "CodexExec") whose ask already passed the
 *     engine's own decision to ask the human (the request reaching the broker
 *     IS an ask by construction — the bridges deny/refuse everything the
 *     engine already settled);
 *   - 4730 xfix D1: a CodexExec ask with a string `command` and NOT
 *     `kind:"writeStdin"` is normalized to the Bash-shaped classifier input
 *     (the same CodexExec→Bash shape the broker's TASK.184 rule matching
 *     already uses) — engine approvals get the classifier coverage the card
 *     promised. A `writeStdin` ask (input to an ALREADY-RUNNING command) is
 *     never classifiable (D6): the classifier must not reason about stdin
 *     input on a stale command line, the same exclusion the plaque layer and
 *     the bridge's own de-risk gate apply;
 *   - 4730 xfix D5: while the wiring's Session reference is UNBOUND (the
 *     decorator is built before the Session exists), nothing is consulted —
 *     an empty human context would make the classifier's "consistent with
 *     what the human asked" check vacuous. Fail-closed: delegate (ask);
 *   - 4730 xfix D8: the unattended latch (TASK.138) is checked BEFORE any
 *     consultation — an unattended run's asks are denied fast by the wrapped
 *     broker, and burning a model call (up to the full timeout) before that
 *     deny would change nothing but the latency;
 *   - the shared core consultation (consultAskClassifier) applies the same
 *     eligibility gate (isClassifiableAsk: sudo/force-push/curl|sh/too-long/
 *     unparseable are never consulted) and emits the same
 *     `permission_auto_decided` journal event (under the ORIGINAL tool name —
 *     the journal records the ask that was decided, not the normalized
 *     classifier input);
 *   - a valid `allow` verdict resolves the ask WITHOUT the wrapped broker
 *     ({behavior:"allow"}) so the human is not prompted;
 *   - EVERY other path (ask verdict, classifier error/timeout, ineligible,
 *     non-command tool, absent classifier) delegates to the wrapped broker
 *     unchanged — fail-closed to asking.
 *
 * `emit` receives the AgentEvent; the wiring decides how it reaches the
 * transcript (the core engine emits through the Session's agent_event channel).
 */

import {
  consultAskClassifier,
  isPlaqueCommandLineTool,
  type AgentEvent,
  type AskClassifier,
  type PermissionBroker,
  type PermissionDecision,
  type PermissionRequest,
} from "@anycode/core";
import type { EngineBridgeBroker, SettleOrigin } from "./permission-broker.js";

export interface ClassifyingBrokerOptions {
  classifier: AskClassifier;
  timeoutMs?: number;
  /** Last plain HUMAN user-message texts (bounded ring owned by the wiring). */
  userContext(): string[];
  /**
   * 4730 xfix D5: true once the wiring's Session reference has bound. While
   * false (the decorator outlives the Session's construction), NOTHING is
   * consulted — the human context is unknown, so classification is
   * fail-closed to delegating (ask). Optional for direct/unit use; omitted
   * means "always bound".
   */
  isBound?(): boolean;
  cwd: string;
  /** The journal sink for permission_auto_decided (the session's emit channel). */
  emit: (event: AgentEvent) => void;
}

/** Default model-kind deadline for one classification (a model call is slower than a local command). */
export const CLASSIFYING_BROKER_MODEL_TIMEOUT_MS = 8000;

/**
 * Taskana 4730 xfix D1: normalize a command-tool ask to the Bash-shaped
 * request core's shared eligibility gate and classifier input understand.
 * A CodexExec ask (the Codex approval bridge's stamp for a `commandExecution`
 * approval) carries the same `command: string` a Bash call does — rules.ts's
 * TASK.184 treatment. `kind: "writeStdin"` (input to a command that is
 * ALREADY running) never normalizes (D6), and neither does an ask without a
 * non-empty string `command` — both delegate untouched.
 */
function normalizeCommandAsk(request: PermissionRequest): PermissionRequest | undefined {
  if (request.toolName === "Bash") return request;
  if (request.toolName !== "CodexExec") return undefined;
  const record =
    request.input !== null && typeof request.input === "object"
      ? (request.input as { command?: unknown; kind?: unknown })
      : undefined;
  const command = record?.command;
  if (typeof command !== "string" || command.trim().length === 0) return undefined;
  if (record?.kind === "writeStdin") return undefined;
  return { ...request, toolName: "Bash", input: { command } };
}

export function withAskClassifier<T extends EngineBridgeBroker>(
  broker: T,
  opts: ClassifyingBrokerOptions,
): EngineBridgeBroker {
  const config = {
    classifier: opts.classifier,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    userContext: opts.userContext,
  };
  // Every denyAll / latch read forwards to the wrapped broker untouched: the
  // decorator only ever intercepts requestPermission, and only the ask path.
  const proxy: EngineBridgeBroker = {
    denyAll: (reason: string, origin: SettleOrigin) => broker.denyAll(reason, origin),
    get isUnattended(): boolean {
      return broker.isUnattended;
    },
    get isAwaitingApproval(): boolean {
      return broker.isAwaitingApproval;
    },
    requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
      return classify(request);
    },
  };
  async function classify(request: PermissionRequest): Promise<PermissionDecision> {
      // 4730 xfix D8: the unattended latch first — the wrapped broker's fast
      // deny settles an unattended run's asks; a consultation before it would
      // only add a model call (and its full timeout) to the latency.
      if (broker.isUnattended) {
        return broker.requestPermission(request);
      }
      // Only Bash-like command tools are classifiable; everything else (patch
      // approvals, MCP, ask-user, etc.) delegates untouched.
      if (!isPlaqueCommandLineTool(request.toolName)) {
        return broker.requestPermission(request);
      }
      // 4730 xfix D5: unbound Session reference — the human context is
      // unknown, so nothing is consulted; fail-closed to the wrapped broker.
      if (opts.isBound !== undefined && !opts.isBound()) {
        return broker.requestPermission(request);
      }
      // 4730 xfix D1/D6: normalize to the Bash shape (a writeStdin or
      // command-less CodexExec ask never normalizes and delegates here).
      const normalized = normalizeCommandAsk(request);
      if (normalized === undefined) {
        return broker.requestPermission(request);
      }
      try {
        const consulted = await consultAskClassifier(
          config,
          normalized,
          // The request reaching the broker IS an ask: the engine's bridge
          // already settled everything it could settle itself.
          { decision: "ask" },
          {
            cwd: opts.cwd,
            toolCallId: request.toolCallId ?? "",
            hookEscalated: false, // engine sessions run no PreToolUse hooks

          },
        );
        if (consulted === null) {
          // Not eligible (sudo/force-push/pipe-to-shell/too-long/...): ask.
          return broker.requestPermission(request);
        }
        // The journal records the ask that was auto-decided under its
        // ORIGINAL tool name (CodexExec for a Codex command approval), not
        // the normalized classifier input's.
        const event = consulted.event;
        if (event.type === "permission_auto_decided") {
          opts.emit({ ...event, toolName: request.toolName });
        } else {
          opts.emit(event);
        }
        if (consulted.autoAllowed) {
          return { behavior: "allow" };
        }
        return broker.requestPermission(request);
      } catch {
        // The decorator must never invent a decision: any throw is an ask.
        return broker.requestPermission(request);
      }
  }
  return proxy;
}

