import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_STALL_TIMEOUT_MS, createAgentTool, formatChildTaskNotification } from "@anycode/core";
import type { PermissionMode, SessionSubagentOutcome, SessionSubagentRequest, SubagentProgress, SubagentStallReport, ToolContext } from "@anycode/core";
import {
  CHILD_AGENT_TYPE_MAX_CHARS,
  CHILD_DESCRIPTION_MAX_CHARS,
  CHILD_ID_MAX_CHARS,
  CHILD_MODEL_MAX_CHARS,
  CHILD_PROMPT_MAX_CHARS,
  CHILD_PROVIDER_MAX_CHARS,
  CHILD_RUN_CANCEL_TYPE,
  CHILD_RUN_EVENT_TYPE,
  CHILD_RUN_SEND_TYPE,
  CHILD_SPAWN_REQUEST_TYPE,
  type ChildRunCancel,
  type ChildRunEvent,
  type ChildRunSend,
  type ChildSpawnRequest,
} from "../shared/child-sessions.js";
import { createChildSessionPort, CHILD_SEND_RPC_TIMEOUT_MS, type ChildSessionPort } from "./child-session-port.js";

const PARENT_SESSION_ID = "parent-session-1";

/** Verbatim §2.7 text (CUT-S2.md) — the model-visible refusal for a per-session limit hit. */
const LIMIT_PARENT_MESSAGE =
  'Agent: session-subagent limit reached — this session already has 3 running child sessions. Wait for one to finish, or use tier "inline".';

