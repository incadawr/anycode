/**
 * Store reducer tests (design/phase-mvp.md §10, MVP.4 criterion): a fixture
 * sequence of HostToUiMessage -> expected transcript, fake-scheduler
 * "N deltas -> 1 flush" batching, a tool card walking
 * proposed -> running -> outcome, and turn_rejected/host_exited states.
 *
 * Every test builds its own store via `createDesktopStore` (not the
 * `useDesktopStore` singleton) with a manual FrameScheduler double, so the
 * buffered-delta state and flushScheduled flag never leak between cases.
 */
import { describe, expect, it, vi } from "vitest";
import {
  accumulateSessionTokens,
  buildConfirmedGitCommand,
  createDesktopStore,
  projectHistoryToBlocks,
  SUBAGENT_ACTIVITY_RING,
  type FrameScheduler,
  type GitDestructiveIntent,
  type TranscriptBlock,
} from "./store.js";
import { createAutomationFacade, type AnycodeBridge } from "./automation.js";
import { createTabRegistry } from "./tab-registry.js";
import { createTabsStore } from "./tabs-store.js";
import type {
  HostToUiMessage,
  WireCheckpointMeta,
  WireContextBreakdown,
  WireEnvStatus,
  WireGitStatus,
  WireHistoryItem,
} from "../../shared/protocol.js";
import type {
  BackgroundTaskSnapshot,
  CommandHookDeclaration,
  GitBranchInfo,
  GitCommitInfo,
  LspServerStatus,
  McpServerStatus,
} from "@anycode/core";
import type { CreateTabResult, CloseTabResult, SessionSummary } from "../../shared/tabs.js";

/** A FrameScheduler double that captures the flush callback instead of running it, so tests control frame timing explicitly. */
function createManualScheduler(): {
  scheduler: FrameScheduler;
  runPending: () => void;
  scheduleCallCount: () => number;
} {
  let pending: (() => void) | null = null;
  const schedule = vi.fn((cb: () => void) => {
    pending = cb;
  });
  return {
    scheduler: { schedule },
    runPending(): void {
      const cb = pending;
      pending = null;
      cb?.();
    },
    scheduleCallCount(): number {
      return schedule.mock.calls.length;
    },
  };
}

function findBlock<K extends TranscriptBlock["kind"]>(
  blocks: TranscriptBlock[],
  kind: K,
): Extract<TranscriptBlock, { kind: K }> | undefined {
  return blocks.find((b): b is Extract<TranscriptBlock, { kind: K }> => b.kind === kind);
}

describe("desktop store — connection lifecycle", () => {
  it("starts awaiting_port, tracks host_ready/setHostExited/setAwaitingPort transitions, preserves the transcript across the host_exited/awaiting_port gap, but resets it once the respawned host's host_ready lands (design F2)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);

    expect(store.getState().connection).toBe("awaiting_port");

    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    expect(store.getState().connection).toBe("ready");
    expect(store.getState().workspace).toBe("/ws");
    expect(store.getState().mode).toBe("build");
    expect(store.getState().model).toBe("m1");

    // Simulate a user message landing in the transcript (Composer's job, not applyHostMessage).
    store.setState((state) => ({
      transcript: [...state.transcript, { kind: "user_text", id: "req-1", text: "hi" }],
    }));

    store.getState().setHostExited();
    expect(store.getState().connection).toBe("host_exited");
    // Not a reset yet — connection-phase transitions alone (host_exited/
    // awaiting_port) never touch the session slice.
    expect(store.getState().transcript).toHaveLength(1);

    store.getState().setAwaitingPort();
    expect(store.getState().connection).toBe("awaiting_port");
    expect(store.getState().transcript).toHaveLength(1);


    // respawn = resume, a new authoritative process) — it resets the session
    // slice BEFORE the session_history/replay that would follow on the real
    // port hydrates it from persisted truth. No session_history follows in
    // this fixture, so the honest result is an empty transcript (§8: the
    // dead host's live-rendered memory is really gone).
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    expect(store.getState().connection).toBe("ready");
    expect(store.getState().transcript).toHaveLength(0);
  });

  it("turn_rejected does not throw and leaves turn state untouched", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });

    const turnBefore = store.getState().turn;
    expect(() =>
      store.getState().applyHostMessage({ type: "turn_rejected", requestId: "req-1", reason: "busy" }),
    ).not.toThrow();
    expect(store.getState().turn).toEqual(turnBefore);

    expect(() =>
      store.getState().applyHostMessage({ type: "turn_rejected", requestId: "req-1", reason: "not_ready" }),
    ).not.toThrow();
    expect(store.getState().turn).toEqual(turnBefore);
  });

  it("stores an external engine projection and clears it when legacy core host_ready replaces the session", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({
      type: "host_ready",
      workspace: "/ws",
      mode: "build",
      model: "gpt-5.6-terra",
      sessionId: "codex-session",
      engine: {
        id: "codex",
        capabilities: {
          supportsCorePermissions: false,
          supportsRewind: false,
          supportsWorkflow: false,
          supportsGitMutations: false,
          supportsContextUsage: true,
          supportsContextBreakdown: false,
          supportsInteractiveApprovals: true,
          costAccounting: false,
          supportsModelSelection: false,
          supportsReasoningEffort: false,
          supportsImages: false,
          supportsTasks: false,
          supportsFileSnapshots: false,
        },
      },
    });
    expect(store.getState().engine?.id).toBe("codex");
    expect(store.getState().engine?.capabilities.supportsRewind).toBe(false);

    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "core-session" });
    expect(store.getState().engine).toBeNull();
  });

  it("host_ready and reasoning_effort_changed update available effort levels", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);

    store.getState().applyHostMessage({
      type: "host_ready",
      workspace: "/ws",
      mode: "build",
      model: "glm-5.2",
      sessionId: "s1",
      reasoningEffort: "off",
      availableEffortLevels: ["off", "high", "max"],
    });
    expect(store.getState().reasoningEffort).toBe("off");
    expect(store.getState().availableEffortLevels).toEqual(["off", "high", "max"]);

    store.getState().applyHostMessage({
      type: "reasoning_effort_changed",
      effort: "max",
      availableEffortLevels: ["off", "high", "max"],
    });
    expect(store.getState().reasoningEffort).toBe("max");
    expect(store.getState().availableEffortLevels).toEqual(["off", "high", "max"]);
  });

  it("model_changed updates model + effort + levels in one shot (slice P7.15 · F14), ZERO new store slots", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);

    store.getState().applyHostMessage({
      type: "host_ready",
      workspace: "/ws",
      mode: "build",
      model: "glm-5.2",
      sessionId: "s1",
      reasoningEffort: "high",
      availableEffortLevels: ["off", "high", "max"],
    });
    expect(store.getState().model).toBe("glm-5.2");

    // Switch to a NON-reasoning model: model updates, effort collapses to "off",
    // and levels become undefined (hides the effort segment of the pill).
    store.getState().applyHostMessage({
      type: "model_changed",
      model: "glm-4.6",
      reasoningEffort: "off",
    });
    expect(store.getState().model).toBe("glm-4.6");
    expect(store.getState().reasoningEffort).toBe("off");
    expect(store.getState().availableEffortLevels).toBeUndefined();

    // Switch back to a reasoning model: levels + effort return together.
    store.getState().applyHostMessage({
      type: "model_changed",
      model: "glm-5.2",
      reasoningEffort: "high",
      availableEffortLevels: ["off", "high", "max"],
    });
    expect(store.getState().model).toBe("glm-5.2");
    expect(store.getState().reasoningEffort).toBe("high");
    expect(store.getState().availableEffortLevels).toEqual(["off", "high", "max"]);
  });
});

describe("desktop store — respawn-hydration reset (task 2.1.6, design F2)", () => {
  it("host_ready resets the session slice AND drains pending rAF delta buffers; a subsequent session_history then hydrates exactly the persisted items with zero duplicates", () => {
    const { scheduler, runPending, scheduleCallCount } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";

    // First "session": a live turn with an in-flight (un-flushed) delta, a
    // pending permission request, and a notice — everything host_ready must
    // discard on respawn.
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
    store.getState().applyHostMessage({ type: "agent_event", turnId, event: { type: "text_start", id: "text-1" } });
    store
      .getState()
      .applyHostMessage({ type: "agent_event", turnId, event: { type: "text_delta", id: "text-1", text: "partial" } });
    store.getState().applyHostMessage({
      type: "permission_request",
      requestId: "perm-1",
      toolName: "Bash",
      input: { command: "ls" },
      mode: "build",
      metadata: {
        name: "Bash",
        description: "run a command",
        readOnly: false,
        destructive: true,
        riskLevel: "high",
        sideEffectScope: "process",
      },
    });
    store.getState().setNotice({ kind: "turn_rejected", text: "boo" });

    // The delta is buffered, not yet flushed into the transcript.
    expect(scheduleCallCount()).toBe(1);
    expect(store.getState().transcript).toHaveLength(1);
    expect(store.getState().permission?.requestId).toBe("perm-1");
    expect(store.getState().notice?.kind).toBe("turn_rejected");
    expect(store.getState().turn.status).toBe("running");

    // Respawn: a new host_ready lands on this SAME store instance (design

    store.getState().applyHostMessage({
      type: "host_ready",
      workspace: "/ws",
      mode: "build",
      model: "m1",
      sessionId: "s1",
    });

    expect(store.getState().transcript).toEqual([]);
    expect(store.getState().turn).toEqual({ status: "idle", turnId: null, requestId: null });
    expect(store.getState().permission).toBeNull();
    expect(store.getState().notice).toBeNull();
    expect(store.getState().contextUsage).toBeNull();

    // The pre-reset scheduled flush firing late (its callback is stable
    // across the reset) must be a no-op: the buffers it would have drained
    // were cleared by the reset, not carried forward onto new blocks.
    runPending();
    expect(store.getState().transcript).toEqual([]);

    const items: WireHistoryItem[] = [
      { id: "h1", createdAt: 1, message: { role: "user", content: "hello" } },
      { id: "h2", createdAt: 2, message: { role: "assistant", content: [{ type: "text", text: "hi there" }] } },
    ];

    store.getState().applyHostMessage({ type: "session_history", sessionId: "s1", items, truncated: false });
    expect(store.getState().transcript.map((b) => b.id)).toEqual(["h1:0", "h2:0"]);

    // A second identical session_history still doesn't duplicate (existing
    // per-block dedup, now composed with the reset rather than relied on
    // alone for respawn-safety).
    store.getState().applyHostMessage({ type: "session_history", sessionId: "s1", items, truncated: false });
    expect(store.getState().transcript).toHaveLength(2);
  });

  it("a fresh session with no session_history is unaffected: host_ready on an already-empty slice is a no-op (page-load path unchanged)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);

    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });

    expect(store.getState().transcript).toEqual([]);
    expect(store.getState().turn).toEqual({ status: "idle", turnId: null, requestId: null });
    expect(store.getState().permission).toBeNull();
    expect(store.getState().notice).toBeNull();
  });
});

