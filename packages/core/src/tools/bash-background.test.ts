/**
 * background-capable Bash contract guards (Phase 5 slice 5.5, design §2-B5).

 * bashTool), delegation-equivalence of the sync path (§6#12), and the
 * fail-closed / limit-reached background outcomes.
 */

import { describe, expect, it, vi } from "vitest";
import { backgroundCapableBashTool } from "./bash-background.js";
import { bashTool } from "./bash.js";
import type { ToolContext } from "../types/tools.js";
import type { CorePorts } from "../ports/index.js";
import type { ExecRequest, ExecResult, ExecutionPort } from "../ports/execution.js";
import type {
  BackgroundTaskPort,
  BackgroundTaskStartRequest,
  BackgroundTaskStartResult,
} from "../ports/tasks.js";

function makeExec(result: ExecResult, record?: (req: ExecRequest) => void): ExecutionPort {
  return {
    run: async (req) => {
      record?.(req);
      return result;
    },
  };
}

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

function ctxFor(exec: ExecutionPort, overrides?: Partial<ToolContext>): ToolContext {
  return {
    toolCallId: "t1",
    abortSignal: new AbortController().signal,
    cwd: "/work",
    ports: { exec } as unknown as CorePorts,
    ...overrides,
  };
}

const completed: ExecResult = {
  status: "completed",
  exitCode: 0,
  signal: null,
  stdout: "hi\n",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 5,
};

const timedOut: ExecResult = {
  status: "timed_out",
  exitCode: null,
  signal: "SIGTERM",
  stdout: "partial",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 42,
};

describe("backgroundCapableBashTool — permission identity (R3)", () => {
  it("carries the SAME metadata object as bashTool (byte-identical permission path)", () => {
    // Not toEqual — the reference identity is the structural invariant: the
    // permission engine, broker and SafeCommandPermissionEngine all see the
    // exact "Bash"/high-risk profile of the synchronous tool.
    expect(backgroundCapableBashTool.metadata).toBe(bashTool.metadata);
    expect(backgroundCapableBashTool.metadata.name).toBe("Bash");
    expect(backgroundCapableBashTool.metadata.riskLevel).toBe("high");
    expect(backgroundCapableBashTool.metadata.needsApproval).toBe(true);
  });
});

describe("backgroundCapableBashTool — sync delegation equivalence (§6#12, L7)", () => {
  it("returns a byte-identical result to bashTool when run_in_background is absent", async () => {
    const exec = makeExec(completed);
    const bg = await backgroundCapableBashTool.handler({ command: "echo hi" }, ctxFor(exec));
    const sync = await bashTool.handler({ command: "echo hi" }, ctxFor(exec));
    expect(bg).toEqual(sync);
  });

  it("delegates the error/errorKind mapping identically (timed_out)", async () => {
    const exec = makeExec(timedOut);
    const bg = await backgroundCapableBashTool.handler({ command: "sleep 9" }, ctxFor(exec));
    const sync = await bashTool.handler({ command: "sleep 9" }, ctxFor(exec));
    expect(bg).toEqual(sync);
    expect(bg.errorKind).toBe("timed_out");
  });

  it("treats run_in_background:false as the sync path and never touches the task port", async () => {
    const start = vi.fn<() => BackgroundTaskStartResult>(() => ({ ok: true, taskId: "task-9" }));
    const exec = makeExec(completed);
    const result = await backgroundCapableBashTool.handler(
      { command: "echo hi", run_in_background: false },
      ctxFor(exec, { tasks: makeTasks({ start }) }),
    );
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ status: "completed", exitCode: 0 });
    expect(start).not.toHaveBeenCalled();
  });
});

describe("backgroundCapableBashTool — background path", () => {
  it("fails closed with an unavailable error when no task port is present", async () => {
    const exec = makeExec(completed);
    const result = await backgroundCapableBashTool.handler(
      { command: "pnpm test", run_in_background: true },
      ctxFor(exec), // tasks undefined
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not available");
    expect(result.output).toBeUndefined();
  });

  it("starts a task and returns { taskId, status:'running', command } immediately", async () => {
    let seen: BackgroundTaskStartRequest | undefined;
    const start = (req: BackgroundTaskStartRequest): BackgroundTaskStartResult => {
      seen = req;
      return { ok: true, taskId: "task-7" };
    };
    const exec = makeExec(completed);
    const result = await backgroundCapableBashTool.handler(
      { command: "pnpm build", description: "build it", timeout: 5000, run_in_background: true },
      ctxFor(exec, { cwd: "/repo", tasks: makeTasks({ start }) }),
    );
    expect(result).toEqual({
      ok: true,
      output: { taskId: "task-7", status: "running", command: "pnpm build" },
    });
    expect(seen).toEqual({
      command: "pnpm build",
      cwd: "/repo",
      description: "build it",
      timeoutMs: 5000,
    });
  });

  it("surfaces a limit_reached start as an honest error-outcome", async () => {
    const exec = makeExec(completed);
    const start = (): BackgroundTaskStartResult => ({
      ok: false,
      reason: "limit_reached",
      message: "background task limit reached",
    });
    const result = await backgroundCapableBashTool.handler(
      { command: "pnpm test", run_in_background: true },
      ctxFor(exec, { tasks: makeTasks({ start }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("limit reached");
    expect(result.output).toBeUndefined();
  });
});
