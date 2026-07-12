/**
 * BashKill contract guards (Phase 5 slice 5.5, design §2-B7, §6#8). Covers the

 * fail-closed paths, the terminal-task no-op (killed:false), and a real live
 * kill through InProcessTaskManager (killed:true + eventual "killed" status).
 *
 * NOTE (deviation from §6#8 wording, see report): an UNKNOWN id yields an honest

 * distinct from a KNOWN-but-terminal task which returns ok:true, killed:false.
 */

import { describe, expect, it } from "vitest";
import { bashKillTool } from "./bash-kill.js";
import { InProcessTaskManager } from "../tasks/manager.js";
import type { ToolContext } from "../types/tools.js";
import type { CorePorts } from "../ports/index.js";
import type { ExecResult, ExecutionPort } from "../ports/execution.js";
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

function snap(status: BackgroundTaskSnapshot["status"]): BackgroundTaskSnapshot {
  return {
    taskId: "task-1",
    command: "sleep 300",
    status,
    exitCode: status === "completed" ? 0 : null,
    startedAt: 1_000,
    ...(status !== "running" ? { endedAt: 2_000 } : {}),
    outputBytes: 0,
    outputTruncated: false,
  };
}

/** ExecutionPort that resolves to a cancelled result only when aborted. */
function makeAbortableExec(): ExecutionPort {
  return {
    run: (req) =>
      new Promise<ExecResult>((resolve) => {
        req.abortSignal?.addEventListener("abort", () =>
          resolve({
            status: "cancelled",
            exitCode: null,
            signal: "SIGTERM",
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 1,
          }),
        );
      }),
  };
}

describe("bashKillTool — metadata (R7)", () => {
  it("is read-only with a process side-effect scope and no approval", () => {
    expect(bashKillTool.metadata).toMatchObject({
      name: "BashKill",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      riskLevel: "low",
      sideEffectScope: "process",
      needsApproval: false,
    });
  });
});

describe("bashKillTool — fail-closed & unknown id", () => {
  it("returns an unavailable error when no task port is present", async () => {
    const result = await bashKillTool.handler({ task_id: "task-1" }, ctxWith());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not available");
  });

  it("returns an honest error for an unknown task id", async () => {
    const result = await bashKillTool.handler(
      { task_id: "task-404" },
      ctxWith(makeTasks({ get: () => undefined })),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("task-404");
  });
});

describe("bashKillTool — outcome mapping", () => {
  it("reports killed:false for a known but already-terminal task (§6#8)", async () => {
    const tasks = makeTasks({ get: () => snap("completed"), kill: () => false });
    const result = await bashKillTool.handler({ task_id: "task-1" }, ctxWith(tasks));
    expect(result).toEqual({
      ok: true,
      output: { taskId: "task-1", killed: false, status: "completed" },
    });
  });

  it("reports killed:true for a running task", async () => {
    const tasks = makeTasks({ get: () => snap("running"), kill: () => true });
    const result = await bashKillTool.handler({ task_id: "task-1" }, ctxWith(tasks));
    expect(result.ok).toBe(true);
    expect(result.output?.killed).toBe(true);
  });
});

describe("bashKillTool — real live kill through InProcessTaskManager", () => {
  it("kills a live task (killed:true) and the task ends up 'killed'", async () => {
    const manager = new InProcessTaskManager(makeAbortableExec());
    const started = manager.start({ command: "sleep 300", cwd: "/work" });
    expect(started.ok).toBe(true);

    const result = await bashKillTool.handler({ task_id: "task-1" }, ctxWith(manager));
    expect(result.output?.killed).toBe(true);

    // The abort -> reap -> finalize transition is async; disposeAll awaits it.
    await manager.disposeAll();
    expect(manager.get("task-1")?.status).toBe("killed");

    // A second kill of the now-terminal task is a no-op.
    const again = await bashKillTool.handler({ task_id: "task-1" }, ctxWith(manager));
    expect(again.output?.killed).toBe(false);
  });
});