describe("desktop store — agent_event transcript accumulation", () => {
  it("surfaces finishReason=length as an output_truncated block", () => {
    const store = createDesktopStore();
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "r1", turnId: "t1" });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "t1", event: { type: "turn_end", turn: 1, finishReason: "length" } });
    expect(findBlock(store.getState().transcript, "output_truncated")).toBeDefined();
  });

  it("applies a full fixture sequence (text stream + tool call + loop_end) to the expected transcript, batching deltas via the injected scheduler", () => {
    const { scheduler, runPending, scheduleCallCount } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";

    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
    expect(store.getState().turn).toEqual({ status: "running", turnId, requestId: "req-1" });

    const fixture: HostToUiMessage[] = [
      { type: "agent_event", turnId, event: { type: "turn_start", turn: 1 } },
      { type: "agent_event", turnId, event: { type: "text_start", id: "text-1" } },
      { type: "agent_event", turnId, event: { type: "text_delta", id: "text-1", text: "Hel" } },
      { type: "agent_event", turnId, event: { type: "text_delta", id: "text-1", text: "lo " } },
      { type: "agent_event", turnId, event: { type: "text_delta", id: "text-1", text: "world" } },
    ];
    for (const message of fixture) {
      store.getState().applyHostMessage(message);
    }

    // 3 deltas for the same block must coalesce into exactly one scheduled flush.
    expect(scheduleCallCount()).toBe(1);
    // Before the frame fires, the block exists but is still empty (batched, not yet applied).
    expect(findBlock(store.getState().transcript, "assistant_text")?.text).toBe("");

    runPending();
    expect(findBlock(store.getState().transcript, "assistant_text")?.text).toBe("Hello world");
    // Draining the buffer must not schedule another flush by itself.
    expect(scheduleCallCount()).toBe(1);

    store.getState().applyHostMessage({ type: "agent_event", turnId, event: { type: "text_end", id: "text-1" } });

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "tool_call", toolCall: { id: "call-1", name: "Bash", input: { command: "ls" } } },
    });
    let toolBlock = findBlock(store.getState().transcript, "tool_call");
    expect(toolBlock).toMatchObject({ toolCallId: "call-1", toolName: "Bash", status: "proposed", modelText: null });

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "Bash", input: { command: "ls" } },
    });
    toolBlock = findBlock(store.getState().transcript, "tool_call");
    expect(toolBlock?.status).toBe("running");

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: {
        type: "tool_result",
        outcome: { toolCallId: "call-1", toolName: "Bash", status: "success", modelText: "ok", durationMs: 5 },
      },
    });
    toolBlock = findBlock(store.getState().transcript, "tool_call");
    expect(toolBlock?.status).toBe("success");
    expect(toolBlock?.modelText).toBe("ok");

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "loop_end", reason: "completed", turns: 1 },
    });

    const loopEndBlock = findBlock(store.getState().transcript, "loop_end");
    expect(loopEndBlock).toMatchObject({ reason: "completed", turns: 1 });
    // loop_end must return the turn to idle so the composer/mode switch unblock.
    expect(store.getState().turn).toEqual({ status: "idle", turnId: null, requestId: null });

    const kinds = store.getState().transcript.map((b) => b.kind);
    expect(kinds).toEqual(["assistant_text", "tool_call", "loop_end"]);
  });

  it("batches reasoning_delta the same way as text_delta", () => {
    const { scheduler, runPending, scheduleCallCount } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });

    store.getState().applyHostMessage({ type: "agent_event", turnId, event: { type: "reasoning_start", id: "r1" } });
    store
      .getState()
      .applyHostMessage({ type: "agent_event", turnId, event: { type: "reasoning_delta", id: "r1", text: "step " } });
    store
      .getState()
      .applyHostMessage({ type: "agent_event", turnId, event: { type: "reasoning_delta", id: "r1", text: "one" } });

    expect(scheduleCallCount()).toBe(1);
    expect(findBlock(store.getState().transcript, "reasoning")?.text).toBe("");
    runPending();
    expect(findBlock(store.getState().transcript, "reasoning")?.text).toBe("step one");
    expect(findBlock(store.getState().transcript, "reasoning")?.collapsed).toBe(false);
  });

  // Regression: the agent loop runs one streamText call per step, so the
  // AI-SDK stream-part id (event.id) is only unique *within* a step — thinking
  // is content-block index 0 every step, assistant text is index 1 every step.
  // The store must mint a turn-global block id so same-numbered stream parts
  // from different steps land on distinct transcript blocks; before that fix
  // the buffered delta for a re-used id was applied to EVERY block sharing it,
  // so the first block re-accumulated every later step's text (visible dup).
  it("keeps per-step reasoning blocks distinct when the SDK reuses content-block id \"0\" across steps", () => {
    const { scheduler, runPending } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
    const send = (event: unknown) =>
      store.getState().applyHostMessage({ type: "agent_event", turnId, event } as HostToUiMessage);

    // Three steps; each reuses reasoning stream id "0" (index restarts per step),
    // a tool call separating them so the loop really advances a step.
    const stepTexts = ["think one", "think two", "think three"];
    stepTexts.forEach((text, i) => {
      send({ type: "reasoning_start", id: "0" });
      send({ type: "reasoning_delta", id: "0", text });
      runPending();
      send({ type: "reasoning_end", id: "0" });
      send({ type: "tool_call", toolCall: { id: `call-${i}`, name: "Bash", input: { command: "ls" } } });
      send({ type: "tool_result", outcome: { toolCallId: `call-${i}`, toolName: "Bash", status: "success", modelText: "ok", durationMs: 1 } });
    });

    const reasoning = store
      .getState()
      .transcript.filter((b): b is Extract<TranscriptBlock, { kind: "reasoning" }> => b.kind === "reasoning");
    // One block per step, all with distinct ids…
    expect(reasoning).toHaveLength(3);
    expect(new Set(reasoning.map((b) => b.id)).size).toBe(3);
    // …and NO block accumulated another step's text (the exact bug: pre-fix
    // reasoning[0].text would be "think onethink twothink three").
    expect(reasoning.map((b) => b.text)).toEqual(stepTexts);
  });

  it("keeps per-step assistant_text blocks distinct when the SDK reuses content-block id \"1\" across steps", () => {
    const { scheduler, runPending } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
    const send = (event: unknown) =>
      store.getState().applyHostMessage({ type: "agent_event", turnId, event } as HostToUiMessage);

    const stepTexts = ["answer A", "answer B"];
    stepTexts.forEach((text, i) => {
      send({ type: "text_start", id: "1" });
      send({ type: "text_delta", id: "1", text });
      runPending();
      send({ type: "text_end", id: "1" });
      send({ type: "tool_call", toolCall: { id: `call-${i}`, name: "Bash", input: { command: "ls" } } });
      send({ type: "tool_result", outcome: { toolCallId: `call-${i}`, toolName: "Bash", status: "success", modelText: "ok", durationMs: 1 } });
    });

    const texts = store
      .getState()
      .transcript.filter((b): b is Extract<TranscriptBlock, { kind: "assistant_text" }> => b.kind === "assistant_text");
    expect(texts).toHaveLength(2);
    expect(new Set(texts.map((b) => b.id)).size).toBe(2);
    expect(texts.map((b) => b.text)).toEqual(stepTexts);
  });

  it("drops agent_event messages whose turnId no longer matches the active turn (late/cancelled-turn events)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "loop_end", reason: "cancelled", turns: 1 },
    });
    // Turn is idle (turnId: null) now; a stale event tagged with the old turnId must be discarded.
    const before = store.getState().transcript;
    store
      .getState()
      .applyHostMessage({ type: "agent_event", turnId, event: { type: "text_delta", id: "ghost", text: "boo" } });
    expect(store.getState().transcript).toBe(before);

    // Also verify a genuinely unknown/different turnId (e.g. a new turn already started) is dropped.
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-2", turnId: "turn-2" });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId, // stale turn-1 id, current turn is turn-2
      event: { type: "text_start", id: "should-not-appear" },
    });
    expect(findBlock(store.getState().transcript, "assistant_text")).toBeUndefined();
  });

  it("appends a dedicated error block for a mid-stream provider error (Wave-1 revision: error detail stays visible)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "error", error: { name: "ProviderError", message: "boom" } },
    });

    const errorBlock = findBlock(store.getState().transcript, "error");
    expect(errorBlock).toMatchObject({ error: { name: "ProviderError", message: "boom" } });

    // A second error in the same turn gets its own block with a distinct id.
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "error", error: { name: "ProviderError", message: "boom again" } },
    });
    const errorBlocks = store.getState().transcript.filter((b) => b.kind === "error");
    expect(errorBlocks).toHaveLength(2);
    expect(new Set(errorBlocks.map((b) => b.id)).size).toBe(2);
  });

  it("renders a recognized provider quota failure as a UI-only usage-limit block", () => {
    const store = createDesktopStore();
    const turnId = "turn-1";
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "glm-5.2", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: {
        type: "error",
        error: { name: "AI_APICallError", message: "[1308] Usage limit reached. Your limit will reset at 2026-07-12 19:07:09" },
      },
    });

    expect(findBlock(store.getState().transcript, "usage_limit")).toMatchObject({
      notice: { kind: "usage_limit", code: 1308, resetAt: Date.UTC(2026, 6, 12, 11, 7, 9) },
    });
    expect(findBlock(store.getState().transcript, "error")).toBeUndefined();
  });
});

describe("desktop store — notice channel (Wave-1 revision)", () => {
  it("turn_rejected and mode_change_rejected raise a notice; setNotice(null) dismisses it", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    expect(store.getState().notice).toBeNull();

    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "req-1", reason: "busy" });
    expect(store.getState().notice?.kind).toBe("turn_rejected");

    store.getState().applyHostMessage({ type: "mode_change_rejected", reason: "cannot change mode during an active turn" });
    expect(store.getState().notice).toEqual({
      kind: "mode_change_rejected",
      text: "cannot change mode during an active turn",
    });

    store.getState().setNotice(null);
    expect(store.getState().notice).toBeNull();
  });

  it("permission_settled clears the modal always, and raises a notice only for non-ui origins", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });

    const request = {
      type: "permission_request" as const,
      requestId: "perm-1",
      toolName: "Bash",
      input: { command: "ls" },
      mode: "build" as const,
      metadata: {
        name: "Bash",
        description: "run a command",
        readOnly: false,
        destructive: true,
        riskLevel: "high" as const,
        sideEffectScope: "process" as const,
      },
    };

    // UI-origin settlement: modal closes, no toast (the user just clicked).
    store.getState().applyHostMessage(request);
    expect(store.getState().permission?.requestId).toBe("perm-1");
    store.getState().applyHostMessage({ type: "permission_settled", requestId: "perm-1", behavior: "allow", origin: "ui" });
    expect(store.getState().permission).toBeNull();
    expect(store.getState().notice).toBeNull();

    // Non-ui settlement: modal closes AND the reason surfaces as a notice.
    store.getState().applyHostMessage({ ...request, requestId: "perm-2" });
    store.getState().applyHostMessage({
      type: "permission_settled",
      requestId: "perm-2",
      behavior: "deny",
      origin: "timeout",
    });
    expect(store.getState().permission).toBeNull();
    expect(store.getState().notice?.kind).toBe("permission_settled");
    expect(store.getState().notice?.text).toContain("timed out");
  });
});

