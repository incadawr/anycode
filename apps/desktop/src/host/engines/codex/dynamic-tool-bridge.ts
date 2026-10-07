import type { AgentEvent, AgentBridgeCatalogEntry, SessionSubagentPort, PermissionMode } from "@anycode/core";
import { buildAgentBridgeToolDecl, decodeAgentBridgeCallInput, runAgentBridgeCall } from "@anycode/core";
import type { JsonRpcServerRequest } from "./protocol.js";
import type { ServerRequestResponder } from "./app-server-client.js";
import type { CodexAgentCardLogPort } from "./agent-card-log.js";
import type { ActiveCodexTurn } from "./approval-bridge.js";

export const ANYCODE_AGENT_TOOL = "anycode_agent";

/** Core children inherit the current native posture, never a wider default. */
export function codexAgentPermissionMode(presetId: string): PermissionMode {
  if (presetId === "full-access") return "yolo";
  if (presetId === "ask" || presetId === "approve-for-me") return "build";
  return "plan";
}

/** One host-owned tool; native Codex agents never substitute for AnyCode profiles. */
export class CodexDynamicToolBridge {
  private readonly pending = new Map<string, AbortController>();
  private readonly work = new Set<Promise<unknown>>();
  private turnKey = "";
  private readonly seenCalls = new Set<string>();
  constructor(readonly catalog: readonly AgentBridgeCatalogEntry[], private readonly port: SessionSubagentPort, private readonly cardLog?: CodexAgentCardLogPort,
    private readonly resolveCatalog?: () => Promise<readonly AgentBridgeCatalogEntry[]>) {}

  declarations(): Record<string, unknown>[] {
    // `detach` is safe to offer here: host/index.ts wires this bridge's port
    // with `onDetachedTerminal`, so a background child's report comes back
    // to this Codex session as a new turn instead of the turn idling on it.
    const decl = buildAgentBridgeToolDecl(this.catalog, { detach: true });
    return decl ? [{ ...decl, name: ANYCODE_AGENT_TOOL, type: "function" }] : [];
  }

  cancel(): void {
    for (const controller of this.pending.values()) controller.abort();
  }

  /**
   * TASK.226: cancel + a promise that settles once every in-flight call has
   * EMITTED its real terminal event (or never will). Used ONLY by the engine's
   * bounded pre-loop_end settle: Stop stays immediate (the interrupt and the
   * immediate cancelled acknowledgment are sent synchronously by `cancel()` +
   * the engine's own beginInterrupt), and this join waits — within the
   * caller's own deadline — for the child's real cancelled outcome (status +
   * child-session target + subagent card) so it can be delivered BEFORE
   * loop_end instead of being dropped after owner teardown.
   *
   * Gated on `work`, NOT `pending`: `handle()` removes its controller from
   * `pending` the moment the abort wins its race (the finally runs right
   * after the immediate acknowledgment), while `work` keeps the underlying
   * `port.run()` promise — the one the real outcome rides — until it truly
   * settles. `cancelled` therefore answers "is there any child still to
   * settle", which is exactly what the engine's join needs.
   */
  cancelAwaiting(): { cancelled: boolean; completion: Promise<unknown> } {
    this.cancel();
    return { cancelled: this.work.size > 0, completion: Promise.allSettled([...this.work]) };
  }

