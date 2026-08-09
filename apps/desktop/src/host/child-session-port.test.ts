import { describe, expect, it, vi } from "vitest";
import type { PermissionMode, SessionSubagentOutcome, SubagentProgress } from "@anycode/core";
import {
  CHILD_AGENT_TYPE_MAX_CHARS,
  CHILD_DESCRIPTION_MAX_CHARS,
  CHILD_ID_MAX_CHARS,
  CHILD_MODEL_MAX_CHARS,
  CHILD_PROMPT_MAX_CHARS,
  CHILD_PROVIDER_MAX_CHARS,
  CHILD_RUN_CANCEL_TYPE,
  CHILD_RUN_EVENT_TYPE,
  CHILD_SPAWN_REQUEST_TYPE,
  type ChildRunCancel,
  type ChildRunEvent,
  type ChildSpawnRequest,
} from "../shared/child-sessions.js";
import { createChildSessionPort } from "./child-session-port.js";

const PARENT_SESSION_ID = "parent-session-1";

/** Verbatim §2.7 text (CUT-S2.md) — the model-visible refusal for a per-session limit hit. */
const LIMIT_PARENT_MESSAGE =
  'Agent: session-subagent limit reached — this session already has 3 running child sessions. Wait for one to finish, or use tier "inline".';

type SentMessage = ChildSpawnRequest | ChildRunCancel;

/**
 * Builds a port over fake send/subscribe closures. `subscribe` is called
 * EXACTLY ONCE by the port under test (construction-time, cut §2.6.1) — the
 * harness captures that single listener and exposes it as `emit`, standing
 * in for main relaying a ChildRunEvent over process.parentPort.
 */
function harness(getPermissionMode: () => PermissionMode = () => "build") {
  const sent: SentMessage[] = [];
  let listener: ((event: ChildRunEvent) => void) | undefined;
  let unsubscribeCalls = 0;
  let nextId = 0;

  const port = createChildSessionPort({
    parentSessionId: PARENT_SESSION_ID,
    getPermissionMode,
    send: (message) => sent.push(message),
    subscribe: (cb) => {
      listener = cb;
      return () => {
        unsubscribeCalls += 1;
      };
    },
    createRequestId: () => `req-${++nextId}`,
  });

  return {
    port,
    sent,
    emit: (event: ChildRunEvent) => listener?.(event),
    unsubscribeCalls: () => unsubscribeCalls,
  };
}

function spawns(sent: SentMessage[]): ChildSpawnRequest[] {
  return sent.filter((m): m is ChildSpawnRequest => m.type === CHILD_SPAWN_REQUEST_TYPE);
}

function cancels(sent: SentMessage[]): ChildRunCancel[] {
  return sent.filter((m): m is ChildRunCancel => m.type === CHILD_RUN_CANCEL_TYPE);
}

function terminalEvent(requestId: string, overrides: Partial<Extract<ChildRunEvent, { kind: "terminal" }>> = {}): ChildRunEvent {
  return {
    type: CHILD_RUN_EVENT_TYPE,
    requestId,
    kind: "terminal",
    status: "completed",
    finalText: "",
    truncated: false,
    turns: 0,
    toolCalls: 0,
    durationMs: 0,
    childSessionId: "child-default",
    ...overrides,
  };
}

