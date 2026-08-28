/**
 * Session integration tests over a real worker_threads MessageChannel driving
 * the real AgentLoop + dispatcher against a scripted ModelPort (design §10,
 * MVP.3 criteria): event order/completeness with turnId, busy gate, cancel
 * mid-turn (cancelled + denyAll of parked asks), permission allow round-trip,
 * before/after snapshots, the fail-closed snapshot observer, disconnect denyAll,
 * replay on ui_ready, and mode changes (mid-turn and between turns, TASK.37).
 *
 * Slice 2.2.3 additions (design §5, ruling §3): "Always allow" remember
 * round-trip (a remembered allow adds a session rule that auto-allows a
 * subsequent matching call without another ask) and the fail-closed invariant
 * that a plan-mode deny is never overridden by a matching rule.
 *
 * Slice 6.DP-2 additions (design slice-6.DP-2-cut.md §1.3/§1.6/§6#8): the
 * unit-grain proof of Session's notice-injection seam over
 * `createHarness({ tasks: fakePort })` — a local minimal `BackgroundTaskPort`
 * fake whose `drainNotices()` is scripted per test. The e2e (real
 * InProcessTaskManager + real child processes) lives in tasks-wire.test.ts;
 * these tests only prove the SESSION-level wiring: injection byte-format,
 * exactly-once drain, A/B byte-identity with no tasks at all, busy-reject
 * never drains, and title purity.
 *
 * TASK.102 CUT-S2 §2.6.3 additions (slice S2b B4): child-mode Session over a
 * SEPARATE local harness (`createChildHarness` below) rather than
 * `createHarness` — it wires the `child` option `createHarness` deliberately
 * never exposes (test-harness.ts is shared by many other test files; adding a
 * child seam there is out of this slice's file fence). Covers the steer
 * queue's bound, the terminal's ordering against `flushHistory` (including a
 * non-empty queue and a flush failure), the no-title invariant on both the
 * programmatic initial turn and a steer message, `startProgrammaticTurn`'s
 * repeat-refusal, `child.onReady`'s first-ui_ready-only firing, and the
 * frozen-`sessionHistory` invariant mirrored along the child path (§10.4).
 * `tapChildPermissions` itself gets its own pure-function describe block —
 * no harness needed for a pure `(message) => message` wrapper.
 */

import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  AgentLoop,
  InMemoryHookRunner,
  InMemoryTodoStore,
  ModePermissionEngine,
  NodeHttpAdapter,
  RuleAwarePermissionEngine,
  SUBAGENT_ACTIVITY_MAX_EVENTS,
  SessionPermissionRules,
  bashTool,
  createDefaultToolRegistry,
  buildChildModelSettingsResolver,
  matchCatalogEntryByBaseUrl,
  resolveEffortLevels,
  resolveReasoningEffort,
  summarizeChildToolCall,
  withSubagents,
} from "@anycode/core";
import { getBuiltinCatalog } from "@anycode/core/catalog";
import type {
  AgentEvent,
  AgentLoopConfig,
  BackgroundTaskNotice,
  BackgroundTaskPort,
  BackgroundTaskSnapshot,
  BackgroundTaskStartRequest,
  BackgroundTaskStartResult,
  CommandHookDeclaration,
  DiagnosticsOutcome,
  HistoryItem,
  ImageAttachment,
  LspServerStatus,
  LspPort,
  ModelRequest,
  ModelStreamEvent,
  PermissionMode,
  ReasoningEffort,
  TelemetryStatus,
} from "@anycode/core";
import type { SessionEngine } from "./engines/session-engine.js";
import type {
  HostToUiMessage,
  ShellCapabilitiesProjection,
  UiToHostMessage,
  WireBackgroundChild,
  WireEnvStatus,
  WirePort,
} from "../shared/protocol.js";
import { CHILD_PROGRESS_TYPE, CHILD_STEER_QUEUE_MAX, parseChildProgress } from "../shared/child-sessions.js";
import type { GitUiBridge } from "./git-bridge.js";
import { CoreEngine } from "./engines/core-engine.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import {
  Outbound,
  Session,
  tapChildPermissions,
  type ChildProgressReport,
  type ChildTerminalReport,
  type SessionOptions,
  type SessionPersistence,
} from "./session.js";
import {
  MemFs,
  ScriptedModelPort,
  ThrowingFs,
  createHarness,
  finishStep,
  nodeWirePort,
  textStep,
  toolStep,
} from "./test-harness.js";

/**
 * Minimal BackgroundTaskPort fake (design §1.6): every member stubbed except
 * `drainNotices`, which returns a scripted, queued set of notices exactly once
 * (mirrors the real InProcessTaskManager's "terminal-notice queue,
 * exactly-once semantics" contract, ports/tasks.ts:55-56) — `queueNotice`
 * lets a test arrange completions without spawning any real process.
 */
class FakeTaskPort implements BackgroundTaskPort {
  private notices: BackgroundTaskNotice[] = [];
  snapshots: BackgroundTaskSnapshot[] = [];
  outputs = new Map<string, string[]>();
  killed: string[] = [];

  queueNotice(notice: BackgroundTaskNotice): void {
    this.notices.push(notice);
  }

  start(_req: BackgroundTaskStartRequest): BackgroundTaskStartResult {
    return { ok: false, reason: "limit_reached", message: "FakeTaskPort does not start tasks" };
  }

  get(_taskId: string): BackgroundTaskSnapshot | undefined {
    return this.snapshots.find((task) => task.taskId === _taskId);
  }

  readOutput(taskId: string): { snapshot: BackgroundTaskSnapshot; newOutput: string } | undefined {
    const snapshot = this.get(taskId);
    if (!snapshot) return undefined;
    const chunks = this.outputs.get(taskId) ?? [];
    const newOutput = chunks.shift() ?? "";
    return { snapshot, newOutput };
  }

  kill(taskId: string): boolean {
    const snapshot = this.get(taskId);
    if (!snapshot || snapshot.status !== "running") return false;
    this.killed.push(taskId);
    return true;
  }

  list(): BackgroundTaskSnapshot[] {
    return this.snapshots;
  }

  drainNotices(): BackgroundTaskNotice[] {
    const drained = this.notices;
    this.notices = [];
    return drained;
  }

  disposeAll(): Promise<void> {
    return Promise.resolve();
  }
}

function taskSnapshot(overrides?: Partial<BackgroundTaskSnapshot>): BackgroundTaskSnapshot {
  return {
    taskId: "task-1",
    command: "pnpm test",
    status: "running",
    exitCode: null,
    startedAt: 1_000,
    outputBytes: 0,
    outputTruncated: false,
    ...overrides,
  };
}

class FakeLspPort implements LspPort {
  constructor(private servers: LspServerStatus[]) {}

  setStatus(servers: LspServerStatus[]): void {
    this.servers = servers;
  }

  diagnosticsAfterWrite(): Promise<DiagnosticsOutcome> {
    return Promise.resolve({ available: false, reason: "no_server" });
  }

  status(): LspServerStatus[] {
    return this.servers;
  }

  disposeAll(): Promise<void> {
    return Promise.resolve();
  }
}

/** The last message's content, asserted to be the user's (mirrors cli/main.test.ts's own helper — turnInput is always appended as a user ChatMessage). */
function lastUserMessageText(request: ModelRequest | undefined): string {
  const last = request?.messages[request.messages.length - 1];
  expect(last?.role).toBe("user");
  return (last as { role: "user"; content: string }).content;
}

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;

const isHostReady = (m: HostToUiMessage): m is Of<"host_ready"> => m.type === "host_ready";
const isTurnStarted = (m: HostToUiMessage): m is Of<"turn_started"> => m.type === "turn_started";
const isTurnRejected = (m: HostToUiMessage): m is Of<"turn_rejected"> => m.type === "turn_rejected";
const isPermissionRequest = (m: HostToUiMessage): m is Of<"permission_request"> =>
  m.type === "permission_request";
const isPermissionSettled = (m: HostToUiMessage): m is Of<"permission_settled"> =>
  m.type === "permission_settled";
const isModeChanged = (m: HostToUiMessage): m is Of<"mode_changed"> => m.type === "mode_changed";
const isModeChangeRejected = (m: HostToUiMessage): m is Of<"mode_change_rejected"> =>
  m.type === "mode_change_rejected";
const isLspStatus = (m: HostToUiMessage): m is Of<"lsp_status"> => m.type === "lsp_status";
const isHooksList = (m: HostToUiMessage): m is Of<"hooks_list"> => m.type === "hooks_list";
const isTaskList = (m: HostToUiMessage): m is Of<"task_list"> => m.type === "task_list";
const isTaskOutput = (m: HostToUiMessage): m is Of<"task_output"> => m.type === "task_output";
const isTaskKillResult = (m: HostToUiMessage): m is Of<"task_kill_result"> => m.type === "task_kill_result";
const isEnvStatus = (m: HostToUiMessage): m is Of<"env_status"> => m.type === "env_status";
const isContextBreakdown = (m: HostToUiMessage): m is Of<"context_breakdown"> => m.type === "context_breakdown";
const isRewindResult = (m: HostToUiMessage): m is Of<"rewind_result"> => m.type === "rewind_result";

const agentEventOf =
  (innerType: string) =>
  (m: HostToUiMessage): m is Of<"agent_event"> =>
    m.type === "agent_event" && m.event.type === innerType;

const snapshotPhase =
  (phase: "before" | "after") =>
  (m: HostToUiMessage): m is Of<"file_snapshot"> =>
    m.type === "file_snapshot" && m.phase === phase;

const WRITE_INPUT = { file_path: "/workspace/a.txt", content: "NEW" };

describe("Session — LSP status panel wire", () => {
  it("pushes LSP status once on ui_ready after host_ready", async () => {
    const lsp = new FakeLspPort([
      { name: "typescript", state: "ready", pid: 123, extensions: [".ts"], stderrTail: "" },
    ]);
    const h = createHarness({ steps: [finishStep()], lsp });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      const status = await h.waitFor(isLspStatus);
      expect(status.servers).toEqual(lsp.status());
      expect(h.received.findIndex(isHostReady)).toBeLessThan(h.received.findIndex(isLspStatus));
    } finally {
      h.close();
    }
  });

  it("round-trips lsp_status_request with the current status snapshot", async () => {
    const lsp = new FakeLspPort([
      { name: "typescript", state: "not_started", extensions: [".ts", ".tsx"], stderrTail: "" },
    ]);
    const h = createHarness({ steps: [finishStep()], lsp });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isLspStatus);

      lsp.setStatus([{ name: "typescript", state: "ready", pid: 456, extensions: [".ts", ".tsx"], stderrTail: "ok" }]);
      const before = h.received.filter(isLspStatus).length;
      h.send({ type: "lsp_status_request" });

      await h.waitUntil(() => h.received.filter(isLspStatus).length > before);
      expect(h.received.filter(isLspStatus).at(-1)?.servers).toEqual(lsp.status());
    } finally {
      h.close();
    }
  });
});

describe("Session — context breakdown wire (slice P7.17 · F12)", () => {
  const SUM = (b: Of<"context_breakdown">["breakdown"]): number =>
    b.messagesTokens + b.systemToolsTokens + b.mcpToolsTokens + b.skillsTokens + b.systemPromptTokens + b.metaTokens;

  it("answers a context_breakdown_request with a decomposition that sums to the anchor", async () => {
    const h = createHarness({ steps: [finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "context_breakdown_request" });
      const { breakdown } = await h.waitFor(isContextBreakdown);

      // Every leaf is a finite number (no NaN from a div-by-0 / missing prompt).
      for (const value of Object.values(breakdown)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
      // Provider-anchored decomposition: the six leaves sum EXACTLY to the total.
      expect(SUM(breakdown)).toBe(breakdown.totalEstimatedTokens);
      // A harness workspace has no skills components and no MCP tools bridged.
      expect(breakdown.skillsTokens).toBe(0);
      expect(breakdown.mcpToolsTokens).toBe(0);
    } finally {
      h.close();
    }
  });

  it("serves the request mid-turn (pure read, busy is not a gate)", async () => {
    const h = createHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      // Park the turn at the Write permission ask -> the session is busy.
      h.send({ type: "user_message", requestId: "r1", text: "write it" });
      const req = await h.waitFor(isPermissionRequest);

      h.send({ type: "context_breakdown_request" });
      const { breakdown } = await h.waitFor(isContextBreakdown);
      expect(SUM(breakdown)).toBe(breakdown.totalEstimatedTokens);

      // Release the parked ask so the turn drains cleanly.
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });
      await h.waitFor(agentEventOf("loop_end"));
    } finally {
      h.close();
    }
  });
});

describe("Session — hooks config-list panel wire", () => {
  it("pushes the static hook list once on ui_ready after host_ready", async () => {
    const declarations: CommandHookDeclaration[] = [
      { event: "PreToolUse", matcher: "Write|Edit", command: "./guard.sh", timeoutMs: 2000 },
      { event: "Stop", command: "./cleanup.sh" },
    ];
    const h = createHarness({ steps: [finishStep()], hooksList: { declarations } });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      const hooks = await h.waitFor(isHooksList);
      expect(hooks.hooks).toEqual(declarations);
      expect(hooks.configError).toBeUndefined();
      expect(h.received.findIndex(isHostReady)).toBeLessThan(h.received.findIndex(isHooksList));
    } finally {
      h.close();
    }
  });

  it("surfaces a hook config load error with an empty list", async () => {
    const h = createHarness({
      steps: [finishStep()],
      hooksList: { declarations: [], configError: "Invalid hook config /ws/.anycode/config.json" },
    });
    try {
      h.send({ type: "ui_ready" });
      const hooks = await h.waitFor(isHooksList);

      expect(hooks.hooks).toEqual([]);
      expect(hooks.configError).toBe("Invalid hook config /ws/.anycode/config.json");
    } finally {
      h.close();
    }
  });
});