describe("desktop store — Phase 1 context/retry events (task 1.9, design §2.12)", () => {
  function beginTurn(store: ReturnType<typeof createDesktopStore>, turnId: string): void {
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
  }

  it("stream_retry raises a notice mentioning retrying", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginTurn(store, turnId);

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 500, reason: "429" },
    });

    expect(store.getState().notice?.kind).toBe("stream_retry");
    expect(store.getState().notice?.text.toLowerCase()).toContain("retrying");
  });

  it("compaction_start and compaction_end (ok) raise notices; compaction_end (fail) surfaces the error", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginTurn(store, turnId);

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "compaction_start", trigger: "auto" },
    });
    expect(store.getState().notice?.kind).toBe("compaction_start");

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "compaction_end", ok: true, preTokens: 100_000, postTokens: 20_000, durationMs: 500 },
    });
    expect(store.getState().notice?.kind).toBe("compaction_end");
    expect(store.getState().notice?.text).toContain("100000");
    expect(store.getState().notice?.text).toContain("20000");

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "compaction_end", ok: false, preTokens: 100_000, durationMs: 500, error: "model unreachable" },
    });
    expect(store.getState().notice?.kind).toBe("compaction_end");
    expect(store.getState().notice?.text).toContain("model unreachable");
  });

  it("microcompact raises a notice with the cleared-results/saved-tokens counts", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginTurn(store, turnId);

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "microcompact", clearedToolResults: 4, savedTokens: 1200 },
    });

    expect(store.getState().notice?.kind).toBe("microcompact");
    expect(store.getState().notice?.text).toContain("4");
    expect(store.getState().notice?.text).toContain("1200");
  });

  it("context_usage updates the contextUsage status-bar field without touching the notice channel", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginTurn(store, turnId);
    expect(store.getState().contextUsage).toBeNull();

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "context_usage", estimatedTokens: 42_000, budgetTokens: 176_000, source: "provider" },
    });

    expect(store.getState().contextUsage).toEqual({
      estimatedTokens: 42_000,
      budgetTokens: 176_000,
      source: "provider",
    });
    // Purely a status-bar reading — must not raise a toast.
    expect(store.getState().notice).toBeNull();
  });

  it("an unrecognized/future event type is still a no-op (default-case tolerance preserved)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginTurn(store, turnId);
    const before = store.getState();

    // Simulates a message from a newer host the current renderer build doesn't know about yet.
    const futureMessage = {
      type: "agent_event",
      turnId,
      event: { type: "some_future_event", foo: "bar" },
    } as unknown as HostToUiMessage;

    expect(() => store.getState().applyHostMessage(futureMessage)).not.toThrow();

    expect(store.getState().transcript).toEqual(before.transcript);
    expect(store.getState().notice).toEqual(before.notice);
    expect(store.getState().contextUsage).toEqual(before.contextUsage);
  });
});

describe("desktop store — Wave-1 revision actions", () => {
  it("appendUserText appends a user_text block and setAwaitingHostReady sets the handshake phase", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);

    store.getState().setAwaitingHostReady();
    expect(store.getState().connection).toBe("awaiting_host_ready");

    store.getState().appendUserText("req-1", "hi there");
    expect(store.getState().transcript).toEqual([{ kind: "user_text", id: "req-1", text: "hi there" }]);
  });
});

describe("desktop store — file_snapshot (MVP.5)", () => {
  it("attaches before/after snapshots to the matching tool_call block by toolCallId, merging rather than clobbering", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });

    // Two concurrent-looking tool calls in the transcript (Phase 0's dispatch
    // is actually sequential, but the reducer must still key strictly off
    // toolCallId rather than "the most recent tool_call").
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "tool_call", toolCall: { id: "call-1", name: "Write", input: { file_path: "a.ts" } } },
    });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "tool_call", toolCall: { id: "call-2", name: "Edit", input: { file_path: "b.ts" } } },
    });

    store.getState().applyHostMessage({
      type: "file_snapshot",
      toolCallId: "call-1",
      path: "a.ts",
      phase: "before",
      content: "",
      truncated: false,
    });

    const findByToolCallId = (id: string) =>
      store.getState().transcript.find((b) => b.kind === "tool_call" && b.toolCallId === id);

    const call1AfterBefore = findByToolCallId("call-1");
    expect(call1AfterBefore).toMatchObject({ snapshots: { before: { content: "", truncated: false }, after: null } });
    // The other tool_call block must be untouched.
    expect(findByToolCallId("call-2")).toMatchObject({ snapshots: { before: null, after: null } });

    store.getState().applyHostMessage({
      type: "file_snapshot",
      toolCallId: "call-1",
      path: "a.ts",
      phase: "after",
      content: "hello\n",
      truncated: false,
    });

    // Setting "after" must not clobber the "before" that arrived earlier.
    const call1AfterAfter = findByToolCallId("call-1");
    expect(call1AfterAfter).toMatchObject({
      snapshots: {
        before: { content: "", truncated: false },
        after: { content: "hello\n", truncated: false },
      },
    });
    expect(findByToolCallId("call-2")).toMatchObject({ snapshots: { before: null, after: null } });
  });

  it("is a no-op when the toolCallId doesn't match any tool_call block in the transcript", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });

    const before = store.getState().transcript;
    expect(() =>
      store.getState().applyHostMessage({
        type: "file_snapshot",
        toolCallId: "unknown-call",
        path: "a.ts",
        phase: "before",
        content: "x",
        truncated: false,
      }),
    ).not.toThrow();
    expect(store.getState().transcript).toEqual(before);
  });

  it("attaches content:null (unreadable/oversize) snapshots as-is, truncated flag included", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "tool_call", toolCall: { id: "call-1", name: "Edit", input: { file_path: "big.bin" } } },
    });

    store.getState().applyHostMessage({
      type: "file_snapshot",
      toolCallId: "call-1",
      path: "big.bin",
      phase: "before",
      content: null,
      truncated: true,
    });

    const block = store.getState().transcript.find((b) => b.kind === "tool_call" && b.toolCallId === "call-1");
    expect(block).toMatchObject({ snapshots: { before: { content: null, truncated: true }, after: null } });
  });
});

describe("desktop store — subagent sub-status (task 3.1.4, design §3.3/§4.2)", () => {
  function beginAgentToolCall(store: ReturnType<typeof createDesktopStore>, turnId: string, toolCallId: string): void {
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: {
        type: "tool_call",
        toolCall: { id: toolCallId, name: "Agent", input: { description: "explore", prompt: "look around" } },
      },
    });
  }

  const findByToolCallId = (store: ReturnType<typeof createDesktopStore>, id: string) =>
    store.getState().transcript.find((b) => b.kind === "tool_call" && b.toolCallId === id);

  it("start seeds the sub-status (spinner state, final null), progress×N refreshes counters, end fills the terminal status — keyed by toolCallId", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginAgentToolCall(store, turnId, "call-1");

    let block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({ subagent: null });

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_start", toolCallId: "call-1", agentType: "explore", description: "survey the repo" },
    });
    block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({
      subagent: { agentType: "explore", description: "survey the repo", turns: 0, toolCalls: 0, lastTool: null, final: null },
    });

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_progress", toolCallId: "call-1", turns: 1, toolCalls: 1, lastTool: "Read" },
    });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_progress", toolCallId: "call-1", turns: 2, toolCalls: 3, lastTool: "Grep" },
    });
    block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({
      subagent: { agentType: "explore", description: "survey the repo", turns: 2, toolCalls: 3, lastTool: "Grep", final: null },
    });

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_end", toolCallId: "call-1", status: "completed", turns: 3, durationMs: 4200 },
    });
    block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({
      subagent: {
        agentType: "explore",
        description: "survey the repo",
        turns: 3,
        toolCalls: 3,
        lastTool: "Grep",
        final: { status: "completed", durationMs: 4200 },
      },
    });
  });

  it("ignores subagent_start/progress/end events carrying a foreign toolCallId (no matching tool_call block in the transcript)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginAgentToolCall(store, turnId, "call-1");

    const before = store.getState().transcript;

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_start", toolCallId: "foreign-call", agentType: "explore", description: "d" },
    });
    expect(store.getState().transcript).toEqual(before);

    // Seed call-1 for real, then send progress/end for the foreign id — call-1 must stay untouched.
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_start", toolCallId: "call-1", agentType: "explore", description: "d" },
    });
    const seeded = store.getState().transcript;

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_progress", toolCallId: "foreign-call", turns: 9, toolCalls: 9, lastTool: "Bash" },
    });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_end", toolCallId: "foreign-call", status: "error", turns: 9, durationMs: 1 },
    });
    expect(store.getState().transcript).toEqual(seeded);
  });

  it("subagent_progress/end for a toolCallId with no prior subagent_start is a no-op (defensive — matches patchFileSnapshot's posture)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginAgentToolCall(store, turnId, "call-1");

    const before = store.getState().transcript;

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_progress", toolCallId: "call-1", turns: 1, toolCalls: 1, lastTool: "Bash" },
    });
    expect(store.getState().transcript).toEqual(before);

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_end", toolCallId: "call-1", status: "completed", turns: 1, durationMs: 10 },
    });
    expect(store.getState().transcript).toEqual(before);
  });

  it("a genuinely unknown AgentEvent variant near a subagent-bearing tool_call still hits the exhaustiveness default no-op (regression guard, same tolerance as the general 'unrecognized event' case above)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginAgentToolCall(store, turnId, "call-1");
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_start", toolCallId: "call-1", agentType: "explore", description: "d" },
    });

    const before = store.getState().transcript;
    // Simulates a message from a newer host the current renderer build doesn't know about yet.
    const futureMessage = {
      type: "agent_event",
      turnId,
      event: { type: "some_future_subagent_variant", toolCallId: "call-1" },
    } as unknown as HostToUiMessage;

    expect(() => store.getState().applyHostMessage(futureMessage)).not.toThrow();
    expect(store.getState().transcript).toEqual(before);
  });
});

describe("desktop store — subagent activity feed (slice P7.18/F16b, design/slice-P7.18-cut.md §4 W2)", () => {
  function beginAgentToolCall(store: ReturnType<typeof createDesktopStore>, turnId: string, toolCallId: string): void {
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: {
        type: "tool_call",
        toolCall: { id: toolCallId, name: "Agent", input: { description: "explore", prompt: "look around" } },
      },
    });
  }

  const findByToolCallId = (store: ReturnType<typeof createDesktopStore>, id: string) =>
    store.getState().transcript.find((b) => b.kind === "tool_call" && b.toolCallId === id);

  it("subagent_start seeds activity: [] and activityDropped: 0 alongside the existing counters", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginAgentToolCall(store, turnId, "call-1");

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_start", toolCallId: "call-1", agentType: "explore", description: "survey the repo" },
    });

    const block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({ subagent: { activity: [], activityDropped: 0 } });
  });

  it("subagent_activity appends {toolName, summary} rows to the seeded subagent's activity array, in arrival order", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginAgentToolCall(store, turnId, "call-1");
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_start", toolCallId: "call-1", agentType: "explore", description: "d" },
    });

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_activity", toolCallId: "call-1", toolName: "Bash", summary: "npm test" },
    });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_activity", toolCallId: "call-1", toolName: "Read", summary: "src/index.ts" },
    });

    const block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({
      subagent: {
        activity: [
          { toolName: "Bash", summary: "npm test" },
          { toolName: "Read", summary: "src/index.ts" },
        ],
        activityDropped: 0,
      },
    });
  });

  it("rings the activity array at SUBAGENT_ACTIVITY_RING: past the cap the oldest row drops and activityDropped increments", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginAgentToolCall(store, turnId, "call-1");
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_start", toolCallId: "call-1", agentType: "explore", description: "d" },
    });

    for (let i = 0; i < SUBAGENT_ACTIVITY_RING + 5; i += 1) {
      store.getState().applyHostMessage({
        type: "agent_event",
        turnId,
        event: { type: "subagent_activity", toolCallId: "call-1", toolName: "Bash", summary: `cmd ${i}` },
      });
    }

    const block = findByToolCallId(store, "call-1");
    expect(block?.kind).toBe("tool_call");
    if (block?.kind !== "tool_call" || !block.subagent) throw new Error("expected seeded subagent block");
    expect(block.subagent.activity).toHaveLength(SUBAGENT_ACTIVITY_RING);
    expect(block.subagent.activityDropped).toBe(5);
    // Ring keeps the newest rows — the oldest 5 (cmd 0..4) were dropped.
    expect(block.subagent.activity[0]).toEqual({ toolName: "Bash", summary: "cmd 5" });
    expect(block.subagent.activity[SUBAGENT_ACTIVITY_RING - 1]).toEqual({
      toolName: "Bash",
      summary: `cmd ${SUBAGENT_ACTIVITY_RING + 4}`,
    });
  });

  it("subagent_activity for a toolCallId with no prior subagent_start is a no-op (unseeded — same guard as patchSubagentProgress)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginAgentToolCall(store, turnId, "call-1");

    const before = store.getState().transcript;

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_activity", toolCallId: "call-1", toolName: "Bash", summary: "npm test" },
    });

    expect(store.getState().transcript).toEqual(before);
  });

  it("subagent_activity carrying a foreign toolCallId is a no-op — the seeded subagent it doesn't belong to stays untouched", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginAgentToolCall(store, turnId, "call-1");
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_start", toolCallId: "call-1", agentType: "explore", description: "d" },
    });

    const seeded = store.getState().transcript;

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "subagent_activity", toolCallId: "foreign-call", toolName: "Bash", summary: "npm test" },
    });

    expect(store.getState().transcript).toEqual(seeded);
  });
});