type SentMessage = ChildSpawnRequest | ChildRunCancel | ChildRunSend;

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

  describe("resumeChildSessionId passthrough (follow-up to a finished child)", () => {
    it("forwards a well-formed id verbatim into the ChildSpawnRequest", () => {
      const { port, sent } = harness();
      port.run({ agentType: "glm-lead", description: "d", prompt: "fix", spawnToolCallId: "spawn-r", resumeChildSessionId: "child-1" }, {});
      expect(spawns(sent)[0]!.resumeChildSessionId).toBe("child-1");
    });

    it("refuses a malformed id, or one combined with an engine, before anything reaches main", async () => {
      for (const extra of [{ resumeChildSessionId: "--resume=x" }, { resumeChildSessionId: "child-1", engine: "codex" as const }]) {
        const { port, sent } = harness();
        const outcome = await port.run({ agentType: "a", description: "d", prompt: "p", spawnToolCallId: "spawn-bad", ...extra }, {});
        expect(spawns(sent)).toHaveLength(0);
        expect(outcome.status).toBe("error");
        expect(outcome.finalText).toMatch(/malformed child session id to continue/);
      }
    });
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

  // TASK.196: a max_turns terminal's report/notice text stays non-empty and
  // its status is relayed unchanged — the parent-side mirror of the child
  // host's turn-limit rescue/notice. Wire logic is NOT changed by TASK.196;
  // this pins the relay of the (possibly rescued or noticed) finalText.
  it("a max_turns terminal relays its (rescued/notice) finalText non-empty and the status unchanged (TASK.196)", async () => {
    for (const text of ["RESCUE REPORT", "Agent: the child stopped at its turn limit without a final report; last activity: TodoRead."]) {
      const { port, sent, emit } = harness();
      const onProgress = vi.fn();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-maxturns" },
        { onProgress },
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "c-mt", childTabId: "t-mt", model: "m" });
      onProgress.mockClear();

      emit(
        terminalEvent(requestId, {
          status: "max_turns",
          finalText: text,
          turns: 3,
          toolCalls: 5,
          durationMs: 999,
          childSessionId: "c-mt",
        }),
      );

      expect(onProgress).toHaveBeenCalledWith({ kind: "end", status: "max_turns", turns: 3, durationMs: 999 });
      const outcome: SessionSubagentOutcome = await pending;
      expect(outcome.status).toBe("max_turns");
      expect(outcome.finalText).toBe(text);
      expect(outcome.finalText.trim().length).toBeGreaterThan(0);
    }
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

    // Taskana 4055 cross-review F1: the session tier's kind:"end" progress is
    // the ONLY source of subagent_end (tools/agent.ts), so the ceiling summary
    // must ride it or the UI budget line and telemetry never fire.
    it("a terminal event carrying a ceiling summary puts it on the end-progress report (Taskana 4055 F1)", async () => {
      const { port, sent, emit } = harness();
      const onProgress = vi.fn();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-ceiling-end" },
        { onProgress },
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-ce", childTabId: "tab-ce", model: "m" });
      onProgress.mockClear();

      const ceiling = { rounds: 1, grantedTurns: 1, lastRefusal: "stalled" as const };
      emit(terminalEvent(requestId, { status: "max_turns", childSessionId: "child-ce", ceiling }));

      const ends = onProgress.mock.calls.map(([p]) => p as SubagentProgress).filter((p) => p.kind === "end");
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({ kind: "end", ceiling });
      const outcome = await pending;
      expect(outcome.ceiling).toEqual(ceiling);
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

  // TASK.219: end uses the terminal's own child-fact model fields and the
  // REQUEST's engine — never req.model nor the accepted event's model.
  describe("terminal model/responseModel/engine passthrough (TASK.219)", () => {
    it("terminal model+responseModel with an engine request: end carries all three, ignoring req/accepted models", async () => {
      const { port, sent, emit } = harness();
      const onProgress = vi.fn();
      const pending = port.run(
        { agentType: "engine-persona", description: "d", prompt: "p", spawnToolCallId: "spawn-m1", model: "sent-model", engine: "codex" },
        { onProgress },
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-m1", childTabId: "tab-m1", model: "m" });
      onProgress.mockClear();

      emit(terminalEvent(requestId, { childSessionId: "child-m1", model: "booted-model", responseModel: "glm-5.3" }));

      expect(onProgress).toHaveBeenCalledWith({
        kind: "end",
        status: "completed",
        turns: 0,
        durationMs: 0,
        model: "booted-model",
        responseModel: "glm-5.3",
        engine: "codex",
      });
      await pending;
    });

    it("bare terminal with no engine request: model/responseModel/engine all absent", async () => {
      const { port, sent, emit } = harness();
      const onProgress = vi.fn();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-m2" },
        { onProgress },
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-m2", childTabId: "tab-m2", model: "m" });
      onProgress.mockClear();

      emit(terminalEvent(requestId, { childSessionId: "child-m2" }));

      expect(onProgress).toHaveBeenCalledTimes(1);
      const end = onProgress.mock.calls[0]?.[0] as SubagentProgress;
      expect(end && "model" in end).toBe(false);
      expect(end && "responseModel" in end).toBe(false);
      expect(end && "engine" in end).toBe(false);
      await pending;
    });

    it("engine request with a bare terminal: engine present, model/responseModel absent", async () => {
      const { port, sent, emit } = harness();
      const onProgress = vi.fn();
      const pending = port.run(
        { agentType: "engine-persona", description: "d", prompt: "p", spawnToolCallId: "spawn-m3", engine: "codex" },
        { onProgress },
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-m3", childTabId: "tab-m3", model: "m" });
      onProgress.mockClear();

      emit(terminalEvent(requestId, { childSessionId: "child-m3" }));

      expect(onProgress).toHaveBeenCalledWith({ kind: "end", status: "completed", turns: 0, durationMs: 0, engine: "codex" });
      await pending;
    });
  });

  it("terminal declaredDoneAtCeiling reaches the attached outcome (and is absent otherwise) (TASK 4149)", async () => {
    for (const flag of [true, false]) {
      const { port, sent, emit } = harness();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: `spawn-ceiling-${flag}` },
        {},
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-c", childTabId: "tab-c", model: "m" });
      emit(
        terminalEvent(requestId, {
          status: "max_turns",
          childSessionId: "child-c",
          ...(flag ? { declaredDoneAtCeiling: true } : {}),
        }),
      );
      const outcome = await pending;
      expect(outcome.status).toBe("max_turns");
      expect("declaredDoneAtCeiling" in outcome).toBe(flag);
    }
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
  // S4 blocker (found independently by two reviewers): `model` is a
  // model-authored field that reaches the child host's argv unsanitized
  // (main/tabs.ts pushes `["--engine-model", value]`) and `host/boot.ts`'s
  // `parseHostArgs` has no `--engine-model` branch, so a value starting with
  // `-` gets re-read as a FLAG. This pre-flight must refuse a flag-shaped
  // model BEFORE it ever reaches `options.send` — a bad model must never be
  // silently forwarded and left to hang the tool call on the dispatcher's
  // 600s timeout.

  it("a flag-shaped model (e.g. '--session=x') resolves an IMMEDIATE MALFORMED_MODEL_MESSAGE error outcome and sends NOTHING (S4 blocker fix)", async () => {
    const MALFORMED_MODEL_MESSAGE = "Agent: the child session failed to start (malformed model).";
    const sendSpy = vi.fn();
    let listener: ((event: ChildRunEvent) => void) | undefined;
    const port = createChildSessionPort({
      parentSessionId: PARENT_SESSION_ID,
      getPermissionMode: () => "build",
      send: sendSpy,
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
    });
    void listener;

    const outcome = await port.run(
      {
        agentType: "general-purpose",
        description: "d",
        prompt: "p",
        spawnToolCallId: "spawn-s4",
        model: "--session=x",
      },
      {},
    );

    expect(sendSpy).not.toHaveBeenCalled();
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toBe(MALFORMED_MODEL_MESSAGE);
    expect(outcome.parentSessionId).toBe(PARENT_SESSION_ID);
    expect(outcome.spawnToolCallId).toBe("spawn-s4");
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

  // ---------------------------------------------------------------------------
  // TASK.145 срез 1: `req.detach` breaks sync-join on purpose — the run()
  // promise settles at "accepted" (admit), not "terminal". See the file
  // header's TASK.145 addendum for the full contract this suite pins.

  describe("detach (TASK.145 срез 1)", () => {
    function detachHarness(getPermissionMode: () => PermissionMode = () => "build") {
      const sent: SentMessage[] = [];
      let listener: ((event: ChildRunEvent) => void) | undefined;
      let nextId = 0;
      const detachedTerminals: Array<{ outcome: SessionSubagentOutcome; req: unknown }> = [];

      const port = createChildSessionPort({
        parentSessionId: PARENT_SESSION_ID,
        getPermissionMode,
        send: (message) => sent.push(message),
        subscribe: (cb) => {
          listener = cb;
          return () => {};
        },
        createRequestId: () => `req-${++nextId}`,
        onDetachedTerminal: (outcome, req) => {
          detachedTerminals.push({ outcome, req });
        },
      });

      return {
        port,
        sent,
        emit: (event: ChildRunEvent) => listener?.(event),
        detachedTerminals,
      };
    }

    it("resolves the run() promise on 'accepted' (admit) — does NOT wait for 'terminal'", async () => {
      const { port, sent, emit } = detachHarness();
      let settled = false;
      const pending = port
        .run(
          { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-detach-1", detach: true },
          {},
        )
        .then((outcome) => {
          settled = true;
          return outcome;
        });
      const requestId = spawns(sent)[0]!.requestId;

      expect(settled).toBe(false);
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-detach-1", childTabId: "t1", model: "m" });
      await Promise.resolve();
      expect(settled).toBe(true);

      const outcome = await pending;
      expect(outcome.status).toBe("completed");
      expect(outcome.childSessionId).toBe("child-detach-1");
      expect(outcome.parentSessionId).toBe(PARENT_SESSION_ID);
      expect(outcome.spawnToolCallId).toBe("spawn-detach-1");
      // The admit message names the child and says it's running in the
      // background — the ONLY text the model ever sees for this call.
      expect(outcome.finalText).toContain("child-detach-1");
      expect(outcome.finalText.toLowerCase()).toContain("background");
      // TASK.218: the admit text also tells the model how to follow up on
      // this same child later.
      expect(outcome.finalText).toContain("continue_session");
    });

    it("TASK.218: full detached lifecycle — onDetachedTerminal's childSessionId is the child's, and the delivered child_report composite carries the hint", async () => {
      const { port, sent, emit, detachedTerminals } = detachHarness();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-detach-r", detach: true },
        {},
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-9", childTabId: "t1", model: "m" });
      await pending; // admit settles the run() promise

      emit(
        terminalEvent(requestId, {
          status: "completed",
          finalText: "the child's report",
          turns: 2,
          toolCalls: 4,
          durationMs: 800,
          childSessionId: "child-9",
        }),
      );

      expect(detachedTerminals).toHaveLength(1);
      const outcome = detachedTerminals[0]!.outcome as SessionSubagentOutcome;
      expect(outcome.childSessionId).toBe("child-9");
      // The exact composition deliverDetachedChildReport performs
      // (host/index.ts ~511): the formatter keyed on the outcome's child id.
      const report = formatChildTaskNotification({
        taskId: "spawn-detach-r",
        toolUseId: "spawn-detach-r",
        agentId: outcome.childSessionId,
        subagentType: "general-purpose",
        status: "completed",
        summary: "the child's report",
      });
      expect(report).toContain("<agent-id>child-9</agent-id>");
      expect(report).toMatch(/pass its agent-id as continue_session/);
    });

    it("emits NO onProgress at all on accept (no live card for a call that already returned)", async () => {
      const { port, sent, emit } = detachHarness();
      const onProgress = vi.fn();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-detach-2", detach: true },
        { onProgress },
      );
      const requestId = spawns(sent)[0]!.requestId;

      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-2", childTabId: "t1", model: "m" });
      await pending;

      expect(onProgress).not.toHaveBeenCalled();
    });

    it("progress/activity/attention arriving AFTER admit are silently dropped (no onProgress, no throw)", async () => {
      const { port, sent, emit } = detachHarness();
      const onProgress = vi.fn();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-detach-3", detach: true },
        { onProgress },
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-3", childTabId: "t1", model: "m" });
      await pending;

      expect(() => {
        emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "progress", turns: 1, toolCalls: 1 });
        emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "activity", toolName: "Bash", summary: "ls" });
        emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "attention", waiting: true });
      }).not.toThrow();

      expect(onProgress).not.toHaveBeenCalled();
    });

    it("detached terminal declaredDoneAtCeiling reaches onDetachedTerminal's outcome (TASK 4149)", async () => {
      // TASK.196: a max_turns terminal's rescued report / turn-limit notice
      // must reach the parent via onDetachedTerminal non-empty and with the
      // status unchanged — detached delivery mirrors the attached relay
      // pinned above; wire logic is NOT changed by TASK.196.
      for (const text of ["RESCUE REPORT", "Agent: the child stopped at its turn limit without a final report; last activity: TodoRead."]) {
        const { port, sent, emit, detachedTerminals } = detachHarness();
        const pending = port.run(
          { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-maxturns-detached", detach: true },
          {},
        );
        const requestId = spawns(sent)[0]!.requestId;
        emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "c-mt-d", childTabId: "t-mt-d", model: "m" });
        await pending; // admit settles the run() promise

        emit(
          terminalEvent(requestId, {
            status: "max_turns",
            finalText: text,
            turns: 3,
            toolCalls: 5,
            durationMs: 999,
            childSessionId: "c-mt-d",
          }),
        );

        expect(detachedTerminals).toHaveLength(1);
        expect(detachedTerminals[0]!.outcome.status).toBe("max_turns");
        expect(detachedTerminals[0]!.outcome.finalText).toBe(text);
        expect(detachedTerminals[0]!.outcome.finalText.trim().length).toBeGreaterThan(0);
        expect(detachedTerminals[0]!.outcome.turns).toBe(3);
      }
    });

    it("detached terminal declaredDoneAtCeiling reaches onDetachedTerminal's outcome (TASK 4149)", async () => {
      const { port, sent, emit, detachedTerminals } = detachHarness();
      const pending = port.run(
        { agentType: "explore", description: "d", prompt: "p", spawnToolCallId: "spawn-detach-ceiling", detach: true },
        {},
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-dc", childTabId: "t1", model: "m" });
      await pending;
      emit(terminalEvent(requestId, { status: "max_turns", childSessionId: "child-dc", declaredDoneAtCeiling: true }));
      expect(detachedTerminals[0]!.outcome.declaredDoneAtCeiling).toBe(true);
    });

    it("terminal arriving AFTER admit does NOT re-resolve the (already settled) promise, emits NO onProgress, and invokes onDetachedTerminal with the FULL outcome + the original request", async () => {
      const { port, sent, emit, detachedTerminals } = detachHarness();
      const onProgress = vi.fn();
      const pending = port.run(
        {
          agentType: "explore",
          description: "sweep the repo",
          prompt: "find X",
          spawnToolCallId: "spawn-detach-4",
          detach: true,
        },
        { onProgress },
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-4", childTabId: "t1", model: "m" });

      const admitOutcome = await pending;
      expect(admitOutcome.status).toBe("completed");

      emit(
        terminalEvent(requestId, {
          finalText: "found 3 files",
          status: "completed",
          turns: 5,
          toolCalls: 7,
          durationMs: 9_000,
          childSessionId: "child-4",
        }),
      );

      expect(onProgress).not.toHaveBeenCalled();
      expect(detachedTerminals).toHaveLength(1);
      expect(detachedTerminals[0]!.outcome).toEqual({
        status: "completed",
        finalText: "found 3 files",
        truncated: false,
        turns: 5,
        toolCalls: 7,
        durationMs: 9_000,
        childSessionId: "child-4",
        parentSessionId: PARENT_SESSION_ID,
        spawnToolCallId: "spawn-detach-4",
      });
      expect(detachedTerminals[0]!.req).toMatchObject({
        agentType: "explore",
        description: "sweep the repo",
        spawnToolCallId: "spawn-detach-4",
      });
    });

    it("a SECOND terminal for an already-delivered detached requestId is a no-op (unknown/settled requestId, same discipline as the sync path)", async () => {
      const { port, sent, emit, detachedTerminals } = detachHarness();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-detach-5", detach: true },
        {},
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-5", childTabId: "t1", model: "m" });
      await pending;

      emit(terminalEvent(requestId, { finalText: "first", childSessionId: "child-5" }));
      expect(() => emit(terminalEvent(requestId, { finalText: "second (must be ignored)", childSessionId: "child-5" }))).not.toThrow();

      expect(detachedTerminals).toHaveLength(1);
      expect(detachedTerminals[0]!.outcome.finalText).toBe("first");
    });

    it("finalTurnFinishReason \"length\": attached run resolves with the field AND emits it on the end-progress; detached run hands it to onDetachedTerminal", async () => {
      // Attached (sync-join) run:
      const attached = harness();
      const attachedProgress: SubagentProgress[] = [];
      const attachedPending = attached.port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-length-attached" },
        { onProgress: (p) => attachedProgress.push(p) },
      );
      const attachedReq = spawns(attached.sent)[0]!.requestId;
      attached.emit({ type: CHILD_RUN_EVENT_TYPE, requestId: attachedReq, kind: "accepted", childSessionId: "c-len", childTabId: "t1", model: "m" });
      attached.emit(terminalEvent(attachedReq, { childSessionId: "c-len", finalTurnFinishReason: "length" }));
      const attachedOutcome = await attachedPending;
      expect(attachedOutcome.finalTurnFinishReason).toBe("length");
      const attachedEnd = attachedProgress.filter((p): p is Extract<SubagentProgress, { kind: "end" }> => p.kind === "end");
      expect(attachedEnd[attachedEnd.length - 1]!.finalTurnFinishReason).toBe("length");

      // Detached run:
      const detached = detachHarness();
      const detachedPending = detached.port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-length-detached", detach: true },
        {},
      );
      const detachedReq = spawns(detached.sent)[0]!.requestId;
      detached.emit({ type: CHILD_RUN_EVENT_TYPE, requestId: detachedReq, kind: "accepted", childSessionId: "c-len2", childTabId: "t1", model: "m" });
      const admitOutcome = await detachedPending;
      expect(admitOutcome.status).toBe("completed");
      detached.emit(terminalEvent(detachedReq, { childSessionId: "c-len2", finalTurnFinishReason: "length" }));
      expect(detached.detachedTerminals).toHaveLength(1);
      expect(detached.detachedTerminals[0]!.outcome.finalTurnFinishReason).toBe("length");
    });

    it("propagates non-completed statuses (max_turns/cancelled/error) to onDetachedTerminal honestly — the admit message never claimed the CHILD finished, only that it started", async () => {      for (const status of ["max_turns", "cancelled", "error"] as const) {
        const { port, sent, emit, detachedTerminals } = detachHarness();
        const pending = port.run(
          { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: `spawn-detach-${status}`, detach: true },
          {},
        );
        const requestId = spawns(sent)[0]!.requestId;
        emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: `child-${status}`, childTabId: "t1", model: "m" });
        const admitOutcome = await pending;
        // The admit-time outcome is ALWAYS "completed" (the spawn succeeded) —
        // proven distinct from the eventual real terminal status below.
        expect(admitOutcome.status).toBe("completed");

        emit(terminalEvent(requestId, { status, childSessionId: `child-${status}` }));
        expect(detachedTerminals[0]!.outcome.status).toBe(status);
      }
    });

    it("TASK.145 срез 3: an abort on opts.signal AFTER admit sends NO ChildRunCancel — Stop cancels the parent's TURN, not a child it already detached into the background", async () => {
      const { port, sent, emit, detachedTerminals } = detachHarness();
      const controller = new AbortController();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-detach-cancel", detach: true },
        { signal: controller.signal },
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-cancel", childTabId: "t1", model: "m" });
      const admitOutcome = await pending;
      expect(admitOutcome.status).toBe("completed");

      // srez 3 disarms the abort listener at admit (file header addendum) —
      // cancelling the parent's still-live turn no longer cascades into the
      // detached child at all.
      controller.abort();
      expect(cancels(sent)).toHaveLength(0);

      // The child is unaffected by the parent's Stop — it keeps running and
      // eventually reports a REAL (non-"cancelled") terminal, which still
      // reaches onDetachedTerminal normally.
      emit(terminalEvent(requestId, { status: "completed", finalText: "done despite parent Stop", childSessionId: "child-cancel" }));
      expect(detachedTerminals).toHaveLength(1);
      expect(detachedTerminals[0]!.outcome.status).toBe("completed");
    });

    it("TASK.145 срез 3: a SYNC (non-detached) run is UNCHANGED — an abort still sends exactly one ChildRunCancel (cascade preserved for the sync tier)", async () => {
      const { port, sent } = detachHarness();
      const controller = new AbortController();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-sync-cancel" },
        { signal: controller.signal },
      );
      void pending.catch(() => {});
      const requestId = spawns(sent)[0]!.requestId;

      controller.abort();
      expect(cancels(sent)).toHaveLength(1);
      expect(cancels(sent)[0]!.requestId).toBe(requestId);
    });

    it("TASK.145 срез 3: cancelBackgroundChild sends a ChildRunCancel for a live detached child by childSessionId, and its eventual 'cancelled' terminal still reaches onDetachedTerminal", async () => {
      const { port, sent, emit, detachedTerminals } = detachHarness();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-detach-explicit-cancel", detach: true },
        {},
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-explicit", childTabId: "t1", model: "m" });
      await pending;

      expect(port.cancelBackgroundChild("child-explicit")).toBe(true);
      expect(cancels(sent)).toHaveLength(1);
      expect(cancels(sent)[0]!.requestId).toBe(requestId);

      // A second cancel on the same id is a no-op (idempotent) — no duplicate ChildRunCancel.
      expect(port.cancelBackgroundChild("child-explicit")).toBe(true);
      expect(cancels(sent)).toHaveLength(1);

      emit(terminalEvent(requestId, { status: "cancelled", childSessionId: "child-explicit" }));
      expect(detachedTerminals).toHaveLength(1);
      expect(detachedTerminals[0]!.outcome.status).toBe("cancelled");
    });

    it("TASK.240 user-stop: a cancelBackgroundChild (the UI stop path) marks the terminal outcome cancelledBy=user", async () => {
      const { port, sent, emit, detachedTerminals } = detachHarness();
      const pending = port.run(
        { agentType: "explore", description: "d", prompt: "p", spawnToolCallId: "spawn-user-stop", detach: true },
        {},
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-user-stop", childTabId: "t1", model: "m" });
      await pending;

      expect(port.cancelBackgroundChild("child-user-stop")).toBe(true);
      emit(terminalEvent(requestId, { status: "cancelled", childSessionId: "child-user-stop" }));
      expect(detachedTerminals).toHaveLength(1);
      expect(detachedTerminals[0]!.outcome.status).toBe("cancelled");
      expect(detachedTerminals[0]!.outcome.cancelledBy).toBe("user");
    });

    it("TASK.240 user-stop: a shutdown sweep (cancelAllBackgroundChildren) is NOT attributed to the user", async () => {
      const { port, sent, emit, detachedTerminals } = detachHarness();
      const pending = port.run(
        { agentType: "explore", description: "d", prompt: "p", spawnToolCallId: "spawn-shutdown-cause", detach: true },
        {},
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-shutdown", childTabId: "t1", model: "m" });
      await pending;

      port.cancelAllBackgroundChildren();
      emit(terminalEvent(requestId, { status: "cancelled", childSessionId: "child-shutdown" }));
      expect(detachedTerminals).toHaveLength(1);
      expect(detachedTerminals[0]!.outcome.cancelledBy).toBeUndefined();
    });

    it("TASK.145 срез 3: cancelBackgroundChild on an unknown/already-finished childSessionId returns false and sends nothing", () => {
      const { port, sent } = detachHarness();
      expect(port.cancelBackgroundChild("no-such-child")).toBe(false);
      expect(sent).toHaveLength(0);
    });

    it("TASK.145 срез 3: listBackgroundChildren reflects admit (added) and terminal (removed), carrying agentType/description/childSessionId/startedAt", async () => {
      const { port, sent, emit } = detachHarness();
      expect(port.listBackgroundChildren()).toEqual([]);

      const pending = port.run(
        { agentType: "explore", description: "sweep the repo", prompt: "p", spawnToolCallId: "spawn-detach-list", detach: true },
        {},
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-list", childTabId: "t1", model: "m" });
      await pending;

      const listed = port.listBackgroundChildren();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ childSessionId: "child-list", agentType: "explore", description: "sweep the repo" });
      expect(typeof listed[0]!.startedAt).toBe("number");

      emit(terminalEvent(requestId, { status: "completed", childSessionId: "child-list" }));
      expect(port.listBackgroundChildren()).toEqual([]);
    });

    it("TASK.145 срез 3: cancelAllBackgroundChildren cancels every live detached child (and only those)", async () => {
      const { port, sent, emit } = detachHarness();
      const pendingA = port.run(
        { agentType: "general-purpose", description: "a", prompt: "p", spawnToolCallId: "spawn-all-a", detach: true },
        {},
      );
      const pendingB = port.run(
        { agentType: "general-purpose", description: "b", prompt: "p", spawnToolCallId: "spawn-all-b", detach: true },
        {},
      );
      const [reqA, reqB] = spawns(sent).map((s) => s.requestId);
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId: reqA!, kind: "accepted", childSessionId: "child-all-a", childTabId: "t1", model: "m" });
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId: reqB!, kind: "accepted", childSessionId: "child-all-b", childTabId: "t1", model: "m" });
      await Promise.all([pendingA, pendingB]);

      port.cancelAllBackgroundChildren();
      expect(cancels(sent)).toHaveLength(2);
      expect(cancels(sent).map((c) => c.requestId).sort()).toEqual([reqA, reqB].sort());
    });

    it("TASK.145 срез 3: onBackgroundChildrenChanged fires on admit and on terminal, and the returned unsubscribe stops further notifications", async () => {
      const { port, sent, emit } = detachHarness();
      const listener = vi.fn();
      const unsubscribe = port.onBackgroundChildrenChanged(listener);

      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-detach-change", detach: true },
        {},
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-change", childTabId: "t1", model: "m" });
      await pending;
      expect(listener).toHaveBeenCalledTimes(1);

      emit(terminalEvent(requestId, { status: "completed", childSessionId: "child-change" }));
      expect(listener).toHaveBeenCalledTimes(2);

      unsubscribe();
      const pending2 = port.run(
        { agentType: "general-purpose", description: "d2", prompt: "p", spawnToolCallId: "spawn-detach-change-2", detach: true },
        {},
      );
      const requestId2 = spawns(sent)[1]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId: requestId2, kind: "accepted", childSessionId: "child-change-2", childTabId: "t1", model: "m" });
      await pending2;
      expect(listener).toHaveBeenCalledTimes(2); // unchanged — unsubscribed
    });

    it("rejected (never admitted) settles the run() promise normally — no admission ever happened, so there is nothing to detach FROM", async () => {
      const { port, sent, emit } = detachHarness();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-detach-rejected", detach: true },
        {},
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "rejected", reason: "limit_parent", message: "no room" });

      const outcome = await pending;
      expect(outcome.status).toBe("error");
      expect(outcome.finalText).toBe("no room");
    });

    it("a non-detached run (detach absent) is completely unaffected: onDetachedTerminal is never called, and sync-join still holds", async () => {
      const { port, sent, emit, detachedTerminals } = detachHarness();
      const pending = port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-sync" },
        {},
      );
      const requestId = spawns(sent)[0]!.requestId;
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-sync", childTabId: "t1", model: "m" });
      emit(terminalEvent(requestId, { finalText: "done", childSessionId: "child-sync" }));

      const outcome = await pending;
      expect(outcome.finalText).toBe("done");
      expect(detachedTerminals).toHaveLength(0);
    });
  });
});