describe("Session — env status wire (slice P7.8)", () => {
  it("pushes env_status on ui_ready, after task_list, with the exact seam payload", async () => {
    const telemetryStatus: TelemetryStatus = { filePath: "/ws/.anycode/telemetry/s1.jsonl", written: 3, dropped: 0 };
    const repoMapStatus: WireEnvStatus["repoMap"] = { fileCount: 10, includedCount: 8, truncated: false, maxTokens: 2_000 };
    const h = createHarness({
      steps: [finishStep()],
      envStatus: { telemetry: () => telemetryStatus, repoMap: () => repoMapStatus },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      const status = await h.waitFor(isEnvStatus);
      expect(status.status).toEqual({ telemetry: telemetryStatus, repoMap: repoMapStatus });
      expect(h.received.findIndex(isTaskList)).toBeLessThan(h.received.findIndex(isEnvStatus));
    } finally {
      h.close();
    }
  });

  it("emits nothing without the envStatus seam (legacy byte-identity, ruling R5)", async () => {
    const h = createHarness({ steps: [finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await h.waitFor(isTaskList);
      await h.flush();

      expect(h.received.some(isEnvStatus)).toBe(false);
    } finally {
      h.close();
    }
  });

  it("re-pushes a fresh env_status after each turn's teardown", async () => {
    let written = 3;
    const h = createHarness({
      steps: [textStep("done"), finishStep()],
      envStatus: { telemetry: () => ({ filePath: "/ws/t.jsonl", written, dropped: 0 }), repoMap: () => null },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await h.waitFor(isEnvStatus);
      const before = h.received.filter(isEnvStatus).length;

      written = 4;
      h.send({ type: "user_message", requestId: "t1", text: "hi" });
      await h.waitUntil(() => h.received.filter(isEnvStatus).length > before);

      expect(h.received.filter(isEnvStatus).at(-1)?.status.telemetry).toEqual({
        filePath: "/ws/t.jsonl",
        written: 4,
        dropped: 0,
      });
    } finally {
      h.close();
    }
  });

  it("awaits flushTelemetry() before the teardown push, so late-settling counters are not lost (codex-P2)", async () => {
    // Mirrors JsonlTelemetrySink: written only increments once the async
    // append actually resolves, which can straddle turn teardown. flush()
    // here resolves `written` from 3 -> 4 on a microtask delay, simulating an
    // append still in flight when runTurn() settles.
    let written = 3;
    let flushResolved = false;
    const h = createHarness({
      steps: [finishStep()],
      envStatus: {
        telemetry: () => ({ filePath: "/ws/t.jsonl", written, dropped: 0 }),
        repoMap: () => null,
        flushTelemetry: async () => {
          await Promise.resolve();
          await Promise.resolve();
          written = 4;
          flushResolved = true;
        },
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await h.waitFor(isEnvStatus);
      const before = h.received.filter(isEnvStatus).length;

      h.send({ type: "user_message", requestId: "t1", text: "hi" });
      await h.waitUntil(() => h.received.filter(isEnvStatus).length > before);

      // The teardown push must have waited for flushTelemetry() to resolve
      // before reading telemetry() — asserting flushResolved guards against a
      // regression where pushEnvStatus races ahead of the flush.
      expect(flushResolved).toBe(true);
      expect(h.received.filter(isEnvStatus).at(-1)?.status.telemetry).toEqual({
        filePath: "/ws/t.jsonl",
        written: 4,
        dropped: 0,
      });
    } finally {
      h.close();
    }
  });

  it("shutdown() during teardown waits for flushTelemetry() + the teardown push (codex-P2 hostfix)", async () => {
    // Regression guard: `currentTurn` used to be nulled out at the TOP of the
    // turn's `.finally()` (before `await flushTelemetry()`), so a shutdown()
    // arriving after the turn's for-await loop finished but before
    // flushTelemetry() settled would find `this.currentTurn` already null and
    // return immediately — skipping the flush + teardown env_status push.
    // flushTelemetry is gated on a manually-resolved promise so the test can
    // deterministically land shutdown() inside that exact window instead of
    // relying on microtask-count timing.
    let written = 3;
    let flushCalled = false;
    let releaseFlush: () => void = () => {};
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const h = createHarness({
      steps: [finishStep()],
      envStatus: {
        telemetry: () => ({ filePath: "/ws/t.jsonl", written, dropped: 0 }),
        repoMap: () => null,
        flushTelemetry: async () => {
          flushCalled = true;
          await flushGate;
          written = 4;
        },
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await h.waitFor(isEnvStatus);
      const before = h.received.filter(isEnvStatus).length;

      h.send({ type: "user_message", requestId: "t1", text: "hi" });
      // Wait until the turn's finally() has actually reached flushTelemetry()
      // — in the old buggy code, `currentTurn` was already nulled by this point.
      await h.waitUntil(() => flushCalled);

      let shutdownSettled = false;
      const shutdownPromise = h.session.shutdown().then(() => {
        shutdownSettled = true;
      });

      // shutdown() must NOT resolve while flushTelemetry is still gated, and
      // the teardown env_status push must not have happened yet either.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      expect(h.received.filter(isEnvStatus).length).toBe(before);

      releaseFlush();
      await shutdownPromise;
      // shutdownPromise settling only means the host-side teardown finished;
      // the resulting env_status message still needs a tick to cross the
      // (real) MessageChannel into `h.received`.
      await h.flush();

      expect(shutdownSettled).toBe(true);
      expect(h.received.filter(isEnvStatus).length).toBeGreaterThan(before);
      expect(h.received.filter(isEnvStatus).at(-1)?.status.telemetry).toEqual({
        filePath: "/ws/t.jsonl",
        written: 4,
        dropped: 0,
      });
    } finally {
      h.close();
    }
  });
});

describe("Session — root busy does not span the teardown tail (TASK.102 CUT-S2 §10.10.1 O1)", () => {
  it("accepts a user_message sent right after loop_end even while flushTelemetry() is still pending", async () => {
    // F7 held `busy` across the ENTIRE turn teardown for every session, root
    // included — but a root session has no terminal to protect, and the
    // renderer's contract is "input is accepted right after loop_end" (the
    // queue drains on loop_end; a reject here pauses it, store.test.ts
    // pinned). §10.10.1 reverts the root half of that hold: `busy` clears as
    // the FIRST step of teardown, before flushTelemetry (or any other await)
    // below it — CHILD busy keeps the F7 hold, unaffected by this test.
    // flushTelemetry is gated on a manually-resolved promise so the test can
    // deterministically land the second user_message inside that exact
    // window instead of relying on microtask-count timing.
    let flushCalled = false;
    let releaseFlush: () => void = () => {};
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const h = createHarness({
      steps: [finishStep(), finishStep()],
      envStatus: {
        telemetry: () => null,
        repoMap: () => null,
        flushTelemetry: async () => {
          flushCalled = true;
          await flushGate;
        },
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "t1", text: "hi" });
      await h.waitFor(agentEventOf("loop_end"));
      // The turn's finally() is now stuck awaiting the gated flushTelemetry —
      // in the pre-fix code `busy` stays true across this whole window.
      await h.waitUntil(() => flushCalled);

      h.send({ type: "user_message", requestId: "t2", text: "again" });
      // A real round trip over the MessageChannel — enough ticks for either a
      // turn_started#2 or a turn_rejected to already have posted, whichever
      // the host chose.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Discriminator: a facade that still held root `busy` across
      // flushTelemetry (the shipped F7 behavior) would reject t2 as busy
      // instead of starting it.
      expect(h.received.filter(isTurnStarted).filter((m) => m.requestId === "t2")).toHaveLength(1);
      expect(h.received.filter(isTurnRejected)).toHaveLength(0);

      releaseFlush();
      await h.flush();
    } finally {
      h.close();
    }
  });
});

describe("Session — background jobs panel wire", () => {
  it("pushes a task list on ui_ready and on task_list_request", async () => {
    const tasks = new FakeTaskPort();
    tasks.snapshots = [taskSnapshot()];
    const h = createHarness({ steps: [finishStep()], tasks });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      const initial = await h.waitFor(isTaskList);
      expect(initial.tasks).toEqual(tasks.snapshots);

      tasks.snapshots = [taskSnapshot({ taskId: "task-2", command: "sleep 10" })];
      const before = h.received.filter(isTaskList).length;
      h.send({ type: "task_list_request" });
      await h.waitUntil(() => h.received.filter(isTaskList).length > before);
      expect(h.received.filter(isTaskList).at(-1)?.tasks).toEqual(tasks.snapshots);
    } finally {
      h.close();
    }
  });

  it("round-trips task output chunks and confirmed kill", async () => {
    const tasks = new FakeTaskPort();
    tasks.snapshots = [taskSnapshot()];
    tasks.outputs.set("task-1", ["hello\n", "world\n"]);
    const h = createHarness({ steps: [finishStep()], tasks });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isTaskList);

      h.send({ type: "task_output_request", taskId: "task-1" });
      const first = await h.waitFor(isTaskOutput);
      expect(first).toMatchObject({ taskId: "task-1", snapshot: tasks.snapshots[0], newOutput: "hello\n" });

      h.send({ type: "task_output_request", taskId: "task-1" });
      await h.waitUntil(() => h.received.filter(isTaskOutput).length >= 2);
      expect(h.received.filter(isTaskOutput).at(-1)?.newOutput).toBe("world\n");

      h.send({ type: "task_kill_request", requestId: "kill-1", taskId: "task-1", confirmed: true });
      const killed = await h.waitFor(isTaskKillResult);
      expect(killed).toMatchObject({ requestId: "kill-1", ok: true });
      expect(tasks.killed).toEqual(["task-1"]);
    } finally {
      h.close();
    }
  });
});

describe("Session — stream bridge", () => {
  it("streams a text turn in order with every agent_event tagged by turnId; busy resets after", async () => {
    const h = createHarness({ steps: [textStep("hello"), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      const ready = await h.waitFor(isHostReady);
      expect(ready).toMatchObject({
        workspace: "/workspace",
        mode: "build",
        model: "scripted-model",
        sessionId: "test-session",
      });
      expect(ready.engine).toBeUndefined();

      h.send({ type: "user_message", requestId: "r1", text: "hi" });
      const started = await h.waitFor(isTurnStarted);
      expect(started.requestId).toBe("r1");
      const { turnId } = started;
      expect(turnId).toBeTruthy();

      await h.waitFor(agentEventOf("loop_end"));

      const agentEvents = h.received.filter((m): m is Of<"agent_event"> => m.type === "agent_event");
      expect(agentEvents.every((e) => e.turnId === turnId)).toBe(true);
      expect(agentEvents.map((e) => e.event.type)).toEqual([
        "turn_start",
        "start",
        "text_delta",
        "finish",
        "context_usage",
        "turn_end",
        "loop_end",
      ]);
      const last = agentEvents.at(-1);
      expect(last?.event).toMatchObject({ type: "loop_end", reason: "completed" });

      // Busy gate released: a second message starts a fresh turn (not rejected).
      h.send({ type: "user_message", requestId: "r2", text: "again" });
      const second = await h.waitFor(
        (m): m is Of<"turn_started"> => m.type === "turn_started" && m.requestId === "r2",
      );
      expect(second.turnId).not.toBe(turnId);
    } finally {
      h.close();
    }
  });

  it("logs a provider stream error to the process log (TASK.2 DoD-c, slice-P7.7-cut.md §3.3)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = createHarness({ steps: [[{ type: "error", error: new Error("boom") }]] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "hi" });
      await h.waitFor(agentEventOf("loop_end"));

      expect(
        consoleError.mock.calls.some(
          (call) =>
            typeof call[0] === "string" &&
            call[0].includes("[host] provider stream error:") &&
            call[0].includes("boom"),
        ),
      ).toBe(true);
    } finally {
      consoleError.mockRestore();
      h.close();
    }
  });
});

/**
 * TASK.159: SessionOptions.eventTap — the ONLY telemetry seam a foreign-engine
 * (codex/claude) boot has, since those engines never instantiate AgentLoop
 * (whose own eventTap is unreachable for them). Direct `new Session(...)`
 * construction (mirror of the "shell capability" describe block's own
 * buildFakeEngine/buildTestSession pattern above — a fresh, small, LOCAL
 * harness rather than test-harness.ts, which is shared by many other test
 * files, per this file's own header note on child-mode's `createChildHarness`)
 * lets a test pass `eventTap` directly, which `createHarness` (test-harness.ts)
 * does not expose.
 */
describe("Session — foreign-engine telemetry tap (TASK.159)", () => {
  class FakeWirePort implements WirePort {
    readonly received: unknown[] = [];
    private messageCb: ((msg: unknown) => void) | null = null;

    post(msg: unknown): void {
      this.received.push(msg);
    }

    onMessage(cb: (msg: unknown) => void): void {
      this.messageCb = cb;
    }

    onClose(): void {
      // Unused by these tests.
    }

    send(message: UiToHostMessage): void {
      this.messageCb?.(message);
    }
  }

  /** A non-core external-engine shape (mirrors buildFakeEngine in the shell-capability describe above). */
  function buildFakeEngine(overrides: Partial<SessionEngine> = {}): SessionEngine {
    return {
      id: "codex",
      capabilities: {
        supportsCorePermissions: false,
        supportsRewind: false,
        supportsWorkflow: false,
        supportsGitMutations: false,
        supportsContextUsage: false,
        supportsContextBreakdown: false,
        supportsInteractiveApprovals: false,
        costAccounting: false,
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsImages: false,
        supportsTasks: false,
        supportsFileSnapshots: false,
      },
      mode: () => "build",
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      async *runTurn(): AsyncIterable<AgentEvent> {},
      historyItems: () => [],
      dispose: async () => {},
      ...overrides,
    };
  }

  function buildSession(opts: { engine: SessionEngine; eventTap?: (event: AgentEvent) => void }): { port: FakeWirePort } {
    const outbound = new Outbound();
    const broker = new IpcPermissionBroker((message) => outbound.emit(message));
    const session = new Session({
      outbound,
      engine: opts.engine,
      broker,
      fs: new MemFs(),
      workspace: "/workspace",
      model: "m1",
      sessionId: "s1",
      rules: new SessionPermissionRules(),
      ...(opts.eventTap !== undefined ? { eventTap: opts.eventTap } : {}),
    });
    const port = new FakeWirePort();
    session.bindPort(port);
    return { port };
  }

  it("sees every event runTurn observes, in order — covers tool_result/turn_end/finish/loop_end", async () => {
    const seen: AgentEvent[] = [];
    const engine = buildFakeEngine({
      async *runTurn(): AsyncIterable<AgentEvent> {
        yield {
          type: "tool_result",
          outcome: { toolCallId: "c1", toolName: "Bash", status: "success", modelText: "ok", durationMs: 5 },
        };
        yield { type: "turn_end", turn: 1, finishReason: "stop" };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        yield { type: "loop_end", reason: "completed", turns: 1 };
      },
    });
    const { port } = buildSession({ engine, eventTap: (event) => seen.push(event) });
    port.send({ type: "ui_ready" });
    port.send({ type: "user_message", requestId: "r1", text: "go" });
    await vi.waitFor(() =>
      expect(seen.map((event) => event.type)).toEqual(["tool_result", "turn_end", "finish", "loop_end"]),
    );
  });

  it("a throwing tap is caught and logged — the turn completes exactly as without one", async () => {
    const engine = buildFakeEngine({
      async *runTurn(): AsyncIterable<AgentEvent> {
        yield { type: "loop_end", reason: "completed", turns: 1 };
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { port } = buildSession({
        engine,
        eventTap: () => {
          throw new Error("tap boom");
        },
      });
      port.send({ type: "ui_ready" });
      port.send({ type: "user_message", requestId: "r1", text: "go" });
      await vi.waitFor(() =>
        expect(port.received).toContainEqual({
          type: "agent_event",
          turnId: expect.any(String),
          event: { type: "loop_end", reason: "completed", turns: 1 },
        }),
      );
      expect(
        consoleError.mock.calls.some(
          (call) => typeof call[0] === "string" && call[0].includes("[host] eventTap failed:") && call[0].includes("tap boom"),
        ),
      ).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("no eventTap configured — the turn is byte-identical to a legacy/core-path Session (no crash, same events on the wire)", async () => {
    const engine = buildFakeEngine({
      async *runTurn(): AsyncIterable<AgentEvent> {
        yield { type: "loop_end", reason: "completed", turns: 1 };
      },
    });
    const { port } = buildSession({ engine });
    port.send({ type: "ui_ready" });
    port.send({ type: "user_message", requestId: "r1", text: "go" });
    await vi.waitFor(() =>
      expect(port.received).toContainEqual({
        type: "agent_event",
        turnId: expect.any(String),
        event: { type: "loop_end", reason: "completed", turns: 1 },
      }),
    );
  });
});

describe("Session — provider health reporting (TASK.45 W11)", () => {
  it("reports a failure with the core loop's OWN classified code (401 -> auth) on a stream error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: Array<{ kind: "success" } | { kind: "failure"; code: string }> = [];
    const error = Object.assign(new Error("invalid api key"), { statusCode: 401 });
    const h = createHarness({
      steps: [[{ type: "error", error }]],
      reportProviderHealth: (event) => events.push(event),
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "hi" });
      await h.waitFor(agentEventOf("loop_end"));

      expect(events).toEqual([{ kind: "failure", code: "auth" }]);
    } finally {
      consoleError.mockRestore();
      h.close();
    }
  });

  it("reports a failure with code \"unknown\" for a bad-model-shaped 400 — never auth", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: Array<{ kind: "success" } | { kind: "failure"; code: string }> = [];
    const error = Object.assign(new Error("invalid request: unknown model"), { statusCode: 400 });
    const h = createHarness({
      steps: [[{ type: "error", error }]],
      reportProviderHealth: (event) => events.push(event),
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "hi" });
      await h.waitFor(agentEventOf("loop_end"));

      expect(events).toEqual([{ kind: "failure", code: "unknown" }]);
    } finally {
      consoleError.mockRestore();
      h.close();
    }
  });

  it("reports a failure with code \"rate_limited\" on a 429 and \"server\" on a 503, distinct from auth", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const events: Array<{ kind: "success" } | { kind: "failure"; code: string }> = [];
    const rateLimited = Object.assign(new Error("too many requests"), { statusCode: 429 });
    const serverError = Object.assign(new Error("server error"), { statusCode: 503 });
    const h = createHarness({
      steps: [[{ type: "error", error: rateLimited }], [{ type: "error", error: serverError }]],
      reportProviderHealth: (event) => events.push(event),
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "hi" });
      await h.waitFor(agentEventOf("loop_end"));
      h.send({ type: "user_message", requestId: "r2", text: "again" });
      await h.waitUntil(() => events.length >= 2);

      expect(events).toEqual([
        { kind: "failure", code: "rate_limited" },
        { kind: "failure", code: "server" },
      ]);
    } finally {
      consoleError.mockRestore();
      h.close();
    }
  });

  it("reports success on a normal finish, and never fires for a legacy caller that omits the seam", async () => {
    const events: Array<{ kind: "success" } | { kind: "failure"; code: string }> = [];
    const h = createHarness({
      steps: [textStep("hello")],
      reportProviderHealth: (event) => events.push(event),
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "hi" });
      await h.waitFor(agentEventOf("loop_end"));

      expect(events).toEqual([{ kind: "success" }]);
    } finally {
      h.close();
    }

    // Legacy caller (no reportProviderHealth seam): the exact same script must
    // not throw — the field is a pure no-op when absent.
    const legacy = createHarness({ steps: [textStep("hello")] });
    try {
      legacy.send({ type: "ui_ready" });
      await legacy.waitFor(isHostReady);
      legacy.send({ type: "user_message", requestId: "r1", text: "hi" });
      await expect(legacy.waitFor(agentEventOf("loop_end"))).resolves.toBeTruthy();
    } finally {
      legacy.close();
    }
  });
});

describe("Session — multimodal attachments", () => {
  const image: ImageAttachment = { mediaType: "image/png", data: "QUJD", sourcePath: "shot.png" };

  it("passes user_message images into AgentLoop.runTurn attachments without changing the text", async () => {
    const h = createHarness({ steps: [textStep("ok"), finishStep()], imageInputEnabled: true });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "look at this", images: [image] });
      await h.waitFor(agentEventOf("loop_end"));

      const model = h.config.modelPort as ScriptedModelPort;
      const user = model.requests[0]?.messages[0];
      expect(user).toEqual({ role: "user", content: "look at this", images: [image] });
    } finally {
      h.close();
    }
  });

  it("rejects image turns fail-closed when the session model is not image-capable", async () => {
    const h = createHarness({ steps: [textStep("must not run")], imageInputEnabled: false });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "look", images: [image] });
      const rejected = await h.waitFor(isTurnRejected);
      expect(rejected).toMatchObject({ requestId: "r1", reason: "unsupported_images" });
      expect((h.config.modelPort as ScriptedModelPort).requests).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("Session — busy gate", () => {
  it("rejects a second user_message while a turn is in flight", async () => {
    const h = createHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write it" });
      const req = await h.waitFor(isPermissionRequest); // turn parked at the Write ask

      h.send({ type: "user_message", requestId: "r2", text: "again" });
      const rejected = await h.waitFor(isTurnRejected);
      expect(rejected).toMatchObject({ requestId: "r2", reason: "busy" });

      // release the parked ask so the turn drains cleanly
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });
      await h.waitFor(agentEventOf("loop_end"));
    } finally {
      h.close();
    }
  });
});

describe("Session — cancel", () => {
  it("cancel mid-turn ends the loop as cancelled and denies parked asks (turn_cancelled)", async () => {
    const h = createHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write it" });
      await h.waitFor(isPermissionRequest);

      h.send({ type: "cancel_turn" });

      const settled = await h.waitFor(isPermissionSettled);
      expect(settled).toMatchObject({ behavior: "deny", origin: "turn_cancelled" });

      const loopEnd = await h.waitFor(agentEventOf("loop_end"));
      expect(loopEnd.event).toMatchObject({ type: "loop_end", reason: "cancelled" });
    } finally {
      h.close();
    }
  });
});

describe("Session — engine shutdown seam", () => {
  it("projects a non-core engine's capabilities and gates unsupported core controls", async () => {
    const setMode = vi.fn();
    const setReasoningEffort = vi.fn();
    const switchModel = vi.fn(() => ({ model: "ignored", reasoningEffort: "off" as const }));
    const engine: SessionEngine = {
      id: "codex",
      capabilities: {
        supportsCorePermissions: false,
        supportsRewind: false,
        supportsWorkflow: false,
        supportsGitMutations: false,
        supportsContextUsage: false,
        supportsContextBreakdown: false,
        supportsInteractiveApprovals: true,
        costAccounting: false,
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsImages: false,
        supportsTasks: false,
        supportsFileSnapshots: false,
      },
      mode: () => "build",
      setMode,
      reasoningEffort: () => undefined,
      setReasoningEffort,
      switchModel,
      async *runTurn(): AsyncIterable<AgentEvent> {},
      historyItems: () => [],
      dispose: async () => {},
    };
    const h = createHarness({ steps: [], engine, imageInputEnabled: true });
    try {
      h.send({ type: "ui_ready" });
      const ready = await h.waitFor(isHostReady);
      expect(ready.engine).toEqual({ id: "codex", capabilities: engine.capabilities });

      h.send({ type: "set_mode", mode: "plan" });
      const modeRejected = await h.waitFor(isModeChangeRejected);
      expect(modeRejected.reason).toBe("permission modes are managed by this engine");

      h.send({ type: "set_reasoning_effort", effort: "high" });
      h.send({ type: "set_model", model: "some-model" });
      h.send({ type: "context_breakdown_request" });
      h.send({ type: "task_list_request" });
      h.send({ type: "checkpoint_list_request" });
      h.send({ type: "user_message", requestId: "image", text: "look", images: [{ mediaType: "image/png", data: "WA==" }] });
      const imageRejected = await h.waitFor(isTurnRejected);

      expect(imageRejected).toMatchObject({ requestId: "image", reason: "unsupported_images" });
      expect(setMode).not.toHaveBeenCalled();
      expect(setReasoningEffort).not.toHaveBeenCalled();
      expect(switchModel).not.toHaveBeenCalled();
      expect(h.received.some(isContextBreakdown)).toBe(false);
      expect(h.received.some(isTaskList)).toBe(false);
      expect(h.received.some((message) => message.type === "checkpoint_list")).toBe(false);
    } finally {
      h.close();
    }
  });

  it("starts engine disposal before awaiting a turn that ignores ordinary abort", async () => {
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    let turnSignal: AbortSignal | undefined;
    const order: string[] = [];
    const engine: SessionEngine = {
      id: "codex",
      capabilities: {
        supportsCorePermissions: false,
        supportsRewind: false,
        supportsWorkflow: false,
        supportsGitMutations: false,
        supportsContextUsage: false,
        supportsContextBreakdown: false,
        supportsInteractiveApprovals: false,
        costAccounting: false,
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsImages: false,
        supportsTasks: false,
        supportsFileSnapshots: false,
      },
      mode: () => "build",
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      async *runTurn(_input, options): AsyncIterable<AgentEvent> {
        turnSignal = options.signal;
        await turnGate; // Deliberately ignores abort; disposal must unblock it.
        order.push("turn-ended");
        yield { type: "loop_end", reason: "cancelled", turns: 0 };
      },
      historyItems: () => [],
      dispose: vi.fn(() => {
        order.push("dispose");
        releaseTurn();
        return disposeGate;
      }),
    };
    const h = createHarness({ steps: [], engine });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "external turn" });
      await h.waitUntil(() => turnSignal !== undefined);

      let settled = false;
      const shutdown = h.session.shutdown().then(() => {
        settled = true;
      });
      await h.waitUntil(() => vi.mocked(engine.dispose).mock.calls.length === 1);
      await h.waitUntil(() => order.includes("turn-ended"));

      expect(turnSignal?.aborted).toBe(true);
      expect(order.indexOf("dispose")).toBeLessThan(order.indexOf("turn-ended"));
      expect(settled).toBe(false);

      releaseDispose();
      await shutdown;
      expect(engine.dispose).toHaveBeenCalledWith("host-shutdown");
      expect(settled).toBe(true);
    } finally {
      h.close();
    }
  });

  it("swallows a synchronous adapter dispose failure during shutdown", async () => {
    const dispose = vi.fn((): Promise<void> => {
      throw new Error("dispose boom");
    });
    const engine: SessionEngine = {
      id: "codex",
      capabilities: {
        supportsCorePermissions: false,
        supportsRewind: false,
        supportsWorkflow: false,
        supportsGitMutations: false,
        supportsContextUsage: false,
        supportsContextBreakdown: false,
        supportsInteractiveApprovals: false,
        costAccounting: false,
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsImages: false,
        supportsTasks: false,
        supportsFileSnapshots: false,
      },
      mode: () => "build",
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      async *runTurn(): AsyncIterable<AgentEvent> {},
      historyItems: () => [],
      dispose,
    };
    const h = createHarness({ steps: [], engine });
    try {
      await expect(h.session.shutdown()).resolves.toBeUndefined();
      expect(dispose).toHaveBeenCalledWith("host-shutdown");
    } finally {
      h.close();
    }
  });
});

/**
 * Design TASK.40 §2(f): shell (AnyCode chrome) vs engine (agent runtime)
 * capability split. These construct a minimal Session directly (not via
 * createHarness's full AgentLoop wiring — unnecessary here, since no turn
 * ever runs) over a hand-rolled in-memory WirePort, so the wire-shape and
 * git_command routing assertions below stay independent of the harness's
 * own option surface.
 */