describe("desktop store — workflow sub-status (task 3.4.5, design/slice-3.4-cut.md §2.3/§6)", () => {
  function beginWorkflowToolCall(store: ReturnType<typeof createDesktopStore>, turnId: string, toolCallId: string): void {
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: {
        type: "tool_call",
        toolCall: { id: toolCallId, name: "Workflow", input: { name: "release-flow" } },
      },
    });
  }

  const findByToolCallId = (store: ReturnType<typeof createDesktopStore>, id: string) =>
    store.getState().transcript.find((b) => b.kind === "tool_call" && b.toolCallId === id);

  it("start seeds the sub-status (empty steps, final null); step_start appends a step; step_progress×N refreshes its counters; step_end settles it; end fills the run-level terminal status — keyed by toolCallId/stepId", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginWorkflowToolCall(store, turnId, "call-1");

    let block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({ workflow: null });

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_start", toolCallId: "call-1", workflow: "release-flow", totalSteps: 2 },
    });
    block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({ workflow: { workflow: "release-flow", totalSteps: 2, steps: [], final: null } });

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_start", toolCallId: "call-1", stepId: "fetch", agentType: "explore" },
    });
    block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({
      workflow: {
        steps: [{ stepId: "fetch", agentType: "explore", turns: 0, toolCalls: 0, lastTool: null, final: null }],
      },
    });

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_progress", toolCallId: "call-1", stepId: "fetch", turns: 1, toolCalls: 1, lastTool: "Read" },
    });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_progress", toolCallId: "call-1", stepId: "fetch", turns: 2, toolCalls: 3, lastTool: "Grep" },
    });
    block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({
      workflow: {
        steps: [{ stepId: "fetch", agentType: "explore", turns: 2, toolCalls: 3, lastTool: "Grep", final: null }],
      },
    });

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_end", toolCallId: "call-1", stepId: "fetch", status: "completed", turns: 3, durationMs: 500 },
    });
    block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({
      workflow: {
        steps: [
          {
            stepId: "fetch",
            agentType: "explore",
            turns: 3,
            toolCalls: 3,
            lastTool: "Grep",
            final: { status: "completed", durationMs: 500 },
          },
        ],
      },
    });

    // A second concurrent step starting and settling appends independently of the first.
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_start", toolCallId: "call-1", stepId: "build", agentType: "general-purpose" },
    });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_end", toolCallId: "call-1", stepId: "build", status: "completed", turns: 1, durationMs: 700 },
    });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_end", toolCallId: "call-1", status: "completed", completedSteps: 2, totalSteps: 2, durationMs: 1200 },
    });
    block = findByToolCallId(store, "call-1");
    expect(block).toMatchObject({
      workflow: {
        workflow: "release-flow",
        totalSteps: 2,
        final: { status: "completed", completedSteps: 2, durationMs: 1200 },
        steps: [
          { stepId: "fetch", final: { status: "completed", durationMs: 500 } },
          { stepId: "build", final: { status: "completed", durationMs: 700 } },
        ],
      },
    });
  });

  it("ignores workflow_start/step_start/step_progress/step_end/end events carrying a foreign toolCallId (no matching tool_call block in the transcript)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginWorkflowToolCall(store, turnId, "call-1");

    const before = store.getState().transcript;

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_start", toolCallId: "foreign-call", workflow: "other", totalSteps: 1 },
    });
    expect(store.getState().transcript).toEqual(before);

    // Seed call-1 for real, then send the rest of the lifecycle for the foreign id — call-1 must stay untouched.
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_start", toolCallId: "call-1", workflow: "release-flow", totalSteps: 1 },
    });
    const seeded = store.getState().transcript;

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_start", toolCallId: "foreign-call", stepId: "s1", agentType: "explore" },
    });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_progress", toolCallId: "foreign-call", stepId: "s1", turns: 9, toolCalls: 9, lastTool: "Bash" },
    });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_end", toolCallId: "foreign-call", stepId: "s1", status: "error", turns: 9, durationMs: 1 },
    });
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_end", toolCallId: "foreign-call", status: "failed", completedSteps: 0, totalSteps: 1, durationMs: 1 },
    });
    expect(store.getState().transcript).toEqual(seeded);
  });

  it("workflow_step_start/step_progress/step_end/end for a toolCallId with no prior workflow_start is a no-op (defensive — matches patchSubagentProgress's posture)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginWorkflowToolCall(store, turnId, "call-1");

    const before = store.getState().transcript;

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_start", toolCallId: "call-1", stepId: "s1", agentType: "explore" },
    });
    expect(store.getState().transcript).toEqual(before);

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_end", toolCallId: "call-1", status: "completed", completedSteps: 0, totalSteps: 0, durationMs: 1 },
    });
    expect(store.getState().transcript).toEqual(before);
  });

  it("workflow_step_progress/step_end for a stepId with no prior workflow_step_start is a no-op even once the run itself is seeded", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    const turnId = "turn-1";
    beginWorkflowToolCall(store, turnId, "call-1");
    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_start", toolCallId: "call-1", workflow: "release-flow", totalSteps: 1 },
    });

    const seeded = store.getState().transcript;

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_progress", toolCallId: "call-1", stepId: "unknown-step", turns: 1, toolCalls: 1, lastTool: "Bash" },
    });
    expect(store.getState().transcript).toEqual(seeded);

    store.getState().applyHostMessage({
      type: "agent_event",
      turnId,
      event: { type: "workflow_step_end", toolCallId: "call-1", stepId: "unknown-step", status: "completed", turns: 1, durationMs: 10 },
    });
    expect(store.getState().transcript).toEqual(seeded);
  });
});