/**
 * Stall clock wiring — session tier (TASK.148 slice 1). This client owns the
 * PARENT side of the wire, so it is where the shared SubagentStallClock is
 * driven for a session-tier child: silence is measured against the cadence of
 * `progress`/`activity` ChildRunEvents already arriving from main (no new
 * wire message), and `attention` (the child's OWN permission-broker wait,
 * already pushed end to end today) pauses/resumes it — a real event, unlike
 * the inline tier's poll-based broker read (permission-broker.test.ts).
 * FULL fake timers (Date + setTimeout), same rationale as runner.test.ts's
 * mirror suite: the detector needs a firing timer, not a Date-boundary check.
 */
describe("stall clock wiring — session tier (TASK.148 slice 1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function stallHarness(stallTimeoutMs?: number) {
    const sent: SentMessage[] = [];
    let listener: ((event: ChildRunEvent) => void) | undefined;
    let nextId = 0;
    const port = createChildSessionPort({
      parentSessionId: PARENT_SESSION_ID,
      getPermissionMode: () => "build",
      send: (message) => sent.push(message),
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
      createRequestId: () => `req-${++nextId}`,
      ...(stallTimeoutMs !== undefined ? { stallTimeoutMs } : {}),
    });
    return { port, sent, emit: (event: ChildRunEvent) => listener?.(event) };
  }

  function stalledOf(onProgress: ReturnType<typeof vi.fn>): SubagentProgress[] {
    return onProgress.mock.calls
      .map((args: unknown[]) => args[0] as SubagentProgress)
      .filter((p: SubagentProgress) => p.kind === "stalled");
  }

  it("silence past SUBAGENT_STALL_TIMEOUT_MS after accepted emits exactly one stalled progress; the run() promise stays pending until terminal", async () => {
    vi.useFakeTimers();
    const { port, sent, emit } = stallHarness();
    const onProgress = vi.fn();
    const pending = port.run(
      { agentType: "general-purpose", description: "build X", prompt: "...", spawnToolCallId: "spawn-stall-1" },
      { onProgress },
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "c1", childTabId: "t1", model: "claude-x" });

    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS - 1);
    expect(stalledOf(onProgress)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    const stalls = stalledOf(onProgress);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({
      kind: "stalled",
      agentType: "general-purpose",
      description: "build X",
      waitingForApproval: false,
    });

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    emit(terminalEvent(requestId, { childSessionId: "c1" }));
    const outcome = await pending;
    expect(outcome.status).toBe("completed");
    // The eventual completion did not add a second notice.
    expect(stalledOf(onProgress)).toHaveLength(1);
  });

  it("progress/activity ChildRunEvents reset the clock — a child producing them across a span far longer than the threshold never stalls", async () => {
    vi.useFakeTimers();
    const { port, sent, emit } = stallHarness();
    const onProgress = vi.fn();
    const pending = port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-stall-2" },
      { onProgress },
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "c1", childTabId: "t1", model: "m" });

    const step = Math.floor(SUBAGENT_STALL_TIMEOUT_MS * 0.6);
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(step);
      // Alternate progress/activity so both reset paths are exercised.
      if (i % 2 === 0) {
        emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "progress", turns: i + 1, toolCalls: i + 1 });
      } else {
        emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "activity", toolName: "Bash", summary: "ran a command" });
      }
    }
    expect(stalledOf(onProgress)).toHaveLength(0);

    emit(terminalEvent(requestId, { childSessionId: "c1" }));
    await pending;
  });

  it("attention pauses the clock — blocked past the threshold emits no notice; resume continues from where it paused, not from a fresh cycle", async () => {
    vi.useFakeTimers();
    const { port, sent, emit } = stallHarness();
    const onProgress = vi.fn();
    const pending = port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-stall-3" },
      { onProgress },
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "c1", childTabId: "t1", model: "m" });

    await vi.advanceTimersByTimeAsync(200_000);
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "attention", waiting: true });

    // Blocked far longer than the whole threshold — never counted as silence.
    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS + 50_000);
    expect(stalledOf(onProgress)).toHaveLength(0);

    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "attention", waiting: false });
    // ~400_000ms of budget remained when it paused; a fresh cycle would need
    // another SUBAGENT_STALL_TIMEOUT_MS from here.
    await vi.advanceTimersByTimeAsync(450_000);
    expect(stalledOf(onProgress)).toHaveLength(1);

    emit(terminalEvent(requestId, { childSessionId: "c1" }));
    await pending;
  });

  it("re-arms: notice -> sign of life -> silence again -> a second notice; still-silent after the first notice produces no second one", async () => {
    vi.useFakeTimers();
    const { port, sent, emit } = stallHarness();
    const onProgress = vi.fn();
    const pending = port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-stall-4" },
      { onProgress },
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "c1", childTabId: "t1", model: "m" });

    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS);
    expect(stalledOf(onProgress)).toHaveLength(1);

    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "activity", toolName: "Bash", summary: "ran a command" });
    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS - 1);
    expect(stalledOf(onProgress)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stalledOf(onProgress)).toHaveLength(2);

    emit(terminalEvent(requestId, { childSessionId: "c1" }));
    await pending;
  });

  it("a detached run STILL constructs and drives a stall clock (TASK.148 slice 2 reverses slice 1's scope boundary — delivery now goes through onDetachedStall, see the dedicated describe block below); onProgress is still never called for it, and a host that wires no onDetachedStall at all sees a harmless no-op, never a throw", async () => {
    vi.useFakeTimers();
    const { port, sent, emit } = stallHarness(); // no onDetachedStall wired
    const onProgress = vi.fn();
    port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-stall-5", detach: true },
      { onProgress },
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "c1", childTabId: "t1", model: "m" });

    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS * 3);
    // Never bridged to onProgress — the detached call's own tool call already
    // returned at admit, exactly as before slice 2.
    expect(stalledOf(onProgress)).toHaveLength(0);

    emit(terminalEvent(requestId, { childSessionId: "c1" }));
  });

  it("honors an injected stallTimeoutMs override instead of the SUBAGENT_STALL_TIMEOUT_MS default", async () => {
    vi.useFakeTimers();
    const { port, sent, emit } = stallHarness(10_000);
    const onProgress = vi.fn();
    const pending = port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-stall-6" },
      { onProgress },
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "c1", childTabId: "t1", model: "m" });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(stalledOf(onProgress)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stalledOf(onProgress)).toHaveLength(1);

    emit(terminalEvent(requestId, { childSessionId: "c1" }));
    await pending;
  });
});

