/**
 * Step-by-step tests for the tool-call dispatch pipeline. Registry, hooks,
 * permission engine, broker and handler are all mocked so each pipeline stage
 * can be driven in isolation. The overarching guarantee under test: executeToolCall
 * NEVER throws — every failure path resolves to a ToolCallOutcome.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { checkpointRequired, executeToolCall, type DispatchContext } from "./dispatcher.js";
import type {
  AggregatedPreToolUseResult,
  HookRunner,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from "../types/hooks.js";
import type {
  PermissionBroker,
  PermissionDecision,
  PermissionEngine,
  PermissionRequest,
  PermissionRuling,
  PlanModeControl,
} from "../types/permissions.js";
import type { ProposedToolCall } from "../types/events.js";
import type {
  AnyToolDefinition,
  ToolContext,
  ToolEmittedEvent,
  ToolMetadata,
  ToolResult,
} from "../types/tools.js";
import type {
  CheckpointCaptureResult,
  TurnCheckpointControl,
} from "../ports/checkpoints.js";
import type { BackgroundTaskPort } from "../ports/tasks.js";
import type { LspPort } from "../ports/lsp.js";
import type { MediaCapabilityPort } from "../ports/media.js";
import type { CorePorts } from "../ports/index.js";
import type { ExecResult } from "../ports/execution.js";
import { ToolRegistry } from "../tools/registry.js";
import { bashTool } from "../tools/bash.js";
import { writeTool } from "../tools/write.js";
import { editTool } from "../tools/edit.js";
import { readTool } from "../tools/read.js";
import { globTool } from "../tools/glob.js";
import { grepTool } from "../tools/grep.js";
import { webFetchTool } from "../tools/web-fetch.js";
import { todoWriteTool } from "../tools/todo-write.js";
import { skillTool } from "../tools/skill.js";
import { exitPlanModeTool } from "../tools/exit-plan-mode.js";
import { agentTool } from "../tools/agent.js";
import { workflowTool } from "../tools/workflow.js";
import { bridgeMcpTool } from "../mcp/tool-bridge.js";
import { DISPATCH_TIMEOUT_GRACE_MS } from "../types/config.js";

// ---------------------------------------------------------------------------
// Mock builders

const baseMetadata: ToolMetadata = {
  name: "Mock",
  description: "mock tool",
  readOnly: false,
  destructive: false,
  concurrentSafe: false,
  riskLevel: "low",
  sideEffectScope: "none",
  needsApproval: false,
  timeoutMs: 1_000,
};

function makeTool(overrides: Partial<AnyToolDefinition> = {}): AnyToolDefinition {
  const tool: AnyToolDefinition = {
    metadata: baseMetadata,
    inputSchema: z.object({ value: z.string() }),
    handler: async () => ({ ok: true, output: { done: true } }),
    ...overrides,
  };
  if (overrides.metadata) {
    tool.metadata = { ...baseMetadata, ...overrides.metadata };
  }
  return tool;
}

function makeRegistry(tools: Record<string, AnyToolDefinition>): ToolRegistry {
  return {
    get: (name: string) => tools[name],
  } as unknown as ToolRegistry;
}

interface ObserverCall {
  event: "PostToolUse" | "PostToolUseFailure";
  input: PostToolUseHookInput;
}

function makeHooks(
  result: AggregatedPreToolUseResult = {},
  onCall?: (input: { toolName: string; input: unknown }) => void,
  observers?: ObserverCall[],
): HookRunner {
  return {
    register: () => {},
    runPreToolUse: async (input: PreToolUseHookInput) => {
      onCall?.({ toolName: input.toolName, input: input.input });
      return result;
    },
    runUserPromptSubmit: async () => ({}),
    runObservers: async (
      event: "PostToolUse" | "PostToolUseFailure" | "Stop",
      input: PostToolUseHookInput,
    ) => {
      if (observers && (event === "PostToolUse" || event === "PostToolUseFailure")) {
        observers.push({ event, input });
      }
    },
  } as unknown as HookRunner;
}

function makeThrowingHooks(): HookRunner {
  return {
    register: () => {},
    runPreToolUse: async () => {
      throw new Error("hook runner exploded");
    },
    runUserPromptSubmit: async () => ({}),
    runObservers: async () => {},
  } as unknown as HookRunner;
}

function makeEngine(
  ruling: PermissionRuling,
  onCheck?: (request: PermissionRequest) => void,
): PermissionEngine {
  return {
    check: (request: PermissionRequest) => {
      onCheck?.(request);
      return ruling;
    },
  };
}

function makeBroker(decision: PermissionDecision | (() => Promise<never>)): PermissionBroker {
  return {
    requestPermission: async () => {
      if (typeof decision === "function") return decision();
      return decision;
    },
  };
}

const allowEngine = makeEngine({ decision: "allow" });
const denyBroker = makeBroker({ behavior: "deny", reason: "no interactive client" });

function makeCtx(overrides: Partial<DispatchContext>): DispatchContext {
  return {
    registry: makeRegistry({ Mock: makeTool() }),
    hooks: makeHooks(),
    permissionEngine: allowEngine,
    permissionBroker: denyBroker,
    mode: "build",
    ports: {} as CorePorts,
    cwd: "/work",
    ...overrides,
  };
}

function call(input: unknown = { value: "x" }, name = "Mock"): ProposedToolCall {
  return { id: "call-1", name, input };
}

// ---------------------------------------------------------------------------

describe("executeToolCall — happy path", () => {
  it("runs the handler and reports success with a rendered result", async () => {
    const ctx = makeCtx({});
    const outcome = await executeToolCall(ctx, call());

    expect(outcome.status).toBe("success");
    expect(outcome.toolCallId).toBe("call-1");
    expect(outcome.toolName).toBe("Mock");
    expect(outcome.result).toEqual({ ok: true, output: { done: true } });
    expect(outcome.modelText).toContain("done");
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("prefers the tool's own formatResultForModel", async () => {
    const tool = makeTool({ formatResultForModel: () => "custom text" });
    const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }) });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.modelText).toBe("custom text");
  });

  it("maps a handler result of ok:false to an error outcome", async () => {
    const tool = makeTool({ handler: async () => ({ ok: false, error: "disk full" }) });
    const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }) });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("error");
    expect(outcome.modelText).toBe("disk full");
  });
});

describe("executeToolCall — lookup & validation", () => {
  it("returns an error outcome for an unknown tool", async () => {
    const ctx = makeCtx({ registry: makeRegistry({}) });
    const outcome = await executeToolCall(ctx, call({ value: "x" }, "Ghost"));
    expect(outcome.status).toBe("error");
    expect(outcome.modelText).toContain("Unknown tool: Ghost");
  });

  it("returns invalid_input with zod issues rendered for the model", async () => {
    const ctx = makeCtx({});
    const outcome = await executeToolCall(ctx, call({ value: 123 }));
    expect(outcome.status).toBe("invalid_input");
    expect(outcome.modelText).toContain("Invalid input for Mock");
    expect(outcome.modelText).toContain("value");
  });
});

describe("executeToolCall — hooks", () => {
  it("denies when a PreToolUse hook returns deny (handler never runs)", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const tool = makeTool({ handler });
    const ctx = makeCtx({
      registry: makeRegistry({ Mock: tool }),
      hooks: makeHooks({ permissionDecision: "deny", reason: "policy violation" }),
    });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("denied");
    expect(outcome.modelText).toBe("policy violation");
    expect(handler).not.toHaveBeenCalled();
  });

  it("re-validates a hook rewrite and threads it to the engine and handler", async () => {
    let handlerInput: unknown;
    const engineInputs: unknown[] = [];
    const tool = makeTool({
      handler: async (input) => {
        handlerInput = input;
        return { ok: true, output: input };
      },
    });
    const ctx = makeCtx({
      registry: makeRegistry({ Mock: tool }),
      hooks: makeHooks({ updatedInput: { value: "rewritten" } }),
      permissionEngine: makeEngine({ decision: "allow" }, (req) => engineInputs.push(req.input)),
    });
    const outcome = await executeToolCall(ctx, call({ value: "original" }));
    expect(outcome.status).toBe("success");
    expect(handlerInput).toEqual({ value: "rewritten" });
    expect(engineInputs).toEqual([{ value: "rewritten" }]);
  });

  it("returns invalid_input when a hook rewrite fails re-validation", async () => {
    const ctx = makeCtx({
      hooks: makeHooks({ updatedInput: { value: 999 } }),
    });
    const outcome = await executeToolCall(ctx, call({ value: "original" }));
    expect(outcome.status).toBe("invalid_input");
    expect(outcome.modelText).toContain("value");
  });

  it("escalates to the broker when a hook asks even though the engine allows", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const tool = makeTool({ handler });
    const ctx = makeCtx({
      registry: makeRegistry({ Mock: tool }),
      hooks: makeHooks({ permissionDecision: "ask" }),
      permissionEngine: makeEngine({ decision: "allow" }),
      permissionBroker: denyBroker,
    });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("executeToolCall — permission gate", () => {
  it("denies on an engine deny ruling (handler never runs)", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const tool = makeTool({ handler });
    const ctx = makeCtx({
      registry: makeRegistry({ Mock: tool }),
      permissionEngine: makeEngine({ decision: "deny", reason: "plan mode forbids writes" }),
    });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("denied");
    expect(outcome.modelText).toBe("plan mode forbids writes");
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies fail-closed when the engine asks and the DenyBroker resolves deny", async () => {
    const ctx = makeCtx({
      permissionEngine: makeEngine({ decision: "ask" }),
      permissionBroker: denyBroker,
    });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("denied");
    expect(outcome.modelText).toBe("no interactive client");
  });

  it("proceeds when the engine asks and the broker allows", async () => {
    const ctx = makeCtx({
      permissionEngine: makeEngine({ decision: "ask" }),
      permissionBroker: makeBroker({ behavior: "allow" }),
    });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("success");
  });

  it("re-validates a broker-supplied updatedInput", async () => {
    let handlerInput: unknown;
    const tool = makeTool({
      handler: async (input) => {
        handlerInput = input;
        return { ok: true };
      },
    });
    const ctx = makeCtx({
      registry: makeRegistry({ Mock: tool }),
      permissionEngine: makeEngine({ decision: "ask" }),
      permissionBroker: makeBroker({ behavior: "allow", updatedInput: { value: "from-broker" } }),
    });
    const outcome = await executeToolCall(ctx, call({ value: "orig" }));
    expect(outcome.status).toBe("success");
    expect(handlerInput).toEqual({ value: "from-broker" });
  });
});

describe("executeToolCall — timeout & abort", () => {
  it("times out a hung handler and actually aborts its signal", async () => {
    vi.useFakeTimers();
    try {
      let handlerSignal: AbortSignal | undefined;
      const tool = makeTool({
        metadata: { ...baseMetadata, timeoutMs: 500 },
        handler: (_input, ctx: ToolContext) =>
          new Promise<ToolResult>((_, reject) => {
            handlerSignal = ctx.abortSignal;
            ctx.abortSignal.addEventListener(
              "abort",
              () => reject(new Error("handler observed abort")),
              { once: true },
            );
          }),
      });
      const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }) });

      const promise = executeToolCall(ctx, call());
      // B(2): the dispatcher races handler vs timeoutMs + grace; the reported
      // message still cites the original 500ms.
      await vi.advanceTimersByTimeAsync(500 + DISPATCH_TIMEOUT_GRACE_MS);
      const outcome = await promise;

      expect(outcome.status).toBe("timed_out");
      expect(outcome.modelText).toContain("timed out after 500ms");
      expect(handlerSignal?.aborted).toBe(true);
      expect(handlerSignal?.reason).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a per-call timeout override for tools that declare maxTimeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const tool = makeTool({
        inputSchema: z.object({ value: z.string(), timeout: z.number().optional() }),
        metadata: { ...baseMetadata, timeoutMs: 100_000, maxTimeoutMs: 600_000 },
        handler: (_input, ctx: ToolContext) =>
          new Promise<ToolResult>((_, reject) => {
            ctx.abortSignal.addEventListener("abort", () => reject(new Error("abort")), {
              once: true,
            });
          }),
      });
      const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }) });

      const promise = executeToolCall(ctx, call({ value: "x", timeout: 250 }));
      // Under the metadata default (100_000ms) this would still be pending;
      // the per-call override (250ms) + grace is what fires.
      await vi.advanceTimersByTimeAsync(250 + DISPATCH_TIMEOUT_GRACE_MS);
      const outcome = await promise;
      expect(outcome.status).toBe("timed_out");
      expect(outcome.modelText).toContain("timed out after 250ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a parent-signal abort during handler execution as cancelled", async () => {
    const controller = new AbortController();
    const tool = makeTool({
      handler: (_input, ctx: ToolContext) =>
        new Promise<ToolResult>((_, reject) => {
          // Abort the parent turn the moment the handler starts running.
          controller.abort("user-cancel");
          if (ctx.abortSignal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          ctx.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    });
    const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }) });
    const outcome = await executeToolCall(ctx, call(), controller.signal);
    expect(outcome.status).toBe("cancelled");
  });

  it("returns cancelled without running the handler when the parent is already aborted", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const tool = makeTool({ handler });
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }) });
    const outcome = await executeToolCall(ctx, call(), controller.signal);
    expect(outcome.status).toBe("cancelled");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("executeToolCall — broker contract (design §2.8)", () => {
  it("fills PermissionRequest.toolCallId and passes the turn signal to the broker", async () => {
    const seen: Array<{ request: PermissionRequest; signal: AbortSignal | undefined }> = [];
    const broker: PermissionBroker = {
      requestPermission: async (request, options) => {
        seen.push({ request, signal: options?.signal });
        return { behavior: "allow" };
      },
    };
    const controller = new AbortController();
    const ctx = makeCtx({
      permissionEngine: makeEngine({ decision: "ask" }),
      permissionBroker: broker,
    });

    const outcome = await executeToolCall(ctx, call(), controller.signal);

    expect(outcome.status).toBe("success");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.request.toolCallId).toBe("call-1");
    expect(seen[0]?.signal).toBe(controller.signal);
  });
});

describe("executeToolCall — B(2) errorKind mapping & grace", () => {
  it("maps a handler errorKind to the outcome status and keeps the captured result", async () => {
    const tool = makeTool({
      handler: async () => ({
        ok: false,
        errorKind: "timed_out",
        output: { stdout: "partial" },
        error: "command timed_out",
      }),
    });
    const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }) });
    const outcome = await executeToolCall(ctx, call());

    // The inner layer wins deterministically: named failure -> that status,
    // and the handler result (with captured output) rides along.
    expect(outcome.status).toBe("timed_out");
    expect(outcome.result).toEqual({
      ok: false,
      errorKind: "timed_out",
      output: { stdout: "partial" },
      error: "command timed_out",
    });
  });

  it("maps a cancelled errorKind to a cancelled outcome", async () => {
    const tool = makeTool({
      handler: async () => ({ ok: false, errorKind: "cancelled", error: "command cancelled" }),
    });
    const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }) });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("cancelled");
  });

  // TASK.44: max_turns errorKind (set by the Agent tool for a subagent that hit
  // its turn budget) maps to a max_turns outcome — never success.
  it("maps a max_turns errorKind to a max_turns outcome (never success)", async () => {
    const tool = makeTool({
      handler: async () => ({
        ok: false,
        errorKind: "max_turns",
        output: { status: "max_turns", finalText: "partial" },
        error: "Agent: the subagent reached its max turn limit (8 turns) without finishing.",
      }),
    });
    const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }) });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("max_turns");
    expect(outcome.result?.errorKind).toBe("max_turns");
    // The partial output rides along, same as the timed_out case above.
    expect((outcome.result?.output as { finalText: string }).finalText).toBe("partial");
  });

  it("falls back to error when the handler fails without an errorKind", async () => {
    const tool = makeTool({ handler: async () => ({ ok: false, error: "boom" }) });
    const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }) });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("error");
  });

  it("e2e: a Bash inner timeout produces a timed_out outcome that keeps captured stdout", async () => {
    const execResult: ExecResult = {
      status: "timed_out",
      exitCode: null,
      signal: "SIGKILL",
      stdout: "partial output before kill",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 5,
    };
    const registry = new ToolRegistry();
    registry.register(bashTool);
    const ports = {
      exec: { run: async () => execResult },
    } as unknown as CorePorts;
    const ctx: DispatchContext = {
      registry,
      hooks: makeHooks(),
      permissionEngine: makeEngine({ decision: "allow" }),
      permissionBroker: denyBroker,
      mode: "yolo",
      ports,
      cwd: "/work",
    };

    const outcome = await executeToolCall(ctx, {
      id: "bash-1",
      name: "Bash",
      input: { command: "sleep 5" },
    });

    // B(2) verdict: the ExecutionPort's own timeout wins before the dispatcher
    // grace race, so the outcome is timed_out WITH the captured stdout intact.
    expect(outcome.status).toBe("timed_out");
    expect(outcome.result?.errorKind).toBe("timed_out");
    expect((outcome.result?.output as { stdout: string }).stdout).toBe("partial output before kill");
  });
});

describe("executeToolCall — PostToolUse observers", () => {
  it("fires PostToolUse after a successful outcome", async () => {
    const observers: ObserverCall[] = [];
    const ctx = makeCtx({ hooks: makeHooks({}, undefined, observers) });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("success");
    expect(observers).toHaveLength(1);
    expect(observers[0]?.event).toBe("PostToolUse");
    expect(observers[0]?.input.outcome.status).toBe("success");
    expect(observers[0]?.input.toolCallId).toBe("call-1");
  });

  it("fires PostToolUseFailure after a non-success outcome", async () => {
    const observers: ObserverCall[] = [];
    const tool = makeTool({ handler: async () => ({ ok: false, error: "nope" }) });
    const ctx = makeCtx({
      registry: makeRegistry({ Mock: tool }),
      hooks: makeHooks({}, undefined, observers),
    });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("error");
    expect(observers).toHaveLength(1);
    expect(observers[0]?.event).toBe("PostToolUseFailure");
  });

  it("fires PostToolUseFailure for a denied outcome and passes the effective input", async () => {
    const observers: ObserverCall[] = [];
    const ctx = makeCtx({
      permissionEngine: makeEngine({ decision: "deny", reason: "nope" }),
      hooks: makeHooks({}, undefined, observers),
    });
    const outcome = await executeToolCall(ctx, call({ value: "orig" }));
    expect(outcome.status).toBe("denied");
    expect(observers[0]?.event).toBe("PostToolUseFailure");
    expect(observers[0]?.input.input).toEqual({ value: "orig" });
  });

  it("is fail-open: an observer that throws never disturbs the outcome", async () => {
    const hooks = {
      register: () => {},
      runPreToolUse: async () => ({}),
      runUserPromptSubmit: async () => ({}),
      runObservers: async () => {
        throw new Error("observer exploded");
      },
    } as unknown as HookRunner;
    const ctx = makeCtx({ hooks });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("success");
  });
});

describe("executeToolCall — never throws", () => {
  it("turns a handler throw into an error outcome", async () => {
    const tool = makeTool({
      handler: async () => {
        throw new Error("kaboom");
      },
    });
    const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }) });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("error");
    expect(outcome.modelText).toContain("kaboom");
  });

  it("turns a throwing hook runner into an error outcome instead of propagating", async () => {
    const ctx = makeCtx({ hooks: makeThrowingHooks() });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("error");
    expect(outcome.modelText).toContain("dispatch failed");
  });

  it("turns a throwing broker into an error outcome", async () => {
    const ctx = makeCtx({
      permissionEngine: makeEngine({ decision: "ask" }),
      permissionBroker: makeBroker(async () => {
        throw new Error("broker crashed");
      }),
    });
    const outcome = await executeToolCall(ctx, call());
    expect(outcome.status).toBe("error");
    expect(outcome.modelText).toContain("dispatch failed");
  });

  it("never rejects across every failure-inducing scenario", async () => {
    const scenarios: Array<Promise<unknown>> = [
      executeToolCall(makeCtx({ registry: makeRegistry({}) }), call({}, "Ghost")),
      executeToolCall(makeCtx({}), call({ value: 5 })),
      executeToolCall(makeCtx({ hooks: makeThrowingHooks() }), call()),
      executeToolCall(
        makeCtx({
          registry: makeRegistry({
            Mock: makeTool({
              handler: async () => {
                throw new Error("x");
              },
            }),
          }),
        }),
        call(),
      ),
    ];
    // Promise.all rejects if any inner promise rejects; resolving proves no throw escaped.
    await expect(Promise.all(scenarios)).resolves.toBeDefined();
  });
});

describe("executeToolCall — planMode plumbing (design slice-4.3-cut.md §2.4)", () => {
  const control: PlanModeControl = {
    currentMode: () => "plan",
    exitPlan: () => null,
  };

  function captureTool(sink: { planMode?: PlanModeControl }): AnyToolDefinition {
    return makeTool({
      handler: async (_input, ctx: ToolContext) => {
        sink.planMode = ctx.planMode;
        return { ok: true } as ToolResult;
      },
    });
  }

  it("threads DispatchContext.planMode into the handler's ctx", async () => {
    const sink: { planMode?: PlanModeControl } = {};
    const ctx = makeCtx({ registry: makeRegistry({ Mock: captureTool(sink) }), planMode: control });
    await executeToolCall(ctx, call());
    expect(sink.planMode).toBe(control);
  });

  it("leaves ctx.planMode undefined when the DispatchContext carries none (fail-closed lock)", async () => {
    const sink: { planMode?: PlanModeControl } = { planMode: control };
    const ctx = makeCtx({ registry: makeRegistry({ Mock: captureTool(sink) }) });
    await executeToolCall(ctx, call());
    expect(sink.planMode).toBeUndefined();
  });
});

describe("executeToolCall — tasks plumbing (design slice-5.5-cut.md §2/R3)", () => {
  const tasksPort: BackgroundTaskPort = {
    start: () => ({ ok: true, taskId: "task-1" }),
    get: () => undefined,
    readOutput: () => undefined,
    kill: () => false,
    list: () => [],
    drainNotices: () => [],
    disposeAll: async () => {},
  };

  function captureTool(sink: { tasks?: BackgroundTaskPort }): AnyToolDefinition {
    return makeTool({
      handler: async (_input, ctx: ToolContext) => {
        sink.tasks = ctx.tasks;
        return { ok: true } as ToolResult;
      },
    });
  }

  it("threads DispatchContext.tasks into the handler's ctx", async () => {
    const sink: { tasks?: BackgroundTaskPort } = {};
    const ctx = makeCtx({ registry: makeRegistry({ Mock: captureTool(sink) }), tasks: tasksPort });
    await executeToolCall(ctx, call());
    expect(sink.tasks).toBe(tasksPort);
  });

  it("leaves ctx.tasks undefined when the DispatchContext carries none (fail-closed lock)", async () => {
    const sink: { tasks?: BackgroundTaskPort } = { tasks: tasksPort };
    const ctx = makeCtx({ registry: makeRegistry({ Mock: captureTool(sink) }) });
    await executeToolCall(ctx, call());
    expect(sink.tasks).toBeUndefined();
  });
});

describe("executeToolCall — lsp plumbing (design slice-6.1-cut.md §2/R6)", () => {
  const lspPort: LspPort = {
    diagnosticsAfterWrite: async () => ({ available: false, reason: "no_server" }),
    status: () => [],
    disposeAll: async () => {},
  };

  function captureTool(sink: { lsp?: LspPort }): AnyToolDefinition {
    return makeTool({
      handler: async (_input, ctx: ToolContext) => {
        sink.lsp = ctx.lsp;
        return { ok: true } as ToolResult;
      },
    });
  }

  it("threads DispatchContext.lsp into the handler's ctx", async () => {
    const sink: { lsp?: LspPort } = {};
    const ctx = makeCtx({ registry: makeRegistry({ Mock: captureTool(sink) }), lsp: lspPort });
    await executeToolCall(ctx, call());
    expect(sink.lsp).toBe(lspPort);
  });

  it("leaves ctx.lsp undefined when the DispatchContext carries none (fail-closed lock)", async () => {
    const sink: { lsp?: LspPort } = { lsp: lspPort };
    const ctx = makeCtx({ registry: makeRegistry({ Mock: captureTool(sink) }) });
    await executeToolCall(ctx, call());
    expect(sink.lsp).toBeUndefined();
  });
});

describe("executeToolCall — media plumbing (design slice-6.2-cut.md §2/R3)", () => {
  const mediaPort: MediaCapabilityPort = { imageInputEnabled: () => true };

  function captureTool(sink: { media?: MediaCapabilityPort }): AnyToolDefinition {
    return makeTool({
      handler: async (_input, ctx: ToolContext) => {
        sink.media = ctx.media;
        return { ok: true } as ToolResult;
      },
    });
  }

  it("threads DispatchContext.media into the handler's ctx", async () => {
    const sink: { media?: MediaCapabilityPort } = {};
    const ctx = makeCtx({ registry: makeRegistry({ Mock: captureTool(sink) }), media: mediaPort });
    await executeToolCall(ctx, call());
    expect(sink.media).toBe(mediaPort);
  });

  it("leaves ctx.media undefined when the DispatchContext carries none (fail-closed lock)", async () => {
    const sink: { media?: MediaCapabilityPort } = { media: mediaPort };
    const ctx = makeCtx({ registry: makeRegistry({ Mock: captureTool(sink) }) });
    await executeToolCall(ctx, call());
    expect(sink.media).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

// is asserted against REAL tool metadata (A14); the ensure() seam is driven with
// a recording TurnCheckpointControl and the dispatcher's emit callback.

describe("checkpointRequired — write-effect predicate over real tool metadata (A14)", () => {
  // Frozen bridged MCP metadata is readOnly:false (mcp/tool-bridge.ts) — build a
  // real bridged tool for both transports rather than a hand-rolled object.
  const noopCall = async (): Promise<{ kind: "cancelled" }> => ({ kind: "cancelled" });
  const mcpHttp = bridgeMcpTool({
    serverName: "srv",
    transport: "http",
    tool: { name: "do" },
    callTool: noopCall,
  });
  const mcpStdio = bridgeMcpTool({
    serverName: "srv",
    transport: "stdio",
    tool: { name: "do" },
    callTool: noopCall,
  });

  it("returns true for every write-effect tool (not readOnly, or process-scope)", () => {
    // Write/Edit/Bash: readOnly:false; mcp__*: frozen readOnly:false; Agent/
    // Workflow: readOnly:true but sideEffectScope:"process" (children may write).
    for (const tool of [writeTool, editTool, bashTool, mcpHttp, mcpStdio, agentTool, workflowTool]) {
      expect(checkpointRequired(tool.metadata)).toBe(true);
    }
  });

  it("returns false for every read-only, non-process tool", () => {
    for (const tool of [
      readTool,
      globTool,
      grepTool,
      webFetchTool,
      todoWriteTool,
      skillTool,
      exitPlanModeTool,
    ]) {
      expect(checkpointRequired(tool.metadata)).toBe(false);
    }
  });
});

describe("executeToolCall — auto-checkpoint seam (design slice-4.7-cut.md §2.4)", () => {
  function recordingCheckpoint(
    result: CheckpointCaptureResult | null,
  ): { control: TurnCheckpointControl; ensureCalls: () => number } {
    let calls = 0;
    return {
      control: {
        ensure: async () => {
          calls += 1;
          return result;
        },
      },
      ensureCalls: () => calls,
    };
  }

  const readOnlyMeta: ToolMetadata = {
    ...baseMetadata,
    name: "Read",
    readOnly: true,
    sideEffectScope: "none",
  };

  it("calls ensure() and emits checkpoint_created before the write-effect handler runs", async () => {
    const order: string[] = [];
    const cp = recordingCheckpoint({ kind: "created", id: "cp-123456789", label: "fix the bug" });
    const tool = makeTool({
      handler: async () => {
        order.push("handler");
        return { ok: true };
      },
    });
    const emitted: ToolEmittedEvent[] = [];
    const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }), checkpoint: cp.control });

    await executeToolCall(ctx, call(), undefined, (event) => {
      order.push(event.type);
      emitted.push(event);
    });

    expect(cp.ensureCalls()).toBe(1);
    expect(emitted).toEqual([
      { type: "checkpoint_created", id: "cp-123456789", label: "fix the bug" },
    ]);
    // ensure() (and its event) precede the handler: the checkpoint is taken
    // BEFORE the write effect.
    expect(order).toEqual(["checkpoint_created", "handler"]);
  });

  it("emits checkpoint_failed when the capturer reports a failure", async () => {
    const cp = recordingCheckpoint({ kind: "failed", reason: "git not found" });
    const emitted: ToolEmittedEvent[] = [];
    const ctx = makeCtx({ checkpoint: cp.control });
    await executeToolCall(ctx, call(), undefined, (event) => emitted.push(event));
    expect(cp.ensureCalls()).toBe(1);
    expect(emitted).toEqual([{ type: "checkpoint_failed", reason: "git not found" }]);
  });

  it("emits nothing when ensure() returns skipped (self-disabled capturer)", async () => {
    const cp = recordingCheckpoint({ kind: "skipped" });
    const emitted: ToolEmittedEvent[] = [];
    const ctx = makeCtx({ checkpoint: cp.control });
    await executeToolCall(ctx, call(), undefined, (event) => emitted.push(event));
    expect(cp.ensureCalls()).toBe(1);
    expect(emitted).toEqual([]);
  });

  it("emits nothing when ensure() returns null (already announced this turn)", async () => {
    const cp = recordingCheckpoint(null);
    const emitted: ToolEmittedEvent[] = [];
    const ctx = makeCtx({ checkpoint: cp.control });
    await executeToolCall(ctx, call(), undefined, (event) => emitted.push(event));
    expect(cp.ensureCalls()).toBe(1);
    expect(emitted).toEqual([]);
  });

  it("never calls ensure() for a read-only, non-process tool (laziness)", async () => {
    const cp = recordingCheckpoint({ kind: "created", id: "cp", label: "x" });
    const tool = makeTool({ metadata: readOnlyMeta });
    const emitted: ToolEmittedEvent[] = [];
    const ctx = makeCtx({ registry: makeRegistry({ Mock: tool }), checkpoint: cp.control });
    const outcome = await executeToolCall(ctx, call(), undefined, (event) => emitted.push(event));
    expect(outcome.status).toBe("success");
    expect(cp.ensureCalls()).toBe(0);
    expect(emitted).toEqual([]);
  });

  it("does NOT burn the checkpoint on a denied write call (ensure is post-permission)", async () => {
    const cp = recordingCheckpoint({ kind: "created", id: "cp", label: "x" });
    const emitted: ToolEmittedEvent[] = [];
    const ctx = makeCtx({
      permissionEngine: makeEngine({ decision: "deny", reason: "plan mode forbids writes" }),
      checkpoint: cp.control,
    });
    const outcome = await executeToolCall(ctx, call(), undefined, (event) => emitted.push(event));
    expect(outcome.status).toBe("denied");
    expect(cp.ensureCalls()).toBe(0);
    expect(emitted).toEqual([]);
  });

  it("does NOT capture when the DispatchContext carries no checkpoint (arc asleep)", async () => {
    const emitted: ToolEmittedEvent[] = [];
    const ctx = makeCtx({});
    const outcome = await executeToolCall(ctx, call(), undefined, (event) => emitted.push(event));
    expect(outcome.status).toBe("success");
    expect(emitted).toEqual([]);
  });
});