describe("desktop store — session_history hydration (task 2.1.5, design §3.3)", () => {
  /** A realistic resumed-session fixture: plain user turn, compact_summary user turn, and an assistant turn with a text part + a paired tool_call/tool_result. */
  const fixtureItems: WireHistoryItem[] = [
    { id: "h1", createdAt: 1, message: { role: "user", content: "hello" } },
    {
      id: "h2",
      createdAt: 2,
      kind: "compact_summary",
      message: { role: "user", content: "[compact summary] earlier conversation" },
    },
    {
      id: "h3",
      createdAt: 3,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_call", toolCallId: "call-1", toolName: "Bash", input: { command: "ls" } },
        ],
      },
    },
    {
      id: "h4",
      createdAt: 4,
      message: {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call-1", toolName: "Bash", text: "a.ts\nb.ts", status: "success" }],
      },
    },
  ];

  it("projectHistoryToBlocks maps user/compact_summary/assistant-text/tool_call+result per §3.3, pairing status+modelText and skipping the tool-role item", () => {
    const blocks = projectHistoryToBlocks(fixtureItems);

    expect(blocks).toEqual([
      { kind: "user_text", id: "h1:0", text: "hello" },
      { kind: "user_text", id: "h2:0", text: "[compact summary] earlier conversation" },
      { kind: "assistant_text", id: "h3:0", text: "Let me check." },
      {
        kind: "tool_call",
        id: "h3:1",
        toolCallId: "call-1",
        toolName: "Bash",
        input: { command: "ls" },
        status: "success",
        modelText: "a.ts\nb.ts",
        snapshots: { before: null, after: null },
        subagent: null,
        workflow: null,
      },
    ]);
  });

  it("pairs multiple tool_call parts of one assistant item against the run of tool-role items that follow it, by toolCallId", () => {
    const items: WireHistoryItem[] = [
      {
        id: "a1",
        createdAt: 1,
        message: {
          role: "assistant",
          content: [
            { type: "tool_call", toolCallId: "call-1", toolName: "Read", input: { file_path: "a.ts" } },
            { type: "tool_call", toolCallId: "call-2", toolName: "Read", input: { file_path: "b.ts" } },
          ],
        },
      },
      {
        id: "a2",
        createdAt: 2,
        message: { role: "tool", content: [{ type: "tool_result", toolCallId: "call-1", toolName: "Read", text: "contents-a", status: "success" }] },
      },
      {
        id: "a3",
        createdAt: 3,
        message: { role: "tool", content: [{ type: "tool_result", toolCallId: "call-2", toolName: "Read", text: "denied", status: "denied" }] },
      },
    ];

    const blocks = projectHistoryToBlocks(items);
    expect(blocks).toEqual([
      {
        kind: "tool_call",
        id: "a1:0",
        toolCallId: "call-1",
        toolName: "Read",
        input: { file_path: "a.ts" },
        status: "success",
        modelText: "contents-a",
        snapshots: { before: null, after: null },
        subagent: null,
        workflow: null,
      },
      {
        kind: "tool_call",
        id: "a1:1",
        toolCallId: "call-2",
        toolName: "Read",
        input: { file_path: "b.ts" },
        status: "denied",
        modelText: "denied",
        snapshots: { before: null, after: null },
        subagent: null,
        workflow: null,
      },
    ]);
  });

  it("leaves a tool_call part unpaired (status proposed, modelText null) when no matching tool-result item follows (truncated/defective history)", () => {
    const items: WireHistoryItem[] = [
      {
        id: "b1",
        createdAt: 1,
        message: {
          role: "assistant",
          content: [{ type: "tool_call", toolCallId: "call-1", toolName: "Bash", input: { command: "ls" } }],
        },
      },
    ];

    const blocks = projectHistoryToBlocks(items);
    expect(blocks).toEqual([
      {
        kind: "tool_call",
        id: "b1:0",
        toolCallId: "call-1",
        toolName: "Bash",
        input: { command: "ls" },
        status: "proposed",
        modelText: null,
        snapshots: { before: null, after: null },
        subagent: null,
        workflow: null,
      },
    ]);
  });

  it("applyHostMessage(session_history) hydrates the transcript in one shot, in item order", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });

    store.getState().applyHostMessage({ type: "session_history", sessionId: "s1", items: fixtureItems, truncated: false });

    expect(store.getState().transcript.map((b) => b.kind)).toEqual([
      "user_text",
      "user_text",
      "assistant_text",
      "tool_call",
    ]);
    expect(store.getState().notice).toBeNull();
  });

  it("truncated:true raises a notice on the one-slot channel (tail-of-history warning)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });

    store.getState().applyHostMessage({ type: "session_history", sessionId: "s1", items: fixtureItems, truncated: true });

    expect(store.getState().notice?.kind).toBe("session_history_truncated");
    expect(store.getState().notice?.text.toLowerCase()).toContain("tail of history");
  });

  it("a second identical session_history on the same store instance does not duplicate blocks (idempotent re-hydration, e.g. a respawn re-sending the same boot snapshot)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });

    store.getState().applyHostMessage({ type: "session_history", sessionId: "s1", items: fixtureItems, truncated: false });
    const afterFirst = store.getState().transcript;
    expect(afterFirst).toHaveLength(4);

    // Same message, resent verbatim (respawn re-sending the identical boot snapshot).
    store.getState().applyHostMessage({ type: "session_history", sessionId: "s1", items: fixtureItems, truncated: false });
    expect(store.getState().transcript).toHaveLength(4);
    expect(store.getState().transcript).toEqual(afterFirst);
  });

  it("a follow-up session_history with additional items only appends the new blocks, leaving previously-hydrated ones untouched", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });

    store.getState().applyHostMessage({
      type: "session_history",
      sessionId: "s1",
      items: fixtureItems.slice(0, 2),
      truncated: false,
    });
    expect(store.getState().transcript).toHaveLength(2);

    store.getState().applyHostMessage({ type: "session_history", sessionId: "s1", items: fixtureItems, truncated: false });
    expect(store.getState().transcript.map((b) => b.id)).toEqual(["h1:0", "h2:0", "h3:0", "h3:1"]);
  });

  it("a page reload (fresh store instance) hydrates cleanly with no special-casing needed — the empty transcript means nothing to dedupe against", () => {
    const { scheduler } = createManualScheduler();
    const freshStore = createDesktopStore(scheduler);
    expect(freshStore.getState().transcript).toHaveLength(0);

    freshStore.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    freshStore.getState().applyHostMessage({ type: "session_history", sessionId: "s1", items: fixtureItems, truncated: false });

    expect(freshStore.getState().transcript).toHaveLength(4);
  });

  it("projectHistoryToBlocks strips a system-reminder tail from a resumed user message (design slice-P7.9-cut.md)", () => {
    const items: WireHistoryItem[] = [
      {
        id: "r1",
        createdAt: 1,
        message: { role: "user", content: "please fix the bug\n<system-reminder>Background task update: done</system-reminder>" },
      },
    ];

    const blocks = projectHistoryToBlocks(items);
    expect(blocks).toEqual([{ kind: "user_text", id: "r1:0", text: "please fix the bug" }]);
  });

  it("projectHistoryToBlocks emits zero blocks for a wholly-reminder user item, without disturbing neighbor id numbering", () => {
    const items: WireHistoryItem[] = [
      { id: "r1", createdAt: 1, message: { role: "user", content: "<system-reminder>Background task update: done</system-reminder>" } },
      { id: "r2", createdAt: 2, message: { role: "user", content: "hello" } },
    ];

    const blocks = projectHistoryToBlocks(items);
    expect(blocks).toEqual([{ kind: "user_text", id: "r2:0", text: "hello" }]);
  });

  it("projectHistoryToBlocks leaves a reminder-free user message byte-identical (lock)", () => {
    const text = "just a normal message, nothing to strip.\nmultiline too.";
    const items: WireHistoryItem[] = [{ id: "r1", createdAt: 1, message: { role: "user", content: text } }];

    const blocks = projectHistoryToBlocks(items);
    expect(blocks).toEqual([{ kind: "user_text", id: "r1:0", text }]);
  });

  it("applyHostMessage(session_history) hydrates a reminder-carrying resumed user item with the block stripped from the transcript", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });

    const items: WireHistoryItem[] = [
      {
        id: "r1",
        createdAt: 1,
        message: { role: "user", content: "please fix the bug\n<hook-context>some hook payload</hook-context>" },
      },
    ];
    store.getState().applyHostMessage({ type: "session_history", sessionId: "s1", items, truncated: false });

    expect(store.getState().transcript).toEqual([{ kind: "user_text", id: "r1:0", text: "please fix the bug" }]);
  });
});

describe("desktop store — mcp_status (task 3.2.4, design slice-3.2-cut.md §3.5/§6)", () => {
  const SERVERS: McpServerStatus[] = [
    { name: "fixture", transport: "stdio", state: "connected", toolCount: 3, toolsTruncated: false },
    { name: "broken", transport: "http", state: "failed", toolCount: 0, toolsTruncated: false, error: "connect timed out" },
  ];

  it("mcp_status replaces the mcpServers slice with the host's snapshot verbatim", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    expect(store.getState().mcpServers).toEqual([]);

    store.getState().applyHostMessage({ type: "mcp_status", servers: SERVERS });
    expect(store.getState().mcpServers).toEqual(SERVERS);
  });

  it("a later mcp_status snapshot REPLACES (does not merge with) the previous one", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "mcp_status", servers: SERVERS });

    const nextSnapshot: McpServerStatus[] = [
      { name: "fixture", transport: "stdio", state: "closed", toolCount: 3, toolsTruncated: false },
    ];
    store.getState().applyHostMessage({ type: "mcp_status", servers: nextSnapshot });
    expect(store.getState().mcpServers).toEqual(nextSnapshot);
  });

  it("regression: an unrelated message (turn_rejected) leaves mcpServers untouched", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "mcp_status", servers: SERVERS });

    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "req-1", reason: "busy" });
    expect(store.getState().mcpServers).toEqual(SERVERS);
  });

  it("regression: mcp_status leaves every other existing slice (transcript/turn/notice) untouched", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().appendUserText("req-1", "hi");
    const before = store.getState();

    store.getState().applyHostMessage({ type: "mcp_status", servers: SERVERS });

    expect(store.getState().transcript).toEqual(before.transcript);
    expect(store.getState().turn).toEqual(before.turn);
    expect(store.getState().notice).toEqual(before.notice);
  });

  it("a respawned host's host_ready resets mcpServers back to [] (design F2: respawn = a new, not-yet-reported process)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "mcp_status", servers: SERVERS });
    expect(store.getState().mcpServers).toEqual(SERVERS);

    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    expect(store.getState().mcpServers).toEqual([]);
  });

  it("an unknown/future wire variant is still a no-op and does not disturb mcpServers (exhaustiveness default preserved)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "mcp_status", servers: SERVERS });

    const futureMessage = { type: "some_future_message", foo: "bar" } as unknown as HostToUiMessage;
    expect(() => store.getState().applyHostMessage(futureMessage)).not.toThrow();
    expect(store.getState().mcpServers).toEqual(SERVERS);
  });
});

describe("desktop store — lsp_status (renderer panels sub-slice A)", () => {
  const SERVERS: LspServerStatus[] = [
    { name: "typescript", state: "ready", pid: 1234, extensions: [".ts", ".tsx"], stderrTail: "" },
    { name: "python", state: "crashed", extensions: [".py"], stderrTail: "traceback" },
  ];

  it("lsp_status replaces the lspServers slice with the host's snapshot verbatim", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    expect(store.getState().lspServers).toEqual([]);

    store.getState().applyHostMessage({ type: "lsp_status", servers: SERVERS });
    expect(store.getState().lspServers).toEqual(SERVERS);
  });

  it("a later lsp_status snapshot replaces rather than merges", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "lsp_status", servers: SERVERS });

    const nextSnapshot: LspServerStatus[] = [{ name: "typescript", state: "disposed", extensions: [".ts"], stderrTail: "" }];
    store.getState().applyHostMessage({ type: "lsp_status", servers: nextSnapshot });
    expect(store.getState().lspServers).toEqual(nextSnapshot);
  });

  it("host_ready resets lspServers back to [] for a respawned host", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "lsp_status", servers: SERVERS });
    expect(store.getState().lspServers).toEqual(SERVERS);

    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    expect(store.getState().lspServers).toEqual([]);
  });
});

describe("desktop store — env_status (slice P7.8, design slice-P7.8-cut.md §3.4)", () => {
  const STATUS: WireEnvStatus = {
    telemetry: { filePath: "/ws/.anycode/telemetry/s1.jsonl", written: 4, dropped: 0 },
    repoMap: { fileCount: 12, includedCount: 10, truncated: false, maxTokens: 2000 },
  };

  it("env_status replaces the envStatus slice with the host's snapshot verbatim", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    expect(store.getState().envStatus).toBeNull();

    store.getState().applyHostMessage({ type: "env_status", status: STATUS });
    expect(store.getState().envStatus).toEqual(STATUS);
  });

  it("a later env_status snapshot replaces rather than merges (teardown re-push refreshes counters)", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "env_status", status: STATUS });

    const nextSnapshot: WireEnvStatus = {
      telemetry: { filePath: STATUS.telemetry!.filePath, written: 9, dropped: 1, lastWriteError: "disk full" },
      repoMap: null,
    };
    store.getState().applyHostMessage({ type: "env_status", status: nextSnapshot });
    expect(store.getState().envStatus).toEqual(nextSnapshot);
  });

  it("host_ready resets envStatus back to null for a respawned host", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    store.getState().applyHostMessage({ type: "env_status", status: STATUS });
    expect(store.getState().envStatus).toEqual(STATUS);

    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    expect(store.getState().envStatus).toBeNull();
  });
});

describe("desktop store — hooks_list (renderer panels sub-slice B)", () => {
  const HOOKS: CommandHookDeclaration[] = [
    { event: "PreToolUse", matcher: "Write|Edit", command: "./guard.sh", timeoutMs: 2500 },
    { event: "Stop", command: "./cleanup.sh" },
  ];

  it("hooks_list replaces the hookDeclarations slice with the host's static snapshot", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    expect(store.getState().hookDeclarations).toEqual([]);
    expect(store.getState().hookConfigError).toBeNull();

    store.getState().applyHostMessage({ type: "hooks_list", hooks: HOOKS });
    expect(store.getState().hookDeclarations).toEqual(HOOKS);
    expect(store.getState().hookConfigError).toBeNull();
  });

  it("stores and clears hook config errors based on later full snapshots", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "hooks_list", hooks: [], configError: "bad config" });
    expect(store.getState().hookConfigError).toBe("bad config");

    store.getState().applyHostMessage({ type: "hooks_list", hooks: HOOKS });
    expect(store.getState().hookDeclarations).toEqual(HOOKS);
    expect(store.getState().hookConfigError).toBeNull();
  });

  it("host_ready resets hook state for a respawned host", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "hooks_list", hooks: HOOKS, configError: "bad config" });

    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    expect(store.getState().hookDeclarations).toEqual([]);
    expect(store.getState().hookConfigError).toBeNull();
  });
});