describe("Session — shell capability projection & git-user-mutation gate (design TASK.40 §2(f))", () => {
  /** Records posted messages and lets a test push a UiToHostMessage in directly, bypassing any real transport. */
  class FakeWirePort implements WirePort {
    readonly received: unknown[] = [];
    private messageCb: ((msg: unknown) => void) | null = null;

    post(msg: unknown): void {
      this.received.push(msg);
    }

    onMessage(cb: (msg: unknown) => void): void {
      this.messageCb = cb;
    }

    onClose(): void {
      // Unused by these tests.
    }

    send(message: UiToHostMessage): void {
      this.messageCb?.(message);
    }

    hostReady(): (HostToUiMessage & { type: "host_ready" }) | undefined {
      return this.received.find(
        (m): m is HostToUiMessage & { type: "host_ready" } =>
          typeof m === "object" && m !== null && (m as { type?: unknown }).type === "host_ready",
      );
    }
  }

  /** Records every `handleCommand` call so a test can assert which git_command reached the bridge. */
  /** The requestId of the single ask the broker put in front of the UI. */
  function permissionRequestId(port: FakeWirePort): string {
    const found = port.received.find(
      (m): m is HostToUiMessage & { type: "permission_request" } =>
        typeof m === "object" && m !== null && (m as { type?: unknown }).type === "permission_request",
    );
    if (!found) {
      throw new Error("no permission_request emitted");
    }
    return found.requestId;
  }

  /** Records every `handleCommand` call so a test can assert which git_command reached the bridge. */
  class FakeGitBridge implements GitUiBridge {
    readonly handled: { requestId: string; command: { op: string } }[] = [];

    handleCommand(message: { requestId: string; command: { op: string } }): void {
      this.handled.push(message);
    }

    refreshAfterTurn(): void {
      // Unused by these tests.
    }

    pushSnapshot(): void {
      // Unused by these tests.
    }
  }

  /** A non-core external-engine shape (mirrors the "engine shutdown seam" fakes above): `supportsGitMutations: false` throughout, deliberately, so a test proves it does NOT gate the shell's own git_command routing. */
  function buildFakeEngine(overrides: Partial<SessionEngine> = {}): SessionEngine {
    return {
      id: "codex",
      capabilities: {
        supportsCorePermissions: false,
        supportsRewind: false,
        supportsWorkflow: false,
        supportsGitMutations: false,
        supportsContextUsage: false,
        supportsContextBreakdown: false,
        supportsInteractiveApprovals: false,
        costAccounting: false,
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsImages: false,
        supportsTasks: false,
        supportsFileSnapshots: false,
      },
      mode: () => "build",
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      async *runTurn(): AsyncIterable<AgentEvent> {},
      historyItems: () => [],
      dispose: async () => {},
      ...overrides,
    };
  }

  function buildTestSession(opts: {
    engine?: SessionEngine;
    shell?: ShellCapabilitiesProjection;
    git?: GitUiBridge;
    continuationPending?: boolean;
    onContinuationReady?: () => Promise<void>;
    projectRoot?: string;
    workspace?: string;
    worktree?: { id: string; path: string; branch: string; baseRef: string; ownedByAnyCode: boolean };
    worktreeControl?: SessionOptions["worktreeControl"];
    onWorkspaceTransition?: SessionOptions["onWorkspaceTransition"];
    /** TASK.144: an explicit store so a test can assert what a remembered allow appended to it. */
    rules?: SessionPermissionRules;
    /** TASK.145 срез 3: see SessionOptions.backgroundChildren's own doc. */
    backgroundChildren?: SessionOptions["backgroundChildren"];
  }): { port: FakeWirePort; session: Session; broker: IpcPermissionBroker } {
    const outbound = new Outbound();
    const broker = new IpcPermissionBroker((message) => outbound.emit(message));
    const session = new Session({
      outbound,
      engine: opts.engine ?? buildFakeEngine(),
      broker,
      ...(opts.backgroundChildren !== undefined ? { backgroundChildren: opts.backgroundChildren } : {}),
      fs: new MemFs(),
      workspace: opts.workspace ?? "/workspace",
      model: "m1",
      sessionId: "s1",
      ...(opts.continuationPending !== undefined ? { continuationPending: opts.continuationPending } : {}),
      ...(opts.onContinuationReady !== undefined ? { onContinuationReady: opts.onContinuationReady } : {}),
      ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
      ...(opts.worktree !== undefined ? { worktree: opts.worktree } : {}),
      ...(opts.worktreeControl !== undefined ? { worktreeControl: opts.worktreeControl } : {}),
      ...(opts.onWorkspaceTransition !== undefined ? { onWorkspaceTransition: opts.onWorkspaceTransition } : {}),
      rules: opts.rules ?? new SessionPermissionRules(),
      ...(opts.git !== undefined ? { git: opts.git } : {}),
      ...(opts.shell !== undefined ? { shell: opts.shell } : {}),
    });
    const port = new FakeWirePort();
    session.bindPort(port);
    return { port, session, broker };
  }

  /**
   * TASK.144. `maybeRemember` used to be gated on `supportsCorePermissions`,
   * which is false for both foreign engines — so "Always allow" in a Codex or
   * Claude session wrote nothing anywhere. It is now gated only by reaching the
   * `permission_response` case at all (i.e. by `supportsInteractiveApprovals`),
   * because an engine session's store IS read back: host/index.ts hands the same
   * instance to the IpcPermissionBroker.
   */
  it("a remembered allow appends a rule even though the engine has no core permission engine", async () => {
    const rules = new SessionPermissionRules();
    const { port, broker } = buildTestSession({
      rules,
      engine: buildFakeEngine({
        capabilities: { ...buildFakeEngine().capabilities, supportsInteractiveApprovals: true },
      }),
    });
    port.send({ type: "ui_ready" });

    // Exactly what an approval bridge does: straight to the broker, no core
    // permission engine anywhere in the path.
    const decision = broker.requestPermission({
      toolName: "Bash",
      input: { command: "git status" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    const requestId = permissionRequestId(port);

    port.send({
      type: "permission_response",
      requestId,
      behavior: "allow",
      remember: { pattern: "git *" },
    });
    await expect(decision).resolves.toMatchObject({ behavior: "allow" });
    expect(rules.list()).toEqual([{ toolName: "Bash", pattern: "git *" }]);
  });

  it("a remembered allow is still a no-op for an engine that cannot answer approvals at all", async () => {
    const rules = new SessionPermissionRules();
    const { port, broker } = buildTestSession({ rules });
    port.send({ type: "ui_ready" });
    const decision = broker.requestPermission({
      toolName: "Bash",
      input: { command: "git status" },
      metadata: bashTool.metadata,
      mode: "build",
    });
    const requestId = permissionRequestId(port);

    port.send({
      type: "permission_response",
      requestId,
      behavior: "allow",
      remember: { pattern: "git *" },
    });
    expect(rules.list()).toEqual([]);
    broker.denyAll("test teardown", "shutdown");
    await expect(decision).resolves.toMatchObject({ behavior: "deny" });
  });

  /**
   * TASK.145 срезы 2+3 (§4bis п.2/§4ter): a `user_message` normally proves a
   * human is at the keyboard and disarms the TASK.138 unattended latch
   * (route()'s `case "user_message"`). `origin:"system"` — set on a
   * background child's report auto-drained through the renderer's own prompt
   * queue (TASK.145 срез 1) — must NOT count: it is a system-originated
   * wake-up, not evidence anyone is watching. The same field срез 2 uses to
   * pick the transcript's system-card rendering is the one read here; the two
   * slices' independent additions were merged onto it.
   */
  describe("user_message.origin and the TASK.138 unattended latch", () => {
    /**
     * A Session wired to a CALLER-supplied broker (buildTestSession always
     * constructs its own, so this test needs its own minimal harness to arm
     * the latch on the broker instance the session actually uses).
     */
    function buildSessionOnBroker(broker: IpcPermissionBroker): { port: FakeWirePort } {
      const session = new Session({
        outbound: new Outbound(),
        engine: buildFakeEngine(),
        broker,
        fs: new MemFs(),
        workspace: "/workspace",
        model: "m1",
        sessionId: "s-system-origin",
        rules: new SessionPermissionRules(),
      });
      const port = new FakeWirePort();
      session.bindPort(port);
      port.send({ type: "ui_ready" });
      return { port };
    }

    /** Arms the broker's unattended latch the same way TASK.138's own suite does: one unanswered ask times out. */
    async function armUnattendedLatch(broker: IpcPermissionBroker): Promise<void> {
      const pending = broker.requestPermission({
        toolName: "Bash",
        input: { command: "git status" },
        metadata: bashTool.metadata,
        mode: "build",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ behavior: "deny" });
      expect(broker.isUnattended).toBe(true);
    }

    it("an ORDINARY user_message (no origin) still disarms the latch, unchanged", async () => {
      vi.useFakeTimers();
      try {
        const broker = new IpcPermissionBroker(() => {}, 1_000);
        const { port } = buildSessionOnBroker(broker);

        await armUnattendedLatch(broker);

        port.send({ type: "user_message", requestId: "r1", text: "hello" });
        expect(broker.isUnattended).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a SYSTEM-ORIGIN user_message (child_report auto-drain) does NOT disarm the latch", async () => {
      vi.useFakeTimers();
      try {
        const broker = new IpcPermissionBroker(() => {}, 1_000);
        const { port } = buildSessionOnBroker(broker);

        await armUnattendedLatch(broker);

        port.send({ type: "user_message", requestId: "r1", text: "<task-notification>...</task-notification>", origin: "system" });
        expect(broker.isUnattended).toBe(true);

        // A REAL follow-up message from the human still disarms it normally —
        // origin:"system" only withholds disarming for the message it is set on.
        port.send({ type: "user_message", requestId: "r2", text: "ok thanks" });
        expect(broker.isUnattended).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * TASK.145 срез 3 §2/§3: the `backgroundChildren` seam wiring — a pure host
   * unit-test surface, deliberately NOT exercised through a real
   * ChildSessionPort (that registry logic is child-session-port.test.ts's
   * job); here a fake seam proves session.ts's OWN plumbing: ui_ready push,
   * on-demand pull, cancel request/ack, live-push-on-change, and the explicit
   * shutdown sweep (§3).
   */
  describe("backgroundChildren seam (TASK.145 срез 3 §2/§3)", () => {
    function fakeBackgroundChildren(initial: WireBackgroundChild[] = []) {
      let children = initial;
      let changeListener: (() => void) | undefined;
      const cancelCalls: string[] = [];
      return {
        seam: {
          list: () => children,
          cancel: (childSessionId: string) => {
            cancelCalls.push(childSessionId);
            const before = children.length;
            children = children.filter((c) => c.childSessionId !== childSessionId);
            return children.length < before;
          },
          cancelAll: vi.fn(() => {
            children = [];
          }),
          onChange: (listener: () => void) => {
            changeListener = listener;
            return () => {
              if (changeListener === listener) changeListener = undefined;
            };
          },
        },
        setChildren: (next: WireBackgroundChild[]) => {
          children = next;
          changeListener?.();
        },
        cancelCalls,
      };
    }

    function backgroundChildrenMessages(port: FakeWirePort): Array<HostToUiMessage & { type: "background_children" }> {
      return port.received.filter(
        (m): m is HostToUiMessage & { type: "background_children" } =>
          typeof m === "object" && m !== null && (m as { type?: unknown }).type === "background_children",
      );
    }

    const CHILD_A: WireBackgroundChild = {
      childSessionId: "child-a",
      agentType: "explore",
      description: "sweep the repo",
      startedAt: 1_000,
    };

    it("pushes the current list (possibly empty) on ui_ready, mirroring pushTaskList/pushHooksList", () => {
      const { seam } = fakeBackgroundChildren([CHILD_A]);
      const { port } = buildTestSession({ backgroundChildren: seam });
      port.send({ type: "ui_ready" });

      const pushes = backgroundChildrenMessages(port);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]!.children).toEqual([CHILD_A]);
    });

    it("an absent seam pushes an empty list on ui_ready (legacy/claude/codex boot — no crash, no undefined)", () => {
      const { port } = buildTestSession({});
      port.send({ type: "ui_ready" });

      const pushes = backgroundChildrenMessages(port);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]!.children).toEqual([]);
    });

    it("background_children_request re-pushes the CURRENT list on demand, even after ui_ready's own push", () => {
      const { seam, setChildren } = fakeBackgroundChildren([CHILD_A]);
      const { port } = buildTestSession({ backgroundChildren: seam });
      port.send({ type: "ui_ready" });
      // setChildren also fires onChange (a live push) — this test's own
      // concern is the EXPLICIT pull below, not the live-push count (that is
      // its own test further down).
      setChildren([]);

      port.send({ type: "background_children_request" });
      const pushes = backgroundChildrenMessages(port);
      expect(pushes.at(-1)!.children).toEqual([]);
      expect(pushes.length).toBeGreaterThanOrEqual(2);
    });

    it("background_child_cancel_request calls seam.cancel with the id, acks ok:true, and re-pushes the updated list", () => {
      const { seam, cancelCalls } = fakeBackgroundChildren([CHILD_A]);
      const { port } = buildTestSession({ backgroundChildren: seam });
      port.send({ type: "ui_ready" });

      port.send({ type: "background_child_cancel_request", requestId: "cr1", childSessionId: "child-a" });

      expect(cancelCalls).toEqual(["child-a"]);
      const ack = port.received.find(
        (m): m is HostToUiMessage & { type: "background_child_cancel_result" } =>
          typeof m === "object" && m !== null && (m as { type?: unknown }).type === "background_child_cancel_result",
      );
      expect(ack).toMatchObject({ requestId: "cr1", ok: true });
      expect(backgroundChildrenMessages(port).at(-1)!.children).toEqual([]);
    });

    it("background_child_cancel_request on an unknown id acks ok:false with a non-merits reason", () => {
      const { seam } = fakeBackgroundChildren([]);
      const { port } = buildTestSession({ backgroundChildren: seam });
      port.send({ type: "ui_ready" });

      port.send({ type: "background_child_cancel_request", requestId: "cr1", childSessionId: "no-such-child" });

      const ack = port.received.find(
        (m): m is HostToUiMessage & { type: "background_child_cancel_result" } =>
          typeof m === "object" && m !== null && (m as { type?: unknown }).type === "background_child_cancel_result",
      );
      expect(ack).toMatchObject({ requestId: "cr1", ok: false });
      expect((ack as { reason?: string }).reason).toContain("no such background child");
    });

    it("seam.onChange live-pushes an updated snapshot to an already-ui_ready renderer (mirror of lsp.onStatusChange)", () => {
      const { seam, setChildren } = fakeBackgroundChildren([]);
      const { port } = buildTestSession({ backgroundChildren: seam });
      port.send({ type: "ui_ready" });
      expect(backgroundChildrenMessages(port)).toHaveLength(1);

      setChildren([CHILD_A]);

      const pushes = backgroundChildrenMessages(port);
      expect(pushes).toHaveLength(2);
      expect(pushes[1]!.children).toEqual([CHILD_A]);
    });

    it("a change BEFORE ui_ready does not push (mirrors the LSP subscription's uiReady gate — no push-before-mount)", () => {
      const { seam, setChildren } = fakeBackgroundChildren([]);
      const { port } = buildTestSession({ backgroundChildren: seam });
      setChildren([CHILD_A]); // no ui_ready yet
      expect(backgroundChildrenMessages(port)).toHaveLength(0);

      port.send({ type: "ui_ready" });
      expect(backgroundChildrenMessages(port)).toHaveLength(1);
    });

    it("TASK.145 срез 3 §3: session shutdown explicitly calls seam.cancelAll (not a side effect of aborting the turn)", async () => {
      const { seam } = fakeBackgroundChildren([CHILD_A]);
      const { session } = buildTestSession({ backgroundChildren: seam });

      await session.shutdown();

      expect(seam.cancelAll).toHaveBeenCalledTimes(1);
    });
  });

  it("never emits host_ready.shell for a core-shaped engine (id \"core\"), even if the host mistakenly supplied one — core wire stays byte-identical", () => {
    const { port } = buildTestSession({
      engine: buildFakeEngine({ id: "core" }),
      shell: { gitReadOnly: true, gitUserMutations: true, terminal: true },
    });
    port.send({ type: "ui_ready" });
    const hostReady = port.hostReady();
    expect(hostReady?.engine).toBeUndefined();
    expect(hostReady?.shell).toBeUndefined();
  });

  it("emits host_ready.shell verbatim for a non-core engine when the host supplied one", () => {
    const shell: ShellCapabilitiesProjection = { gitReadOnly: true, gitUserMutations: false, terminal: true };
    const { port } = buildTestSession({ shell });
    port.send({ type: "ui_ready" });
    const hostReady = port.hostReady();
    expect(hostReady?.engine).toBeDefined();
    expect(hostReady?.shell).toEqual(shell);
  });

  it("omits host_ready.shell for a non-core engine when the host supplied none — renderer treats absence as every shell feature enabled", () => {
    const { port } = buildTestSession({});
    port.send({ type: "ui_ready" });
    const hostReady = port.hostReady();
    expect(hostReady?.engine).toBeDefined();
    expect(hostReady?.shell).toBeUndefined();
  });

  it("restores worktree identity before continuing without a synthetic user turn", async () => {
    const order: string[] = [];
    let ordinaryRuns = 0;
    let continuationRuns = 0;
    const engine = buildFakeEngine({
      async *runTurn(): AsyncIterable<AgentEvent> {
        ordinaryRuns += 1;
      },
      async *continueTurn(): AsyncIterable<AgentEvent> {
        continuationRuns += 1;
        order.push("continue");
        yield { type: "loop_end", reason: "completed", turns: 1 };
      },
    });
    const worktree = {
      id: "task-5",
      path: "/repo/.anycode/worktrees/task-5",
      branch: "anycode-wt/task-5",
      baseRef: "HEAD",
      ownedByAnyCode: true,
    };
    const { port } = buildTestSession({
      engine,
      continuationPending: true,
      projectRoot: "/repo",
      workspace: worktree.path,
      worktree,
      onContinuationReady: async () => {
        order.push("ready");
      },
    });
    port.send({ type: "ui_ready" });
    await vi.waitFor(() => expect(continuationRuns).toBe(1));
    expect(port.hostReady()).toMatchObject({
      workspace: worktree.path,
      projectRoot: "/repo",
      worktree,
    });
    expect(order).toEqual(["ready", "continue"]);
    expect(ordinaryRuns).toBe(0);
  });

  it("(Q1-a, TASK.102 CUT-S2 §10.12.1) ui_ready arriving after shutdown() has already resolved never starts the pending continuation on the disposed engine", async () => {
    let continuationRuns = 0;
    const engine = buildFakeEngine({
      async *continueTurn(): AsyncIterable<AgentEvent> {
        continuationRuns += 1;
        yield { type: "loop_end", reason: "completed", turns: 1 };
      },
    });
    const { port, session } = buildTestSession({ engine, continuationPending: true });
    // shutdown() resolves immediately here — nothing is busy and nothing is
    // parked, so the reentrant currentTurn wait exits on its first check.
    await session.shutdown();
    port.send({ type: "ui_ready" });
    // Discriminator (pre-fix): route()'s ui_ready case has no shuttingDown
    // check of its own — it unconditionally assigns
    // `this.currentTurn = this.startContinuation()...`, which emits
    // host_ready/turn_started and calls the (disposed) engine's continueTurn.
    expect(port.hostReady()).toBeUndefined();
    expect(port.received.some((m) => (m as { type?: unknown }).type === "turn_started")).toBe(false);
    expect(continuationRuns).toBe(0);
    expect((session as unknown as { currentTurn: Promise<void> | null }).currentTurn).toBeNull();
  });

  it("permanently rejects new turns in the source host after transition handoff", async () => {
    let runs = 0;
    const transition = {
      kind: "enter_worktree" as const,
      projectRoot: "/repo",
      fromWorkspace: "/repo",
      toWorkspace: "/repo/.anycode/worktrees/task-5",
      worktree: {
        id: "task-5",
        path: "/repo/.anycode/worktrees/task-5",
        branch: "anycode-wt/task-5",
        baseRef: "HEAD",
        ownedByAnyCode: true,
      },
    };
    const engine = buildFakeEngine({
      async *runTurn(): AsyncIterable<AgentEvent> {
        runs += 1;
        yield { type: "workspace_transition", transition };
        yield { type: "loop_end", reason: "workspace_transition", turns: 1 };
      },
    });
    const { port } = buildTestSession({ engine, onWorkspaceTransition: async () => {} });
    port.send({ type: "ui_ready" });
    port.send({ type: "user_message", requestId: "first", text: "enter" });
    await vi.waitFor(() => expect(runs).toBe(1));
    await vi.waitFor(() => expect(port.received).toContainEqual({
      type: "agent_event",
      turnId: expect.any(String),
      event: { type: "loop_end", reason: "workspace_transition", turns: 1 },
    }));
    port.send({ type: "user_message", requestId: "second", text: "must not run" });
    await vi.waitFor(() => expect(port.received).toContainEqual({
      type: "turn_rejected",
      requestId: "second",
      reason: "not_ready",
    }));
    expect(runs).toBe(1);
  });

  it("reports a non-fatal notice when Exit Worktree arrives during a running turn", async () => {
    let markStarted!: () => void;
    let releaseTurn!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const engine = buildFakeEngine({
      async *runTurn(): AsyncIterable<AgentEvent> {
        markStarted();
        await turnGate;
        yield { type: "loop_end", reason: "completed", turns: 1 };
      },
    });
    const exit = vi.fn(async () => ({ ok: false as const, error: "must not run" }));
    const { port } = buildTestSession({
      engine,
      worktreeControl: { enter: vi.fn(), exit },
    });
    port.send({ type: "ui_ready" });
    port.send({ type: "user_message", requestId: "turn", text: "work" });
    await started;

    port.send({ type: "exit_worktree", cleanup: "auto" });

    await vi.waitFor(() => expect(port.received).toContainEqual({
      type: "worktree_notice",
      message: "Cannot exit the worktree while the session is busy.",
    }));
    expect(exit).not.toHaveBeenCalled();
    expect(port.received).not.toContainEqual(expect.objectContaining({ type: "fatal" }));
    releaseTurn();
  });

  it("reports a non-fatal notice when worktree exit is unavailable", () => {
    const { port } = buildTestSession({});
    port.send({ type: "ui_ready" });

    port.send({ type: "exit_worktree", cleanup: "auto" });

    expect(port.received).toContainEqual({
      type: "worktree_notice",
      message: "Worktree exit is unavailable for this session.",
    });
    expect(port.received).not.toContainEqual(expect.objectContaining({ type: "fatal" }));
  });

  it("reports a non-fatal notice instead of starting a second relocation", async () => {
    let markHandoffStarted!: () => void;
    let releaseHandoff!: () => void;
    const handoffStarted = new Promise<void>((resolve) => { markHandoffStarted = resolve; });
    const handoffGate = new Promise<void>((resolve) => { releaseHandoff = resolve; });
    const transition = {
      kind: "exit_worktree" as const,
      projectRoot: "/repo",
      fromWorkspace: "/repo/.anycode/worktrees/task-5",
      toWorkspace: "/repo",
      worktree: {
        id: "task-5",
        path: "/repo/.anycode/worktrees/task-5",
        branch: "anycode-wt/task-5",
        baseRef: "HEAD",
        ownedByAnyCode: true,
      },
      cleanup: "auto" as const,
    };
    const exit = vi.fn(async () => ({ ok: true as const, transition }));
    const { port } = buildTestSession({
      worktreeControl: { enter: vi.fn(), exit },
      onWorkspaceTransition: async () => {
        markHandoffStarted();
        await handoffGate;
      },
    });
    port.send({ type: "ui_ready" });
    port.send({ type: "exit_worktree", cleanup: "auto" });
    await handoffStarted;

    port.send({ type: "exit_worktree", cleanup: "auto" });

    await vi.waitFor(() => expect(port.received).toContainEqual({
      type: "worktree_notice",
      message: "A workspace transition is already in progress.",
    }));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(port.received).not.toContainEqual(expect.objectContaining({ type: "fatal" }));
    releaseHandoff();
  });

  it("routes a git MUTATION through shell.gitUserMutations, ignoring engine.capabilities.supportsGitMutations entirely (agent-owned vs shell-owned split)", () => {
    const git = new FakeGitBridge();
    const { port } = buildTestSession({
      // supportsGitMutations: false throughout buildFakeEngine() — proves it is NOT consulted.
      shell: { gitReadOnly: true, gitUserMutations: true, terminal: true },
      git,
    });
    port.send({ type: "ui_ready" });
    port.send({ type: "git_command", requestId: "r1", command: { op: "stage_all" } });
    expect(git.handled).toHaveLength(1);
    expect(git.handled[0]?.requestId).toBe("r1");
  });

  it("refuses a git MUTATION when shell.gitUserMutations is false, while a read-only op still routes through", () => {
    const git = new FakeGitBridge();
    const { port } = buildTestSession({
      shell: { gitReadOnly: true, gitUserMutations: false, terminal: true },
      git,
    });
    port.send({ type: "ui_ready" });
    port.send({ type: "git_command", requestId: "r1", command: { op: "stage_all" } });
    port.send({ type: "git_command", requestId: "r2", command: { op: "refresh" } });
    expect(git.handled).toHaveLength(1);
    expect(git.handled[0]?.requestId).toBe("r2");
  });

  it("defaults gitUserMutations to true when shell is absent — byte-identical to the pre-TASK.40 unconditional-for-core routing", () => {
    const git = new FakeGitBridge();
    const { port } = buildTestSession({ git }); // no shell option at all
    port.send({ type: "ui_ready" });
    port.send({ type: "git_command", requestId: "r1", command: { op: "stage_all" } });
    expect(git.handled).toHaveLength(1);
  });

  it("(mutational discriminator, TASK.102 CUT-S2 §10.14.3 BLOCKER-2) once relocating is true (the post-handoff workspace-transition window), rewind is refused and a git MUTATION never reaches the bridge, while a read-only git op still does", () => {
    const git = new FakeGitBridge();
    const { port, session } = buildTestSession({
      shell: { gitReadOnly: true, gitUserMutations: true, terminal: true },
      git,
    });
    port.send({ type: "ui_ready" });
    // Discriminator (pre-fix): onRewind and the git_command mutation branch
    // only ever checked `this.busy`/`shell.gitUserMutations` — neither
    // observed `relocating`, so all three sends below were admitted against a
    // workspace main is already tearing down via `git worktree remove`.
    (session as unknown as { relocating: boolean }).relocating = true;
    port.send({ type: "rewind_request", requestId: "rw1", checkpointId: "cp-1", scope: "both" });
    port.send({ type: "git_command", requestId: "g1", command: { op: "stage_all" } });
    port.send({ type: "git_command", requestId: "g2", command: { op: "refresh" } });

    expect(port.received).toContainEqual({
      type: "rewind_result",
      requestId: "rw1",
      ok: false,
      reason: "workspace transition in progress",
      conversationRestored: false,
      restoredPaths: null,
    });
    expect(git.handled).toHaveLength(1);
    expect(git.handled[0]?.requestId).toBe("g2");
  });
});

describe("Session — permission allow + snapshots", () => {
  it("allow runs the tool and emits before/after file snapshots", async () => {
    const toolFs = new MemFs();
    const h = createHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()], toolFs });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write it" });

      const before = await h.waitFor(snapshotPhase("before"));
      expect(before).toMatchObject({ path: "/workspace/a.txt", content: "", truncated: false });

      const req = await h.waitFor(isPermissionRequest);
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });

      const settled = await h.waitFor(isPermissionSettled);
      expect(settled).toMatchObject({ behavior: "allow", origin: "ui" });

      const after = await h.waitFor(snapshotPhase("after"));
      expect(after).toMatchObject({ path: "/workspace/a.txt", content: "NEW", truncated: false });

      const result = await h.waitFor(agentEventOf("tool_result"));
      if (result.event.type === "tool_result") {
        expect(result.event.outcome.status).toBe("success");
      }
      expect(toolFs.files.get("/workspace/a.txt")).toBe("NEW");
    } finally {
      h.close();
    }
  });
});