/**
 * Detached stall notice delivery (TASK.148 slice 2). Slice 1 deliberately
 * left `req.detach === true` without a stall clock at all — the ONE case
 * where a stall report matters most (the parent is not blocked waiting on
 * the child, so it can actually read and act on a notice) had no clock. This
 * suite pins the reversal: a detached run's `SubagentStallClock` is now fed
 * by the SAME `progress`/`activity`/`attention` cadence as the sync path
 * (never bridged to `opts.onProgress`, whose owning call already returned at
 * admit — that half is unchanged), and `onStall` routes through the NEW
 * `onDetachedStall` seam on `CreateChildSessionPortOptions` — mirroring
 * `onDetachedTerminal`'s existing shape (outcome/report + the original
 * request), plus the child's `childSessionId` once known (captured at
 * "accepted", exactly like the background-children registry does).
 */
describe("detached stall notice delivery (TASK.148 slice 2)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function detachedStallHarness(stallTimeoutMs?: number) {
    const sent: SentMessage[] = [];
    let listener: ((event: ChildRunEvent) => void) | undefined;
    let nextId = 0;
    const stalls: Array<{ report: SubagentStallReport; req: SessionSubagentRequest; childSessionId: string }> = [];
    const detachedTerminals: Array<{ outcome: SessionSubagentOutcome; req: SessionSubagentRequest }> = [];

    const port = createChildSessionPort({
      parentSessionId: PARENT_SESSION_ID,
      getPermissionMode: () => "build",
      send: (message) => sent.push(message),
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
      createRequestId: () => `req-${++nextId}`,
      onDetachedTerminal: (outcome, req) => {
        detachedTerminals.push({ outcome, req });
      },
      onDetachedStall: (report, req, childSessionId) => {
        stalls.push({ report, req, childSessionId });
      },
      ...(stallTimeoutMs !== undefined ? { stallTimeoutMs } : {}),
    });

    return { port, sent, emit: (event: ChildRunEvent) => listener?.(event), stalls, detachedTerminals };
  }

  it("a detached child silent past the threshold delivers exactly one stall notice via onDetachedStall; the child is NEVER terminated (no ChildRunCancel sent)", async () => {
    vi.useFakeTimers();
    const { port, sent, emit, stalls } = detachedStallHarness();
    const pending = port.run(
      { agentType: "general-purpose", description: "watch logs", prompt: "p", spawnToolCallId: "spawn-dstall-1", detach: true },
      {},
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-dstall-1", childTabId: "t1", model: "m" });
    await pending; // detach settles at admit — unaffected by this slice

    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS - 1);
    expect(stalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.report).toMatchObject({
      agentType: "general-purpose",
      description: "watch logs",
      waitingForApproval: false,
    });
    expect(stalls[0]!.childSessionId).toBe("child-dstall-1");
    expect(stalls[0]!.req.spawnToolCallId).toBe("spawn-dstall-1");
    // A stall report is information, never a verdict — nothing about it cancels the child.
    expect(cancels(sent)).toHaveLength(0);

    // The child can still finish normally afterward.
    emit(terminalEvent(requestId, { childSessionId: "child-dstall-1" }));
  });

  it("a detached child showing progress/activity before the threshold produces no stall notice", async () => {
    vi.useFakeTimers();
    const { port, sent, emit, stalls } = detachedStallHarness();
    port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-dstall-2", detach: true },
      {},
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-dstall-2", childTabId: "t1", model: "m" });

    const step = Math.floor(SUBAGENT_STALL_TIMEOUT_MS * 0.6);
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(step);
      if (i % 2 === 0) {
        emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "progress", turns: i + 1, toolCalls: i + 1 });
      } else {
        emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "activity", toolName: "Bash", summary: "ran a command" });
      }
    }
    expect(stalls).toHaveLength(0);

    emit(terminalEvent(requestId, { childSessionId: "child-dstall-2" }));
  });

  it("a detached child blocked on an unanswered permission ask (attention waiting=true) produces no notice while blocked; resume continues from the remaining budget, not a fresh cycle", async () => {
    vi.useFakeTimers();
    const { port, sent, emit, stalls } = detachedStallHarness();
    port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-dstall-3", detach: true },
      {},
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-dstall-3", childTabId: "t1", model: "m" });

    await vi.advanceTimersByTimeAsync(200_000);
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "attention", waiting: true });

    // Blocked far longer than the whole threshold — never counted as silence.
    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS + 50_000);
    expect(stalls).toHaveLength(0);

    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "attention", waiting: false });
    // ~400_000ms of budget remained when it paused; a fresh cycle would need
    // another SUBAGENT_STALL_TIMEOUT_MS from here.
    await vi.advanceTimersByTimeAsync(450_000);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.report.waitingForApproval).toBe(false);

    emit(terminalEvent(requestId, { childSessionId: "child-dstall-3" }));
  });

  it("a stall notice never triggers onDetachedTerminal, and a terminal event never triggers onDetachedStall — the two are delivered through separate, distinguishable callbacks", async () => {
    vi.useFakeTimers();
    const { port, sent, emit, stalls, detachedTerminals } = detachedStallHarness();
    port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-dstall-4", detach: true },
      {},
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-dstall-4", childTabId: "t1", model: "m" });

    await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS);
    expect(stalls).toHaveLength(1);
    expect(detachedTerminals).toHaveLength(0);

    emit(terminalEvent(requestId, { childSessionId: "child-dstall-4" }));
    expect(detachedTerminals).toHaveLength(1);
    expect(stalls).toHaveLength(1); // the terminal did not also register as a stall
  });

  it("re-arm: repeated stall/recover cycles for the SAME child call onDetachedStall once per cycle, always for the SAME spawnToolCallId — the caller (host/index.ts) can coalesce these into ONE pending queue slot (see ChildReportQueue.upsert)", async () => {
    vi.useFakeTimers();
    const { port, sent, emit, stalls } = detachedStallHarness();
    port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-dstall-5", detach: true },
      {},
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-dstall-5", childTabId: "t1", model: "m" });

    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(SUBAGENT_STALL_TIMEOUT_MS);
      emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "activity", toolName: "Bash", summary: `cycle ${i}` });
    }
    expect(stalls).toHaveLength(4);
    expect(stalls.every((s) => s.req.spawnToolCallId === "spawn-dstall-5")).toBe(true);

    emit(terminalEvent(requestId, { childSessionId: "child-dstall-5" }));
  });

  it("honors an injected stallTimeoutMs override for a detached run too", async () => {
    vi.useFakeTimers();
    const { port, sent, emit, stalls } = detachedStallHarness(10_000);
    port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-dstall-6", detach: true },
      {},
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-dstall-6", childTabId: "t1", model: "m" });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(stalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stalls).toHaveLength(1);

    emit(terminalEvent(requestId, { childSessionId: "child-dstall-6" }));
  });
});