describe("desktop store — task_list/task_output (renderer panels sub-slice D)", () => {
  const TASK: BackgroundTaskSnapshot = {
    taskId: "task-1",
    command: "pnpm test",
    status: "running",
    exitCode: null,
    startedAt: 1,
    outputBytes: 6,
    outputTruncated: false,
  };

  it("task_list replaces backgroundTasks wholesale", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "task_list", tasks: [TASK] });
    expect(store.getState().backgroundTasks).toEqual([TASK]);

    const next = { ...TASK, taskId: "task-2", command: "sleep 10" };
    store.getState().applyHostMessage({ type: "task_list", tasks: [next] });
    expect(store.getState().backgroundTasks).toEqual([next]);
  });

  it("task_output appends new chunks and patches the task snapshot", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "task_list", tasks: [TASK] });

    store.getState().applyHostMessage({ type: "task_output", taskId: "task-1", snapshot: TASK, newOutput: "hello\n" });
    store.getState().applyHostMessage({
      type: "task_output",
      taskId: "task-1",
      snapshot: { ...TASK, outputBytes: 12 },
      newOutput: "world\n",
    });

    expect(store.getState().backgroundTaskOutput["task-1"]).toBe("hello\nworld\n");
    expect(store.getState().backgroundTasks[0]?.outputBytes).toBe(12);
  });

  it("host_ready resets task state for a respawned host", () => {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage({ type: "task_list", tasks: [TASK] });
    store.getState().applyHostMessage({ type: "task_output", taskId: "task-1", snapshot: TASK, newOutput: "hello\n" });

    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    expect(store.getState().backgroundTasks).toEqual([]);
    expect(store.getState().backgroundTaskOutput).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GUI-git slice (design slice-5.8-cut.md §2.5 + adversarial §6#6). Node-env,
// no DOM: exported pure helper + reducer/actions over HostToUiMessage.
// ─────────────────────────────────────────────────────────────────────────

const WIRE_STATUS: WireGitStatus = {
  head: { branch: "main", detached: false, sha: "abc1234", ahead: 0, behind: 0 },
  staged: [],
  unstaged: [],
  untracked: [],
  dirtyCount: 0,
  filesTruncated: false,
};

const BRANCHES: GitBranchInfo[] = [{ name: "main", current: true, sha: "abc1234" }];
const COMMITS: GitCommitInfo[] = [{ sha: "abc1234", authorName: "A", authorDate: 0, subject: "init" }];

function newGitStore() {
  const { scheduler } = createManualScheduler();
  return createDesktopStore(scheduler);
}

describe("git slice — buildConfirmedGitCommand (the SOLE destructive-command constructor, ruling R2 / §6#6)", () => {
  it("returns null for a null confirm (dispatch without the dialog is structurally impossible)", () => {
    expect(buildConfirmedGitCommand(null)).toBeNull();
  });

  it("maps each destructive intent to its confirmed:true wire command", () => {
    expect(buildConfirmedGitCommand({ op: "discard", paths: ["a.ts", "b.ts"] })).toEqual({
      op: "discard",
      paths: ["a.ts", "b.ts"],
      confirmed: true,
    });
    expect(buildConfirmedGitCommand({ op: "stash_pop" })).toEqual({ op: "stash_pop", confirmed: true });
    expect(buildConfirmedGitCommand({ op: "reset", mode: "mixed" })).toEqual({ op: "reset", mode: "mixed", confirmed: true });
    expect(buildConfirmedGitCommand({ op: "reset", mode: "hard" })).toEqual({ op: "reset", mode: "hard", confirmed: true });
  });

  it("carries stash_push message/includeUntracked only when present (no undefined keys on the wire)", () => {
    expect(buildConfirmedGitCommand({ op: "stash_push" })).toEqual({ op: "stash_push", confirmed: true });
    const full = buildConfirmedGitCommand({ op: "stash_push", message: "wip", includeUntracked: true });
    expect(full).toEqual({ op: "stash_push", message: "wip", includeUntracked: true, confirmed: true });
    // The optional keys are absent (not present-but-undefined) when unset.
    expect(Object.keys(buildConfirmedGitCommand({ op: "stash_push" }) as object).sort()).toEqual(["confirmed", "op"]);
  });
});

describe("git slice — gitStageConfirm gate (ruling R10 / §6#6)", () => {
  it("stages a destructive intent while idle and clears it on demand", () => {
    const store = newGitStore();
    const intent: GitDestructiveIntent = { op: "reset", mode: "hard" };
    expect(store.getState().gitStageConfirm(intent)).toBe(true);
    expect(store.getState().git.confirm).toEqual(intent);

    store.getState().gitClearConfirm();
    expect(store.getState().git.confirm).toBeNull();
  });

  it("REFUSES (returns false, no state change) while a turn is running", () => {
    const store = newGitStore();
    store.getState().applyHostMessage({ type: "turn_started", requestId: "r1", turnId: "t1" });
    expect(store.getState().turn.status).toBe("running");

    const staged = store.getState().gitStageConfirm({ op: "discard", paths: ["a.ts"] });
    expect(staged).toBe(false);
    expect(store.getState().git.confirm).toBeNull();
  });
});

describe("git slice — git_status / git_result reducer", () => {
  it("git_status stores the payload and flips statusKnown (null = git unavailable)", () => {
    const store = newGitStore();
    expect(store.getState().git.statusKnown).toBe(false);
    expect(store.getState().git.status).toBeNull();

    store.getState().applyHostMessage({ type: "git_status", status: WIRE_STATUS });
    expect(store.getState().git.statusKnown).toBe(true);
    expect(store.getState().git.status).toEqual(WIRE_STATUS);

    store.getState().applyHostMessage({ type: "git_status", status: null });
    expect(store.getState().git.statusKnown).toBe(true);
    expect(store.getState().git.status).toBeNull();
  });

  it("routes branches/log results to their slices and retires the pending entry", () => {
    const store = newGitStore();
    store.getState().gitRequestStarted("r-b", { kind: "branches", label: "branches" });
    store.getState().gitRequestStarted("r-l", { kind: "log", label: "log" });

    store.getState().applyHostMessage({ type: "git_result", requestId: "r-b", outcome: { ok: true, kind: "branches", branches: BRANCHES } });
    store.getState().applyHostMessage({ type: "git_result", requestId: "r-l", outcome: { ok: true, kind: "log", commits: COMMITS } });

    expect(store.getState().git.branches).toEqual(BRANCHES);
    expect(store.getState().git.log).toEqual(COMMITS);
    expect(store.getState().git.pending).toEqual({});
  });

  it("a git_result for an unknown requestId is warn+ignored without throwing (reset race, ruling R9)", () => {
    const store = newGitStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = store.getState().git;

    expect(() =>
      store.getState().applyHostMessage({ type: "git_result", requestId: "ghost", outcome: { ok: true, kind: "unit" } }),
    ).not.toThrow();
    expect(store.getState().git).toBe(before); // no state change at all
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a successful mutation (unit) clears a stale in-panel error; any {ok:false} sets it (ruling R11)", () => {
    const store = newGitStore();
    // A failing op records the in-panel error under its label.
    store.getState().gitRequestStarted("r-fail", { kind: "mutation", label: "discard" });
    store.getState().applyHostMessage({ type: "git_result", requestId: "r-fail", outcome: { ok: false, reason: "boom" } });
    expect(store.getState().git.lastError).toEqual({ label: "discard", reason: "boom" });

    // A later successful mutation clears it.
    store.getState().gitRequestStarted("r-ok", { kind: "mutation", label: "stage" });
    store.getState().applyHostMessage({ type: "git_result", requestId: "r-ok", outcome: { ok: true, kind: "unit" } });
    expect(store.getState().git.lastError).toBeNull();
  });

  it("applies a diff result that matches the current request and drops a stale/superseded one (§6#6)", () => {
    const store = newGitStore();
    // Requesting a diff stamps git.diff with the desired {path,target} (loading).
    store.getState().gitRequestStarted("r1", { kind: "diff", diff: { path: "a.ts", target: "worktree" }, label: "diff" });
    store.getState().gitRequestStarted("r2", { kind: "diff", diff: { path: "b.ts", target: "worktree" }, label: "diff" });
    expect(store.getState().git.diff).toEqual({ path: "b.ts", target: "worktree", text: "", truncated: false });

    // The slow result for the SUPERSEDED request (a.ts) no longer matches git.diff -> dropped.
    store.getState().applyHostMessage({
      type: "git_result",
      requestId: "r1",
      outcome: { ok: true, kind: "diff", diff: "DIFF-A", truncated: false },
    });
    expect(store.getState().git.diff).toEqual({ path: "b.ts", target: "worktree", text: "", truncated: false });
    expect(store.getState().git.pending.r1).toBeUndefined(); // still retired

    // The result for the current request (b.ts) lands, honest truncation flag preserved.
    store.getState().applyHostMessage({
      type: "git_result",
      requestId: "r2",
      outcome: { ok: true, kind: "diff", diff: "DIFF-B", truncated: true },
    });
    expect(store.getState().git.diff).toEqual({ path: "b.ts", target: "worktree", text: "DIFF-B", truncated: true });
    expect(store.getState().git.pending).toEqual({});
  });
});

describe("git slice — panel state + reset semantics (ruling R9)", () => {
  it("gitSetPanelOpen / gitSetView drive the panel independently of session state", () => {
    const store = newGitStore();
    expect(store.getState().git.panelOpen).toBe(false);
    expect(store.getState().git.view).toBe("changes");

    store.getState().gitSetPanelOpen(true);
    store.getState().gitSetView("history");
    expect(store.getState().git.panelOpen).toBe(true);
    expect(store.getState().git.view).toBe("history");
  });

  it("reset() clears the entire git slice back to initial (respawn re-pushes git_status)", () => {
    const store = newGitStore();
    store.getState().applyHostMessage({ type: "git_status", status: WIRE_STATUS });
    store.getState().gitSetPanelOpen(true);
    store.getState().gitSetView("history");
    store.getState().gitStageConfirm({ op: "reset", mode: "hard" });
    store.getState().gitRequestStarted("r1", { kind: "mutation", label: "stage" });
    store.getState().applyHostMessage({ type: "git_result", requestId: "r-x", outcome: { ok: false, reason: "x" } });

    store.getState().reset();

    expect(store.getState().git).toEqual({
      status: null,
      statusKnown: false,
      panelOpen: false,
      view: "changes",
      branches: null,
      log: null,
      diff: null,
      confirm: null,
      pending: {},
      lastError: null,
    });
  });
});

describe("git slice — automation /state non-leak (ruling R12, §6#6)", () => {
  /** Minimal MessagePort double (mirrors automation.test.ts). */
  class FakeMessagePort {
    onmessage: ((event: MessageEvent<HostToUiMessage>) => void) | null = null;
    postMessage(): void {}
    emit(message: HostToUiMessage): void {
      this.onmessage?.({ data: message } as MessageEvent<HostToUiMessage>);
    }
  }
  function stubBridge(): AnycodeBridge {
    return {
      createTab: vi.fn(async (): Promise<CreateTabResult> => ({ ok: true, tabId: "t", workspace: "/ws" })),
      closeTab: vi.fn(async (): Promise<CloseTabResult> => ({ ok: true })),
      listSessions: vi.fn(async (): Promise<SessionSummary[]> => []),
    };
  }

  it("the populated git slice is projected into the TabStateSnapshot (slice 5.8-R8)", () => {
    const tabsStore = createTabsStore();
    const registry = createTabRegistry(tabsStore);
    const port = new FakeMessagePort();
    registry.registerPort("tab-a", "/ws", port as unknown as MessagePort);
    port.emit({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });



    // git-UI smoke can read pill/panel/diff/confirm state back through /state.
    port.emit({ type: "git_status", status: WIRE_STATUS });
    expect(registry.getStore("tab-a")!.getState().git.statusKnown).toBe(true);

    const facade = createAutomationFacade(registry, tabsStore, stubBridge());
    const projected = facade.snapshot().states["tab-a"]!;

    // git rides the projection as a reference copy of the live slice.
    expect("git" in projected).toBe(true);
    expect(projected.git).toEqual(registry.getStore("tab-a")!.getState().git);
    // Control: the other explicit projection fields are still carried.
    expect("turn" in projected).toBe(true);
    expect("transcript" in projected).toBe(true);
  });
});

describe("desktop store — prompt queue (slice P7.14 · F15)", () => {
  const HOST_READY = { type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" } as const;

  function readyStore() {
    const { scheduler } = createManualScheduler();
    const store = createDesktopStore(scheduler);
    store.getState().applyHostMessage(HOST_READY);
    return store;
  }

  it("enqueue/edit/delete are pure FIFO mutations keyed by minted id", () => {
    const store = readyStore();
    store.getState().enqueuePrompt({ text: "first", images: [] });
    store.getState().enqueuePrompt({ text: "second", images: [] });

    let queue = store.getState().promptQueue;
    expect(queue.map((p) => p.text)).toEqual(["first", "second"]);
    expect(new Set(queue.map((p) => p.id)).size).toBe(2); // distinct ids

    // Edit by id replaces only that item's text.
    store.getState().editQueuedPrompt(queue[1]!.id, "second-edited");
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["first", "second-edited"]);
    // Edit of an unknown id is a no-op.
    store.getState().editQueuedPrompt("ghost", "nope");
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["first", "second-edited"]);

    // Delete by id drops only that item.
    queue = store.getState().promptQueue;
    store.getState().deleteQueuedPrompt(queue[0]!.id);
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["second-edited"]);
    // Delete of an unknown id is a no-op.
    store.getState().deleteQueuedPrompt("ghost");
    expect(store.getState().promptQueue).toHaveLength(1);
  });

  it("takeQueueHead atomically pops the head and constructs the sole inFlight; guards against empty/paused/already-inFlight", () => {
    const store = readyStore();

    // Empty queue → null, no inFlight.
    expect(store.getState().takeQueueHead("req-0")).toBeNull();
    expect(store.getState().queueInFlight).toBeNull();

    store.getState().enqueuePrompt({ text: "a", images: [] });
    store.getState().enqueuePrompt({ text: "b", images: [] });

    const head = store.getState().takeQueueHead("req-1");
    expect(head?.text).toBe("a");
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["b"]);
    expect(store.getState().queueInFlight).toEqual({ requestId: "req-1", item: head });

    // A second take while inFlight is non-null returns null and does NOT pop "b".
    expect(store.getState().takeQueueHead("req-2")).toBeNull();
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["b"]);
    expect(store.getState().queueInFlight?.requestId).toBe("req-1");

    // Paused also blocks a take even with inFlight cleared.
    store.getState().clearQueue();
    store.getState().enqueuePrompt({ text: "c", images: [] });
    store.setState({ queuePaused: true });
    expect(store.getState().takeQueueHead("req-3")).toBeNull();
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["c"]);
  });

  it("turn_started clears the inFlight slot only for a matching requestId (accepts the drain)", () => {
    const store = readyStore();
    store.getState().enqueuePrompt({ text: "a", images: [] });
    store.getState().takeQueueHead("req-1");
    expect(store.getState().queueInFlight?.requestId).toBe("req-1");

    // A turn_started for a DIFFERENT requestId does not clear it.
    store.getState().applyHostMessage({ type: "turn_started", requestId: "other", turnId: "t0" });
    expect(store.getState().queueInFlight?.requestId).toBe("req-1");

    // The matching requestId officially accepts the item — inFlight clears.
    store.getState().applyHostMessage({ type: "turn_started", requestId: "req-1", turnId: "t1" });
    expect(store.getState().queueInFlight).toBeNull();
    expect(store.getState().turn).toEqual({ status: "running", turnId: "t1", requestId: "req-1" });
  });

  it("turn_rejected on the in-flight drain restores the item to the head and pauses (busy-race, §2.3)", () => {
    const store = readyStore();
    store.getState().enqueuePrompt({ text: "drained", images: [] });
    store.getState().enqueuePrompt({ text: "waiting", images: [] });
    const drained = store.getState().takeQueueHead("req-1");
    expect(drained?.text).toBe("drained");
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["waiting"]);

    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "req-1", reason: "busy" });

    // Item goes back to the HEAD (FIFO preserved), queue pauses, inFlight clears.
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["drained", "waiting"]);
    expect(store.getState().queuePaused).toBe(true);
    expect(store.getState().queueInFlight).toBeNull();
    expect(store.getState().notice?.kind).toBe("turn_rejected");
  });

  it("turn_rejected for a non-matching requestId leaves the queue untouched (still just a notice)", () => {
    const store = readyStore();
    store.getState().enqueuePrompt({ text: "a", images: [] });
    store.getState().takeQueueHead("req-1");

    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "some-other", reason: "busy" });

    expect(store.getState().queueInFlight?.requestId).toBe("req-1");
    expect(store.getState().queuePaused).toBe(false);
    expect(store.getState().notice?.kind).toBe("turn_rejected");
  });

  it("loop_end with a non-\"completed\" reason pauses a non-empty queue; a clean completion does not", () => {
    for (const reason of ["cancelled", "error", "max_turns"] as const) {
      const store = readyStore();
      store.getState().enqueuePrompt({ text: "held", images: [] });
      store.getState().applyHostMessage({ type: "turn_started", requestId: "r1", turnId: "t1" });
      store.getState().applyHostMessage({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason, turns: 1 } });
      expect(store.getState().queuePaused).toBe(true);
    }

    const clean = readyStore();
    clean.getState().enqueuePrompt({ text: "drain-me", images: [] });
    clean.getState().applyHostMessage({ type: "turn_started", requestId: "r1", turnId: "t1" });
    clean.getState().applyHostMessage({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(clean.getState().queuePaused).toBe(false);

    // An anomalous end with an EMPTY queue must not spuriously flip paused.
    const empty = readyStore();
    empty.getState().applyHostMessage({ type: "turn_started", requestId: "r1", turnId: "t1" });
    empty.getState().applyHostMessage({ type: "agent_event", turnId: "t1", event: { type: "loop_end", reason: "cancelled", turns: 1 } });
    expect(empty.getState().queuePaused).toBe(false);
  });

  it("fatal and setHostExited pause a non-empty queue (don't drain silently after an anomaly)", () => {
    const onFatal = readyStore();
    onFatal.getState().enqueuePrompt({ text: "a", images: [] });
    onFatal.getState().applyHostMessage({ type: "fatal", message: "sanitizer failure" });
    expect(onFatal.getState().queuePaused).toBe(true);

    const onExit = readyStore();
    onExit.getState().enqueuePrompt({ text: "a", images: [] });
    onExit.getState().setHostExited();
    expect(onExit.getState().queuePaused).toBe(true);

    // Empty queue: neither anomaly spuriously pauses.
    const emptyFatal = readyStore();
    emptyFatal.getState().applyHostMessage({ type: "fatal", message: "boom" });
    expect(emptyFatal.getState().queuePaused).toBe(false);
  });

  it("a respawned host_ready PRESERVES still-queued prompts and RESTORES the mid-flight item to the head, paused; a public reset() clears them", () => {
    const store = readyStore();
    store.getState().enqueuePrompt({ text: "in-flight", images: [] });
    store.getState().enqueuePrompt({ text: "still-queued", images: [] });
    // Simulate a drain caught mid-air by the crash: head is in flight, the
    // rest still sits in the queue.
    store.getState().takeQueueHead("req-1");
    expect(store.getState().queueInFlight?.item.text).toBe("in-flight");
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["still-queued"]);

    // Respawn: a fresh host_ready lands on the same store.
    store.getState().applyHostMessage(HOST_READY);
    // Both prompts survived (queue isn't in the session slice) and are held
    // paused. The mid-flight item is RESTORED to the HEAD (a crash between drain
    // and turn_started must not lose an already-typed prompt) — matching the
    // turn_rejected restore pattern. (P7.14/F15 codex fix, supersedes W1 dev #3.)
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["in-flight", "still-queued"]);
    expect(store.getState().queueInFlight).toBeNull();
    expect(store.getState().queuePaused).toBe(true);

    // A public reset() (a genuinely new session in the tab) drops them.
    store.getState().reset();
    expect(store.getState().promptQueue).toEqual([]);
    expect(store.getState().queuePaused).toBe(false);
    expect(store.getState().queueInFlight).toBeNull();
  });

  it("enqueuePrompt returns the minted id, matching the item it appended to the tail", () => {
    const store = readyStore();
    const idA = store.getState().enqueuePrompt({ text: "a", images: [] });
    const idB = store.getState().enqueuePrompt({ text: "b", images: [] });
    expect(idA).not.toBe(idB);
    const queue = store.getState().promptQueue;
    expect(queue.map((p) => ({ id: p.id, text: p.text }))).toEqual([
      { id: idA, text: "a" },
      { id: idB, text: "b" },
    ]);
  });

  it("setHostExited RESTORES a non-null queueInFlight item to the head, clears inFlight, and pauses (crash mid-flight must not lose the prompt)", () => {
    const store = readyStore();
    store.getState().enqueuePrompt({ text: "drained", images: [] });
    store.getState().enqueuePrompt({ text: "behind", images: [] });
    store.getState().takeQueueHead("req-1");
    expect(store.getState().queueInFlight?.item.text).toBe("drained");
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["behind"]);

    store.getState().setHostExited();

    expect(store.getState().connection).toBe("host_exited");
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["drained", "behind"]);
    expect(store.getState().queueInFlight).toBeNull();
    expect(store.getState().queuePaused).toBe(true);
  });

  it("setHostExited with a null queueInFlight leaves the queue exactly as-is (idempotent), pausing only a non-empty queue", () => {
    const store = readyStore();
    store.getState().enqueuePrompt({ text: "held", images: [] });
    store.getState().setHostExited();
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["held"]);
    expect(store.getState().queueInFlight).toBeNull();
    expect(store.getState().queuePaused).toBe(true);

    // Empty queue: no restore, no spurious pause.
    const empty = readyStore();
    empty.getState().setHostExited();
    expect(empty.getState().promptQueue).toEqual([]);
    expect(empty.getState().queuePaused).toBe(false);
  });

  it("host_ready(respawn) with a null queueInFlight (already restored by setHostExited) is a no-op restore — the head is not duplicated", () => {
    const store = readyStore();
    store.getState().enqueuePrompt({ text: "drained", images: [] });
    store.getState().enqueuePrompt({ text: "behind", images: [] });
    store.getState().takeQueueHead("req-1");

    // Crash path: setHostExited restores + clears inFlight, THEN host_ready lands.
    store.getState().setHostExited();
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["drained", "behind"]);
    expect(store.getState().queueInFlight).toBeNull();

    // host_ready's own restore sees a null inFlight → does NOT re-prepend "drained".
    store.getState().applyHostMessage(HOST_READY);
    expect(store.getState().promptQueue.map((p) => p.text)).toEqual(["drained", "behind"]);
    expect(store.getState().queueInFlight).toBeNull();
    expect(store.getState().queuePaused).toBe(true);
  });

  it("a respawn with an EMPTY queue neither pauses nor carries an inFlight (page-load-shaped path unaffected)", () => {
    const store = readyStore();
    store.getState().applyHostMessage(HOST_READY);
    expect(store.getState().promptQueue).toEqual([]);
    expect(store.getState().queuePaused).toBe(false);
    expect(store.getState().queueInFlight).toBeNull();
  });

  it("clearQueue and resumeQueue behave as their names say", () => {
    const store = readyStore();
    store.getState().enqueuePrompt({ text: "a", images: [] });
    store.setState({ queuePaused: true });
    store.getState().resumeQueue();
    expect(store.getState().queuePaused).toBe(false);
    expect(store.getState().promptQueue).toHaveLength(1); // resume does not empty

    store.getState().takeQueueHead("req-1");
    store.getState().clearQueue();
    expect(store.getState().promptQueue).toEqual([]);
    expect(store.getState().queueInFlight).toBeNull();
    expect(store.getState().queuePaused).toBe(false);
  });

  it("carries image attachments through the queued item unchanged", () => {
    const store = readyStore();
    const image = {
      name: "shot.png",
      sizeBytes: 1234,
      attachment: { mediaType: "image/png" as const, data: "BASE64", sourcePath: "shot.png" },
    };
    store.getState().enqueuePrompt({ text: "see this", images: [image] });
    const head = store.getState().takeQueueHead("req-1");
    expect(head?.images).toEqual([image]);
  });
});