describe("Session — snapshot observer is fail-closed", () => {
  it("a throwing snapshot fs never denies the dispatch (Write still succeeds)", async () => {
    const toolFs = new MemFs();
    const h = createHarness({
      steps: [toolStep("c1", "Write", { file_path: "/workspace/b.txt", content: "OK" }), finishStep()],
      toolFs,
      snapshotFs: new ThrowingFs(),
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write it" });

      // Reaching the permission gate proves the throwing hook did not deny.
      const req = await h.waitFor(isPermissionRequest);
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });

      const result = await h.waitFor(agentEventOf("tool_result"));
      if (result.event.type === "tool_result") {
        expect(result.event.outcome.status).toBe("success");
      }

      await h.flush();
      expect(h.received.some(snapshotPhase("before"))).toBe(false);
      expect(toolFs.files.get("/workspace/b.txt")).toBe("OK");
    } finally {
      h.close();
    }
  });
});

describe("Session — disconnect", () => {
  it("closing the UI port force-denies parked asks (disconnect)", async () => {
    const h = createHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()] });
    const denySpy = vi.spyOn(h.broker, "denyAll");
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write it" });
      await h.waitFor(isPermissionRequest);

      h.close();
      await h.flush();
      await h.flush();

      expect(denySpy).toHaveBeenCalledWith("ui disconnected", "disconnect");
    } finally {
      h.close();
    }
  });
});

describe("Session — replay", () => {
  it("replays the buffered transcript on a repeat ui_ready", async () => {
    const h = createHarness({ steps: [textStep("hey"), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "hi" });
      await h.waitFor(agentEventOf("loop_end"));
      await h.flush();

      const beforeReplay = h.received.length;
      const firstAgentTypes = h.received
        .filter((m): m is Of<"agent_event"> => m.type === "agent_event")
        .map((e) => e.event.type);

      // host_ready is NOT buffered (regenerated per connect); everything else is.
      h.send({ type: "ui_ready" });
      await h.waitUntil(
        () =>
          h.received
            .slice(beforeReplay)
            .filter((m): m is Of<"agent_event"> => m.type === "agent_event").length >= firstAgentTypes.length,
      );

      const replayed = h.received.slice(beforeReplay);
      expect(replayed[0]?.type).toBe("host_ready");
      expect(replayed.some(isTurnStarted)).toBe(true);
      const replayedAgentTypes = replayed
        .filter((m): m is Of<"agent_event"> => m.type === "agent_event")
        .map((e) => e.event.type);
      expect(replayedAgentTypes).toEqual(firstAgentTypes);
    } finally {
      h.close();
    }
  });
});

describe("Session — mode changes", () => {
  it("changes reasoning effort between turns and reports it on the next handshake", async () => {
    const h = createHarness({ steps: [textStep("x"), finishStep()], availableEffortLevels: ["off", "high", "max"] });
    try {
      h.send({ type: "ui_ready" });
      const firstReady = await h.waitFor(isHostReady);
      expect(firstReady.availableEffortLevels).toEqual(["off", "high", "max"]);
      h.send({ type: "set_reasoning_effort", effort: "max" });
      const changed = await h.waitFor((m): m is Of<"reasoning_effort_changed"> => m.type === "reasoning_effort_changed");
      expect(changed.availableEffortLevels).toEqual(["off", "high", "max"]);
      expect(h.config.reasoningEffort).toBe("max");
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.filter(isHostReady).length === 2);
      expect(h.received.filter(isHostReady).at(-1)?.reasoningEffort).toBe("max");
      expect(h.received.filter(isHostReady).at(-1)?.availableEffortLevels).toEqual(["off", "high", "max"]);
    } finally {
      h.close();
    }
  });

  it("changes mode between turns", async () => {
    const h = createHarness({ steps: [textStep("x"), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "set_mode", mode: "plan" });
      const changed = await h.waitFor(isModeChanged);
      expect(changed.mode).toBe("plan");
      expect(h.config.mode).toBe("plan");
    } finally {
      h.close();
    }
  });

  // MS1-MS3 (TASK.37): mid-turn set_mode is now accepted; the old busy-reject
  // test above (D-S3-11) is gone. MS4 is not new code — the between-turns
  // test above and the non-core rejection test (below, in the "engine
  // shutdown seam" describe) stay green byte-identical and are listed in
  // CUT-S3.md §6b so the reviewer knows they were considered.

  it("MS1: mid-turn set_mode is accepted and persisted; an already-open ask is honored under its snapshotted mode", async () => {
    const h = createHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write it" });
      const req = await h.waitFor(isPermissionRequest);
      expect(req.mode).toBe("build");

      h.send({ type: "set_mode", mode: "yolo" });
      const changed = await h.waitFor(isModeChanged);
      expect(changed.mode).toBe("yolo");
      expect(h.config.mode).toBe("yolo");
      expect(h.touches).toContainEqual({ mode: "yolo" });

      // The EXPLICIT answer rules, not the new yolo mode (DV-1).
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });
      const result = await h.waitFor(agentEventOf("tool_result"));
      if (result.event.type === "tool_result") {
        expect(result.event.outcome.status).toBe("denied");
      }
      await h.waitFor(agentEventOf("loop_end"));
    } finally {
      h.close();
    }
  });

  it("MS2: multi-tool turn — tool 1 asks under the old mode, tool 2 is allowed under the new mode without asking", async () => {
    const h = createHarness({
      steps: [toolStep("c1", "Write", WRITE_INPUT), toolStep("c2", "Write", WRITE_INPUT), finishStep()],
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write twice" });
      const req = await h.waitFor(isPermissionRequest);
      expect(req.mode).toBe("build");

      h.send({ type: "set_mode", mode: "yolo" });
      await h.waitFor(isModeChanged);

      h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
      const c1Result = await h.waitFor(
        (m): m is Of<"agent_event"> =>
          m.type === "agent_event" && m.event.type === "tool_result" && m.event.outcome.toolCallId === "c1",
      );
      if (c1Result.event.type === "tool_result") {
        expect(c1Result.event.outcome.status).toBe("success");
      }

      const c2Result = await h.waitFor(
        (m): m is Of<"agent_event"> =>
          m.type === "agent_event" && m.event.type === "tool_result" && m.event.outcome.toolCallId === "c2",
      );
      if (c2Result.event.type === "tool_result") {
        expect(c2Result.event.outcome.status).toBe("success");
      }

      // c2 never asked: exactly one permission_request across the whole turn.
      expect(h.received.filter(isPermissionRequest).length).toBe(1);
      // One uninterrupted turn (single turn_started).
      expect(h.received.filter(isTurnStarted).length).toBe(1);
      await h.waitFor(agentEventOf("loop_end"));
    } finally {
      h.close();
    }
  });

  it("MS3: switching into plan mid-turn denies the next tool without a modal; the transcript stays uninterrupted", async () => {
    const h = createHarness({
      steps: [toolStep("c1", "Write", WRITE_INPUT), toolStep("c2", "Write", WRITE_INPUT), finishStep()],
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write twice" });
      const req = await h.waitFor(isPermissionRequest);
      expect(req.mode).toBe("build");

      h.send({ type: "set_mode", mode: "plan" });
      await h.waitFor(isModeChanged);
      expect(h.touches).toContainEqual({ mode: "plan" });

      // The explicit answer under the OLD (snapshotted) mode still executes.
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
      const c1Result = await h.waitFor(
        (m): m is Of<"agent_event"> =>
          m.type === "agent_event" && m.event.type === "tool_result" && m.event.outcome.toolCallId === "c1",
      );
      if (c1Result.event.type === "tool_result") {
        expect(c1Result.event.outcome.status).toBe("success");
      }

      // c2 is denied without ever reaching the broker (no second permission_request).
      const c2Result = await h.waitFor(
        (m): m is Of<"agent_event"> =>
          m.type === "agent_event" && m.event.type === "tool_result" && m.event.outcome.toolCallId === "c2",
      );
      if (c2Result.event.type === "tool_result") {
        expect(c2Result.event.outcome.status).toBe("denied");
        expect(c2Result.event.outcome.modelText).toContain("plan");
      }

      expect(h.received.filter(isPermissionRequest).length).toBe(1);
      const loopEnd = await h.waitFor(agentEventOf("loop_end"));
      expect(loopEnd.event).toMatchObject({ type: "loop_end", reason: "completed" });
    } finally {
      h.close();
    }
  });
});

describe("Session — always-allow (slice 2.2.3, design §5)", () => {
  it("a rule pre-seeded before boot (mirrors host/boot.ts's seedAlwaysAllowRules) auto-allows a matching tool from the very first turn", async () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Write" });
    const h = createHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()], rules });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write it" });

      const result = await h.waitFor(agentEventOf("tool_result"));
      if (result.event.type === "tool_result") {
        expect(result.event.outcome.status).toBe("success");
      }
      // No ask was ever needed: the boot-seeded rule escalated ask -> allow
      // before the dispatcher's ruling ever reached the broker.
      expect(h.received.some(isPermissionRequest)).toBe(false);
    } finally {
      h.close();
    }
  });

  it("remember on an allow adds a session rule; a subsequent matching call in the same session auto-allows without another ask", async () => {
    const h = createHarness({
      steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep(), toolStep("c2", "Write", WRITE_INPUT), finishStep()],
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write it" });
      const req = await h.waitFor(isPermissionRequest);
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow", remember: {} });

      // permission_settled must still fire normally — remember does not
      // short-circuit the ordinary allow round-trip for THIS call.
      const settled = await h.waitFor(isPermissionSettled);
      expect(settled).toMatchObject({ behavior: "allow", origin: "ui" });
      await h.waitFor(agentEventOf("loop_end"));

      expect(h.rules.list()).toEqual([{ toolName: "Write" }]);

      const requestsSoFar = h.received.filter(isPermissionRequest).length;

      h.send({ type: "user_message", requestId: "r2", text: "write it again" });
      const secondResult = await h.waitFor(
        (m): m is Of<"agent_event"> =>
          m.type === "agent_event" && m.event.type === "tool_result" && m.event.outcome.toolCallId === "c2",
      );
      if (secondResult.event.type === "tool_result") {
        expect(secondResult.event.outcome.status).toBe("success");
      }
      // No NEW permission_request was sent for the second (rule-matching) call.
      expect(h.received.filter(isPermissionRequest).length).toBe(requestsSoFar);
    } finally {
      h.close();
    }
  });

  it("remember with a Bash pattern scopes the rule: a non-matching command still asks", async () => {
    const h = createHarness({
      steps: [
        toolStep("c1", "Bash", { command: "git status" }),
        finishStep(),
        toolStep("c2", "Bash", { command: "rm -rf /" }),
        finishStep(),
      ],
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "check status" });
      const first = await h.waitFor(isPermissionRequest);
      h.send({
        type: "permission_response",
        requestId: first.requestId,
        behavior: "allow",
        remember: { pattern: "git *" },
      });
      await h.waitFor(agentEventOf("loop_end"));
      expect(h.rules.list()).toEqual([{ toolName: "Bash", pattern: "git *" }]);

      h.send({ type: "user_message", requestId: "r2", text: "clean everything" });
      // "rm -rf /" does not match "git *" -> the dispatcher still asks. Match on
      // a requestId distinct from the first ask (waitFor resolves against any
      // ALREADY-received message first, and the first permission_request is
      // still sitting in `received` from turn 1).
      const second = await h.waitFor(
        (m): m is Of<"permission_request"> => m.type === "permission_request" && m.requestId !== first.requestId,
      );
      expect(second.toolName).toBe("Bash");
      h.send({ type: "permission_response", requestId: second.requestId, behavior: "deny" });
      await h.waitFor(agentEventOf("loop_end"));
    } finally {
      h.close();
    }
  });
});

describe("Session — always-allow never overrides a deny (fail-closed invariant, design §5/ruling §3)", () => {
  it("a plan-mode denial is not overridden by a matching pre-seeded always-allow rule", async () => {
    const rules = new SessionPermissionRules();
    rules.add({ toolName: "Write" }); // would auto-allow in build/edit/auto — must NOT in plan.
    const h = createHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()], mode: "plan", rules });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write it" });

      const result = await h.waitFor(agentEventOf("tool_result"));
      if (result.event.type === "tool_result") {
        expect(result.event.outcome.status).toBe("denied");
      }
      // plan mode's base ruling for a non-readOnly tool is "deny" directly
      // (never "ask") — RuleAwarePermissionEngine only ever escalates "ask" to
      // "allow", so a "deny" ruling passes through untouched regardless of any
      // stored rule, and the broker/UI is never even consulted.
      expect(h.received.some(isPermissionRequest)).toBe(false);
    } finally {
      h.close();
    }
  });

  it("remember on a deny response is a no-op: no rule is added and the tool stays denied", async () => {
    const h = createHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write it" });
      const req = await h.waitFor(isPermissionRequest);
      // A malformed/hostile client sending `remember` alongside a deny must not
      // create an "always allow" rule out of a denial.
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny", remember: { pattern: "*" } });

      const settled = await h.waitFor(isPermissionSettled);
      expect(settled).toMatchObject({ behavior: "deny" });
      await h.waitFor(agentEventOf("loop_end"));

      expect(h.rules.list()).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("Session — background-task notice injection (design slice-6.DP-2-cut.md §1.3/§6#8)", () => {
  it("injects exactly one <system-reminder> block, byte-identical to the frozen background-notice.ts format", async () => {
    const tasks = new FakeTaskPort();
    tasks.queueNotice({
      taskId: "task-1",
      command: "pnpm test",
      status: "completed",
      exitCode: 0,
      durationMs: 5_000,
    });
    const h = createHarness({ steps: [textStep("done")], tasks });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "what happened?" });
      await h.waitFor(agentEventOf("loop_end"));

      const scriptedModel = h.config.modelPort as ScriptedModelPort;
      expect(scriptedModel.requests).toHaveLength(1);
      const turnText = lastUserMessageText(scriptedModel.requests[0]);
      expect(turnText.match(/<system-reminder>/g)).toHaveLength(1);
      expect(turnText).toBe(
        "what happened?\n<system-reminder>\nBackground task update:\ntask-1 (`pnpm test`): completed, exit 0, 5s\n</system-reminder>",
      );
    } finally {
      h.close();
    }
  });

  it("drains exactly once: a second accepted turn (no new notices queued) sees no reminder block at all", async () => {
    const tasks = new FakeTaskPort();
    tasks.queueNotice({
      taskId: "task-1",
      command: "pnpm test",
      status: "completed",
      exitCode: 0,
      durationMs: 5_000,
    });
    const h = createHarness({ steps: [textStep("a"), textStep("b")], tasks });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "first" });
      await h.waitFor(agentEventOf("loop_end"));

      const scriptedModel = h.config.modelPort as ScriptedModelPort;
      const turn1Text = lastUserMessageText(scriptedModel.requests[0]);
      expect(turn1Text).toContain("<system-reminder>");

      const loopEndsBefore = h.received.filter(agentEventOf("loop_end")).length;
      h.send({ type: "user_message", requestId: "r2", text: "second" });
      await h.waitUntil(() => h.received.filter(agentEventOf("loop_end")).length > loopEndsBefore);

      expect(scriptedModel.requests).toHaveLength(2);
      const turn2Text = lastUserMessageText(scriptedModel.requests[1]);
      expect(turn2Text).toBe("second");
      expect(turn2Text).not.toContain("system-reminder");
    } finally {
      h.close();
    }
  });

  it("no queued notices at all -> requests are byte-identical to a harness with no tasks port (A/B control)", async () => {
    const tasks = new FakeTaskPort(); // never queued -> drainNotices() always returns []
    const withTasks = createHarness({ steps: [textStep("x")], tasks });
    const withoutTasks = createHarness({ steps: [textStep("x")] });
    try {
      for (const h of [withTasks, withoutTasks]) {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.send({ type: "user_message", requestId: "r1", text: "same input" });
        await h.waitFor(agentEventOf("loop_end"));
      }

      const textWith = lastUserMessageText((withTasks.config.modelPort as ScriptedModelPort).requests[0]);
      const textWithout = lastUserMessageText((withoutTasks.config.modelPort as ScriptedModelPort).requests[0]);
      expect(textWith).toBe("same input");
      expect(textWith).toBe(textWithout);
    } finally {
      withTasks.close();
      withoutTasks.close();
    }
  });

  it("a busy-rejected user_message never drains — the notice is not lost, it arrives on the next ACCEPTED turn", async () => {
    const tasks = new FakeTaskPort();
    const h = createHarness({
      steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep(), textStep("later")],
      tasks,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "start writing" });
      await h.waitFor(isPermissionRequest); // turn 1 parked at the Write ask (busy)

      // The task completes WHILE turn 1 is still in flight.
      tasks.queueNotice({
        taskId: "task-1",
        command: "sleep 1",
        status: "completed",
        exitCode: 0,
        durationMs: 1_000,
      });

      h.send({ type: "user_message", requestId: "r2", text: "are you done?" });
      const rejected = await h.waitFor(isTurnRejected);
      expect(rejected).toMatchObject({ requestId: "r2", reason: "busy" });
      // A rejected message returns before maybeDeriveTitle/drain even run —
      // the notice is still sitting in the fake port, unconsumed.

      // Release the parked ask so turn 1 completes.
      const req = await h.waitFor(isPermissionRequest);
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });
      await h.waitFor(agentEventOf("loop_end"));

      const scriptedModel = h.config.modelPort as ScriptedModelPort;
      // Turn 1 consumed 2 scripted steps (the tool call + the post-deny finish
      // round) — neither carries the notice yet, since it was queued AFTER
      // turn 1's onUserMessage already ran its own drain.
      expect(scriptedModel.requests).toHaveLength(2);
      expect(lastUserMessageText(scriptedModel.requests[0])).not.toContain("system-reminder");

      // Next ACCEPTED turn (r3, NOT the rejected r2) drains the still-queued notice.
      h.send({ type: "user_message", requestId: "r3", text: "now?" });
      await h.waitUntil(() => scriptedModel.requests.length >= 3);

      const turn3Text = lastUserMessageText(scriptedModel.requests[2]);
      expect(turn3Text.startsWith("now?")).toBe(true);
      expect(turn3Text).toContain("<system-reminder>");
      expect(turn3Text).toContain("task-1");
    } finally {
      h.close();
    }
  });

  it("title derivation reads the RAW text — a queued notice never leaks into the title", async () => {
    const tasks = new FakeTaskPort();
    tasks.queueNotice({
      taskId: "task-1",
      command: "pnpm test",
      status: "completed",
      exitCode: 0,
      durationMs: 5_000,
    });
    const h = createHarness({ steps: [textStep("ok")], tasks });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "fix the login bug" });
      await h.waitFor(agentEventOf("loop_end"));

      expect(h.touches).toHaveLength(1);
      expect(h.touches[0]?.title).toBe("fix the login bug");
      expect(h.touches[0]?.title).not.toContain("Background task update");
    } finally {
      h.close();
    }
  });
});