// TASK.180: the profile turn budget rides the wire as ChildSpawnRequest
// .maxTurns — only for a fresh spawn, validated pre-flight.
describe("createChildSessionPort — maxTurns (TASK.180)", () => {
  it("sends a defined budget on the spawn request verbatim", async () => {
    const { port, sent, emit } = harness();
    const pending = port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-mt-1", maxTurns: 15 },
      {},
    );
    const spawn = spawns(sent)[0]!;
    expect(spawn.maxTurns).toBe(15);
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId: spawn.requestId, kind: "accepted", childSessionId: "c", childTabId: "t", model: "m" });
    emit(terminalEvent(spawn.requestId));
    const outcome = await pending;
    expect(outcome.status).toBe("completed");
  });

  it("an absent budget leaves the spawn request unchanged (no key)", async () => {
    const { port, sent, emit } = harness();
    const pending = port.run(
      { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-mt-2" },
      {},
    );
    const spawn = spawns(sent)[0]!;
    expect("maxTurns" in spawn).toBe(false);
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId: spawn.requestId, kind: "accepted", childSessionId: "c", childTabId: "t", model: "m" });
    emit(terminalEvent(spawn.requestId));
    await pending;
  });

  it("an invalid budget fails immediately with an honest error and sends NOTHING", async () => {
    const { port, sent } = harness();
    for (const maxTurns of [0, -1, 2.5, 201, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      const outcome = await port.run(
        { agentType: "general-purpose", description: "d", prompt: "p", spawnToolCallId: "spawn-mt-bad", maxTurns },
        {},
      );
      expect(outcome.status).toBe("error");
      expect(outcome.finalText).toContain("malformed turn budget");
    }
    expect(sent).toHaveLength(0);
  });

  it("a follow-up (resume) request does not impose a new budget", async () => {
    const { port, sent, emit } = harness();
    const pending = port.run(
      {
        agentType: "general-purpose",
        description: "d",
        prompt: "again",
        spawnToolCallId: "spawn-mt-3",
        resumeChildSessionId: "child-9",
        maxTurns: 40,
      },
      {},
    );
    const spawn = spawns(sent)[0]!;
    expect("maxTurns" in spawn).toBe(false);
    emit(terminalEvent(spawn.requestId));
    await pending;
  });
});