describe("desktop store — context_breakdown reducer (slice P7.17 · F12)", () => {
  it("stores the breakdown wholesale and clears it on a respawn host_ready reset", () => {
    const store = createDesktopStore();
    expect(store.getState().contextBreakdown).toBeNull();

    const breakdown: WireContextBreakdown = {
      messagesTokens: 900,
      systemToolsTokens: 60,
      mcpToolsTokens: 8,
      skillsTokens: 6,
      systemPromptTokens: 20,
      metaTokens: 6,
      totalEstimatedTokens: 1000,
    };
    store.getState().applyHostMessage({ type: "context_breakdown", breakdown });
    expect(store.getState().contextBreakdown).toEqual(breakdown);

    // A respawn host_ready resets the session slice — the stale breakdown clears.
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    expect(store.getState().contextBreakdown).toBeNull();
  });
});

describe("desktop store — checkpoint_list reducer (slice P7.26/R2)", () => {
  it("stores the checkpoint list wholesale and clears it on a respawn host_ready reset", () => {
    const store = createDesktopStore();
    expect(store.getState().checkpoints).toEqual([]);

    const checkpoints: WireCheckpointMeta[] = [
      { id: "cp-1", label: "turn 1", createdAt: 1000, reason: "auto" },
      { id: "cp-2", label: "before rewind", createdAt: 2000, reason: "pre-rewind" },
    ];
    store.getState().applyHostMessage({ type: "checkpoint_list", checkpoints });
    expect(store.getState().checkpoints).toEqual(checkpoints);

    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    expect(store.getState().checkpoints).toEqual([]);
  });
});

