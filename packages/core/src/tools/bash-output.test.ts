/**
 * BashOutput contract guards (Phase 5 slice 5.5, design §2-B6, §6#7). Covers the
 * metadata profile (allowed everywhere incl. plan), the two fail-closed paths
 * (no port / unknown id), and the real per-task cursor increment driven through
 * a live InProcessTaskManager with a controllable ExecutionPort — no timers.
 */

import { describe, expect, it } from "vitest";
import { bashOutputTool } from "./bash-output.js";
import { InProcessTaskManager } from "../tasks/manager.js";
import type { ToolContext } from "../types/tools.js";
import type { CorePorts } from "../ports/index.js";
import type { ExecRequest, ExecResult, ExecutionPort } from "../ports/execution.js";
import type {
  BackgroundTaskPort,
  BackgroundTaskSnapshot,
} from "../ports/tasks.js";

function makeTasks(overrides: Partial<BackgroundTaskPort> = {}): BackgroundTaskPort {
  return {
    start: () => ({ ok: true, taskId: "task-1" }),
    get: () => undefined,
    readOutput: () => undefined,
    kill: () => false,
    list: () => [],
    drainNotices: () => [],
    disposeAll: async () => {},
    ...overrides,
  };
}

function ctxWith(tasks?: BackgroundTaskPort): ToolContext {
  return {
    toolCallId: "t1",
    abortSignal: new AbortController().signal,
    cwd: "/work",
    ports: {} as CorePorts,
    ...(tasks !== undefined ? { tasks } : {}),
  };
}

/** ExecutionPort whose run() never resolves on its own; the test pushes chunks. */
function makeControllableExec(): {
  exec: ExecutionPort;
  push: (text: string) => void;
} {
  let onOutput: ExecRequest["onOutput"];
  const exec: ExecutionPort = {
    run: (req) => {
      onOutput = req.onOutput;
      return new Promise<ExecResult>(() => {
        /* stays pending — a live background task */
      });
    },
  };
  return { exec, push: (text) => onOutput?.({ stream: "stdout", text }) };
}

describe("bashOutputTool — metadata", () => {
  it("is read-only, no side effects, no approval (allowed in every mode incl. plan)", () => {
    expect(bashOutputTool.metadata).toMatchObject({
      name: "BashOutput",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
    });
  });
});

describe("bashOutputTool — fail-closed", () => {
  it("returns an unavailable error when no task port is present", async () => {
    const result = await bashOutputTool.handler({ task_id: "task-1" }, ctxWith());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not available");
  });

  it("returns an honest error for an unknown task id", async () => {
    const result = await bashOutputTool.handler(
      { task_id: "task-404" },
      ctxWith(makeTasks({ readOutput: () => undefined })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("task-404");
  });
});

describe("bashOutputTool — snapshot mapping", () => {
  it("maps snapshot fields and computes final runningForMs from endedAt", async () => {
    const snapshot: BackgroundTaskSnapshot = {
      taskId: "task-2",
      command: "pnpm test",
      status: "completed",
      exitCode: 0,
      startedAt: 1_000,
      endedAt: 3_500,
      outputBytes: 3,
      outputTruncated: true,
    };
    const tasks = makeTasks({ readOutput: () => ({ snapshot, newOutput: "abc" }) });
    const result = await bashOutputTool.handler({ task_id: "task-2" }, ctxWith(tasks));
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      taskId: "task-2",
      status: "completed",
      exitCode: 0,
      newOutput: "abc",
      outputTruncated: true,
      runningForMs: 2_500,
    });
  });
});

describe("bashOutputTool — real cursor increment through InProcessTaskManager (§6#7)", () => {
  it("returns only output appended since the previous read, then empty", async () => {
    const { exec, push } = makeControllableExec();
    const manager = new InProcessTaskManager(exec);
    const started = manager.start({ command: "printer", cwd: "/work" });
    expect(started.ok).toBe(true);
    const ctx = ctxWith(manager);

    push("A");
    const r1 = await bashOutputTool.handler({ task_id: "task-1" }, ctx);
    expect(r1.output?.newOutput).toBe("A");
    expect(r1.output?.status).toBe("running");

    push("B");
    const r2 = await bashOutputTool.handler({ task_id: "task-1" }, ctx);
    expect(r2.output?.newOutput).toBe("B");

    const r3 = await bashOutputTool.handler({ task_id: "task-1" }, ctx);
    expect(r3.output?.newOutput).toBe("");

    await manager.disposeAll();
  });
});