// ---------------------------------------------------------------------------
// Taskana 4269: `connectionId` — a profile's exact `connection:` id — rides the
// posted ChildSpawnRequest, mirroring `provider`'s shape cap. Carrying BOTH is
// refused with a PROMPT error (never a hang to the start deadline; nothing is
// posted).

describe("createChildSessionPort — profile connectionId routing (Taskana 4269)", () => {
  it("forwards connectionId on the wire only when the request carries it (never alongside provider)", async () => {
    const { port, sent, emit } = harness();

    const pending = port.run(
      {
        agentType: "general-purpose",
        description: "d",
        prompt: "p",
        spawnToolCallId: "spawn-conn-1",
        connectionId: "conn-glm",
      },
      {},
    );
    expect(spawns(sent)[0]).toMatchObject({ connectionId: "conn-glm" });
    expect(spawns(sent)[0]).not.toHaveProperty("provider");

    emit(terminalEvent(spawns(sent)[0]!.requestId));
    await pending;
  });

  it("an over-cap connectionId resolves an IMMEDIATE MALFORMED_CONNECTION error outcome and sends NOTHING", async () => {
    const { port, sent } = harness();
    const outcome = await port.run(
      {
        agentType: "general-purpose",
        description: "d",
        prompt: "p",
        spawnToolCallId: "spawn-conn-bad",
        connectionId: "c".repeat(CHILD_PROVIDER_MAX_CHARS + 1),
      },
      {},
    );

    expect(sent).toHaveLength(0);
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toBe("Agent: the child session failed to start (malformed connectionId).");
  });

  it("a NON-STRING connectionId resolves an IMMEDIATE MALFORMED_CONNECTION error outcome and sends NOTHING", async () => {
    const { port, sent } = harness();
    const outcome = await port.run(
      {
        agentType: "general-purpose",
        description: "d",
        prompt: "p",
        spawnToolCallId: "spawn-conn-nonstring",
        connectionId: 42 as unknown as string,
      },
      {},
    );

    expect(sent).toHaveLength(0);
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toBe("Agent: the child session failed to start (malformed connectionId).");
  });

  it("an EMPTY-string connectionId resolves an IMMEDIATE MALFORMED_CONNECTION error outcome and sends NOTHING", async () => {
    const { port, sent } = harness();
    const outcome = await port.run(
      {
        agentType: "general-purpose",
        description: "d",
        prompt: "p",
        spawnToolCallId: "spawn-conn-empty",
        connectionId: "",
      },
      {},
    );

    expect(sent).toHaveLength(0);
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toBe("Agent: the child session failed to start (malformed connectionId).");
  });

  it("provider + connectionId resolves a PROMPT conflict error outcome and sends NOTHING (the caller never hangs)", async () => {
    const { port, sent } = harness();
    const outcome = await port.run(
      {
        agentType: "general-purpose",
        description: "d",
        prompt: "p",
        spawnToolCallId: "spawn-conn-conflict",
        provider: "z-ai",
        connectionId: "conn-glm",
      },
      {},
    );

    expect(sent).toHaveLength(0);
    expect(outcome.status).toBe("error");
    expect(outcome.finalText).toBe(
      'Agent: "provider" and "connectionId" are mutually exclusive on one spawn; the profile selects its own connection — omit "provider".',
    );
  });
});

