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
 *   - the shared core consultation (consultAskClassifier) applies the same
 *     eligibility gate (isClassifiableAsk: sudo/force-push/curl|sh/too-long/
 *     unparseable are never consulted) and emits the same
 *     `permission_auto_decided` journal event;
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
  cwd: string;
  /** The journal sink for permission_auto_decided (the session's emit channel). */
  emit: (event: AgentEvent) => void;
}

/** Default model-kind deadline for one classification (a model call is slower than a local command). */
export const CLASSIFYING_BROKER_MODEL_TIMEOUT_MS = 8000;

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
      // Only Bash-like command tools are classifiable; everything else (patch
      // approvals, MCP, ask-user, etc.) delegates untouched.
      if (!isPlaqueCommandLineTool(request.toolName)) {
        return broker.requestPermission(request);
      }
      try {
        const consulted = await consultAskClassifier(
          config,
          request,
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
        opts.emit(consulted.event);
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

