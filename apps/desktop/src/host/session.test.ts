/**
 * Session integration tests over a real worker_threads MessageChannel driving
 * the real AgentLoop + dispatcher against a scripted ModelPort (design §10,
 * MVP.3 criteria): event order/completeness with turnId, busy gate, cancel
 * mid-turn (cancelled + denyAll of parked asks), permission allow round-trip,
 * before/after snapshots, the fail-closed snapshot observer, disconnect denyAll,
 * replay on ui_ready, and mode changes only between turns.
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
 */

import { describe, expect, it, vi } from "vitest";
import {
  SessionPermissionRules,
  matchCatalogEntryByBaseUrl,
  resolveEffortLevels,
  resolveReasoningEffort,
} from "@anycode/core";
import { getBuiltinCatalog } from "@anycode/core/catalog";
import type {
  AgentEvent,
  BackgroundTaskNotice,
  BackgroundTaskPort,
  BackgroundTaskSnapshot,
  BackgroundTaskStartRequest,
  BackgroundTaskStartResult,
  CommandHookDeclaration,
  DiagnosticsOutcome,
  ImageAttachment,
  LspServerStatus,
  LspPort,
  ModelRequest,
  TelemetryStatus,
} from "@anycode/core";
import type { SessionEngine } from "./engines/session-engine.js";
import type { HostToUiMessage, ShellCapabilitiesProjection, UiToHostMessage, WireEnvStatus, WirePort } from "../shared/protocol.js";
import type { GitUiBridge } from "./git-bridge.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { Outbound, Session } from "./session.js";
import {
  MemFs,
  ScriptedModelPort,
  ThrowingFs,
  createHarness,
  finishStep,
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
  }): { port: FakeWirePort } {
    const outbound = new Outbound();
    const broker = new IpcPermissionBroker((message) => outbound.emit(message));
    const session = new Session({
      outbound,
      engine: opts.engine ?? buildFakeEngine(),
      broker,
      fs: new MemFs(),
      workspace: "/workspace",
      model: "m1",
      sessionId: "s1",
      rules: new SessionPermissionRules(),
      ...(opts.git !== undefined ? { git: opts.git } : {}),
      ...(opts.shell !== undefined ? { shell: opts.shell } : {}),
    });
    const port = new FakeWirePort();
    session.bindPort(port);
    return { port };
  }

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

  it("rejects a mode change during an active turn and leaves the mode unchanged", async () => {
    const h = createHarness({ steps: [toolStep("c1", "Write", WRITE_INPUT), finishStep()] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor(isHostReady);

      h.send({ type: "user_message", requestId: "r1", text: "write it" });
      const req = await h.waitFor(isPermissionRequest);

      h.send({ type: "set_mode", mode: "yolo" });
      await h.waitFor(isModeChangeRejected);
      expect(h.config.mode).toBe("build");

      h.send({ type: "permission_response", requestId: req.requestId, behavior: "deny" });
      await h.waitFor(agentEventOf("loop_end"));
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