describe("desktop store — rewind_result reducer (slice P7.26/R2, design slice-P7.26-R2-ratification.md §1)", () => {
  it("ok + conversationRestored:true does a transcript-scoped clear and raises a restored toast naming the safety checkpoint", () => {
    const store = createDesktopStore();
    store.getState().appendUserText("req-1", "hi there");
    expect(store.getState().transcript).toHaveLength(1);

    store.getState().applyHostMessage({
      type: "rewind_result",
      requestId: "rw-1",
      ok: true,
      conversationRestored: true,
      restoredPaths: 3,
      safetyCheckpointId: "abcdef1234567890",
    });

    expect(store.getState().transcript).toEqual([]);
    expect(store.getState().lastRewindResult).toEqual({
      requestId: "rw-1",
      ok: true,
      conversationRestored: true,
      restoredPaths: 3,
      safetyCheckpointId: "abcdef1234567890",
    });
    expect(store.getState().notice).toEqual({ kind: "rewind_restored", text: "Restored — safety checkpoint abcdef12" });
  });

  it("ok + conversationRestored:false (files-only scope) leaves the transcript untouched", () => {
    const store = createDesktopStore();
    store.getState().appendUserText("req-1", "hi there");

    store.getState().applyHostMessage({
      type: "rewind_result",
      requestId: "rw-1",
      ok: true,
      conversationRestored: false,
      restoredPaths: 2,
      safetyCheckpointId: "abcdef1234567890",
    });

    expect(store.getState().transcript).toHaveLength(1);
    expect(store.getState().lastRewindResult?.conversationRestored).toBe(false);
    expect(store.getState().notice?.kind).toBe("rewind_restored");
  });

  it("ok:false surfaces the reason as a rejected toast and touches nothing else", () => {
    const store = createDesktopStore();
    store.getState().appendUserText("req-1", "hi there");

    store.getState().applyHostMessage({
      type: "rewind_result",
      requestId: "rw-1",
      ok: false,
      reason: "a turn is running",
      conversationRestored: false,
      restoredPaths: null,
    });

    expect(store.getState().transcript).toHaveLength(1);
    expect(store.getState().lastRewindResult).toEqual({
      requestId: "rw-1",
      ok: false,
      reason: "a turn is running",
      conversationRestored: false,
      restoredPaths: null,
    });
    expect(store.getState().notice).toEqual({ kind: "rewind_rejected", text: "a turn is running" });
  });

  it("clears lastRewindResult/checkpoints on a respawn host_ready reset", () => {
    const store = createDesktopStore();
    store.getState().applyHostMessage({
      type: "rewind_result",
      requestId: "rw-1",
      ok: true,
      conversationRestored: true,
      restoredPaths: 0,
      safetyCheckpointId: "cp-safety",
    });
    expect(store.getState().lastRewindResult).not.toBeNull();

    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" });
    expect(store.getState().lastRewindResult).toBeNull();
  });
});

describe("accumulateSessionTokens (slice P7.17 · F12 W3)", () => {
  it("starts from a null previous total and copies the usage over 1:1", () => {
    expect(accumulateSessionTokens(null, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })).toEqual({
      input: 10,
      output: 5,
      total: 15,
    });
  });

  it("sums onto a non-null previous total", () => {
    const prev = { input: 10, output: 5, total: 15 };
    expect(accumulateSessionTokens(prev, { inputTokens: 3, outputTokens: 2, totalTokens: 5 })).toEqual({
      input: 13,
      output: 7,
      total: 20,
    });
  });

  it("keeps the latest provider cache measurement with its own input denominator", () => {
    const first = accumulateSessionTokens(null, {
      inputTokens: 100,
      cachedInputTokens: 75,
      outputTokens: 20,
      totalTokens: 120,
    });
    expect(first).toEqual({ input: 100, output: 20, total: 120, latestCacheRead: 75, latestCacheInput: 100 });
    expect(accumulateSessionTokens(first, {
      inputTokens: 200,
      cachedInputTokens: 150,
      outputTokens: 10,
      totalTokens: 210,
    })).toEqual({ input: 300, output: 30, total: 330, latestCacheRead: 150, latestCacheInput: 200 });
  });

  it("treats missing TokenUsage fields as 0 and falls total back to input+output when absent", () => {
    expect(accumulateSessionTokens(null, {})).toEqual({ input: 0, output: 0, total: 0 });
    expect(accumulateSessionTokens(null, { inputTokens: 4, outputTokens: 6 })).toEqual({ input: 4, output: 6, total: 10 });
  });
});

describe("desktop store — sessionTokens accumulator (slice P7.17 · F12 W3)", () => {
  // agent_event's onAgentEvent drops events whose turnId no longer matches
  // the active turn (design §3 — late events from a cancelled/replaced turn
  // must not resurrect stale UI), so every fixture below opens a turn first,
  // exactly like the existing "surfaces finishReason=length" fixture above.
  const HOST_READY = { type: "host_ready", workspace: "/ws", mode: "build", model: "m1", sessionId: "s1" } as const;

  function startTurn(store: ReturnType<typeof createDesktopStore>, turnId: string): void {
    store.getState().applyHostMessage({ type: "turn_started", requestId: `r-${turnId}`, turnId });
  }

  function finishMessage(turnId: string, usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; totalTokens?: number }): HostToUiMessage {
    return { type: "agent_event", turnId, event: { type: "finish", finishReason: "stop", usage } };
  }

  it("accumulates across multiple step-level finish events, not just the latest one", () => {
    const store = createDesktopStore();
    expect(store.getState().sessionTokens).toBeNull();
    startTurn(store, "t1");

    store.getState().applyHostMessage(finishMessage("t1", { inputTokens: 100, outputTokens: 20, totalTokens: 120 }));
    expect(store.getState().sessionTokens).toEqual({ input: 100, output: 20, total: 120 });

    // A second step-level finish (e.g. after a tool-call round-trip) SUMS onto
    // the running total rather than replacing it.
    store.getState().applyHostMessage(finishMessage("t1", { inputTokens: 50, outputTokens: 10, totalTokens: 60 }));
    expect(store.getState().sessionTokens).toEqual({ input: 150, output: 30, total: 180 });
  });

  it("retains the latest cache measurement for the context popover", () => {
    const store = createDesktopStore();
    startTurn(store, "t1");
    store.getState().applyHostMessage(finishMessage("t1", {
      inputTokens: 100,
      cachedInputTokens: 75,
      outputTokens: 20,
      totalTokens: 120,
    }));
    expect(store.getState().sessionTokens).toEqual({
      input: 100,
      output: 20,
      total: 120,
      latestCacheRead: 75,
      latestCacheInput: 100,
    });
  });

  it("defaults missing TokenUsage fields to 0 and falls total back to input+output when the provider omits it", () => {
    const store = createDesktopStore();
    startTurn(store, "t1");

    store.getState().applyHostMessage(finishMessage("t1", {}));
    expect(store.getState().sessionTokens).toEqual({ input: 0, output: 0, total: 0 });

    store.getState().applyHostMessage(finishMessage("t1", { inputTokens: 30, outputTokens: 5 }));
    expect(store.getState().sessionTokens).toEqual({ input: 30, output: 5, total: 35 });
  });

  it("clears on a public reset() and on a respawned host_ready, with no double-count from a later finish", () => {
    const store = createDesktopStore();
    startTurn(store, "t1");
    store.getState().applyHostMessage(finishMessage("t1", { inputTokens: 100, outputTokens: 20, totalTokens: 120 }));
    expect(store.getState().sessionTokens).toEqual({ input: 100, output: 20, total: 120 });

    store.getState().reset();
    expect(store.getState().sessionTokens).toBeNull();

    // Post-reset accumulation starts fresh — no leftover from the pre-reset
    // total, and a fresh turn must be opened again (reset() also clears turn.turnId).
    startTurn(store, "t2");
    store.getState().applyHostMessage(finishMessage("t2", { inputTokens: 5, outputTokens: 5, totalTokens: 10 }));
    expect(store.getState().sessionTokens).toEqual({ input: 5, output: 5, total: 10 });

    // A respawn host_ready also resets the session slice (same as contextBreakdown above).
    store.getState().applyHostMessage(HOST_READY);
    expect(store.getState().sessionTokens).toBeNull();
  });
});