describe("createChildSessionPort (TASK.102 CUT-S2 §2.6.1)", () => {
  it("correlates concurrent run()s by requestId: replies arriving in REVERSED order still resolve the matching promise, and an unrelated requestId is ignored", async () => {
    const { port, sent, emit } = harness();
    const p1 = port.run(
      { agentType: "general-purpose", description: "task one", prompt: "do one", spawnToolCallId: "spawn-1" },
      {},
    );
    const p2 = port.run(
      { agentType: "explore", description: "task two", prompt: "do two", spawnToolCallId: "spawn-2" },
      {},
    );

    expect(spawns(sent)).toHaveLength(2);
    const id1 = spawns(sent)[0]!.requestId;
    const id2 = spawns(sent)[1]!.requestId;
    expect(id1).not.toBe(id2);

    // A stray event for a requestId neither run() minted — must not throw or
    // resolve anything (unknown-requestId no-op, cut §2.6.1).
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId: "req-unknown", kind: "accepted", childSessionId: "x", childTabId: "t", model: "m" });

    // run2's whole lifecycle settles BEFORE run1's, even though run1 was
    // issued first — a FIFO-based (not requestId-based) correlator would
    // hand run1's promise run2's data here.
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId: id2, kind: "accepted", childSessionId: "child-2", childTabId: "tab-2", model: "model-2" });
    emit(
      terminalEvent(id2, {
        finalText: "result two",
        turns: 2,
        toolCalls: 1,
        durationMs: 200,
        childSessionId: "child-2",
      }),
    );

    emit({ type: CHILD_RUN_EVENT_TYPE, requestId: id1, kind: "accepted", childSessionId: "child-1", childTabId: "tab-1", model: "model-1" });
    emit(
      terminalEvent(id1, {
        finalText: "result one",
        turns: 1,
        toolCalls: 0,
        durationMs: 100,
        childSessionId: "child-1",
      }),
    );

    const [out1, out2] = await Promise.all([p1, p2]);
    expect(out1.finalText).toBe("result one");
    expect(out1.childSessionId).toBe("child-1");
    expect(out2.finalText).toBe("result two");
    expect(out2.childSessionId).toBe("child-2");
  });

  it("accepted emits a start progress event built from the REQUEST's agentType/description and main's resolved model", async () => {
    const { port, sent, emit } = harness();
    const onProgress = vi.fn();
    const pending = port.run(
      { agentType: "general-purpose", description: "build X", prompt: "...", spawnToolCallId: "spawn-build-x" },
      { onProgress },
    );
    const requestId = spawns(sent)[0]!.requestId;

    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "c1", childTabId: "t1", model: "claude-x" });

    expect(onProgress).toHaveBeenCalledTimes(1);
    const expectedStart: SubagentProgress = { kind: "start", agentType: "general-purpose", description: "build X", model: "claude-x" };
    expect(onProgress).toHaveBeenCalledWith(expectedStart);

    emit(terminalEvent(requestId, { childSessionId: "c1" }));
    await pending;
  });

  // TASK.102 CUT-S4 §3.1: `req.engine` rides the wire verbatim into the
  // ChildSpawnRequest AND into the "start" progress event on `accepted` —
  // the client never re-derives it, only forwards whatever the engine-profile
  // route (core, S4a) put on `SessionSubagentRequest.engine`.
  describe("engine passthrough (CUT-S4 §3.1)", () => {
    it("omits engine from the spawn request when the request carries none (core, byte-compatible)", async () => {
      const { port, sent } = harness();
      port.run({ agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-core" }, {});
      const spawnRequest = spawns(sent)[0]!;
      expect(spawnRequest).not.toHaveProperty("engine");
    });

    it.each(["claude", "codex"] as const)("forwards engine %s verbatim into the ChildSpawnRequest", async (engine) => {
      const { port, sent } = harness();
      port.run(
        { agentType: "engine-persona", description: "d", prompt: "p", spawnToolCallId: `spawn-${engine}`, engine },
        {},
      );
      const spawnRequest = spawns(sent)[0]!;
      expect(spawnRequest.engine).toBe(engine);
    });

    it.each(["claude", "codex"] as const)("carries engine %s onto the 'start' SubagentProgress emitted on accepted", async (engine) => {
      const { port, sent, emit } = harness();
      const onProgress = vi.fn();
      const pending = port.run(
        { agentType: "engine-persona", description: "d", prompt: "p", spawnToolCallId: `spawn-start-${engine}`, engine },
        { onProgress },
      );
      const requestId = spawns(sent)[0]!.requestId;

      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "c1", childTabId: "t1", model: "claude-x" });

      const expectedStart: SubagentProgress = {
        kind: "start",
        agentType: "engine-persona",
        description: "d",
        model: "claude-x",
        engine,
      };
      expect(onProgress).toHaveBeenCalledWith(expectedStart);

      emit(terminalEvent(requestId, { childSessionId: "c1" }));
      await pending;
    });
  });

  it("rejected resolves an error outcome carrying the EXACT §2.7 message verbatim (no paraphrasing, no wrapping)", async () => {
    const { port, sent, emit } = harness();
    const pending = port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-rejected" },
      {},
    );
    const requestId = spawns(sent)[0]!.requestId;

    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "rejected", reason: "limit_parent", message: LIMIT_PARENT_MESSAGE });

    const outcome = await pending;
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toBe(LIMIT_PARENT_MESSAGE);
    expect(outcome.parentSessionId).toBe(PARENT_SESSION_ID);
  });

  it("terminal emits an end progress event and resolves the FULL outcome (all counters, finalText, truncated, both ids)", async () => {
    const { port, sent, emit } = harness();
    const onProgress = vi.fn();
    const pending = port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-terminal-full" },
      { onProgress },
    );
    const requestId = spawns(sent)[0]!.requestId;

    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-9", childTabId: "tab-9", model: "m" });
    onProgress.mockClear();

    emit(
      terminalEvent(requestId, {
        finalText: "done!",
        truncated: true,
        turns: 4,
        toolCalls: 6,
        durationMs: 12_345,
        childSessionId: "child-9",
      }),
    );

    expect(onProgress).toHaveBeenCalledTimes(1);
    const expectedEnd: SubagentProgress = { kind: "end", status: "completed", turns: 4, durationMs: 12_345 };
    expect(onProgress).toHaveBeenCalledWith(expectedEnd);

    const outcome: SessionSubagentOutcome = await pending;
    // §10.5 pin: spawnToolCallId on the outcome is the REQUEST's id
    // ("spawn-terminal-full"), round-tripped verbatim — NOT the port's own
    // wire-correlation requestId (asserted distinct just below). Collapsing
    // the two back into one id is exactly the B2-temporary behavior §10.5
    // reverted.
    expect(requestId).not.toBe("spawn-terminal-full");
    expect(outcome).toEqual({
      status: "completed",
      finalText: "done!",
      truncated: true,
      turns: 4,
      toolCalls: 6,
      durationMs: 12_345,
      childSessionId: "child-9",
      parentSessionId: PARENT_SESSION_ID,
      spawnToolCallId: "spawn-terminal-full",
    });
  });

  // TASK.102 CUT-S2 §10.7 п.6c (B2-micro): a terminal event's `activitySuppressed`
  // is passed through onto the "end" progress report — mirrors the inline
  // runner's own `kind:"end"` SubagentProgress (runner.ts:573).
  describe("terminal activitySuppressed passthrough (CUT-S2 §10.7 п.6c)", () => {
    it("a terminal event carrying activitySuppressed puts it on the end-progress report", async () => {
      const { port, sent, emit } = harness();
      const onProgress = vi.fn();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-suppressed" },
        { onProgress },
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-s", childTabId: "tab-s", model: "m" });
      onProgress.mockClear();

      emit(terminalEvent(requestId, { childSessionId: "child-s", activitySuppressed: 7 }));

      const expectedEnd: SubagentProgress = { kind: "end", status: "completed", turns: 0, durationMs: 0, activitySuppressed: 7 };
      expect(onProgress).toHaveBeenCalledWith(expectedEnd);
      await pending;
    });

    it("a terminal event with NO activitySuppressed carries no such key on the end-progress report (parity with inline's absent-when-zero form)", async () => {
      const { port, sent, emit } = harness();
      const onProgress = vi.fn();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-unsuppressed" },
        { onProgress },
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-u", childTabId: "tab-u", model: "m" });
      onProgress.mockClear();

      emit(terminalEvent(requestId, { childSessionId: "child-u" }));

      expect(onProgress).toHaveBeenCalledTimes(1);
      const report = onProgress.mock.calls[0]?.[0] as SubagentProgress;
      expect(report && "activitySuppressed" in report).toBe(false);
      await pending;
    });
  });

  it("abort sends EXACTLY ONE ChildRunCancel; a terminal arriving after abort still resolves (never throws) and does not provoke a second cancel", async () => {
    const { port, sent, emit } = harness();
    const controller = new AbortController();
    const pending = port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-abort" },
      { signal: controller.signal },
    );
    const requestId = spawns(sent)[0]!.requestId;

    controller.abort();
    expect(cancels(sent)).toHaveLength(1);
    expect(cancels(sent)[0]!.requestId).toBe(requestId);

    // Sync-join semantics (cut §0.5): the promise must NOT resolve on abort
    // alone — only once main's own terminal (here "cancelled") arrives.
    let settledBeforeTerminal = false;
    void pending.then(() => {
      settledBeforeTerminal = true;
    });
    await Promise.resolve();
    expect(settledBeforeTerminal).toBe(false);

    expect(() =>
      emit(terminalEvent(requestId, { status: "cancelled", turns: 1, durationMs: 50, childSessionId: "child-cancelled" })),
    ).not.toThrow();

    const outcome = await pending;
    expect(outcome.status).toBe("cancelled");
    expect(cancels(sent)).toHaveLength(1);
  });

  it("a SECOND terminal for an already-settled requestId is a no-op: end-progress fires exactly once and the resolved value is the FIRST terminal's", async () => {
    const { port, sent, emit } = harness();
    const onProgress = vi.fn();
    const pending = port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-double-terminal" },
      { onProgress },
    );
    const requestId = spawns(sent)[0]!.requestId;

    emit(terminalEvent(requestId, { finalText: "first", status: "completed", childSessionId: "child-a" }));
    // A stale/duplicate terminal with DIFFERENT data — must be silently dropped.
    emit(
      terminalEvent(requestId, {
        finalText: "second (must be ignored)",
        status: "error",
        turns: 99,
        toolCalls: 99,
        durationMs: 999,
        childSessionId: "child-b",
      }),
    );

    const outcome = await pending;
    expect(outcome.finalText).toBe("first");
    expect(outcome.status).toBe("completed");
    expect(outcome.childSessionId).toBe("child-a");

    const endCalls = onProgress.mock.calls.filter(([progress]) => (progress as SubagentProgress).kind === "end");
    expect(endCalls).toHaveLength(1);
  });

  it("reads getPermissionMode() FRESH for each run() call rather than caching the value seen at construction", () => {
    let mode: PermissionMode = "plan";
    const { port, sent } = harness(() => mode);

    void port.run(
      { agentType: "general-purpose", description: "d1", prompt: "p1", spawnToolCallId: "spawn-mode-1" },
      {},
    );
    expect(spawns(sent)[0]!.permissionMode).toBe("plan");

    mode = "yolo";
    void port.run(
      { agentType: "general-purpose", description: "d2", prompt: "p2", spawnToolCallId: "spawn-mode-2" },
      {},
    );
    expect(spawns(sent)[1]!.permissionMode).toBe("yolo");
  });

  it("forwards provider/model on the wire ONLY when the request carries them", () => {
    const { port, sent } = harness();

    void port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-fwd-1" },
      {},
    );
    expect(spawns(sent)[0]).not.toHaveProperty("provider");
    expect(spawns(sent)[0]).not.toHaveProperty("model");

    void port.run(
      {
        agentType: "general-purpose",
        description: "d2",
        prompt: "p2",
        spawnToolCallId: "spawn-fwd-2",
        provider: "conn-1",
        model: "gpt-x",
      },
      {},
    );
    expect(spawns(sent)[1]).toMatchObject({ provider: "conn-1", model: "gpt-x" });
  });

  // ---------------------------------------------------------------------------
  // §10.5 pinning: spawnToolCallId is the REQUEST's own id, forwarded
  // verbatim onto the wire and round-tripped on the outcome — it must NEVER
  // be collapsed back onto this client's own wire-correlation `requestId`
  // (the B2-temporary behavior §10.5 explicitly reverted).

  it("requestId (wire correlation, minted by this client) and spawnToolCallId (from the request, forwarded verbatim) are DIFFERENT values on the wire — collapsing them into one id is the reverted B2 behavior", () => {
    const { port, sent } = harness();

    void port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "model-minted-call-id" },
      {},
    );

    const spawnRequest = spawns(sent)[0]!;
    expect(spawnRequest.spawnToolCallId).toBe("model-minted-call-id");
    expect(spawnRequest.requestId).not.toBe("model-minted-call-id");
    expect(spawnRequest.requestId).not.toBe(spawnRequest.spawnToolCallId);
  });

  it("a malformed spawnToolCallId (leading dash, embedded space, control character, empty, or over CHILD_ID_MAX_CHARS) resolves an IMMEDIATE error outcome and sends NOTHING — pre-flight fails closed before any message reaches main (§10.5)", async () => {
    const malformed = [
      "-leading-dash",
      "has space",
      "has\ttab",
      "has\x1fcontrol",
      "",
      "a".repeat(CHILD_ID_MAX_CHARS + 1),
    ];

    for (const spawnToolCallId of malformed) {
      const { port, sent } = harness();
      const outcome = await port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId },
        {},
      );

      expect(sent).toHaveLength(0);
      expect(outcome.status).toBe("error");
      expect(outcome.finalText).toBe(
        "Agent: the child session failed to start (malformed spawn tool-call id).",
      );
      expect(outcome.parentSessionId).toBe(PARENT_SESSION_ID);
      expect(outcome.spawnToolCallId).toBe(spawnToolCallId);
    }
  });

  it("a well-formed spawnToolCallId at exactly CHILD_ID_MAX_CHARS is accepted (boundary, not rejected)", () => {
    const { port, sent } = harness();
    const atCap = "a".repeat(CHILD_ID_MAX_CHARS);

    void port.run({ agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: atCap }, {});

    expect(spawns(sent)).toHaveLength(1);
    expect(spawns(sent)[0]!.spawnToolCallId).toBe(atCap);
  });

  // ---------------------------------------------------------------------------
  // F8 (review finding, MAJOR): parseChildSpawnRequest (shared/child-sessions.ts)
  // fail-closed-and-SILENTLY-drops on FIVE more fields besides spawnToolCallId
  // — agentType/description/prompt/model/provider are all MODEL-controlled free
  // text (tools/agent.ts stamps them straight from AgentInput, unbounded). The
  // pre-flight above only ever checked spawnToolCallId, so an oversized value on
  // any of the other five reached main, was silently dropped (parser -> null,
  // main never replies), and left this call's promise pending until the
  // dispatcher's 600s tool timeout — reachable by an ordinary model turn, no
  // attacker required.

  it("an oversized/empty agentType, description, prompt, model, or provider resolves an IMMEDIATE error outcome and sends NOTHING — symmetry with parseChildSpawnRequest's own caps (F8)", async () => {
    const base = { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-f8" };
    const cases: Array<Partial<typeof base & { model: string; provider: string }>> = [
      { agentType: "" },
      { agentType: "a".repeat(CHILD_AGENT_TYPE_MAX_CHARS + 1) },
      { description: "" },
      { description: "d".repeat(CHILD_DESCRIPTION_MAX_CHARS + 1) },
      { prompt: "" },
      { prompt: "p".repeat(CHILD_PROMPT_MAX_CHARS + 1) },
      { model: "m".repeat(CHILD_MODEL_MAX_CHARS + 1) },
      { provider: "c".repeat(CHILD_PROVIDER_MAX_CHARS + 1) },
    ];

    for (const overrides of cases) {
      const { port, sent } = harness();
      const outcome = await port.run({ ...base, ...overrides }, {});

      expect(sent, `sent should stay empty for ${JSON.stringify(overrides)}`).toHaveLength(0);
      expect(outcome.status, `status for ${JSON.stringify(overrides)}`).toBe("error");
      expect(outcome.finalText, `finalText for ${JSON.stringify(overrides)}`).toMatch(
        /^Agent: the child session failed to start \(malformed /,
      );
      expect(outcome.parentSessionId).toBe(PARENT_SESSION_ID);
      expect(outcome.spawnToolCallId).toBe("spawn-f8");
    }
  });

  it("agentType/description/prompt/model/provider at exactly their caps are accepted (boundary, not rejected — F8)", () => {
    const { port, sent } = harness();

    void port.run(
      {
        agentType: "a".repeat(CHILD_AGENT_TYPE_MAX_CHARS),
        description: "d".repeat(CHILD_DESCRIPTION_MAX_CHARS),
        prompt: "p".repeat(CHILD_PROMPT_MAX_CHARS),
        model: "m".repeat(CHILD_MODEL_MAX_CHARS),
        provider: "c".repeat(CHILD_PROVIDER_MAX_CHARS),
        spawnToolCallId: "spawn-f8-boundary",
      },
      {},
    );

    expect(spawns(sent)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // F9 (review finding, MEDIUM, found independently by all three reviewers): a
  // signal that is ALREADY aborted when run() is called. onAbort() fires
  // SYNCHRONOUSLY, sending ChildRunCancel BEFORE the spawn request — main has
  // no ledger entry yet for this requestId, so it silently ignores the cancel,
  // then admits the spawn normally a moment later. Because an AbortSignal only
  // ever fires "abort" on the not-aborted -> aborted transition, a SECOND
  // cancel can never arrive for this requestId — the child becomes permanently
  // uncancellable, holding its quota slot forever. The existing abort test only
  // covers abort() called AFTER run() starts; this covers the input already
  // being aborted.

  it("a signal that is ALREADY aborted when run() is called never sends a ChildSpawnRequest (F9): no doomed child is spawned that can never be cancelled again", async () => {
    const { port, sent } = harness();
    const controller = new AbortController();
    controller.abort();

    const outcome = await port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-preaborted" },
      { signal: controller.signal },
    );

    expect(spawns(sent)).toHaveLength(0);
    expect(outcome.status).toBe("cancelled");
    expect(outcome.parentSessionId).toBe(PARENT_SESSION_ID);
    expect(outcome.spawnToolCallId).toBe("spawn-preaborted");
  });
});