  /** Parent shutdown joins real child-terminal metadata, while Stop stays immediate. */
  async drain(timeoutMs = 1_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.work]).then(() => this.cardLog?.flush?.()),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async handle(request: JsonRpcServerRequest, respond: ServerRequestResponder,
    active: ActiveCodexTurn | null, emit: (event: AgentEvent) => void): Promise<void> {
    const p = request.params as Record<string, unknown> | undefined;
    const fail = (text: string): void => respond.result({ success: false, contentItems: [{ type: "inputText", text }] });
    if (!p || !active || p.threadId !== active.threadId || p.turnId !== active.turnId ||
      p.tool !== ANYCODE_AGENT_TOOL || (p.namespace !== undefined && p.namespace !== null) ||
      typeof p.callId !== "string" || !p.callId || this.pending.has(p.callId)) {
      fail("AnyCode rejected an unknown, duplicate or out-of-turn agent call");
      return;
    }
    const turnKey = JSON.stringify([active.threadId, active.turnId]);
    if (this.turnKey !== turnKey) {
      this.turnKey = turnKey;
      this.seenCalls.clear();
    }
    if (this.seenCalls.has(p.callId)) {
      fail("AnyCode rejected a repeated agent call");
      return;
    }
    const input = p.arguments !== null && typeof p.arguments === "object" && !Array.isArray(p.arguments)
      ? decodeAgentBridgeCallInput(p.arguments as Record<string, unknown>) : null;
    if (!input) { fail("Malformed AnyCode agent arguments"); return; }
    const id = p.callId;
    const controller = new AbortController();
    this.pending.set(id, controller);
    this.seenCalls.add(id);
    emit({ type: "tool_call", toolCall: { id, name: "Agent", input } });
    emit({ type: "tool_execution_start", toolCallId: id, toolName: "Agent", input });
    const startedAt = Date.now();
    let removeAbort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new Error("AnyCode agent was cancelled"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => controller.signal.removeEventListener("abort", onAbort);
    });
    try {
      const execute = (catalog: readonly AgentBridgeCatalogEntry[]) => {
        if (controller.signal.aborted) throw new Error("AnyCode agent was cancelled");
        return runAgentBridgeCall(input, {
          // Native declarations stay fixed for this thread; existing profile bodies/models are live.
          catalog: catalog.filter((entry) => this.catalog.some((declared) => declared.name === entry.name)),
          port: this.port, spawnToolCallId: id, signal: controller.signal,
          onEvent: (event) => { if (!controller.signal.aborted) emit(event); },
        });
      };
      const work = this.resolveCatalog ? this.resolveCatalog().then(execute) : execute(this.catalog);
      const settledWork = work.then((result) => {
        // A late cancelled outcome still owns durable metadata; it cannot emit into a later turn.
        if (result.presentation) this.cardLog?.record(id, result.presentation);
        return result;
      });
      this.work.add(settledWork);
      void settledWork.then(() => this.work.delete(settledWork), () => this.work.delete(settledWork));
      type Settled = Awaited<ReturnType<typeof runAgentBridgeCall>>;
      const result: { via: "settled"; settled: Settled } | { via: "cancelled" | "failed"; settled: unknown } =
        await Promise.race([settledWork, cancelled]).then(
          (settled: Settled) => ({ via: "settled" as const, settled }),
          (rejection: unknown) => ({ via: controller.signal.aborted ? ("cancelled" as const) : ("failed" as const), settled: rejection }),
        );
      if (result.via === "failed") throw result.settled;
      if (result.via === "cancelled") {
        // TASK.226: Stop must stay immediate — emit the abort acknowledgment
        // NOW (the native interrupt must never wait on the child) — but the
        // child's REAL terminal outcome (status + child-session target +
        // subagent card) only settles when main's terminal arrives, AFTER the
        // interrupt's turn/completed. The `work` promise is never abandoned:
        // a follow-up terminal emission (below) replaces this placeholder's
        // coarse card with the real cancelled outcome while the engine's
        // bounded pre-loop_end settle (codex-engine.ts) still owns the turn,
        // so the live parent card closes cancelled WITH its child target
        // instead of staying "running"/final null until a reload.
        emit({ type: "tool_result", outcome: {
          toolCallId: id, toolName: "Agent", status: "cancelled",
          modelText: "AnyCode agent was cancelled", durationMs: Date.now() - startedAt,
          result: { ok: false, error: "AnyCode agent was cancelled", errorKind: "cancelled" },
        } });
        const late = settledWork.then((outcome: Awaited<ReturnType<typeof runAgentBridgeCall>>) => {
          if (outcome.presentation !== undefined) {
            // The presentation's own `final.status` is the honest child
            // verdict (cancelled, with its child-session target); the OUTER
            // status stays "cancelled" because this call WAS Stop-cancelled —
            // a child that reports `isError` after an abort is still a
            // cancelled call, never an error the user must retry.
            emit({ type: "tool_result", outcome: {
              toolCallId: id, toolName: "Agent", status: "cancelled",
              modelText: outcome.text, durationMs: Date.now() - startedAt,
              result: { ok: false, error: outcome.text, presentation: outcome.presentation },
            } });
          }
          return outcome;
        });
        // TASK.226 review fix: track and delete the SAME promise. `late`
        // settles only after the late emission ran, so a drain() joins the
        // emission too — and removing it keeps `work` from retaining settled
        // entries forever (the old shape added `late.then(cleanup)` but
        // deleted `late`, a permanent leak in the set).
        this.work.add(late);
        void late.then(() => this.work.delete(late), () => this.work.delete(late));
        fail("AnyCode agent was cancelled");
        return;
      }
      type AgentCallResult = Awaited<ReturnType<typeof runAgentBridgeCall>>;
      const settled: AgentCallResult = result.settled as AgentCallResult;
      emit({ type: "tool_result", outcome: {
        toolCallId: id, toolName: "Agent", status: controller.signal.aborted ? "cancelled" : settled.isError ? "error" : "success",
        modelText: settled.text, durationMs: Date.now() - startedAt,
        result: settled.isError ? { ok: false, error: settled.text, ...(settled.presentation ? { presentation: settled.presentation } : {}) }
          : { ok: true, output: settled.text, ...(settled.presentation ? { presentation: settled.presentation } : {}) },
      } });
      respond.result({ success: !settled.isError && !controller.signal.aborted,
        contentItems: [{ type: "inputText", text: settled.text }] });
    } catch {
      const text = controller.signal.aborted ? "AnyCode agent was cancelled" : "AnyCode agent call failed";
      emit({ type: "tool_result", outcome: { toolCallId: id, toolName: "Agent",
        status: controller.signal.aborted ? "cancelled" : "error", modelText: text, durationMs: Date.now() - startedAt, result: { ok: false, error: text } } });
      fail(text);
    } finally { removeAbort(); this.pending.delete(id); }
  }
}