describe("send / sendToChild (Taskana 4153 / TASK.216 wire)", () => {
  /** The ChildRunSend op this port put on the wire (the only op kind besides spawn/cancel). */
  function sends(sent: SentMessage[]): ChildRunSend[] {
    return sent.filter((m): m is ChildRunSend => m.type === CHILD_RUN_SEND_TYPE);
  }

  it("resolves { ok: true } on a sent ack, having sent one ChildRunSend with the id and text", async () => {
    const { port, sent, emit } = harness();
    const pending = port.send({ childSessionId: "child-1", text: "re-review with these edits" });
    await Promise.resolve();
    expect(sends(sent)).toEqual([
      { type: CHILD_RUN_SEND_TYPE, requestId: "req-1", childSessionId: "child-1", text: "re-review with these edits" },
    ]);
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "sent" });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("resolves { ok: false } carrying main's refusal message on a rejected ack", async () => {
    const { port, emit } = harness();
    const pending = port.send({ childSessionId: "child-1", text: "hello" });
    await Promise.resolve();
    emit({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "rejected",
      reason: "spawn_failed",
      message: "Agent: that child session is not running. Wait for its report and use a follow-up instead.",
    });
    const result = await pending;
    expect(result).toEqual({
      ok: false,
      reason: "not_running",
      message: "Agent: that child session is not running. Wait for its report and use a follow-up instead.",
    });
  });

  it("maps a not-yours rejection onto the not_yours reason", async () => {
    const { port, emit } = harness();
    const pending = port.send({ childSessionId: "foreign-child", text: "hello" });
    await Promise.resolve();
    emit({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "rejected",
      reason: "spawn_failed",
      message: "Agent: that child session cannot be addressed — only a still-running AnyCode (core) child spawned by this session can.",
    });
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "not_yours" });
  });

  it("a malformed childSessionId resolves immediately without sending anything", async () => {
    const { port, sent } = harness();
    await expect(port.send({ childSessionId: "-dash-leading", text: "hi" })).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    await expect(port.send({ childSessionId: "x".repeat(CHILD_ID_MAX_CHARS + 1), text: "hi" })).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    await expect(port.send({ childSessionId: "child-1", text: "" })).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    await expect(
      port.send({ childSessionId: "child-1", text: "a".repeat(CHILD_PROMPT_MAX_CHARS + 1) }),
    ).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    expect(sent).toHaveLength(0);
  });

  it("an already-aborted signal resolves immediately with unavailable and sends nothing", async () => {
    const { port, sent } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(port.send({ childSessionId: "child-1", text: "hi" }, { signal: controller.signal })).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
      message: "Agent: aborted before send.",
    });
    expect(sent).toHaveLength(0);
  });

  it("times out with host_error when main never answers (CHILD_SEND_RPC_TIMEOUT_MS)", async () => {
    vi.useFakeTimers();
    try {
      const { port, sent } = harness();
      const pending = port.send({ childSessionId: "child-1", text: "hi" });
      await vi.advanceTimersByTimeAsync(CHILD_SEND_RPC_TIMEOUT_MS - 1);
      const settled = await Promise.race([pending.then(() => true), Promise.resolve(false)]);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        reason: "host_error",
        message: "Agent: main did not answer the send; delivery unknown.",
      });
      expect(sends(sent)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the ack waiter is one-shot: a late duplicate ack after settlement is ignored, and unrelated kinds never settle it", async () => {
    const { port, emit } = harness();
    const pending = port.send({ childSessionId: "child-1", text: "hi" });
    await Promise.resolve();
    // A progress event for the same requestId must not settle the send.
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "progress", turns: 1, toolCalls: 0 });
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "sent" });
    await expect(pending).resolves.toEqual({ ok: true });
    // A duplicate sent ack lands on a deleted waiter — silently ignored, no throw.
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "sent" });
  });

  // Cross-review Finding 2 (Taskana 4153): the pre-flight `signal.aborted`
  // check alone is NOT enough — the parent's turn can be cancelled WHILE the
  // ChildRunSend RPC is in flight. run() registers an abort listener and
  // reacts; the send waiter must too, or it lingers until the 30s
  // CHILD_SEND_RPC_TIMEOUT_MS and reports "delivery unknown" long after the
  // user cancelled.
  it("a MID-FLIGHT abort (signal fires while the RPC is in flight) resolves promptly with SEND_ABORTED_MESSAGE, not the 30s timeout", async () => {
    vi.useFakeTimers();
    try {
      const { port } = harness();
      const controller = new AbortController();
      const pending = port.send({ childSessionId: "child-1", text: "hi" }, { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      // The abort must settle the waiter on its own — no timer advance, no
      // main-side ack required.
      await expect(pending).resolves.toMatchObject({
        ok: false,
        reason: "unavailable",
        message: "Agent: aborted before send.",
      });
      // ...and it must have taken down its waiter: the 30s RPC timeout
      // firing later resolves nothing (the promise is already settled) and
      // no unhandled rejection is thrown for a deleted-waiter ack either.
      await vi.advanceTimersByTimeAsync(CHILD_SEND_RPC_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late ack after a mid-flight abort lands on a deleted waiter and is silently ignored (no unhandled rejection)", async () => {
    const { port, emit } = harness();
    const controller = new AbortController();
    const pending = port.send({ childSessionId: "child-1", text: "hi" }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, message: "Agent: aborted before send." });
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "sent" });
  });
});

// ---------------------------------------------------------------------------
// Cross-review Finding 1 (Taskana 4153): the interface seam — core's Agent
// handler delivers through SessionSubagentPort.send, while this port used to
// name the method sendToChild. The unit suites above drive send directly
// (and core's own tests inject a fake literally named `send`), so NOTHING
// exercised the seam where the names must agree. This block runs core's REAL
// Agent tool handler against the REAL createChildSessionPort object (fake
// send/subscribe closures only) — the same wiring host/index.ts performs —
// and asserts a ChildRunSend actually reaches the wire. If a future rename
// ever diverges the interface method from the port's exposed surface again,
// THIS test is the one that goes red.

describe("createChildSessionPort × core agentTool handler — the interface seam (cross-review Finding 1)", () => {
  /** Minimal ToolContext: only the fields runSessionTier's send branch reads. */
  function agentCtx(port: ChildSessionPort): ToolContext {
    return {
      toolCallId: "call-seam-1",
      abortSignal: new AbortController().signal,
      cwd: "/work",
      ports: {} as ToolContext["ports"],
      sessionSubagents: port,
    };
  }

  it("a send_to call against the REAL port reaches the wire as a ChildRunSend and returns ok — the interface seam holds", async () => {
    const { port, sent, emit } = harness();
    const tool = createAgentTool({ sessionTier: true });
    const pending = tool.handler(
      { description: "d", prompt: "re-review with these edits", tier: "session", send_to: "child-77" },
      agentCtx(port),
    );
    await Promise.resolve();
    expect(sent.filter((m) => m.type === CHILD_RUN_SEND_TYPE)).toEqual([
      { type: CHILD_RUN_SEND_TYPE, requestId: "req-1", childSessionId: "child-77", text: "re-review with these edits" },
    ]);
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId: "req-1", kind: "sent" });
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output?.finalText).toContain("delivered");
      expect(result.output?.finalText).toContain("child-77");
    }
  });

  it("the seam fail-closes honestly through the same shape when main rejects the send", async () => {
    const { port, emit } = harness();
    const tool = createAgentTool({ sessionTier: true });
    const pending = tool.handler(
      { description: "d", prompt: "p", tier: "session", send_to: "child-77" },
      agentCtx(port),
    );
    await Promise.resolve();
    emit({
      type: CHILD_RUN_EVENT_TYPE,
      requestId: "req-1",
      kind: "rejected",
      reason: "spawn_failed",
      message: "Agent: that child session is not running. Wait for its report and use a follow-up instead.",
    });
    const result = await pending;
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toBe(
      "Agent: that child session is not running. Wait for its report and use a follow-up instead.",
    );
  });
});

// ---------------------------------------------------------------------------
// Taskana 4704 §2.8/§3.6: the parallel-children cap — an honest refusal at
// the detach ADMIT (never a queue). Only detach requests consume slots;
// sync-join spawns are untouched; `undefined` cap = unlimited (pre-4704).

