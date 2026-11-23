import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { NodeFileSystemAdapter } from "../adapters/node/node-file-system.js";
import { NodeHttpAdapter } from "../adapters/node/node-http.js";
import { DenyPermissionBroker, ModePermissionEngine } from "../permissions/index.js";
import type { ExecResult, ExecutionPort } from "../ports/execution.js";
import type { BackgroundTaskPort } from "../ports/tasks.js";
import { bashTool } from "../tools/bash.js";
import { ToolRegistry } from "../tools/registry.js";
import { InMemoryTodoStore } from "../tools/todo-store.js";
import { DEFAULT_TOOL_TIMEOUT_MS, DISPATCH_TIMEOUT_GRACE_MS } from "../types/config.js";
import type { ProposedToolCall } from "../types/events.js";
import type { ToolContext, ToolDefinition, ToolEmittedEvent } from "../types/tools.js";
import { executeToolCall, type DispatchContext } from "./dispatcher.js";
import { InMemoryHookRunner } from "./hook-runner.js";

const childSchema = z.object({ id: z.string(), name: z.string(), input: z.unknown() });
const compositeTool: ToolDefinition<{ children: ProposedToolCall[] }> = {
  metadata: {
    name: "REPL", description: "", readOnly: true, destructive: false,
    concurrentSafe: false, riskLevel: "low", sideEffectScope: "none",
    needsApproval: false, composite: true, timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  },
  inputSchema: z.object({ children: z.array(childSchema) }),
  async handler({ children }, ctx) {
    const results = [];
    for (const child of children) results.push(await ctx.dispatchNested!(child));
    const cancelled = results.some(child => child.status === "cancelled");
    return {
      ok: !cancelled,
      errorKind: cancelled ? "cancelled" : undefined,
      output: results,
    };
  },
};

function fixture(exec: ExecutionPort = new NodeExecutionAdapter()): DispatchContext {
  const registry = new ToolRegistry();
  registry.register(compositeTool);
  registry.register(bashTool);
  return {
    registry, hooks: new InMemoryHookRunner(), permissionEngine: new ModePermissionEngine(),
    permissionBroker: new DenyPermissionBroker(), mode: "yolo", cwd: process.cwd(),
    ports: { fs: new NodeFileSystemAdapter(), exec, http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() },
  };
}

const runParent = (ctx: DispatchContext, children: ProposedToolCall[], signal?: AbortSignal) =>
  executeToolCall(ctx, { id: "parent", name: "REPL", input: { children } }, signal);

afterEach(() => vi.useRealTimers());

it("compositeHasNoOuterDeadline", async () => {
  vi.useFakeTimers();
  const fakeResult: ExecResult = {
    status: "timed_out", exitCode: null, signal: "SIGTERM", stdout: "partial", stderr: "",
    stdoutTruncated: false, stderrTruncated: false, durationMs: 0,
  };
  const run = vi.fn<ExecutionPort["run"]>(request => new Promise(resolve => {
    setTimeout(() => resolve(fakeResult), request.timeoutMs);
  }));
  const ctx = fixture({ run });
  ctx.registry.register({
    metadata: { ...compositeTool.metadata, name: "Direct", composite: undefined },
    inputSchema: z.object({}),
    handler: async () => new Promise(() => {}),
  });
  const outerDeadline = DEFAULT_TOOL_TIMEOUT_MS + DISPATCH_TIMEOUT_GRACE_MS;
  const timeout = outerDeadline + 1_000;
  const nested = runParent(ctx, [{ id: "parent.1", name: "Bash", input: { command: "sleep 100", timeout } }]);
  const ordinary = executeToolCall(ctx, { id: "direct", name: "Direct", input: {} });
  let settled = false;
  void nested.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(outerDeadline);
  expect(await ordinary).toMatchObject({ status: "timed_out" });
  expect(settled).toBe(false);
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: timeout }));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await nested).toMatchObject({
    status: "success",
    result: { output: [{ toolCallId: "parent.1", status: "timed_out", result: { output: { stdout: "partial" } } }] },
  });
});

