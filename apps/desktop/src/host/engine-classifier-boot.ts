/**
 * Taskana 4730: the ENGINE-SESSION (Codex/Claude) half of ask-zone classifier
 * coverage. The two engine boots (bootCodexSession / bootClaudeSession in
 * host/index.ts) have no core provider stack, so the model kind cannot build a
 * ModelPort there — only the `command` kind is active for engine sessions, and
 * a `model` record is reported as off for them (the CORE boot of the same
 * settings still gets the model kind; a future card may thread a port here).
 *
 * The userContext source is the Session's human-turn ring
 * (Session.recentHumanUserTurns), threaded as a late-bound thunk so the broker
 * can be decorated BEFORE the Session exists (the bridges capture the broker at
 * construction, before the first MCP handshake — Taskana 4226 ordering).
 */

import type { AgentEvent, AskClassifier } from "@anycode/core";
import { withAskClassifier } from "./classifying-broker.js";
import type { EngineBridgeBroker } from "./permission-broker.js";

export interface EngineClassifierBoot {
  classifier: AskClassifier;
  timeoutMs?: number;
}

/**
 * Wraps `broker` with the classifying decorator when a boot exists. `emit` is
 * late-bound (the Session's agent_event channel) for the same reason: the
 * broker is decorated before the Session is constructed. `isBound` (4730 xfix
 * D5) is likewise late-bound: while the Session ref is unbound, the decorator
 * consults nothing and delegates — no classification can ever run against an
 * empty human context.
 */
export function decorateEngineBroker(
  broker: EngineBridgeBroker,
  boot: EngineClassifierBoot | undefined,
  opts: {
    userContext(): string[];
    cwd: string;
    emit(event: AgentEvent): void;
    /** True once the wiring's Session reference has bound (D5 fail-closed gate). */
    isBound?(): boolean;
  },
): EngineBridgeBroker {
  if (boot === undefined) return broker;
  return withAskClassifier(broker, {
    classifier: boot.classifier,
    ...(boot.timeoutMs !== undefined ? { timeoutMs: boot.timeoutMs } : {}),
    userContext: opts.userContext,
    ...(opts.isBound !== undefined ? { isBound: opts.isBound } : {}),
    cwd: opts.cwd,
    emit: opts.emit,
  });
}