describe("child-session-port — maxDetachedChildren cap (Taskana 4704 §2.8)", () => {
  const { spawns } = { spawns: (sent: SentMessage[]) => sent.filter((m): m is Extract<SentMessage, { type: typeof CHILD_SPAWN_REQUEST_TYPE }> => m.type === CHILD_SPAWN_REQUEST_TYPE) };

  function capHarness(cap: () => number | undefined) {
    const sent: SentMessage[] = [];
    let listener: ((event: ChildRunEvent) => void) | undefined;
    let nextId = 0;
    const port = createChildSessionPort({
      parentSessionId: PARENT_SESSION_ID,
      getPermissionMode: () => "build",
      send: (message) => sent.push(message),
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
      createRequestId: () => `req-${++nextId}`,
      maxDetachedChildren: cap,
    });
    return {
      port,
      sent,
      emit: (event: ChildRunEvent) => listener?.(event),
    };
  }

  function admit(emit: (e: ChildRunEvent) => void, sent: SentMessage[], i: number): void {
    const requestId = spawns(sent)[i]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: `child-cap-${i}`, childTabId: "t1", model: "m" });
  }

  it("refuses a detach admit at N live children with the honest refusal text", async () => {
    const { port, sent, emit } = capHarness(() => 2);
    const p1 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-cap-1", detach: true }, {});
    const p2 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-cap-2", detach: true }, {});
    admit(emit, sent, 0);
    admit(emit, sent, 1);
    await p1;
    await p2;

    const third = await port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-cap-3", detach: true }, {});
    expect(third.status).toBe("error");
    expect(third.finalText).toBe("Agent: child limit reached (2 running). Wait for a report or stop a child before delegating more.");
    // Nothing was posted for the refused spawn.
    expect(spawns(sent)).toHaveLength(2);
  });

  it("admits under the cap", async () => {
    const { port, sent, emit } = capHarness(() => 4);
    const p1 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-cap-a", detach: true }, {});
    admit(emit, sent, 0);
    const outcome = await p1;
    expect(outcome.status).toBe("completed");
    expect(spawns(sent)).toHaveLength(1);
  });

  it("the cap does NOT touch sync-join spawns (no detach flag)", async () => {
    const { port, sent } = capHarness(() => 1);
    // Two sync spawns at cap 1 — both post (no admit yet, both pending).
    void port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-sync-1" }, {});
    void port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-sync-2" }, {});
    expect(spawns(sent)).toHaveLength(2);
  });

  it("a child reaching terminal releases its slot", async () => {
    const { port, sent, emit } = capHarness(() => 1);
    const p1 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-rel-1", detach: true }, {});
    admit(emit, sent, 0);
    await p1;
    const requestId = spawns(sent)[0]!.requestId;
    emit(
      {
        type: CHILD_RUN_EVENT_TYPE,
        requestId,
        kind: "terminal",
        status: "completed",
        finalText: "done",
        turns: 1,
        durationMs: 5,
        childSessionId: "child-cap-0",
      } as ChildRunEvent,
    );
    const p2 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-rel-2", detach: true }, {});
    admit(emit, sent, 1);
    const second = await p2;
    expect(second.status).toBe("completed");
  });

  it("cap undefined => unlimited (byte-identical pre-4704)", async () => {
    const { port, sent, emit } = capHarness(() => undefined);
    for (let i = 0; i < 3; i++) {
      void port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: `spawn-unl-${i}`, detach: true }, {});
      admit(emit, sent, i);
    }
    expect(spawns(sent)).toHaveLength(3);
  });

  it("the cap is read LIVE — raising it mid-session admits the next child", async () => {
    let cap = 1;
    const { port, sent, emit } = capHarness(() => cap);
    const p1 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-live-1", detach: true }, {});
    admit(emit, sent, 0);
    await p1;
    const refused = await port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-live-2", detach: true }, {});
    expect(refused.status).toBe("error");
    cap = 2;
    const p3 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-live-3", detach: true }, {});
    admit(emit, sent, 1);
    const admitted = await p3;
    expect(admitted.status).toBe("completed");
  });

  // Taskana 4704 cross-review F6: N detached run() calls made in the SAME
  // assistant turn (before any child session accepted) all passed the old
  // registry-only check — the cap must count ADMITTED children, i.e. the
  // accepted registry PLUS the admits still between spawn request and
  // accepted/terminal.
  it("F6: parallel detached admits BEFORE any accept are capped (admit window counts)", async () => {
    const { port, sent, emit } = capHarness(() => 2);
    // Fire three detached spawns back-to-back; NONE accepted yet.
    const p1 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-f6-1", detach: true }, {});
    const p2 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-f6-2", detach: true }, {});
    const p3 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-f6-3", detach: true }, {});
    // The first two posted spawn requests; the third was refused at admit.
    expect(spawns(sent)).toHaveLength(2);
    admit(emit, sent, 0);
    admit(emit, sent, 1);
    await p1;
    await p2;
    expect((await p3).status).toBe("error");

    // Once BOTH children terminal, the slot count drops and a new detach is
    // admitted again.
    for (const i of [0, 1]) {
      const requestId = spawns(sent)[i]!.requestId;
      emit(
        {
          type: CHILD_RUN_EVENT_TYPE,
          requestId,
          kind: "terminal",
          status: "completed",
          finalText: "done",
          turns: 1,
          durationMs: 5,
          // MUST match the id admit() registered (child-cap-N) — the
          // registry row is keyed by the ACCEPTED childSessionId.
          childSessionId: `child-cap-${i}`,
        } as ChildRunEvent,
      );
    }
    const p4 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-f6-4", detach: true }, {});
    // p4's spawn request is the THIRD posted message (the two earlier ones
    // plus this one; the refused spawn-f6-3 never posted).
    admit(emit, sent, 2);
    expect((await p4).status).toBe("completed");
  });

  it("F6: an admit whose spawn request is never answered (reject) frees its reservation", async () => {
    const { port, sent, emit } = capHarness(() => 1);
    const p1 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-f6-r1", detach: true }, {});
    const requestId = spawns(sent)[0]!.requestId;
    emit({
      type: CHILD_RUN_EVENT_TYPE,
      requestId,
      kind: "rejected",
      reason: "spawn_failed",
      message: "child session failed to boot",
    } as ChildRunEvent);
    const rejected = await p1;
    expect(rejected.status).toBe("error");
    // The reservation is gone with the reject: a fresh detach fits again.
    const p2 = port.run({ agentType: "executor", description: "d", prompt: "p", spawnToolCallId: "spawn-f6-r2", detach: true }, {});
    admit(emit, sent, 1);
    expect((await p2).status).toBe("completed");
  });
});

describe("detached approval notice delivery (Taskana 4821)", () => {
  function approvalHarness() {
    const sent: SentMessage[] = [];
    let listener: ((event: ChildRunEvent) => void) | undefined;
    const asks: Array<{ ask: { toolName: string; subject: string }; req: SessionSubagentRequest; childSessionId: string }> = [];
    const port = createChildSessionPort({
      parentSessionId: PARENT_SESSION_ID,
      getPermissionMode: () => "build",
      send: (message) => sent.push(message),
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
      createRequestId: () => "req-appr",
      onDetachedApproval: (ask, req, childSessionId) => {
        asks.push({ ask, req, childSessionId });
      },
    });
    return { port, sent, emit: (event: ChildRunEvent) => listener?.(event), asks };
  }

  it("a detached child's attention(waiting=true) with an ask identity reaches onDetachedApproval; waiting=false and identity-less events do not", async () => {
    const { port, sent, emit, asks } = approvalHarness();
    const pending = port.run(
      { agentType: "general-purpose", description: "triage", prompt: "p", spawnToolCallId: "spawn-appr-1", detach: true },
      {},
    );
    const requestId = spawns(sent)[0]!.requestId;
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "accepted", childSessionId: "child-appr-1", childTabId: "t1", model: "m" });
    await pending;

    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "attention", waiting: true });
    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "attention", waiting: false, toolName: "Write", subject: "/tmp/r.md" });
    expect(asks).toHaveLength(0);

    emit({ type: CHILD_RUN_EVENT_TYPE, requestId, kind: "attention", waiting: true, toolName: "Write", subject: "/tmp/r.md" });
    expect(asks).toHaveLength(1);
    expect(asks[0]!.ask).toEqual({ toolName: "Write", subject: "/tmp/r.md" });
    expect(asks[0]!.childSessionId).toBe("child-appr-1");
    expect(asks[0]!.req.spawnToolCallId).toBe("spawn-appr-1");
  });
});