it("uses the same hook, checkpoint and output policy for nested dispatch", async () => {
  const ctx = fixture();
  const writeToolResultArtifact = vi.fn(async () => ({ path: "/artifact", bytes: 500 }));
  ctx.artifacts = {
    sessionId: "session",
    store: { writeToolResultArtifact, removeSession: async () => {}, sweepExpired: async () => ({ removed: [] }) },
  };
  ctx.tasks = {} as BackgroundTaskPort;
  const ensure = vi.fn(async () => null);
  ctx.checkpoint = { ensure };
  const handler = vi.fn(async (input: { value: string }, child: ToolContext) => {
    expect(child.dispatchNested).toBeUndefined();
    expect(child.artifacts).toBeUndefined();
    expect(child.tasks).toBeUndefined();
    return { ok: true, output: { value: input.value, large: "x".repeat(4_096) } };
  });
  for (const name of ["Read", "Write"]) {
    ctx.registry.register({
      metadata: {
        ...compositeTool.metadata, name, composite: undefined, readOnly: name === "Read",
        resultBudget: { maxModelBytes: 512, strategy: "artifact" },
      },
      inputSchema: z.object({ value: z.string() }),
      handler,
    });
  }
  vi.spyOn(ctx.hooks, "runPreToolUse").mockImplementation(async ({ toolCallId }) => {
    if (toolCallId === "parent.1") return { permissionDecision: "deny", reason: "blocked" };
    if (toolCallId === "parent.3") return { updatedInput: { value: "rewritten" } };
    return {};
  });
  const outcome = await runParent(ctx, ["Write", "Read", "Write"].map((name, index) => ({
    id: `parent.${index + 1}`, name, input: { value: "original" },
  })));
  expect(outcome.result?.output).toMatchObject([
    { status: "denied", modelText: "blocked" },
    { status: "success", result: { output: { value: "original", large: "x".repeat(4_096) } } },
    { status: "success", result: { output: { value: "rewritten" } } },
  ]);
  expect(handler).toHaveBeenCalledTimes(2);
  expect(ensure).toHaveBeenCalledTimes(1);
  expect(writeToolResultArtifact).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "win32")("forwards Stop to a real foreground Bash", async () => {
  const native = new NodeExecutionAdapter();
  const controller = new AbortController();
  let launched!: () => void;
  const ready = new Promise<void>(resolve => { launched = resolve; });
  let childSettledAt = 0;
  const ctx = fixture({
    run: async (request) => {
      const result = await native.run({
        ...request,
        onOutput: output => {
          request.onOutput?.(output);
          if (output.text.includes("started")) launched();
        },
      });
      childSettledAt = performance.now();
      return result;
    },
  });
  const running = runParent(ctx, [{
    id: "parent.1", name: "Bash",
    // `sleep & wait`: the shell runs the TERM trap as soon as it is signalled,
    // instead of only after a foreground sleep exits, so the trap's output
    // lands inside the SIGKILL grace even under a loaded full-suite run.
    input: { command: "trap 'printf stopped; exit 143' TERM; printf 'started\\n'; sleep 30 & wait" },
  }], controller.signal);
  await ready;
  controller.abort();
  expect(await running).toMatchObject({
    status: "cancelled",
    result: { output: [{ status: "cancelled", result: { output: { stdout: expect.stringContaining("stopped") } } }] },
  });
  expect(performance.now() - childSettledAt).toBeLessThan(1_000);
}, 8_000);

it("nestedEventsTravelOnlyThroughParent", async () => {
  const ctx = fixture();
  const events: ToolEmittedEvent[] = [];
  const input = { fields: { command: "printf hello" } };
  ctx.registry.register({
    ...compositeTool,
    async handler(_input, parent) {
      const child = { id: "parent.1", name: "Bash", input: input.fields };
      parent.emit?.({
        type: "repl_call_start", toolCallId: parent.toolCallId,
        callId: child.id, toolName: "Bash", input,
      });
      const result = await parent.dispatchNested!(child);
      const outcome = {
        callId: child.id, toolName: "Bash" as const, input, status: result.status,
        durationMs: result.durationMs, outputPreview: "hello",
      };
      parent.emit?.({ type: "repl_call_end", toolCallId: parent.toolCallId, callId: child.id, outcome });
      return { ok: true, presentation: { repl: { code: "return 42;", calls: [outcome] } } };
    },
  }, { silentDuplicateWarning: true });
  const result = await executeToolCall(
    ctx, { id: "parent", name: "REPL", input: { children: [] } },
    undefined, event => events.push(event),
  );
  expect(events).toEqual([
    { type: "repl_call_start", toolCallId: "parent", callId: "parent.1", toolName: "Bash", input },
    {
      type: "repl_call_end", toolCallId: "parent", callId: "parent.1",
      outcome: result.result?.presentation?.repl?.calls[0],
    },
  ]);
});