describe("Session — durable worktree-exit notice", () => {
  it("feeds the next real core model turn one hidden workspace reminder, then consumes it", async () => {
    const consume = vi.fn(async () => {});
    const continuationReady = vi.fn(async () => {});
    const continuationComplete = vi.fn(async () => {});
    const h = createHarness({
      steps: [textStep("first"), textStep("second")],
      worktreeExitNoticePending: true,
      consumeWorktreeExitNotice: consume,
      continuationPending: true,
      continuationMode: "none",
      onContinuationReady: continuationReady,
      onContinuationComplete: continuationComplete,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await h.flush();
      expect((h.config.modelPort as ScriptedModelPort).requests).toHaveLength(0);
      expect(continuationReady).toHaveBeenCalledTimes(1);
      expect(continuationComplete).toHaveBeenCalledTimes(1);

      h.send({ type: "user_message", requestId: "r1", text: "continue" });
      await h.waitFor(agentEventOf("loop_end"));

      const model = h.config.modelPort as ScriptedModelPort;
      expect(lastUserMessageText(model.requests[0])).toBe("continue");
      expect(model.requests[0]?.system).toBe(
        "Worktree exited. The session is now back in the main project at /workspace.",
      );
      expect(h.engine.historyItems().find((item) => item.message.role === "user")?.message).toEqual({
        role: "user",
        content: "continue",
      });
      expect(consume).toHaveBeenCalledTimes(1);

      h.send({ type: "user_message", requestId: "r2", text: "again" });
      await h.waitUntil(() => model.requests.length === 2);
      expect(lastUserMessageText(model.requests[1])).toBe("again");
      expect(model.requests[1]?.system).toBeUndefined();
      expect(consume).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });

  it("does not consume before the model stream successfully accepts the augmented turn", async () => {
    const consume = vi.fn(async () => {});
    const h = createHarness({
      steps: [[]],
      worktreeExitNoticePending: true,
      consumeWorktreeExitNotice: consume,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "continue" });
      await h.waitFor(agentEventOf("loop_end"));
      expect(consume).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });
});


// ── Slice P7.15 (F14): mid-session model switch (host set_model core) ─────────
//
// The harness's `switchModel` double is the EFFORT half of the host's re-budget
// recipe (host/index.ts), resolved against the REAL z-ai catalog entry:
// resolveReasoningEffort(id, entry, selectedTier) + resolveEffortLevels(id,
// entry). This is exactly what determines the `model_changed` payload; the
// window/repo-map half is host-index-level and covered in index.test.ts.
const zAiEntry = matchCatalogEntryByBaseUrl(getBuiltinCatalog(), "https://api.z.ai/api/anthropic");
const scriptedSwitchModel = (
  id: string,
  selectedEffort: Parameters<NonNullable<Parameters<typeof createHarness>[0]["switchModel"]>>[1],
): { model: string; reasoningEffort: typeof selectedEffort; availableEffortLevels?: (typeof selectedEffort)[] } => {
  const resolvedEffort = resolveReasoningEffort(id, zAiEntry, selectedEffort);
  const availableEffortLevels = resolveEffortLevels(id, zAiEntry);
  return {
    model: id,
    reasoningEffort: resolvedEffort ?? "off",
    ...(availableEffortLevels !== undefined ? { availableEffortLevels } : {}),
  };
};
const isModelChanged = (m: HostToUiMessage): m is Of<"model_changed"> => m.type === "model_changed";

describe("Session — model switch (slice P7.15 · F14)", () => {
  it("switches the model between turns, emits model_changed, and reports it on the next handshake", async () => {
    const h = createHarness({
      steps: [textStep("x"), finishStep()],
      reasoningSupported: true,
      availableEffortLevels: ["off", "high", "max"],
      switchModel: scriptedSwitchModel,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "set_model", model: "glm-4.6" });
      const changed = await h.waitFor(isModelChanged);
      expect(changed.model).toBe("glm-4.6");
      // glm-4.6 is NOT reasoning-capable -> effort collapses, levels omitted.
      expect(changed.reasoningEffort).toBe("off");
      expect(changed.availableEffortLevels).toBeUndefined();

      // The live model is the switched one on the next handshake.
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.filter(isHostReady).length === 2);
      expect(h.received.filter(isHostReady).at(-1)?.model).toBe("glm-4.6");
    } finally {
      h.close();
    }
  });

  it("re-resolves effort per new model capability and restores the selected tier when switching back", async () => {
    const h = createHarness({
      steps: [textStep("x"), finishStep()],
      reasoningSupported: true,
      availableEffortLevels: ["off", "high", "max"],
      switchModel: scriptedSwitchModel,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      // User selects "high" on the reasoning-capable boot model.
      h.send({ type: "set_reasoning_effort", effort: "high" });
      await h.waitFor((m): m is Of<"reasoning_effort_changed"> => m.type === "reasoning_effort_changed");

      // Switch to a NON-reasoning model -> effort collapses to off, no levels.
      h.send({ type: "set_model", model: "glm-4.6" });
      const collapsed = await h.waitFor(isModelChanged);
      expect(collapsed.reasoningEffort).toBe("off");
      expect(collapsed.availableEffortLevels).toBeUndefined();

      // Switch BACK to the reasoning model -> the selected "high" tier is
      // restored (selectedEffort persisted across the switch).
      h.send({ type: "set_model", model: "glm-5.2" });
      await h.waitUntil(() => h.received.filter(isModelChanged).length === 2);
      const restored = h.received.filter(isModelChanged).at(-1)!;
      expect(restored.model).toBe("glm-5.2");
      expect(restored.reasoningEffort).toBe("high");
      expect(restored.availableEffortLevels).toEqual(["off", "high", "max"]);
    } finally {
      h.close();
    }
  });

  it("silently drops a set_model while a turn is running (busy guard) — model unchanged, no model_changed", async () => {
    const h = createHarness({
      steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()],
      reasoningSupported: true,
      availableEffortLevels: ["off", "high", "max"],
      switchModel: scriptedSwitchModel,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      // Start a turn that parks on a permission ask -> the session is busy.
      h.send({ type: "user_message", requestId: "r1", text: "write it" });
      await h.waitFor(isPermissionRequest);

      // A switch under a running turn is silently dropped (no reply escape).
      h.send({ type: "set_model", model: "glm-4.6" });
      await h.flush();
      await h.flush();
      expect(h.received.some(isModelChanged)).toBe(false);

      // Release the ask, let the turn finish, then confirm the live model is
      // still the boot model on the next handshake.
      const req = await h.waitFor(isPermissionRequest);
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });
      await h.waitFor(agentEventOf("loop_end"));

      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.filter(isHostReady).length === 2);
      expect(h.received.filter(isHostReady).at(-1)?.model).toBe("scripted-model");
    } finally {
      h.close();
    }
  });

  it("silently drops a malformed id (empty / internal whitespace) and a switch with no factory wired", async () => {
    // (a) empty / whitespace ids are dropped even with a factory present.
    const withFactory = createHarness({
      steps: [textStep("x"), finishStep()],
      switchModel: scriptedSwitchModel,
    });
    try {
      withFactory.send({ type: "ui_ready" });
      await withFactory.waitFor(isHostReady);
      withFactory.send({ type: "set_model", model: "   " });
      withFactory.send({ type: "set_model", model: "glm 4.6" });
      await withFactory.flush();
      await withFactory.flush();
      expect(withFactory.received.some(isModelChanged)).toBe(false);
    } finally {
      withFactory.close();
    }

    // (b) a valid id with NO switchModel factory is a silent no-op.
    const noFactory = createHarness({ steps: [textStep("x"), finishStep()] });
    try {
      noFactory.send({ type: "ui_ready" });
      await noFactory.waitFor(isHostReady);
      noFactory.send({ type: "set_model", model: "glm-4.6" });
      await noFactory.flush();
      await noFactory.flush();
      expect(noFactory.received.some(isModelChanged)).toBe(false);
    } finally {
      noFactory.close();
    }
  });

  it("byte-lock: a legacy boot + turn flow (no set_model) emits ZERO model_changed", async () => {
    // Design slice-P7.15-cut.md §2.5: model_changed fires ONLY in response to a
    // set_model, which no legacy/byte-locked flow sends. A full boot + turn
    // therefore carries exactly the pre-P7.15 message set — zero model_changed.
    const h = createHarness({ steps: [textStep("hello"), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "r1", text: "hi" });
      await h.waitFor(agentEventOf("loop_end"));
      await h.flush();
      expect(h.received.some(isModelChanged)).toBe(false);
      // And the wire trace is exactly what it was before P7.15 (no new variant).
      expect(h.received.map((m) => m.type)).not.toContain("model_changed");
    } finally {
      h.close();
    }
  });
});

// ── TASK.56 W2: model image-input verdict on the wire (hello + model_changed) ──
//
// Layer discrimination (design slice-task56-vision-cut.md §4.5): every assert
// below reads RAW wire messages off the harness port, so it goes RED against a
// rollback of the HOST layer (the `imageInput` spread removed from Session's
// host_ready / model_changed emits). No renderer code is involved, and the
// protocol type alone emits nothing — a renderer-side rollback cannot keep
// these green.
describe("Session — model image-input verdict on the wire (TASK.56 W2)", () => {
  it("host_ready carries the live model verdict from the imageInputEnabled seam (both polarities)", async () => {
    for (const verdict of [true, false]) {
      const h = createHarness({ steps: [], imageInputEnabled: verdict });
      try {
        h.send({ type: "ui_ready" });
        const ready = await h.waitFor(isHostReady);
        expect(ready.imageInput).toBe(verdict);
      } finally {
        h.close();
      }
    }
  });

  it("omits imageInput entirely when no seam is wired — the legacy host_ready shape stays byte-identical", async () => {
    const h = createHarness({ steps: [], imageInputEnabled: null });
    try {
      h.send({ type: "ui_ready" });
      const ready = await h.waitFor(isHostReady);
      expect("imageInput" in ready).toBe(false);
    } finally {
      h.close();
    }
  });

  it("model_changed re-reads the verdict for the NEW model: vision -> non-vision flips it, and back", async () => {
    // Mirrors the production wiring (host/index.ts): imageInputEnabled is a
    // closure over the CURRENT model, which switchModel advances BEFORE the
    // model_changed emit — so the push reflects the new model, never the old.
    const visionModels = new Set(["scripted-model", "glm-5.2"]);
    let current = "scripted-model";
    const h = createHarness({
      steps: [],
      imageInputEnabled: () => visionModels.has(current),
      switchModel: (id, selectedEffort) => {
        current = id;
        return scriptedSwitchModel(id, selectedEffort);
      },
    });
    try {
      h.send({ type: "ui_ready" });
      const ready = await h.waitFor(isHostReady);
      expect(ready.imageInput).toBe(true);

      // vision -> non-vision: the push itself carries the flipped verdict.
      h.send({ type: "set_model", model: "glm-4.6" });
      const flipped = await h.waitFor(isModelChanged);
      expect(flipped.model).toBe("glm-4.6");
      expect(flipped.imageInput).toBe(false);

      // ...and back: the verdict follows the live model, not a boot constant.
      h.send({ type: "set_model", model: "glm-5.2" });
      await h.waitUntil(() => h.received.filter(isModelChanged).length === 2);
      expect(h.received.filter(isModelChanged).at(-1)?.imageInput).toBe(true);

      // The next handshake re-reads the same live verdict.
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.filter(isHostReady).length === 2);
      expect(h.received.filter(isHostReady).at(-1)?.imageInput).toBe(true);
    } finally {
      h.close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TASK.102 CUT-S2 §2.6.3 (slice S2b B4): child-mode Session
// ═════════════════════════════════════════════════════════════════════════════

const isSessionHistory = (m: HostToUiMessage): m is Of<"session_history"> => m.type === "session_history";
const isTitleChanged = (m: HostToUiMessage): m is Of<"title_changed"> => m.type === "title_changed";

interface ChildHarness {
  session: Session;
  received: HostToUiMessage[];
  send(message: UiToHostMessage): void;
  waitFor<T extends HostToUiMessage>(predicate: (message: HostToUiMessage) => message is T, timeoutMs?: number): Promise<T>;
  waitUntil(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Every persistence `touch` patch the Session emitted, in order (title/mode) — must never carry a `title` for a child. */
  touches: { title?: string; mode?: PermissionMode }[];
  onReady: ReturnType<typeof vi.fn<() => void>>;
  onTerminal: ReturnType<typeof vi.fn<(report: ChildTerminalReport) => void>>;
  flushHistory: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** Every report Session handed to `child.onProgress` (CUT-S2 §10.7), in order. */
  onProgress: ReturnType<typeof vi.fn<(report: ChildProgressReport) => void>>;
  close(): void;
}

/**
 * A SEPARATE minimal harness (not `test-harness.ts`'s shared `createHarness`,
 * which many other test files depend on and does not expose a `child` seam)
 * wiring a real AgentLoop + dispatcher + broker against a scripted ModelPort,
 * with Session's `child` option populated by inspectable `vi.fn()` mocks —
 * mirrors `createHarness`'s own construction closely enough that every
 * existing predicate/step-builder helper in this file works unchanged.
 *
 * `now` (CUT-S2 §10.7 п.3 DI clock) defaults to a strictly-increasing fake
 * clock (2000ms apart per call) rather than `Date.now` — every progress
 * boundary in a test that doesn't care about the throttle is then always
 * >=1000ms after the last, so it always emits; this keeps the throttle
 * itself from silently swallowing assertions in tests that aren't ABOUT the
 * throttle. Only the dedicated throttle test overrides it.
 */
function createChildHarness(opts: {
  steps: ModelStreamEvent[][];
  mode?: PermissionMode;
  bootHistory?: HistoryItem[];
  flushHistoryImpl?: () => Promise<void>;
  now?: () => number;
  /** F7 regression harness: lets a test gate `flushTelemetry()` to deterministically land inside the turn-teardown window. */
  envStatus?: SessionOptions["envStatus"];
  /** §10.11.1 N7 harness: a LIVE toggle, so a test can flip it BETWEEN a steer message's enqueue and its later drain. */
  imageInputEnabled?: () => boolean;
}): ChildHarness {
  const channel = new MessageChannel();
  const uiPort = channel.port1;
  const hostPort = channel.port2;

  const received: HostToUiMessage[] = [];
  uiPort.on("message", (value: unknown) => {
    received.push(value as HostToUiMessage);
  });
  uiPort.start();

  const outbound = new Outbound();
  const rawEmit = (message: HostToUiMessage): void => {
    outbound.emit(message);
  };
  // Wired through the real permission-tap (not a bare `emit`) so these tests
  // exercise the SAME broker-construction shape host/index.ts's child branch
  // builds — tapChildPermissions itself is proven separately, pure, below.
  const emit = tapChildPermissions(rawEmit, () => {});

  const registry = createDefaultToolRegistry();
  const hooks = new InMemoryHookRunner();
  const broker = new IpcPermissionBroker(emit);
  const toolFs = new MemFs();

  const config: AgentLoopConfig = {
    modelPort: new ScriptedModelPort(opts.steps),
    registry,
    hooks,
    permissionEngine: new RuleAwarePermissionEngine(new ModePermissionEngine(), new SessionPermissionRules()),
    permissionBroker: broker,
    mode: opts.mode ?? "build",
    ports: {
      fs: toolFs,
      exec: {} as AgentLoopConfig["ports"]["exec"],
      http: new NodeHttpAdapter(),
      todos: new InMemoryTodoStore(),
    },
    cwd: "/workspace",
  };
  const loop = new AgentLoop(config);
  const engine = new CoreEngine({ loop, config });

  const touches: { title?: string; mode?: PermissionMode }[] = [];
  const persistence: SessionPersistence = {
    touch(patch) {
      touches.push(patch);
    },
  };

  const onReady = vi.fn<() => void>();
  const onTerminal = vi.fn<(report: ChildTerminalReport) => void>();
  const flushHistory = vi.fn<() => Promise<void>>(opts.flushHistoryImpl ?? (() => Promise.resolve()));
  const onProgress = vi.fn<(report: ChildProgressReport) => void>();
  let defaultNowCalls = 0;
  const now = opts.now ?? ((): number => (defaultNowCalls++) * 2_000);

  const session = new Session({
    outbound,
    engine,
    broker,
    fs: toolFs,
    workspace: "/workspace",
    projectRoot: "/workspace",
    model: "scripted-model",
    sessionId: "child-session",
    bootHistory: opts.bootHistory,
    rules: new SessionPermissionRules(),
    persistence,
    child: { onReady, flushHistory, onTerminal, onProgress, now },
    ...(opts.envStatus ? { envStatus: opts.envStatus } : {}),
    ...(opts.imageInputEnabled ? { imageInputEnabled: opts.imageInputEnabled } : {}),
  });
  session.bindPort(nodeWirePort(hostPort));

  const waitFor = <T extends HostToUiMessage>(
    predicate: (message: HostToUiMessage) => message is T,
    timeoutMs = 1_000,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const existing = received.find(predicate);
      if (existing) {
        resolve(existing);
        return;
      }
      const onMessage = (value: unknown): void => {
        const message = value as HostToUiMessage;
        if (predicate(message)) {
          cleanup();
          resolve(message);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("waitFor timed out"));
      }, timeoutMs);
      const cleanup = (): void => {
        uiPort.off("message", onMessage);
        clearTimeout(timer);
      };
      uiPort.on("message", onMessage);
    });

  return {
    session,
    received,
    touches,
    onReady,
    onTerminal,
    flushHistory,
    onProgress,
    send(message: UiToHostMessage): void {
      uiPort.postMessage(message);
    },
    waitFor,
    // Polling, NOT message-triggered (unlike test-harness.ts's createHarness):
    // several of this file's child-mode predicates observe a `vi.fn()` mock
    // call (onReady/onTerminal/flushHistory) rather than a NEW wire message —
    // a message-only recheck would silently hang forever on exactly those
    // (the side effect that flips the predicate never itself posts anything
    // over `uiPort`), so this polls unconditionally on a short interval.
    waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (predicate()) {
          resolve();
          return;
        }
        const interval = setInterval(() => {
          if (predicate()) {
            cleanup();
            resolve();
          }
        }, 5);
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("waitUntil timed out"));
        }, timeoutMs);
        const cleanup = (): void => {
          clearInterval(interval);
          clearTimeout(timer);
        };
      });
    },
    close(): void {
      uiPort.close();
      hostPort.close();
    },
  };
}

describe("Session — child mode: child.onReady (CUT-S2 §2.6.3)", () => {
  it("fires exactly once, on the FIRST ui_ready — never before, never again on a reconnect", async () => {
    const h = createChildHarness({ steps: [finishStep()] });
    try {
      expect(h.onReady).not.toHaveBeenCalled();

      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      expect(h.onReady).toHaveBeenCalledTimes(1);

      // A reconnect (Open re-attaching to a live child) sends ui_ready again.
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.filter(isHostReady).length === 2);
      expect(h.onReady).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });
});

