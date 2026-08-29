import { afterEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_STALL_TIMEOUT_MS } from "@anycode/core";
import type {
  PermissionMode,
  SessionSubagentOutcome,
  SessionSubagentRequest,
  SubagentProgress,
  SubagentStallReport,
} from "@anycode/core";
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

    it("propagates non-completed statuses (max_turns/cancelled/error) to onDetachedTerminal honestly — the admit message never claimed the CHILD finished, only that it started", async () => {
      for (const status of ["max_turns", "cancelled", "error"] as const) {
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