describe("Session — child mode: host-side steer queue (CUT-S2 §1.1/§2.6.3)", () => {
  it("queues a busy-time user_message instead of rejecting it, up to CHILD_STEER_QUEUE_MAX; the 17th is rejected", async () => {
    const h = createChildHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      const started = h.session.startProgrammaticTurn("do it");
      expect(started).toEqual({ ok: true });
      await h.waitFor(isPermissionRequest); // parked -> busy

      for (let i = 0; i < CHILD_STEER_QUEUE_MAX; i++) {
        h.send({ type: "user_message", requestId: `steer-${i}`, text: `and also ${i}` });
      }
      h.send({ type: "user_message", requestId: "steer-overflow", text: "one too many" });

      // FIFO delivery over the SAME MessageChannel guarantees every steer-N
      // message above was already routed before this one settles.
      const rejected = await h.waitFor(isTurnRejected);
      expect(rejected).toMatchObject({ requestId: "steer-overflow", reason: "busy" });
      expect(h.received.filter(isTurnRejected)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("a facade that rejects a busy-time user_message like a root session would fail this: none of the first 16 is ever a turn_rejected", async () => {
    const h = createChildHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.session.startProgrammaticTurn("do it");
      await h.waitFor(isPermissionRequest);

      h.send({ type: "user_message", requestId: "steer-1", text: "first steer" });
      h.send({ type: "user_message", requestId: "steer-2", text: "second steer" });
      // A marker message proves the two steer sends above were both already
      // routed (FIFO) without producing any turn_rejected.
      h.send({ type: "context_breakdown_request" });
      await h.waitFor(isContextBreakdown);

      expect(h.received.filter(isTurnRejected)).toHaveLength(0);
    } finally {
      h.close();
    }
  });
});

describe("Session — child mode: terminal ordering (CUT-S2 §0.5/§5.10/§5.16)", () => {
  it("chains a queued steer message before ever publishing the terminal — the terminal is never published while the queue is non-empty", async () => {
    const h = createChildHarness({
      steps: [
        // Turn 1 (initial): parks on a permission ask, then (once denied)
        // the SAME turn's internal tool-loop takes one more model round to
        // actually finish — finishStep() is that second round, not a
        // separate session-level turn (toolStep+finishStep together are ONE
        // turn's full internal loop, exactly like the existing "cancel
        // mid-turn"/"busy gate" tests above use).
        toolStep("c1", "Write", WRITE_INPUT),
        finishStep(),
        // Turn 2 (the drained steer message): its own two-round internal loop.
        toolStep("c2", "Write", WRITE_INPUT),
        finishStep(),
      ],
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("do it");
      const req1 = await h.waitFor(isPermissionRequest);

      h.send({ type: "user_message", requestId: "steer-1", text: "and also do this" });

      h.send({ type: "permission_response", requestId: req1.requestId, behavior: "deny" });
      // Turn 2 (the drained steer message) starts and parks on ITS OWN ask —
      // proves the queue was drained rather than the terminal being published
      // with turn 1's own status while the message was still sitting there.
      const req2 = await h.waitFor(
        (m): m is Of<"permission_request"> => isPermissionRequest(m) && m.requestId !== req1.requestId,
      );
      expect(h.received.filter(isTurnStarted)).toHaveLength(2);
      expect(h.onTerminal).not.toHaveBeenCalled();

      h.send({ type: "permission_response", requestId: req2.requestId, behavior: "deny" });
      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });

  it("publishes the terminal only AFTER flushHistory resolves — order is asserted with a deliberately-delayed fake sink, not just eventual completion", async () => {
    let releaseFlush: (() => void) | undefined;
    const flushHistoryImpl = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
    const h = createChildHarness({ steps: [textStep("done")], flushHistoryImpl });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      await h.waitFor(agentEventOf("loop_end"));

      // flushHistory is gated (unresolved) -> a facade that publishes the
      // terminal before/without awaiting it would already have called
      // onTerminal by now; give any such synchronous path a chance to run.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.flushHistory).toHaveBeenCalledTimes(1);
      expect(h.onTerminal).not.toHaveBeenCalled();

      releaseFlush?.();
      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });

  it("reports an error terminal when flushHistory rejects — an honest failure beats a completed card with an unreadable transcript", async () => {
    const h = createChildHarness({
      steps: [textStep("all done")],
      flushHistoryImpl: () => Promise.reject(new Error("disk full")),
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);

      expect(h.onTerminal).toHaveBeenCalledTimes(1);
      const report = h.onTerminal.mock.calls[0]?.[0];
      expect(report?.status).toBe("error");
      expect(report?.finalText).toContain("disk full");
    } finally {
      h.close();
    }
  });
});

describe("Session — child mode: busy spans the WHOLE turn teardown, not just runTurn() (F7)", () => {
  it("a steer message sent while flushTelemetry() is still pending is queued, not started as a live second turn", async () => {
    // Mirrors the root-session "shutdown() during teardown waits for
    // flushTelemetry()" regression test above: flushTelemetry is gated on a
    // manually-resolved promise so the test can deterministically land a
    // user_message inside the EXACT window a facade that resets `busy` at
    // the top of the turn's `.finally()` (before this await) would have
    // already reopened the busy gate.
    let flushCalled = false;
    let releaseFlush: () => void = () => {};
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const h = createChildHarness({
      steps: [textStep("done"), textStep("steer done")],
      envStatus: {
        telemetry: () => null,
        repoMap: () => null,
        flushTelemetry: async () => {
          flushCalled = true;
          await flushGate;
        },
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      await h.waitFor(agentEventOf("loop_end"));
      // The turn's finally() is now stuck awaiting the gated flushTelemetry.
      await h.waitUntil(() => flushCalled);

      h.send({ type: "user_message", requestId: "steer-1", text: "and also this" });
      // A real trip across the MessageChannel — a buggy bypass starts the
      // second turn (and emits its own turn_started) synchronously off that
      // delivery, so this window is enough to observe it either way.
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Discriminator: a facade that reopened `busy` before teardown
      // finished would have run onUserMessage's non-busy path here — an
      // IMMEDIATE second runTurn() (turn_started #2), not a parked steer.
      expect(h.received.filter(isTurnStarted)).toHaveLength(1);
      expect(h.received.filter(isTurnRejected)).toHaveLength(0);
      expect(h.onTerminal).not.toHaveBeenCalled();

      releaseFlush();
      // The queued steer only NOW gets to drain, as its own second turn —
      // and the terminal publishes exactly once, after that turn's own
      // teardown, never twice (the double-finalize the same race used to
      // trigger once the bypassed turn 2 completed independently).
      await h.waitUntil(() => h.received.filter(isTurnStarted).length === 2);
      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });
});

/** Narrow test-only escape hatch onto Session's private `finalizeChildTerminal` (F7's once-latch; §10.10.1 O7 return type). */
function finalizeChildTerminalDirect(session: Session): Promise<"terminal" | "drained"> {
  return (
    session as unknown as { finalizeChildTerminal(): Promise<"terminal" | "drained"> }
  ).finalizeChildTerminal();
}

describe("Session — child mode: finalizeChildTerminal once-latch (F7, revised under §10.10.1 O7)", () => {
  // §10.10.1 O7 moves the latch from the TOP of finalizeChildTerminal (before
  // flushHistory) to immediately before the `onTerminal` call (after the
  // post-flush queue re-check) — required so a settle that finds the queue
  // non-empty can drain into a new turn instead of committing, and so the
  // NEXT settle re-runs flushHistory from scratch (§10.10.1 п.4а). This
  // retires the old defense against two CONCURRENT direct calls racing
  // through flushHistory together (the shape F7's window used to produce) —
  // §10.10.1 argues that race no longer exists by construction once `busy`
  // spans the whole child teardown (a second settle cannot start while the
  // first is still in flight), so the latch's only remaining, still-real job
  // is refusing a call that arrives strictly AFTER the terminal already
  // committed.
  it("a call arriving after the terminal already committed is a no-op — flushHistory/onTerminal each still called exactly once total", async () => {
    const h = createChildHarness({ steps: [textStep("done")] });
    try {
      const first = await finalizeChildTerminalDirect(h.session);
      expect(first).toBe("terminal");
      expect(h.flushHistory).toHaveBeenCalledTimes(1);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);

      const second = await finalizeChildTerminalDirect(h.session);
      expect(second).toBe("terminal");
      expect(h.flushHistory).toHaveBeenCalledTimes(1);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });
});

describe("Session — child mode: teardown contract (TASK.102 CUT-S2 §10.10.1)", () => {
  it("O7: a steer message queued DURING a delayed flushHistory still gets its own turn — the terminal accounts for it, not just the turn that was already running", async () => {
    let flushCallCount = 0;
    let releaseFirstFlush: () => void = () => {};
    const firstFlushGate = new Promise<void>((resolve) => {
      releaseFirstFlush = resolve;
    });
    const flushHistoryImpl = async (): Promise<void> => {
      flushCallCount += 1;
      if (flushCallCount === 1) {
        await firstFlushGate;
      }
    };
    const h = createChildHarness({ steps: [textStep("first"), textStep("second")], flushHistoryImpl });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      await h.waitFor(agentEventOf("loop_end"));
      // Turn 1's finally() has reached finalizeChildTerminal() and is stuck
      // awaiting the gated FIRST flushHistory() call. The queue is still
      // empty at this instant — this is deliberately NOT the "already
      // queued, drained before finalize even starts" path the existing
      // "terminal ordering" tests cover; the steer below arrives strictly
      // DURING the flush, after the once-latch's old position but before its
      // new one.
      await h.waitUntil(() => flushCallCount === 1);

      h.send({ type: "user_message", requestId: "steer-1", text: "and this too" });
      // A real round trip; long enough for a facade with no re-check to have
      // already silently parked this into a queue nothing will ever drain.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.onTerminal).not.toHaveBeenCalled();

      releaseFirstFlush();
      // Discriminator: without the post-flush re-check (§10.10.1 п.4а),
      // this steer is never started — turn_started never reaches 2, and
      // whatever terminal a facade eventually publishes reports only turn
      // 1's counters, silently dropping the queued message (the literal O7
      // bug: a facade of §5.16's "no terminal while the queue is non-empty").
      await h.waitUntil(() => h.received.filter(isTurnStarted).length === 2, 2_000);
      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0, 2_000);

      // flushHistory ran again for the drained turn's own settle — cheap and
      // idempotent, exactly as §10.10.1 п.4а specifies.
      expect(h.flushHistory).toHaveBeenCalledTimes(2);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
      const report = h.onTerminal.mock.calls[0]?.[0];
      expect(report?.turns).toBe(2);
    } finally {
      h.close();
    }
  });

  it("O2: shutdown() during a delayed flushHistory resolves only AFTER the terminal has been posted", async () => {
    let releaseFlush: () => void = () => {};
    const flushHistoryImpl = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
    const h = createChildHarness({ steps: [textStep("done")], flushHistoryImpl });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      await h.waitFor(agentEventOf("loop_end"));
      await h.waitUntil(() => h.flushHistory.mock.calls.length > 0);

      let shutdownSettled = false;
      const shutdownPromise = h.session.shutdown().then(() => {
        shutdownSettled = true;
      });

      // Discriminator: the pre-fix code nulls `currentTurn` at the TOP of
      // this callback (old `:1530`), strictly BEFORE the child branch that
      // awaits finalizeChildTerminal() — shutdown()'s `await this.currentTurn`
      // would find it already null here and resolve immediately, well before
      // flushHistory/onTerminal ever run.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(shutdownSettled).toBe(false);
      expect(h.onTerminal).not.toHaveBeenCalled();

      releaseFlush();
      await shutdownPromise;

      expect(shutdownSettled).toBe(true);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });

  it("O3: a throwing child.onTerminal never rejects finalizeChildTerminal — no unhandled rejection reaches the host", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = createChildHarness({ steps: [textStep("done")] });
    h.onTerminal.mockImplementation(() => {
      throw new Error("renderer bridge boom");
    });
    try {
      // Discriminator: pre-fix, `child.onTerminal(...)` is called bare — a
      // throw here rejects finalizeChildTerminal's own returned promise. The
      // real call site (acceptUserMessage's finally) never wraps `await
      // settling` in a try, and by production time `currentTurn` has already
      // been nulled elsewhere, so nothing holds that rejection — an
      // unhandled rejection that kills the host process. Awaiting the call
      // directly here surfaces that exact rejection as a normal thrown
      // error if the guard is missing.
      await expect(finalizeChildTerminalDirect(h.session)).resolves.toBe("terminal");
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
      expect(
        consoleError.mock.calls.some(
          (call) => typeof call[0] === "string" && call[0].includes("[host]") && call[0].includes("onTerminal"),
        ),
      ).toBe(true);
    } finally {
      consoleError.mockRestore();
      h.close();
    }
  });

  it("O5: a user_message after the terminal has been posted is rejected not_ready, never a live ghost turn", async () => {
    const h = createChildHarness({ steps: [textStep("done")] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);

      h.send({ type: "user_message", requestId: "late", text: "still there?" });
      const rejected = await h.waitFor(isTurnRejected);

      // Discriminator: without the childTerminalFinalized gate, `busy` is
      // already false post-terminal (finalizeChildTerminal resolved
      // "terminal"), so this message falls straight into acceptUserMessage —
      // a real second turn_started for a session whose result can never
      // reach anyone (§6: a completed child is read-only).
      expect(rejected).toMatchObject({ requestId: "late", reason: "not_ready" });
      expect(h.received.filter(isTurnStarted)).toHaveLength(1);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });

  it("O2 identity-guard: shutdown() called after a drain waits for the DRAINED turn, not the one that drained it", async () => {
    let releaseFlush: () => void = () => {};
    const flushHistoryImpl = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
    const h = createChildHarness({
      steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep(), toolStep("c2", "Write", WRITE_INPUT), finishStep()],
      flushHistoryImpl,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("do it");
      const req1 = await h.waitFor(isPermissionRequest);

      h.send({ type: "user_message", requestId: "steer-1", text: "and also do this" });
      h.send({ type: "permission_response", requestId: req1.requestId, behavior: "deny" });

      // Turn 2 (the drained steer) starts and parks on its OWN ask — proves
      // the queue's own top-level drain (onChildTurnSettled) ran, reassigning
      // currentTurn to turn 2's promise, all BEFORE turn 1's finally() ever
      // reaches its (now identity-guarded) null check.
      const req2 = await h.waitFor(
        (m): m is Of<"permission_request"> => isPermissionRequest(m) && m.requestId !== req1.requestId,
      );
      expect(h.received.filter(isTurnStarted)).toHaveLength(2);

      let shutdownSettled = false;
      const shutdownPromise = h.session.shutdown().then(() => {
        shutdownSettled = true;
      });
      // shutdown() aborts turn 2 and denies its parked ask (req2) itself via
      // broker.denyAll — turn 2 unwinds on its own, reaches
      // finalizeChildTerminal, and gets stuck on the gated flushHistory.
      await h.waitUntil(() => h.flushHistory.mock.calls.length > 0);

      // Discriminator: an unconditional (non-identity-guarded) move of the
      // old `:1530` null to the end of turn 1's finally() — the "naive fix"
      // §10.10.1 O2 explicitly warns against — would have clobbered
      // `currentTurn` back to null right after the synchronous drain above
      // reassigned it to turn 2's promise. shutdown() would then have
      // resolved via `disposal` alone, without ever waiting for turn 2.
      expect(shutdownSettled).toBe(false);
      expect(h.onTerminal).not.toHaveBeenCalled();

      releaseFlush();
      await shutdownPromise;

      expect(shutdownSettled).toBe(true);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });
});

/** Narrow test-only escape hatch onto Session's private `busy` flag (§10.11.1 N3: the terminal/drained discriminator at the settling call-site). */
function sessionBusy(session: Session): boolean {
  return (session as unknown as { busy: boolean }).busy;
}

describe("Session — shutdown() vs. admission (TASK.102 CUT-S2 §10.11.1 N1)", () => {
  it("(i) child: a steer message queued while shutdown() is pending a delayed flushHistory is rejected not_ready, the terminal publishes exactly once, and shutdown() resolves only after it — engine started exactly one turn", async () => {
    let releaseFlush: () => void = () => {};
    const flushHistoryImpl = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
    // Discriminator (pre-fix): the OLD unconditional healthy-path re-check
    // drains this queued steer into a SECOND turn on an engine shutdown()
    // already started disposing — the terminal is never published on the
    // path shutdown() actually waits on, and shutdown() resolves off the
    // stale turn-1 snapshot alone. Only ONE step is supplied on purpose:
    // a fixed post-fix does not need a second one (the queue is rejected,
    // not drained), and a still-buggy run should not be handed a clean
    // second script to hide behind.
    const h = createChildHarness({ steps: [textStep("done")], flushHistoryImpl });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      await h.waitFor(agentEventOf("loop_end"));
      await h.waitUntil(() => h.flushHistory.mock.calls.length > 0);

      // Queued BEFORE shutdown() is even called — a live child's ordinary
      // steer path, parked host-side while busy is still true.
      h.send({ type: "user_message", requestId: "steer-1", text: "and this too" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      let shutdownSettled = false;
      const shutdownPromise = h.session.shutdown().then(() => {
        shutdownSettled = true;
      });

      // A real round trip; long enough for a buggy unconditional drain to
      // have already fired its own turn_started off the release below.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shutdownSettled).toBe(false);
      expect(h.onTerminal).not.toHaveBeenCalled();

      releaseFlush();
      await shutdownPromise;
      // shutdownPromise settling only means the host-side teardown finished;
      // the queued steer's turn_rejected still needs a tick to cross the
      // (real) MessageChannel into `h.received`.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(shutdownSettled).toBe(true);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
      expect(h.received.filter(isTurnStarted)).toHaveLength(1);
      expect(h.received.filter(isTurnRejected)).toContainEqual(
        expect.objectContaining({ requestId: "steer-1", reason: "not_ready" }),
      );
    } finally {
      h.close();
    }
  });

  it("(ii) root: a user_message sent after shutdown() has begun (during a delayed flushTelemetry) is rejected not_ready, never a second turn — even though root's own busy already cleared", async () => {
    let flushCalled = false;
    let releaseFlush: () => void = () => {};
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    // Discriminator (pre-fix): §10.10.1 O1 clears root's `busy` as the FIRST
    // step of teardown (before flushTelemetry), so a message arriving here
    // sails straight through the (already-open) busy gate and starts a real
    // turn #2 — the shutdown() snapshot from `:914` never covers it.
    const h = createHarness({
      steps: [finishStep(), finishStep()],
      envStatus: {
        telemetry: () => null,
        repoMap: () => null,
        flushTelemetry: async () => {
          flushCalled = true;
          await flushGate;
        },
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "t1", text: "hi" });
      await h.waitUntil(() => flushCalled);

      let shutdownSettled = false;
      const shutdownPromise = h.session.shutdown().then(() => {
        shutdownSettled = true;
      });

      h.send({ type: "user_message", requestId: "t2", text: "still there?" });
      // A real round trip; long enough for the pre-fix bypass to have
      // already emitted its own turn_started for t2.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.received.filter(isTurnStarted)).toHaveLength(1);
      expect(h.received.filter(isTurnRejected)).toContainEqual(
        expect.objectContaining({ requestId: "t2", reason: "not_ready" }),
      );
      expect(shutdownSettled).toBe(false);

      releaseFlush();
      await shutdownPromise;

      expect(shutdownSettled).toBe(true);
      // Still exactly one turn ever started — the reentrant wait covered the
      // full teardown without a second engine call ever happening.
      expect(h.received.filter(isTurnStarted)).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

describe("Session — shutdown() admission funnel: exit_worktree / rewind_request / default-deny (TASK.102 CUT-S2 §10.12.1)", () => {
  /**
   * Minimal recording WirePort (mirrors the shell-capability describe's own
   * FakeWirePort above, but typed HostToUiMessage for readable `toContainEqual`
   * assertions) — used here because `createHarness` (test-harness.ts) does not
   * expose a `worktreeControl` seam, and Q1-b needs one.
   */
  class RecordingPort implements WirePort {
    readonly received: HostToUiMessage[] = [];
    private cb: ((msg: unknown) => void) | null = null;
    post(msg: unknown): void {
      this.received.push(msg as HostToUiMessage);
    }
    onMessage(cb: (msg: unknown) => void): void {
      this.cb = cb;
    }
    onClose(): void {
      // Unused by these tests.
    }
    send(message: UiToHostMessage): void {
      this.cb?.(message);
    }
  }

  function buildStubEngine(overrides: Partial<SessionEngine> = {}): SessionEngine {
    return {
      id: "core",
      capabilities: {
        supportsCorePermissions: true,
        supportsRewind: true,
        supportsWorkflow: true,
        supportsGitMutations: true,
        supportsContextUsage: true,
        supportsContextBreakdown: true,
        supportsInteractiveApprovals: true,
        costAccounting: true,
        supportsModelSelection: true,
        supportsReasoningEffort: true,
        supportsImages: true,
        supportsTasks: true,
        supportsFileSnapshots: true,
      },
      mode: () => "build",
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      async *runTurn(): AsyncIterable<AgentEvent> {},
      historyItems: () => [],
      dispose: async () => {},
      ...overrides,
    };
  }

  it("(Q1-b) exit_worktree after shutdown() has begun is refused without ever calling worktreeControl.exit", async () => {
    const outbound = new Outbound();
    const broker = new IpcPermissionBroker((message) => outbound.emit(message));
    const exit = vi.fn(async () => ({ ok: false as const, error: "must not run" }));
    const session = new Session({
      outbound,
      engine: buildStubEngine(),
      broker,
      fs: new MemFs(),
      workspace: "/workspace",
      model: "m1",
      sessionId: "s1",
      rules: new SessionPermissionRules(),
      worktreeControl: { enter: vi.fn(), exit },
    });
    const port = new RecordingPort();
    session.bindPort(port);
    port.send({ type: "ui_ready" });

    // Discriminator (pre-fix): none of exit_worktree's own guards
    // (relocating/busy/worktreeControl-undefined) check shuttingDown, so
    // once shutdown() has resolved (nothing busy), exit_worktree sails
    // through and calls the REAL worktreeControl.exit — with
    // `cleanup:"auto"` a genuine worktree deletion on a host already mid-teardown.
    await session.shutdown();
    port.send({ type: "exit_worktree", cleanup: "auto" });

    expect(port.received).toContainEqual({
      type: "worktree_notice",
      message: "Cannot exit the worktree: the session is shutting down.",
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it("(Q1-c) rewind_request after shutdown() has begun is refused without ever calling the checkpoints seam", async () => {
    let rewindCalled = false;
    const seam: SessionOptions["checkpoints"] = {
      list: async () => [],
      rewind: async () => {
        rewindCalled = true;
        return { ok: false, reason: "should not run" };
      },
    };
    const h = createHarness({ steps: [], checkpointsSeam: seam });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      // Discriminator (pre-fix): onRewind's own guards only check
      // `this.busy` — busy is false here (nothing ever ran), so a
      // rewind_request sent after shutdown() has resolved is admitted today.
      await h.session.shutdown();
      h.send({ type: "rewind_request", requestId: "rw1", checkpointId: "cp-1", scope: "both" });

      const res = await h.waitFor(isRewindResult);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("shutting down");
      expect(res.conversationRestored).toBe(false);
      expect(res.restoredPaths).toBeNull();
      expect(rewindCalled).toBe(false);
    } finally {
      h.close();
    }
  });

  it("(Q1-f, mutational discriminator, TASK.102 CUT-S2 §10.14.3 BLOCKER-1) closeAdmissions() closes the funnel BEFORE shutdown() itself runs — a rewind_request and a user_message sent in that window are both refused", async () => {
    let rewindCalled = false;
    const seam: SessionOptions["checkpoints"] = {
      list: async () => [],
      rewind: async () => {
        rewindCalled = true;
        return { ok: false, reason: "should not run" };
      },
    };
    const h = createHarness({ steps: [], checkpointsSeam: seam });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      // Discriminator (pre-fix): nothing arms `this.shuttingDown` until deep
      // inside `shutdown()` itself — the entire host teardown window before
      // that call (git abort, terminal/task/lsp reap, mcp dispose) admitted
      // both message types below. Removing the closeAdmissions() call in
      // handleShutdown lets them sail through admitted, same as Q1-c/Q1-a
      // pre-fix.
      h.session.closeAdmissions();
      h.send({ type: "rewind_request", requestId: "rw1", checkpointId: "cp-1", scope: "both" });
      h.send({ type: "user_message", requestId: "um1", text: "still there?" });

      const res = await h.waitFor(isRewindResult);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("shutting down");
      expect(rewindCalled).toBe(false);

      const rejected = await h.waitFor(isTurnRejected);
      expect(rejected.requestId).toBe("um1");
      expect(rejected.reason).toBe("not_ready");
    } finally {
      h.close();
    }
  });

  it("(Q1-d) an in-flight rewind is awaited by shutdown() to completion, not abandoned via a null currentTurn snapshot", async () => {
    let releaseRewind: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseRewind = resolve;
    });
    const seam: SessionOptions["checkpoints"] = {
      list: async () => [],
      rewind: async () => {
        await gate;
        return { ok: true, safetyCheckpointId: "safety-1", restoredPaths: 0, historyItems: null };
      },
    };
    const h = createHarness({ steps: [], checkpointsSeam: seam });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "rewind_request", requestId: "rw1", checkpointId: "cp-1", scope: "conversation" });
      // A real round trip so the rewind's synchronous prefix (busy=true,
      // currentTurn assigned) has definitely run before shutdown() is called.
      await new Promise((resolve) => setTimeout(resolve, 20));

      let shutdownSettled = false;
      const shutdownPromise = h.session.shutdown().then(() => {
        shutdownSettled = true;
      });
      // Discriminator (pre-fix): onRewind never assigns `this.currentTurn`,
      // so shutdown()'s wait has nothing to observe (null) and resolves
      // immediately — a real round trip is long enough for that to show.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shutdownSettled).toBe(false);

      releaseRewind();
      await shutdownPromise;
      expect(shutdownSettled).toBe(true);

      const res = await h.waitFor(isRewindResult);
      expect(res.ok).toBe(true);
    } finally {
      h.close();
    }
  });

  it("(Q1-e, mutational discriminator) the route() funnel default-denies EVERY message type once shutdown has begun, not just the three carved-out ones — proven against set_model", async () => {
    // Green on the fixed code as-is (set_model has no dedicated shutdown
    // gate of its own — it relies entirely on the funnel's default-deny).
    // Turned red only by temporarily mutating route()'s funnel back into a
    // list-style gate (removing the unconditional `return` so only the three
    // named cases short-circuit) — see the builder's report for the mutation
    // procedure; this comment documents the discipline per §10.12.2's sibling
    // requirement for §10.12.1's own mutational test.
    let switchCalls = 0;
    const h = createHarness({
      steps: [],
      switchModel: (id, effort) => {
        switchCalls += 1;
        return { model: id, reasoningEffort: effort };
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      await h.session.shutdown();
      h.send({ type: "set_model", model: "gpt-5" });
      await h.flush();
      expect(switchCalls).toBe(0);
    } finally {
      h.close();
    }
  });
});

describe("Session — shutdown() reentrant wait vs. a pre-fix single snapshot: white-box discriminator (TASK.102 CUT-S2 §10.12.2)", () => {
  it("(iii-b) shutdown() re-observes a currentTurn reassignment made WHILE it is already waiting on the ORIGINAL turn's promise — a one-shot snapshot cannot see it", async () => {
    let flushCalled = false;
    let releaseFlush: () => void = () => {};
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    let resolveDeferred2: () => void = () => {};
    const deferred2 = new Promise<void>((resolve) => {
      resolveDeferred2 = resolve;
    });
    const h = createHarness({
      steps: [finishStep()],
      envStatus: {
        telemetry: () => null,
        repoMap: () => null,
        flushTelemetry: async () => {
          flushCalled = true;
          await flushGate;
        },
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      h.send({ type: "user_message", requestId: "t1", text: "hi" });
      await h.waitUntil(() => flushCalled);

      // shutdown() starts waiting on turn 1's OWN promise here — nothing
      // else has touched `currentTurn` yet.
      let shutdownSettled = false;
      const shutdownPromise = h.session.shutdown().then(() => {
        shutdownSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shutdownSettled).toBe(false);

      // Simulates a future, unaudited admission point re-pointing
      // `currentTurn` to its OWN fresh promise WHILE shutdown() is already
      // mid-wait on turn 1's promise (§10.12.2) — the exact shape
      // onChildTurnSettled/finalizeChildTerminal's own re-check produces
      // today. Turn 1's identity-guarded teardown (`if (this.currentTurn
      // === turn) this.currentTurn = null`) will see this NEW value below
      // and correctly leave it alone once its own teardown completes.
      (h.session as unknown as { currentTurn: Promise<void> | null }).currentTurn = deferred2;
      releaseFlush();

      // Turn 1's own promise settles now. Discipline (§10.12.2): a one-shot
      // snapshot (`const t = this.currentTurn; if (t) await
      // Promise.allSettled([t]);`) captured turn 1's promise BEFORE this
      // reassignment and would resolve right here, never learning about
      // deferred2 — the reentrant loop instead re-reads `currentTurn`, sees
      // it now points at deferred2, and keeps waiting. Verified by the
      // builder: mutating shutdown()'s loop into that exact snapshot turns
      // THIS assertion red (shutdownSettled flips true here instead of
      // after deferred2 resolves below); the mutation was reverted after
      // observing it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shutdownSettled).toBe(false);

      resolveDeferred2();
      await shutdownPromise;
      expect(shutdownSettled).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe("Session — child mode: terminal/drained discriminator at the settling call-site (TASK.102 CUT-S2 §10.11.1 N3)", () => {
  it("a drained settle (queue non-empty post-flush) leaves busy===true — and a live user_message sent right after is queued, never a second concurrent runTurn", async () => {
    let releaseFlush: () => void = () => {};
    const flushHistoryImpl = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
    const h = createChildHarness({
      steps: [finishStep(), toolStep("c1", "Write", WRITE_INPUT), finishStep()],
      flushHistoryImpl,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      await h.waitFor(agentEventOf("loop_end"));
      await h.waitUntil(() => h.flushHistory.mock.calls.length > 0);

      // Queued too late for onChildTurnSettled's own top-level check (empty
      // at that instant) — only finalizeChildTerminal's post-flush re-check
      // catches it.
      h.send({ type: "user_message", requestId: "steer-1", text: "and this too" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      releaseFlush();
      // The re-check drains the queued steer into turn 2, which parks on its
      // own permission ask — the settling promise (finalizeChildTerminal's
      // own) resolves "drained" once that synchronous drain call returns,
      // well before turn 2 itself reaches this ask.
      const req2 = await h.waitFor(isPermissionRequest);
      expect(h.received.filter(isTurnStarted)).toHaveLength(2);
      expect(h.onTerminal).not.toHaveBeenCalled();

      // Discriminator (§10.11.1 N3): dropping the `=== "terminal"` check —
      // i.e. `this.busy = false` unconditionally whenever settling is
      // defined — would have cleared busy right here, even though turn 2 is
      // still live, mid-flight, parked on its own permission ask.
      expect(sessionBusy(h.session)).toBe(true);

      // Proof beyond the flag itself: a live user_message sent NOW must be
      // queued (the child steer path), never started as an immediate THIRD
      // turn — the concrete two-concurrent-runTurn consequence the mutation
      // produces in production.
      h.send({ type: "user_message", requestId: "late-1", text: "one more" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.received.filter(isTurnStarted)).toHaveLength(2);
      expect(h.received.filter(isTurnRejected)).toHaveLength(0);
      void req2;
    } finally {
      h.close();
    }
  });
});

describe("Session — child mode: flush-failure drain branch coverage (TASK.102 CUT-S2 §10.11.1 N6)", () => {
  it("(a) flushHistory rejects while the steer queue is non-empty — every queued message gets its own turn_rejected not_ready, the error terminal still publishes exactly once, and the once-latch is set", async () => {
    let rejectFlush: (reason: unknown) => void = () => {};
    const flushHistoryImpl = (): Promise<void> =>
      new Promise<void>((_resolve, reject) => {
        rejectFlush = reject;
      });
    const h = createChildHarness({ steps: [textStep("done")], flushHistoryImpl });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      await h.waitFor(agentEventOf("loop_end"));
      await h.waitUntil(() => h.flushHistory.mock.calls.length > 0);

      // Both queued strictly DURING the gated flush — too late for
      // onChildTurnSettled's own top-level check, only reachable by the
      // catch branch's own reject-loop.
      h.send({ type: "user_message", requestId: "steer-1", text: "first queued" });
      h.send({ type: "user_message", requestId: "steer-2", text: "second queued" });
      // FIFO marker: both sends above are guaranteed routed by the time this
      // resolves, without either having produced a turn_rejected yet.
      h.send({ type: "context_breakdown_request" });
      await h.waitFor(isContextBreakdown);
      expect(h.received.filter(isTurnRejected)).toHaveLength(0);

      rejectFlush(new Error("disk full"));
      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);
      // onTerminal is a local mock (no channel transit needed); the two
      // reject-loop turn_rejected posts still need a tick to cross the
      // (real) MessageChannel into `h.received`.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(h.received.filter(isTurnRejected)).toHaveLength(2);
      expect(h.received.filter(isTurnRejected)).toContainEqual(
        expect.objectContaining({ requestId: "steer-1", reason: "not_ready" }),
      );
      expect(h.received.filter(isTurnRejected)).toContainEqual(
        expect.objectContaining({ requestId: "steer-2", reason: "not_ready" }),
      );
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
      const report = h.onTerminal.mock.calls[0]?.[0];
      expect(report?.status).toBe("error");

      // The once-latch was set on THIS branch too: a late message now hits
      // childTerminalFinalized, never a live ghost turn (O5's contract).
      h.send({ type: "user_message", requestId: "late", text: "still there?" });
      const lateRejected = await h.waitFor(
        (m): m is Of<"turn_rejected"> => isTurnRejected(m) && m.requestId === "late",
      );
      expect(lateRejected.reason).toBe("not_ready");
      expect(h.received.filter(isTurnStarted)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("(b) a throwing child.onTerminal on the flush-failure branch never rejects finalizeChildTerminal — no unhandled rejection reaches the host", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = createChildHarness({
      steps: [textStep("done")],
      flushHistoryImpl: () => Promise.reject(new Error("disk full")),
    });
    h.onTerminal.mockImplementation(() => {
      throw new Error("renderer bridge boom");
    });
    try {
      // Discriminator: pre-fix, `child.onTerminal(...)` on the flush-failure
      // branch is called bare — a throw here rejects finalizeChildTerminal's
      // own returned promise, and the real call site never wraps `await
      // settling` in a try, so an unguarded throw here becomes an unhandled
      // rejection that kills the host.
      await expect(finalizeChildTerminalDirect(h.session)).resolves.toBe("terminal");
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
      expect(
        consoleError.mock.calls.some(
          (call) =>
            typeof call[0] === "string" && call[0].includes("[host]") && call[0].includes("onTerminal") && call[0].includes("error terminal"),
        ),
      ).toBe(true);
    } finally {
      consoleError.mockRestore();
      h.close();
    }
  });
});

describe("Session — child mode: finalizeChildTerminal drain branch never strands a terminal on acceptUserMessage's own refusal (TASK.102 CUT-S2 §10.11.1 N7)", () => {
  it("a queued steer message that acceptUserMessage itself refuses (image support revoked between enqueue and drain) is skipped honestly, not lost — the terminal still commits", async () => {
    let imagesAllowed = true;
    let releaseFlush: () => void = () => {};
    const flushHistoryImpl = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseFlush = resolve;
      });
    const h = createChildHarness({
      steps: [textStep("first")],
      flushHistoryImpl,
      imageInputEnabled: () => imagesAllowed,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      await h.waitFor(agentEventOf("loop_end"));
      await h.waitUntil(() => h.flushHistory.mock.calls.length > 0);

      // Accepted into the queue by enqueueSteerMessage's own (identical)
      // guard while images are still allowed.
      h.send({
        type: "user_message",
        requestId: "steer-img",
        text: "look at this",
        images: [{ mediaType: "image/png", data: "AA==" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.received.filter(isTurnRejected)).toHaveLength(0);

      // Flips BEFORE the drain — acceptUserMessage's OWN guard, re-evaluated
      // at drain time, now refuses the very message enqueueSteerMessage let
      // through a moment ago. Discriminator: pre-fix, the drain branch
      // trusts `acceptUserMessage`'s call blindly and returns "drained" —
      // busy is then held forever (nothing ever clears it) and the terminal
      // never publishes, because nothing was actually started.
      imagesAllowed = false;
      releaseFlush();

      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);
      // onTerminal is a local mock (no channel transit needed); the queued
      // message's own turn_rejected still needs a tick to cross the (real)
      // MessageChannel into `h.received`.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
      expect(h.received.filter(isTurnRejected)).toContainEqual(
        expect.objectContaining({ requestId: "steer-img", reason: "unsupported_images" }),
      );
      // The refusal never started a turn — only the initial programmatic one ever ran.
      expect(h.received.filter(isTurnStarted)).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

describe("Session — child mode: shared startNextQueuedSteerTurn() drain helper (TASK.102 CUT-S2 §10.12.3)", () => {
  it("(Q3-i) a queued image steer refused by acceptUserMessage at onChildTurnSettled's OWN top-level check no longer strands the child — terminal still commits exactly once", async () => {
    let imagesAllowed = true;
    const h = createChildHarness({
      steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()],
      imageInputEnabled: () => imagesAllowed,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      const req = await h.waitFor(isPermissionRequest); // turn 1 parked, still mid-flight

      // Enqueued WHILE turn 1 is still running (before it ever settles) —
      // accepted by enqueueSteerMessage's guard while images are allowed.
      h.send({
        type: "user_message",
        requestId: "steer-img",
        text: "look at this",
        images: [{ mediaType: "image/png", data: "AA==" }],
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.received.filter(isTurnRejected)).toHaveLength(0);

      // Flips BEFORE turn 1 settles — acceptUserMessage's own guard, re-run
      // by onChildTurnSettled's TOP-LEVEL shift+accept (not the LATER
      // finalizeChildTerminal re-check §10.11.1 N7 already covers), now
      // refuses the queued message. Discriminator (pre-fix):
      // onChildTurnSettled calls acceptUserMessage and returns `undefined`
      // unconditionally — the caller then never calls finalizeChildTerminal,
      // so `busy` is held forever and `onTerminal` never fires.
      imagesAllowed = false;
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });

      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
      expect(h.received.filter(isTurnRejected)).toContainEqual(
        expect.objectContaining({ requestId: "steer-img", reason: "unsupported_images" }),
      );
      // The refusal never started a second turn — only turn 1 ever ran.
      expect(h.received.filter(isTurnStarted)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("(Q3-ii) queue [image-steer, text-steer]: the image is refused and skipped, the text steer starts turn #2, and the terminal commits exactly once after it", async () => {
    let imagesAllowed = true;
    const h = createChildHarness({
      steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep(), textStep("steer done")],
      imageInputEnabled: () => imagesAllowed,
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      const req = await h.waitFor(isPermissionRequest); // turn 1 parked

      h.send({
        type: "user_message",
        requestId: "steer-img",
        text: "look at this",
        images: [{ mediaType: "image/png", data: "AA==" }],
      });
      h.send({ type: "user_message", requestId: "steer-text", text: "and also this" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.received.filter(isTurnRejected)).toHaveLength(0);

      // Flips BEFORE turn 1 settles, same trick as Q3-i — only the QUEUED
      // image steer is affected; the text steer carries no attachments and
      // is unaffected by the toggle.
      imagesAllowed = false;
      h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });

      // Discriminator (pre-fix): onChildTurnSettled shifts ONLY the image
      // steer, calls the refusing acceptUserMessage, and returns `undefined`
      // regardless — the text steer is never even reached, `busy` is held
      // forever, and the terminal never commits (both messages stranded).
      await h.waitFor((m): m is Of<"turn_started"> => isTurnStarted(m) && m.requestId === "steer-text", 2_000);
      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(h.received.filter(isTurnRejected)).toContainEqual(
        expect.objectContaining({ requestId: "steer-img", reason: "unsupported_images" }),
      );
      // Engine started exactly twice: turn 1, then the drained text steer.
      expect(h.received.filter(isTurnStarted)).toHaveLength(2);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
    } finally {
      h.close();
    }
  });
});

describe("Session — child mode: Q4 admission gates get mutational discriminators (TASK.102 CUT-S2 §10.12.4)", () => {
  it("(Q4-a, mutational discriminator) startProgrammaticTurn refuses once shutdown() has begun — kills a mutant removing that gate", async () => {
    const h = createChildHarness({ steps: [textStep("done")] });
    try {
      await h.session.shutdown();
      const result = h.session.startProgrammaticTurn("x");
      expect(result).toEqual({ ok: false, reason: "shutting down" });
      expect(h.received.filter(isTurnStarted)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("(Q4-b, mutational discriminator) a steer queued BEFORE shutdown() and still queued when turn #1 settles is honestly rejected, never drained — kills both the onChildTurnSettled and finalizeChildTerminal shutdown-branch mutants", async () => {
    let flushCalled = false;
    let releaseFlush: () => void = () => {};
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    // A second script step exists ONLY so a mutated run (which erroneously
    // starts a "turn #2" from the queued steer) has something real to
    // stream instead of hanging on an exhausted ScriptedModelPort — the
    // correct/unmutated run below never touches it.
    const h = createChildHarness({
      steps: [textStep("done"), textStep("mutant-only-turn-2")],
      envStatus: {
        telemetry: () => null,
        repoMap: () => null,
        flushTelemetry: async () => {
          flushCalled = true;
          await flushGate;
        },
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("go");
      await h.waitFor(agentEventOf("loop_end"));
      // Turn 1's finally() is stuck inside flushTelemetry — BEFORE it ever
      // reaches onChildTurnSettled's own top-level queue check (unlike the
      // §10.11.1 N6/N7 tests above, which gate on flushHistory instead and
      // so land strictly AFTER that check has already run with an empty
      // queue). `busy` is still true here (child path), so the steer below
      // is queued, not started.
      await h.waitUntil(() => flushCalled);

      h.send({ type: "user_message", requestId: "steer-1", text: "and this too" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.received.filter(isTurnRejected)).toHaveLength(0);

      let shutdownSettled = false;
      const shutdownPromise = h.session.shutdown().then(() => {
        shutdownSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shutdownSettled).toBe(false);

      releaseFlush();
      await shutdownPromise;
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(shutdownSettled).toBe(true);
      expect(h.onTerminal).toHaveBeenCalledTimes(1);
      // Engine started exactly once — the queued steer was never drained
      // into a second turn (kills a mutant removing onChildTurnSettled's
      // `!this.shuttingDown` guard, which would otherwise drain it here).
      expect(h.received.filter(isTurnStarted)).toHaveLength(1);
      // The queued steer got an honest reject, not silence (kills a mutant
      // removing finalizeChildTerminal's `if (this.shuttingDown)` branch,
      // which would otherwise try to drain it into a live turn instead of
      // rejecting it, dropping this reply entirely).
      expect(h.received.filter(isTurnRejected)).toContainEqual(
        expect.objectContaining({ requestId: "steer-1", reason: "not_ready" }),
      );
    } finally {
      h.close();
    }
  });
});

// ── activity/progress bridge test helpers (CUT-S2 §10.7) ───────────────────

/**
 * One model STEP proposing MANY parallel tool calls (mirrors core's
 * `runner.test.ts`'s own `multiToolStep` builder) — how the
 * SUBAGENT_ACTIVITY_MAX_EVENTS cap boundary is crossed within a single round
 * in the tests below.
 */
function multiToolStep(calls: ReadonlyArray<{ id: string; name: string; input: unknown }>): ModelStreamEvent[] {
  return [
    { type: "start" },
    ...calls.map((c) => ({ type: "tool_call" as const, toolCall: { id: c.id, name: c.name, input: c.input } })),
    { type: "finish", finishReason: "tool_calls" as const, usage: {} },
  ];
}

/**
 * Narrow test-only escape hatch onto Session's private `observeChildEvent`
 * (CUT-S2 §10.7), used ONLY for scenarios that cannot be driven through a
 * real turn:
 *  - a `tool_result` with no matching `tool_execution_start` — on the real
 *    wire this shape only arises from the scheduler's post-
 *    `workspace_transition` cascade-cancel path (dispatch/scheduler.ts:198-
 *    209), which a child config can never reach (CUT-S2 §2.6.3: it never
 *    receives a WorktreeControlPort) — so the defensive guard can only be
 *    proven by feeding the shape directly.
 *  - the leading-edge 1000ms progress throttle, which needs synchronous,
 *    exact-timestamp control over boundary crossings that a real dispatcher
 *    round-trip cannot offer deterministically.
 * Every OTHER activity/progress assertion in this file drives the REAL
 * AgentLoop + dispatcher via `createChildHarness`'s ScriptedModelPort —
 * calling the real (unmocked) method here still exercises Session's actual
 * production code, not a stub.
 */
function observeChildEventDirect(session: Session, event: AgentEvent): void {
  (session as unknown as { observeChildEvent(e: AgentEvent): void }).observeChildEvent(event);
}

function toolResultEvent(toolCallId: string, toolName = "TodoRead"): AgentEvent {
  return {
    type: "tool_result",
    outcome: { toolCallId, toolName, status: "success", modelText: "", durationMs: 0 },
  };
}

type ActivityReport = Extract<ChildProgressReport, { kind: "activity" }>;
type ProgressReport = Extract<ChildProgressReport, { kind: "progress" }>;

const isActivityReport = (r: ChildProgressReport): r is ActivityReport => r.kind === "activity";
const isProgressReport = (r: ChildProgressReport): r is ProgressReport => r.kind === "progress";

describe("Session — child mode: activity/progress bridge (CUT-S2 §2.6.3/§10.7)", () => {
  describe("activity: 1:1 with the inline eligibility rule (§10.7 п.6a.1)", () => {
    it("a tool_execution_start+tool_result pair produces exactly one activity report, via summarizeChildToolCall", async () => {
      const h = createChildHarness({ steps: [toolStep("w1", "Write", WRITE_INPUT), finishStep()] });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.session.startProgrammaticTurn("write it");
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
        await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);

        const activity = h.onProgress.mock.calls.map((c) => c[0]).filter(isActivityReport);
        expect(activity).toHaveLength(1);
        expect(activity[0]).toEqual({
          kind: "activity",
          toolName: "Write",
          summary: summarizeChildToolCall("Write", WRITE_INPUT),
        });
      } finally {
        h.close();
      }
    });

    it("an invalid_input result produces NEITHER an activity report NOR a suppressed-count increment", async () => {
      const h = createChildHarness({ steps: [toolStep("bad1", "Bash", {}), finishStep()] });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.session.startProgrammaticTurn("do it");
        await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);

        const activity = h.onProgress.mock.calls.map((c) => c[0]).filter(isActivityReport);
        expect(activity).toHaveLength(0);
        const report = h.onTerminal.mock.calls[0]?.[0];
        expect(report && "activitySuppressed" in report).toBe(false);
      } finally {
        h.close();
      }
    });

    it("a tool_result with no matching tool_execution_start produces nothing — the defensive guard mirroring runner.ts's own pending-call check", async () => {
      const h = createChildHarness({ steps: [finishStep()] });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        observeChildEventDirect(h.session, toolResultEvent("orphan-1"));

        const activity = h.onProgress.mock.calls.map((c) => c[0]).filter(isActivityReport);
        expect(activity).toHaveLength(0);
      } finally {
        h.close();
      }
    });
  });

  describe("activity cap: SUBAGENT_ACTIVITY_MAX_EVENTS is a whole-session total, not per-turn (§10.7 п.6a.2)", () => {
    it(
      "caps activity at SUBAGENT_ACTIVITY_MAX_EVENTS across the WHOLE turn chain (initial turn + a later steer turn) and reports the honest suppressed count on the terminal",
      async () => {
        const half = SUBAGENT_ACTIVITY_MAX_EVENTS / 2;
        const initialCalls = [
          { id: "gate", name: "Write", input: WRITE_INPUT },
          ...Array.from({ length: half }, (_unused, i) => ({ id: `i${i}`, name: "TodoRead", input: {} })),
        ];
        const steerCalls = Array.from({ length: half }, (_unused, i) => ({ id: `s${i}`, name: "TodoRead", input: {} }));
        const h = createChildHarness({
          steps: [multiToolStep(initialCalls), finishStep(), multiToolStep(steerCalls), finishStep()],
        });
        try {
          h.send({ type: "ui_ready" });
          await h.waitFor(isHostReady);

          h.session.startProgrammaticTurn("go");
          const req = await h.waitFor(isPermissionRequest, 5_000);

          // Queued while turn 1 (the "gate" Write call) is still busy — proves
          // the cap counter is a SESSION-level field carried across the steer
          // turn, not reset between the initial and the later turn.
          h.send({ type: "user_message", requestId: "steer-1", text: "and the rest" });
          h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });

          await h.waitUntil(() => h.onTerminal.mock.calls.length > 0, 10_000);

          const activity = h.onProgress.mock.calls.map((c) => c[0]).filter(isActivityReport);
          expect(activity).toHaveLength(SUBAGENT_ACTIVITY_MAX_EVENTS);
          const report = h.onTerminal.mock.calls[0]?.[0];
          expect(report?.activitySuppressed).toBe(1);
        } finally {
          h.close();
        }
      },
      15_000,
    );

    it(
      "landing EXACTLY at the cap carries NO activitySuppressed key on the terminal (not a silent zero)",
      async () => {
        const calls = Array.from({ length: SUBAGENT_ACTIVITY_MAX_EVENTS }, (_unused, i) => ({
          id: `t${i}`,
          name: "TodoRead",
          input: {},
        }));
        const h = createChildHarness({ steps: [multiToolStep(calls), finishStep()] });
        try {
          h.send({ type: "ui_ready" });
          await h.waitFor(isHostReady);
          h.session.startProgrammaticTurn("go");
          await h.waitUntil(() => h.onTerminal.mock.calls.length > 0, 10_000);

          const activity = h.onProgress.mock.calls.map((c) => c[0]).filter(isActivityReport);
          expect(activity).toHaveLength(SUBAGENT_ACTIVITY_MAX_EVENTS);
          const report = h.onTerminal.mock.calls[0]?.[0];
          expect(report && "activitySuppressed" in report).toBe(false);
        } finally {
          h.close();
        }
      },
      15_000,
    );
  });

  describe("progress: leading-edge 1000ms throttle, NO trailing timer (§10.7 п.6a.3)", () => {
    it("boundaries at t=0/500/1100 emit at t=0 and t=1100 with CUMULATIVE totals; advancing fake timers with no NEW boundary crossed emits nothing", () => {
      let currentTime = 0;
      const h = createChildHarness({ steps: [finishStep()], now: () => currentTime });
      try {
        vi.useFakeTimers();
        try {
          currentTime = 0;
          observeChildEventDirect(h.session, toolResultEvent("r1", "A"));
          currentTime = 500;
          observeChildEventDirect(h.session, toolResultEvent("r2", "B"));
          currentTime = 1100;
          observeChildEventDirect(h.session, toolResultEvent("r3", "C"));

          const progress = h.onProgress.mock.calls.map((c) => c[0]).filter(isProgressReport);
          // Exactly two emissions: t=0 (leading edge) and t=1100 (>=1000ms
          // after t=0); t=500 is within the 1000ms window and is skipped.
          expect(progress).toHaveLength(2);
          expect(progress[0]).toEqual({ kind: "progress", turns: 0, toolCalls: 1, lastTool: "A" });
          // The skipped t=500 boundary's increment is NOT lost — the second
          // emission carries the cumulative total through all three results.
          expect(progress[1]).toEqual({ kind: "progress", turns: 0, toolCalls: 3, lastTool: "C" });

          const countBefore = h.onProgress.mock.calls.length;
          // No new boundary crossed here — a trailing-timer implementation
          // would register a setTimeout during one of the calls above, which
          // fake timers (armed BEFORE those calls) would intercept; advancing
          // them proves no such timer exists (this is a red test the moment
          // one is added).
          vi.advanceTimersByTime(10_000);
          expect(h.onProgress.mock.calls.length).toBe(countBefore);
        } finally {
          vi.useRealTimers();
        }
      } finally {
        h.close();
      }
    });
  });

  describe("progress counters (§10.7 п.6a.4)", () => {
    it("`turns` is the turn_end COUNT across the whole chain (mirrors runner.ts's turnEndCount — NOT the loop_end-summed childTurns); a steer turn keeps counting; `lastTool` updates on an invalid_input result too", async () => {
      const h = createChildHarness({
        steps: [
          toolStep("gateA", "Write", WRITE_INPUT), // turn A round 1 (permission gate)
          finishStep(), // turn A round 2
          toolStep("bad1", "Bash", {}), // turn B (steer) round 1 — invalid_input
          finishStep(), // turn B round 2
        ],
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);

        h.session.startProgrammaticTurn("go");
        const req = await h.waitFor(isPermissionRequest);

        h.send({ type: "user_message", requestId: "steer-1", text: "and more" });
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });

        await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);

        const progress = h.onProgress.mock.calls.map((c) => c[0]).filter(isProgressReport);
        expect(progress.length).toBeGreaterThan(0);
        const last = progress.at(-1)!;
        // 4 turn_end events total (2 per turn) across BOTH turns: a facade
        // reading loop_end-summed childTurns (which hasn't advanced past
        // turn A's 2 at this point — turn B's own loop_end fires AFTER this
        // boundary) would show 2, not 4; a per-turn-reset facade would show
        // 2 as well.
        expect(last.turns).toBe(4);
        // lastTool tracks the LAST tool_result unconditionally — the final
        // one (Bash, invalid_input) never produced an activity report, but
        // still updated lastTool (mirrors runner.ts:502).
        expect(last.lastTool).toBe("Bash");

        const activity = h.onProgress.mock.calls.map((c) => c[0]).filter(isActivityReport);
        expect(activity.map((a) => a.toolName)).toEqual(["Write"]);
      } finally {
        h.close();
      }
    });
  });

  describe("ordering: onTerminal is always LAST (§10.7 п.6a.5)", () => {
    it("no onProgress call is ever observed after onTerminal", async () => {
      const h = createChildHarness({ steps: [toolStep("w1", "Write", WRITE_INPUT), finishStep()] });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.session.startProgrammaticTurn("go");
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
        await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);

        expect(h.onProgress.mock.calls.length).toBeGreaterThan(0);
        expect(h.onTerminal.mock.invocationCallOrder.length).toBeGreaterThan(0);
        const lastProgressOrder = Math.max(...h.onProgress.mock.invocationCallOrder);
        const terminalOrder = h.onTerminal.mock.invocationCallOrder[0]!;
        expect(terminalOrder).toBeGreaterThan(lastProgressOrder);
      } finally {
        h.close();
      }
    });
  });

  describe("wire contract: every report round-trips through the REAL parseChildProgress (§10.7 п.6a.6)", () => {
    it("every report handed to onProgress, wrapped as {type: CHILD_PROGRESS_TYPE, ...report}, parses non-null — the producer and the frozen parser can never silently diverge", async () => {
      const h = createChildHarness({ steps: [toolStep("w1", "Write", WRITE_INPUT), finishStep()] });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor(isHostReady);
        h.session.startProgrammaticTurn("go");
        const req = await h.waitFor(isPermissionRequest);
        h.send({ type: "permission_response", requestId: req.requestId, behavior: "allow" });
        await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);

        expect(h.onProgress.mock.calls.length).toBeGreaterThan(0);
        for (const [report] of h.onProgress.mock.calls) {
          const wire = { type: CHILD_PROGRESS_TYPE, ...report };
          expect(parseChildProgress(wire)).not.toBeNull();
        }
      } finally {
        h.close();
      }
    });
  });
});

describe("Session — child mode: no name (CUT-S2 §5.14)", () => {
  it("never derives a title — not on the programmatic initial turn, not on a steer message that would obviously heuristic-title", async () => {
    const h = createChildHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.session.startProgrammaticTurn("Build the login page end to end");
      const req = await h.waitFor(isPermissionRequest);

      h.send({ type: "user_message", requestId: "steer-1", text: "Refactor the payments module too" });

      h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });
      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);

      expect(h.touches.some((t) => t.title !== undefined)).toBe(false);
      expect(h.received.some(isTitleChanged)).toBe(false);
    } finally {
      h.close();
    }
  });
});

describe("Session — child mode: startProgrammaticTurn (CUT-S2 §2.6.3)", () => {
  it("refuses a second call even AFTER the first has fully settled — one initial turn per child host lifetime, not merely a busy guard", async () => {
    const h = createChildHarness({ steps: [finishStep(), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      const first = h.session.startProgrammaticTurn("go");
      expect(first).toEqual({ ok: true });
      // Wait for the FIRST turn to fully settle (onTerminal fired, busy back
      // to false) before retrying — a facade that guards only on `busy`
      // (and drops the "already started" latch) would let this second call
      // through once the first is no longer running, so this specifically
      // proves the guard is a per-host-lifetime latch, not a busy check.
      await h.waitUntil(() => h.onTerminal.mock.calls.length > 0);

      const second = h.session.startProgrammaticTurn("go again");
      expect(second.ok).toBe(false);
      expect(h.received.filter(isTurnStarted)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("on a NON-child session (no `child` option) it refuses without ever starting a turn", async () => {
    const h = createHarness({ steps: [finishStep()] });
    try {
      const result = h.session.startProgrammaticTurn("go");
      expect(result).toEqual({ ok: false, reason: "not a child session" });
      expect(h.received.some(isTurnStarted)).toBe(false);
    } finally {
      h.close();
    }
  });
});

describe("Session — child mode: sessionHistory is frozen at construction (CUT-S2 §10.4, mirrors CUT-S1 §9.1 along the child path)", () => {
  it("a live startProgrammaticTurn's events never leak into a later ui_ready's session_history handshake", async () => {
    const bootHistory: HistoryItem[] = [
      { id: "h1", createdAt: 1, message: { role: "user", content: "earlier turn" }, tokenEstimate: 3, kind: "normal" },
    ];
    const h = createChildHarness({ steps: [textStep("live output")], bootHistory });
    try {
      h.send({ type: "ui_ready" });
      const firstHandshake = await h.waitFor(isSessionHistory);
      expect(firstHandshake.items).toHaveLength(1);

      h.session.startProgrammaticTurn("do X");
      await h.waitFor(agentEventOf("loop_end"));

      // Reconnect: Open re-attaching to a live child sends a SECOND ui_ready.
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.filter(isSessionHistory).length === 2);
      const secondHandshake = h.received.filter(isSessionHistory).at(-1) as Of<"session_history">;

      // The turn that just ran produced real agent_events (visible in
      // `received` via agent_event messages), but session_history is the
      // FROZEN boot snapshot built once at construction — it must never grow
      // from a live turn's events, on neither handshake.
      expect(secondHandshake.items).toEqual(firstHandshake.items);
      expect(secondHandshake.items).toHaveLength(1);
      expect(h.received.some((m) => m.type === "agent_event" && m.event.type === "text_delta")).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe("tapChildPermissions (TASK.102 CUT-S2 §0.8/§2.6.3)", () => {
  it("emits attention(true) before forwarding a permission_request and attention(false) before a permission_settled — every message passes through completely unchanged", () => {
    const emitted: HostToUiMessage[] = [];
    const attention: boolean[] = [];
    const tapped = tapChildPermissions(
      (m) => emitted.push(m),
      (waiting) => attention.push(waiting),
    );

    const req: HostToUiMessage = {
      type: "permission_request",
      requestId: "r1",
      toolName: "Bash",
      input: { command: "ls" },
      mode: "build",
      metadata: {
        name: "Bash",
        description: "run a shell command",
        readOnly: false,
        destructive: true,
        riskLevel: "medium",
        sideEffectScope: "process",
      },
    };
    const settled: HostToUiMessage = { type: "permission_settled", requestId: "r1", behavior: "deny", origin: "ui" };
    const other: HostToUiMessage = { type: "task_list", tasks: [] };

    tapped(req);
    tapped(other);
    tapped(settled);

    // Identity-equal — not merely deep-equal — proves the tap never
    // reconstructs or mutates the message on its way through.
    expect(emitted).toEqual([req, other, settled]);
    expect(emitted[0]).toBe(req);
    expect(emitted[1]).toBe(other);
    expect(emitted[2]).toBe(settled);
    expect(attention).toEqual([true, false]);
  });

  it("a message stream with no permission_request/permission_settled never touches onAttention", () => {
    const attention: boolean[] = [];
    const tapped = tapChildPermissions(
      () => {},
      (waiting) => attention.push(waiting),
    );
    tapped({ type: "task_list", tasks: [] });
    tapped({ type: "hooks_list", hooks: [] });
    expect(attention).toEqual([]);
  });
});

// TASK.145 срез 2: the host-side pending-detached-child-report queue seam
// (SessionOptions.pendingChildReports) — resendAll on ui_ready, ack on
// child_report_ack, and the origin plumbing from a wire user_message through
// to the appended/persisted HistoryItem.
describe("Session — TASK.145 срез 2: pendingChildReports seam + origin plumbing", () => {
  const isSessionHistory = (m: HostToUiMessage): m is Of<"session_history"> => m.type === "session_history";
  const isLoopEnd = agentEventOf("loop_end");

  function stubPendingChildReports(): SessionOptions["pendingChildReports"] & {
    resendCalls: number;
    acked: string[];
  } {
    const calls = { resendCalls: 0, acked: [] as string[] };
    return {
      get resendCalls() {
        return calls.resendCalls;
      },
      get acked() {
        return calls.acked;
      },
      resendAll: () => {
        calls.resendCalls += 1;
      },
      ack: (id: string) => {
        calls.acked.push(id);
      },
    };
  }

  it("calls resendAll() on the FIRST ui_ready, right after replay/session_history", async () => {
    const pendingChildReports = stubPendingChildReports();
    const h = createHarness({ steps: [finishStep()], pendingChildReports });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      expect(pendingChildReports.resendCalls).toBe(1);
    } finally {
      h.close();
    }
  });

  it("calls resendAll() AGAIN on a later reconnect ui_ready — the exact race this seam exists to cover (a renderer reload right as a detached child's terminal report was being delivered)", async () => {
    const pendingChildReports = stubPendingChildReports();
    const h = createHarness({ steps: [finishStep()], pendingChildReports });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      expect(pendingChildReports.resendCalls).toBe(1);

      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.filter(isHostReady).length >= 2);
      expect(pendingChildReports.resendCalls).toBe(2);
    } finally {
      h.close();
    }
  });

  it("routes child_report_ack.id to ack() and nothing else", async () => {
    const pendingChildReports = stubPendingChildReports();
    const h = createHarness({ steps: [finishStep()], pendingChildReports });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "child_report_ack", id: "report-1" });
      h.send({ type: "child_report_ack", id: "report-2" });
      // child_report_ack produces no host->ui reply of its own (unlike ui_ready
      // above), so `waitUntil` (which only re-checks on an incoming message)
      // would hang — `flush()` just lets the postMessage delivery settle.
      await h.flush();

      expect(pendingChildReports.acked).toEqual(["report-1", "report-2"]);
    } finally {
      h.close();
    }
  });

  it("an absent pendingChildReports seam (every pre-existing test/harness call) makes ui_ready and child_report_ack harmless no-ops — the session keeps working afterwards, proving neither silently crashed the message-handling task", async () => {
    const h = createHarness({ steps: [finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);
      expect(() => h.send({ type: "child_report_ack", id: "ghost" })).not.toThrow();

      // A second ui_ready still round-trips normally — an unhandled throw
      // inside route()'s async message handler would otherwise silently kill
      // all FURTHER processing on this port without ever surfacing here.
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.filter(isHostReady).length >= 2);
    } finally {
      h.close();
    }
  });

  it("a live user_message.origin:\"system\" stamps the appended HistoryItem's origin — the model-facing role/content stay an ordinary user message either way", async () => {
    const h = createHarness({ steps: [finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "background report", origin: "system" });
      await h.waitFor(isLoopEnd);

      const [item] = h.engine.historyItems();
      expect(item?.origin).toBe("system");
      expect(item?.message).toEqual({ role: "user", content: "background report" });
    } finally {
      h.close();
    }
  });

  it("an ordinary user_message (no origin field) never stamps origin", async () => {
    const h = createHarness({ steps: [finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "hi" });
      await h.waitFor(isLoopEnd);

      const [item] = h.engine.historyItems();
      expect(item?.origin).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it("a persisted origin:\"system\" HistoryItem survives the boot -> session_history wire projection (reload-path parity for the transcript's system-card view)", async () => {
    const bootHistory: HistoryItem[] = [
      {
        id: "h1",
        createdAt: 1,
        message: { role: "user", content: "background report" },
        origin: "system",
      },
      {
        id: "h2",
        createdAt: 2,
        message: { role: "assistant", content: [{ type: "text", text: "ack" }] },
      },
    ];
    const h = createHarness({ steps: [finishStep()], bootHistory });
    try {
      h.send({ type: "ui_ready" });
      const sessionHistory = await h.waitFor(isSessionHistory);

      expect(sessionHistory.items[0]).toMatchObject({ id: "h1", origin: "system" });
      expect(sessionHistory.items[1]).not.toHaveProperty("origin");
    } finally {
      h.close();
    }
  });
});

// ── TASK.162 slice B1 — the desktop half of the adjudicated tier seam (§0b) ──
//
// The child's capability settings must be re-resolved against the live
// USER-SELECTED reasoning tier, never against the parent's model-EFFECTIVE
// effort. This mirrors host/index.ts's wiring exactly — a host-owned
// `selectedEffort` cell fed by CoreEngine's `onReasoningEffortSet` callback AND
// by `switchModelImpl`'s `selectedTier` argument — and drives it through the
// REAL Session message path. `session.ts` itself is deliberately untouched by
// this slice: it already preserves the selected tier across a model switch, and
// the whole point of the amended design is that no change was needed there.
//
// The discriminator: with the parent on a NON-reasoning model, the rejected
// design (reading `parent.reasoningEffort` at spawn time) delivers `undefined`,
// because the parent's effective effort is suppressed by its own model. The
// cell delivers the tier the user actually chose.

interface TierSeamWiring {
  harness: ReturnType<typeof createHarness>;
  /** Every (modelId, tier) pair the child-settings resolver was handed, in order. */
  resolverCalls: { modelId: string; tier: ReasoningEffort | undefined }[];
  /** The ports the child-port factory built, keyed by requested model id. */
  childPorts: Map<string, ScriptedModelPort>;
  /** The ONE runner/config the whole test drives — never rebuilt between rounds. */
  spawnChild: (model: string) => Promise<unknown>;
}

function createTierSeamWiring(bootModel: string): TierSeamWiring {
  const entry = matchCatalogEntryByBaseUrl(getBuiltinCatalog(), "https://api.z.ai/api/anthropic");
  // The host cell: seeded from the boot tier, then kept current by the two
  // writers below and read at spawn time by the resolver closure.
  let selectedEffort: ReasoningEffort = "off";
  let currentModel = bootModel;

  const settingsForChild = buildChildModelSettingsResolver({
    catalogEntry: entry,
    envMaxOutputTokens: undefined,
    envContextWindow: undefined,
  });
  const resolverCalls: { modelId: string; tier: ReasoningEffort | undefined }[] = [];

  const childPorts = new Map<string, ScriptedModelPort>();
  const childPortFactory = (modelId: string): ScriptedModelPort => {
    const port = new ScriptedModelPort([textStep(`child-from-${modelId}`)]);
    childPorts.set(modelId, port);
    return port;
  };

  const config: AgentLoopConfig = {
    modelPort: new ScriptedModelPort([]),
    registry: createDefaultToolRegistry(),
    hooks: new InMemoryHookRunner(),
    permissionEngine: new RuleAwarePermissionEngine(new ModePermissionEngine(), new SessionPermissionRules()),
    permissionBroker: new IpcPermissionBroker(() => {}),
    mode: "build",
    ports: {
      fs: new MemFs(),
      exec: {} as AgentLoopConfig["ports"]["exec"],
      http: new NodeHttpAdapter(),
      todos: new InMemoryTodoStore(),
    },
    cwd: "/workspace",
    reasoningEffort: resolveReasoningEffort(bootModel, entry, selectedEffort),
  };
  // ONE runner for the whole test: the seam is only meaningful if nothing is
  // reconstructed between rounds (a rebuilt closure would trivially observe a
  // fresh tier and prove nothing).
  withSubagents(config, {
    resolveChildModelPort: childPortFactory,
    resolveChildModelSettings: (modelId: string) => {
      resolverCalls.push({ modelId, tier: selectedEffort });
      return settingsForChild(modelId, selectedEffort);
    },
  });

  const loop = new AgentLoop(config);
  // Mirror of host/index.ts's switchModelImpl: the tier assignment first, then
  // the re-budget recipe against the NEW model.
  const switchModelImpl = (
    id: string,
    selectedTier: ReasoningEffort,
  ): { model: string; reasoningEffort: ReasoningEffort; availableEffortLevels?: ReasoningEffort[] } => {
    selectedEffort = selectedTier;
    currentModel = id;
    const resolvedEffort = resolveReasoningEffort(id, entry, selectedTier);
    config.reasoningEffort = resolvedEffort;
    const availableEffortLevels = resolveEffortLevels(id, entry);
    return {
      model: id,
      reasoningEffort: resolvedEffort ?? "off",
      ...(availableEffortLevels !== undefined ? { availableEffortLevels } : {}),
    };
  };
  const engine = new CoreEngine({
    loop,
    config,
    switchModelImpl,
    onReasoningEffortSet: (effort) => {
      selectedEffort = effort ?? "off";
    },
  });

  const harness = createHarness({
    steps: [],
    engine,
    reasoningSupported: true,
    availableEffortLevels: resolveEffortLevels(bootModel, entry),
    selectedEffort,
  });

  return {
    harness,
    resolverCalls,
    childPorts,
    spawnChild: (model: string) =>
      config.subagents!.run(
        { agentType: "general-purpose", description: `child on ${model}`, prompt: "do it", model },
        {},
      ),
  };
}

describe("Session -> CoreEngine -> child-settings seam (TASK.162 §0b: live SELECTED tier)", () => {
  it("carries the user-selected tier to an override child across a switch to a NON-reasoning parent, twice, on one runner", async () => {
    // Boot on glm-5.2 (z-ai catalog: reasoning, levels off/high/max).
    const w = createTierSeamWiring("glm-5.2");
    try {
      w.harness.send({ type: "ui_ready" });
      await w.harness.waitFor(isHostReady);

      // ── round 1: "high" ────────────────────────────────────────────────
      w.harness.send({ type: "set_reasoning_effort", effort: "high" });
      await w.harness.waitFor(
        (m): m is Of<"reasoning_effort_changed"> => m.type === "reasoning_effort_changed",
      );

      // Switch the PARENT to a non-reasoning model. Session keeps its own
      // selected tier; the parent's effective effort collapses.
      w.harness.send({ type: "set_model", model: "glm-4.6" });
      const collapsed = await w.harness.waitFor(isModelChanged);
      expect(collapsed.reasoningEffort).toBe("off");
      expect(collapsed.availableEffortLevels).toBeUndefined();

      await w.spawnChild("glm-5.3-flash");

      expect(w.resolverCalls).toEqual([{ modelId: "glm-5.3-flash", tier: "high" }]);
      const firstChild = w.childPorts.get("glm-5.3-flash");
      expect(firstChild!.requests).toHaveLength(1);
      expect(firstChild!.requests[0]!.reasoningEffort).toBe("high");

      // ── round 2: "low", WITHOUT rebuilding the runner or its closure ───
      // The tier can only be selected while a model that declares it is live:
      // glm-5.3's levels are low/high/max.
      w.harness.send({ type: "set_model", model: "glm-5.3" });
      await w.harness.waitUntil(() => w.harness.received.filter(isModelChanged).length === 2);
      w.harness.send({ type: "set_reasoning_effort", effort: "low" });
      await w.harness.waitUntil(
        () => w.harness.received.filter((m) => m.type === "reasoning_effort_changed").length === 2,
      );
      w.harness.send({ type: "set_model", model: "glm-4.6" });
      await w.harness.waitUntil(() => w.harness.received.filter(isModelChanged).length === 3);

      await w.spawnChild("glm-5.3-flash");

      expect(w.resolverCalls).toEqual([
        { modelId: "glm-5.3-flash", tier: "high" },
        { modelId: "glm-5.3-flash", tier: "low" },
      ]);
      const secondChild = w.childPorts.get("glm-5.3-flash");
      expect(secondChild!.requests).toHaveLength(1);
      expect(secondChild!.requests[0]!.reasoningEffort).toBe("low");
    } finally {
      w.harness.close();
    }
  });

  it("a tier selected with NO model switch after it still reaches the child (the CoreEngine callback is the only writer here)", async () => {
    // Isolates `CoreEngine.onReasoningEffortSet`: without a subsequent
    // `set_model` there is no second writer, so the cell can only be current if
    // the callback fired. The boot seed is "off", which is what a missing
    // callback would leave behind.
    const w = createTierSeamWiring("glm-5.2");
    try {
      w.harness.send({ type: "ui_ready" });
      await w.harness.waitFor(isHostReady);

      w.harness.send({ type: "set_reasoning_effort", effort: "max" });
      await w.harness.waitFor(
        (m): m is Of<"reasoning_effort_changed"> => m.type === "reasoning_effort_changed",
      );

      await w.spawnChild("glm-5.3-flash");

      expect(w.resolverCalls).toEqual([{ modelId: "glm-5.3-flash", tier: "max" }]);
      expect(w.childPorts.get("glm-5.3-flash")!.requests[0]!.reasoningEffort).toBe("max");
    } finally {
      w.harness.close();
    }
  });

  it("a user-selected 'off' reaches the resolver as 'off' — the cell never guesses a tier back", async () => {
    const w = createTierSeamWiring("glm-5.2");
    try {
      w.harness.send({ type: "ui_ready" });
      await w.harness.waitFor(isHostReady);

      w.harness.send({ type: "set_reasoning_effort", effort: "high" });
      await w.harness.waitFor(
        (m): m is Of<"reasoning_effort_changed"> => m.type === "reasoning_effort_changed",
      );
      // Session maps "off" to undefined before calling the engine; the cell
      // stores "off", which resolveReasoningEffort treats as "no effort".
      w.harness.send({ type: "set_reasoning_effort", effort: "off" });
      await w.harness.waitUntil(
        () => w.harness.received.filter((m) => m.type === "reasoning_effort_changed").length === 2,
      );

      await w.spawnChild("glm-5.3-flash");

      expect(w.resolverCalls).toEqual([{ modelId: "glm-5.3-flash", tier: "off" }]);
      const child = w.childPorts.get("glm-5.3-flash");
      expect(child!.requests[0]!.reasoningEffort).toBeUndefined();
    } finally {
      w.harness.close();
    }
  });
});
