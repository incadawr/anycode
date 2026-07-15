/**
 * Scenario tests for the agent loop driven by a scripted MockModelPort.
 * The model port, registry, hooks, permission engine and broker are all mocked;
 * the real dispatcher (executeToolCall) runs against the fake registry, so these
 * tests exercise loop + dispatch integration end-to-end without the SDK.
 *
 * toToolDeclarations is mocked away since the loop only forwards its result to
 * the (mocked) model port; the fake registry lacks real zod schemas anyway.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../tools/to-model-tools.js", () => ({
  // vi.fn (not a plain arrow) so the contextBreakdown() describe block below can
  // override the declarations per-test via mockReturnValueOnce; every runTurn
  // test above never touches the mock's return value, so this stays the exact
  // same "[]" default they were written against.
  toToolDeclarations: vi.fn(() => []),
}));

import { z } from "zod";
import { APICallError } from "ai";
import { AgentLoop, type AgentLoopConfig, type ContextBreakdown } from "./agent-loop.js";
import { toToolDeclarations } from "../tools/to-model-tools.js";
import type { Tokenizer } from "../context/tokenizer.js";
import type { AgentEvent, ModelStreamEvent } from "../types/events.js";
import type { ModelPort, ModelRequest, CorePorts } from "../ports/index.js";
import type {
  CheckpointCaptureResult,
  CheckpointCapturer,
  TurnCheckpointRequest,
} from "../ports/checkpoints.js";
import type { AnyToolDefinition, ToolContext, ToolMetadata, ToolResult } from "../types/tools.js";
import type { ImageAttachment } from "../types/images.js";
import type { MediaCapabilityPort } from "../ports/media.js";
import type { HookRunner, AggregatedPreToolUseResult } from "../types/hooks.js";
import type {
  PermissionBroker,
  PermissionEngine,
  PermissionMode,
  PermissionRequest,
  PermissionRuling,
} from "../types/permissions.js";
import { ModePermissionEngine } from "../permissions/index.js";
import { exitPlanModeTool } from "../tools/exit-plan-mode.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { WorkspaceTransition } from "../ports/worktrees.js";

// ---------------------------------------------------------------------------
// Mock model port: replays scripted stream events, one step per streamText call.

class MockModelPort implements ModelPort {
  step = 0;
  /** Every ModelRequest received, in call order (for asserting request shape). */
  readonly requests: ModelRequest[] = [];
  constructor(
    private readonly steps: ModelStreamEvent[][],
    private readonly fallback?: ModelStreamEvent[],
  ) {}

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request);
    const events = this.steps[this.step] ?? this.fallback ?? [];
    this.step += 1;
    const signal = request.abortSignal;
    return (async function* () {
      for (const event of events) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        yield event;
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Registry / permission mocks

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
  return {
    metadata: baseMetadata,
    inputSchema: z.object({ value: z.string() }),
    handler: async () => ({ ok: true, output: { result: "ok" } }),
    ...overrides,
  };
}

function makeRegistry(tools: Record<string, AnyToolDefinition>): ToolRegistry {
  return { get: (name: string) => tools[name] } as unknown as ToolRegistry;
}

function makeHooks(result: AggregatedPreToolUseResult = {}): HookRunner {
  return {
    register: () => {},
    runPreToolUse: async () => result,
    runUserPromptSubmit: async () => ({}),
    runObservers: async () => {},
  } as unknown as HookRunner;
}

function makeEngine(ruling: PermissionRuling): PermissionEngine {
  return { check: () => ruling };
}

const denyBroker: PermissionBroker = {
  requestPermission: async () => ({ behavior: "deny", reason: "no client" }),
};

function makeLoop(overrides: Partial<AgentLoopConfig>): AgentLoop {
  const config: AgentLoopConfig = {
    modelPort: new MockModelPort([]),
    registry: makeRegistry({ Mock: makeTool() }),
    hooks: makeHooks(),
    permissionEngine: makeEngine({ decision: "allow" }),
    permissionBroker: denyBroker,
    mode: "build",
    ports: {} as CorePorts,
    cwd: "/work",
    ...overrides,
  };
  return new AgentLoop(config);
}

/** Deterministic 1-char-1-token stub (design slice-P7.17-cut.md tests): makes
 * contextBreakdown()'s subtraction/split arithmetic exact instead of pinned to
 * HeuristicTokenizer's CJK-weighted heuristic. */
const lengthTokenizer: Tokenizer = { count: (text: string) => text.length };

/**
 * Deliberately SUB-ADDITIVE stub (P7.17/F12 W1-FIX P2): every call to count()
 * pays a flat +1 "per-call overhead" on top of the word count, so tokenizing
 * N pieces independently always costs strictly more than tokenizing their
 * concatenation once — e.g. count("a")+count("b")+count("c") = 2+2+2 = 6 but
 * count("a b c") = 4. lengthTokenizer (used by the tests above) is near-
 * additive (character counts just add up across a concatenation), which is
 * exactly why it never exposed the non-additive-tokenization overcount codex
 * found in contextBreakdown(): independently tokenizing each category and
 * summing the results legitimately overshoots a single whole-prompt/whole-
 * history estimate once per-call overhead is in play.
 */
const subAdditiveTokenizer: Tokenizer = {
  count: (text: string) => text.split(/\s+/).filter(Boolean).length + 1,
};

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);

// ---------------------------------------------------------------------------

describe("AgentLoop.runTurn — tool call then completion", () => {
  it("runs a tool step, appends the outcome, then completes on a tool-free step", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "working" },
        { type: "tool_call", toolCall: { id: "c1", name: "Mock", input: { value: "x" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t2", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("please act"));

    expect(types(events)).toEqual([
      "turn_start",
      "start",
      "text_delta",
      "tool_call",
      "finish",
      "context_usage",
      "tool_execution_start",
      "tool_result",
      "turn_end",
      "turn_start",
      "start",
      "text_delta",
      "finish",
      "context_usage",
      "turn_end",
      "loop_end",
    ]);

    const loopEnd = events.at(-1);
    expect(loopEnd).toEqual({ type: "loop_end", reason: "completed", turns: 2 });

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ outcome: { status: "success", toolName: "Mock" } });

    // History: user, assistant(with tool_call), tool(result), assistant("done").
    const messages = loop.history.toMessages();
    expect(messages).toHaveLength(4);
    const [user, assistant, toolMsg, assistant2] = messages;
    expect(user).toEqual({ role: "user", content: "please act" });

    expect(assistant?.role).toBe("assistant");
    expect(Array.isArray(assistant?.content)).toBe(true);
    const assistantParts = assistant?.content as unknown as Array<Record<string, unknown>>;
    expect(assistantParts).toContainEqual({ type: "text", text: "working" });
    expect(assistantParts).toContainEqual({
      type: "tool_call",
      toolCallId: "c1",
      toolName: "Mock",
      input: { value: "x" },
    });

    expect(toolMsg?.role).toBe("tool");
    const toolParts = toolMsg?.content as unknown as Array<Record<string, unknown>>;
    expect(toolParts[0]).toMatchObject({
      type: "tool_result",
      toolCallId: "c1",
      toolName: "Mock",
      text: '{"result":"ok"}',
      status: "success",
    });

    expect(assistant2).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });

    // Every proposed tool_call is answered — the §2.10 integrity invariant.
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
    // HistoryItem envelope: stable ids and cached token estimates on every item.
    for (const item of loop.history.items) {
      expect(item.id).toBeTruthy();
      expect(item.tokenEstimate).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("AgentLoop — workspace terminal control", () => {
  const transition: WorkspaceTransition = {
    kind: "enter_worktree",
    projectRoot: "/work",
    fromWorkspace: "/work",
    toWorkspace: "/work/.anycode/worktrees/task-5",
    worktree: {
      id: "task-5",
      path: "/work/.anycode/worktrees/task-5",
      branch: "anycode-wt/task-5",
      baseRef: "HEAD",
      ownedByAnyCode: true,
    },
  };

  it("pairs later proposals, emits the transition, and ends before another model step", async () => {
    let laterRuns = 0;
    const modelPort = new MockModelPort([
      [
        { type: "tool_call", toolCall: { id: "enter", name: "EnterWorktree", input: { value: "x" } } },
        { type: "tool_call", toolCall: { id: "later", name: "Later", input: { value: "x" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [{ type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const terminal = makeTool({
      metadata: { ...baseMetadata, name: "EnterWorktree", terminalControl: true },
      handler: async () => ({
        ok: true,
        control: { type: "workspace_transition", transition },
      }),
    });
    const later = makeTool({
      metadata: { ...baseMetadata, name: "Later" },
      handler: async () => {
        laterRuns += 1;
        return { ok: true };
      },
    });
    const loop = makeLoop({
      modelPort,
      registry: makeRegistry({ EnterWorktree: terminal, Later: later }),
    });

    const events = await collect(loop.runTurn("isolate this task"));

    expect(modelPort.requests).toHaveLength(1);
    expect(laterRuns).toBe(0);
    expect(events.find((event) => event.type === "workspace_transition")).toEqual({
      type: "workspace_transition",
      transition,
    });
    expect(events.at(-1)).toEqual({
      type: "loop_end",
      reason: "workspace_transition",
      turns: 1,
    });
    expect(
      events
        .filter((event) => event.type === "tool_result")
        .map((event) => event.outcome.status),
    ).toEqual(["success", "cancelled"]);
    expect(loop.history.unansweredToolCallIds()).toEqual([]);
  });

  it("continueTurn starts from persisted history without hooks or a fake user message", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "text_delta", id: "continued", text: "resumed" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const userHook = vi.fn(async () => ({ additionalContext: "must not run" }));
    const hooks = {
      register: () => {},
      runPreToolUse: async () => ({}),
      runUserPromptSubmit: userHook,
      runObservers: async () => {},
    } as unknown as HookRunner;
    const loop = makeLoop({ modelPort, hooks });

    const events = await collect(loop.continueTurn());

    expect(userHook).not.toHaveBeenCalled();
    expect(modelPort.requests).toHaveLength(1);
    expect(modelPort.requests[0]?.messages).toEqual([]);
    expect(loop.history.toMessages()).toEqual([
      { role: "assistant", content: [{ type: "text", text: "resumed" }] },
    ]);
    expect(events.at(-1)).toEqual({ type: "loop_end", reason: "completed", turns: 1 });
  });
});

describe("AgentLoop.runTurn — image attachments (design slice-6.2-cut.md §2-C1)", () => {
  const img: ImageAttachment = { mediaType: "image/png", data: "AAAA", sourcePath: "/x.png" };
  const completeStep: ModelStreamEvent[] = [
    { type: "start" },
    { type: "text_delta", id: "t", text: "seen" },
    { type: "finish", finishReason: "stop", usage: {} },
  ];

  it("attaches options.attachments onto the user message", async () => {
    const loop = makeLoop({ modelPort: new MockModelPort([completeStep]) });
    await collect(loop.runTurn("look at this", { attachments: [img] }));
    const [user] = loop.history.toMessages();
    expect(user).toEqual({ role: "user", content: "look at this", images: [img] });
  });

  it("does NOT create an images key when no attachments are passed (byte-lock)", async () => {
    const loop = makeLoop({ modelPort: new MockModelPort([completeStep]) });
    await collect(loop.runTurn("plain text"));
    const [user] = loop.history.toMessages();
    expect(user).toEqual({ role: "user", content: "plain text" });
    expect(Object.keys(user!)).toEqual(["role", "content"]);
  });

  it("does NOT create an images key for an empty attachments array (byte-lock)", async () => {
    const loop = makeLoop({ modelPort: new MockModelPort([completeStep]) });
    await collect(loop.runTurn("empty", { attachments: [] }));
    const [user] = loop.history.toMessages();
    expect(Object.keys(user!)).toEqual(["role", "content"]);
  });

  it("carries a tool result's images from outcome.result into the tool message", async () => {
    const imageTool = makeTool({
      handler: async () => ({ ok: true, output: { result: "ok" }, images: [img] }),
    });
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "c1", name: "Mock", input: { value: "x" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      completeStep,
    ]);
    const loop = makeLoop({ modelPort, registry: makeRegistry({ Mock: imageTool }) });
    await collect(loop.runTurn("read the image"));
    const toolMsg = loop.history.toMessages().find((m) => m.role === "tool");
    const parts = toolMsg?.content as unknown as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: "tool_result", images: [img] });
  });

  it("does NOT create an images key on a tool result without images (byte-lock)", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "c1", name: "Mock", input: { value: "x" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      completeStep,
    ]);
    const loop = makeLoop({ modelPort });
    await collect(loop.runTurn("plain tool"));
    const toolMsg = loop.history.toMessages().find((m) => m.role === "tool");
    const parts = toolMsg?.content as unknown as Array<Record<string, unknown>>;
    expect("images" in parts[0]!).toBe(false);
  });

  it("threads AgentLoopConfig.media into the dispatched tool ctx", async () => {
    const media: MediaCapabilityPort = { imageInputEnabled: () => true };
    let seen: MediaCapabilityPort | undefined;
    const captureTool = makeTool({
      handler: async (_input, ctx: ToolContext) => {
        seen = ctx.media;
        return { ok: true, output: { result: "ok" } };
      },
    });
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "c1", name: "Mock", input: { value: "x" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      completeStep,
    ]);
    const loop = makeLoop({ modelPort, registry: makeRegistry({ Mock: captureTool }), media });
    await collect(loop.runTurn("go"));
    expect(seen).toBe(media);
  });
});

describe("AgentLoop.runTurn — max turns", () => {
  it("stops with max_turns when the model keeps requesting tools", async () => {
    const toolStep: ModelStreamEvent[] = [
      { type: "tool_call", toolCall: { id: "c", name: "Mock", input: { value: "x" } } },
      { type: "finish", finishReason: "tool_calls", usage: {} },
    ];
    // No explicit steps: every streamText call falls back to a tool-call step.
    const modelPort = new MockModelPort([], toolStep);
    const loop = makeLoop({ modelPort, maxTurns: 2 });

    const events = await collect(loop.runTurn("go"));
    const loopEnd = events.at(-1);
    expect(loopEnd).toEqual({ type: "loop_end", reason: "max_turns", turns: 2 });

    // Two full turns executed before the budget cut off the third.
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(3);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(2);
  });
});

describe("AgentLoop.runTurn — cancellation", () => {
  it("cancels mid-stream and preserves already-emitted events", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "partial" },
        { type: "text_delta", id: "t1", text: "-more" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const loop = makeLoop({ modelPort });
    const controller = new AbortController();

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("hi", { signal: controller.signal })) {
      events.push(event);
      if (event.type === "text_delta") {
        controller.abort();
      }
    }

    // The first text_delta was delivered before the abort took effect.
    expect(types(events)).toContain("text_delta");
    const loopEnd = events.at(-1);
    expect(loopEnd).toMatchObject({ type: "loop_end", reason: "cancelled" });
    // No completion event slipped through.
    expect(events.some((e) => e.type === "loop_end" && e.reason === "completed")).toBe(false);
  });

  it("cancels mid-tool-execution and emits the cancelled outcome then loop_end", async () => {
    const controller = new AbortController();
    const tool = makeTool({
      handler: (_input, ctx: ToolContext) =>
        new Promise<ToolResult>((_, reject) => {
          // Simulate the turn being aborted while the handler is in flight.
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
    const modelPort = new MockModelPort([
      [
        { type: "tool_call", toolCall: { id: "c1", name: "Mock", input: { value: "x" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
    ]);
    const loop = makeLoop({ modelPort, registry: makeRegistry({ Mock: tool }) });

    const events = await collect(loop.runTurn("act", { signal: controller.signal }));

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult).toMatchObject({ outcome: { status: "cancelled" } });
    const loopEnd = events.at(-1);
    expect(loopEnd).toMatchObject({ type: "loop_end", reason: "cancelled" });
  });

  it("ends cancelled without any model call when the signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const modelPort = new MockModelPort([[{ type: "start" }]]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi", { signal: controller.signal }));
    expect(events).toEqual([{ type: "loop_end", reason: "cancelled", turns: 0 }]);
    expect(modelPort.step).toBe(0);
  });
});

describe("AgentLoop.runTurn — stream errors", () => {
  it("ends with error on an in-stream error event", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "error", error: new Error("boom") },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    expect(types(events)).toContain("error");
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("ends with error when the stream iterator throws (non-abort)", async () => {
    const throwingPort: ModelPort = {
      streamText: () =>
        (async function* () {
          yield { type: "start" } as ModelStreamEvent;
          throw new Error("network dead");
        })(),
    };
    const loop = makeLoop({ modelPort: throwingPort });

    const events = await collect(loop.runTurn("hi"));
    // The throw path must surface the real provider failure as a visible
    // {type:"error"} event before loop_end (TASK.2 DoD-c), never swallowed.
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toMatchObject({ type: "error", error: { message: "network dead" } });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("attaches a redacted `safe` descriptor to the terminal error while keeping the raw error in-process (W7b-FIX #2 / DoD-c)", async () => {
    const poisoned = new APICallError({
      message: "HTTP 500 Authorization: Bearer sk-test",
      url: "https://api.example.com/v1",
      requestBodyValues: { apiKey: "sk-test" },
      statusCode: 500,
      responseHeaders: { authorization: "Bearer sk-test" },
      cause: new Error("cause sk-test"),
      isRetryable: false,
      data: undefined,
    });
    const throwingPort: ModelPort = {
      streamText: () =>
        (async function* () {
          yield { type: "start" } as ModelStreamEvent;
          throw poisoned;
        })(),
    };
    const loop = makeLoop({ modelPort: throwingPort });

    const events = await collect(loop.runTurn("hi"));
    const errorEvent = events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
    expect(errorEvent).toBeDefined();
    // The whitelist-derived descriptor carries no secret; every trust boundary
    // renders from it, never from `error`.
    expect(errorEvent?.safe).toEqual({ code: "server", message: "server error", statusCode: 500 });
    expect(JSON.stringify(errorEvent?.safe)).not.toContain("sk-test");
    // Host-local diagnosability (TASK.2 DoD-c): the RAW error still rides the
    // in-process event so session.ts's process log keeps the original text.
    expect((errorEvent?.error as Error).message).toContain("sk-test");
  });

  it("ends cancelled (not error) when the consumer aborts synchronously upon receiving the yielded error event from a stream throw", async () => {
    const controller = new AbortController();
    const throwingPort: ModelPort = {
      streamText: () =>
        (async function* () {
          yield { type: "start" } as ModelStreamEvent;
          throw new Error("network dead");
        })(),
    };
    const loop = makeLoop({ modelPort: throwingPort });

    const events: AgentEvent[] = [];
    for await (const event of loop.runTurn("hi", { signal: controller.signal })) {
      events.push(event);
      if (event.type === "error") {
        controller.abort();
      }
    }

    expect(types(events)).toContain("error");
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "cancelled" });
    expect(events.some((e) => e.type === "loop_end" && e.reason === "error")).toBe(false);
  });

  it("does not forgive an in-stream error when the only finish is a synthetic finishReason:\"error\" (TASK.2 finish-gate hole)", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "error", error: new Error("boom") },
        { type: "finish", finishReason: "error", usage: {} },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    expect(types(events)).toContain("error");
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("forgives an in-stream error when finish still arrives (TASK.2 finish-gate)", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "error", error: new Error("transient artifact") },
        { type: "text_delta", id: "t1", text: "hello" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    expect(types(events)).toContain("error");
    expect(events.some((e) => e.type === "loop_end" && e.reason === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });

    const messages = loop.history.toMessages();
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toEqual({ role: "assistant", content: [{ type: "text", text: "hello" }] });
  });

  it("forgives an in-stream error and continues into tool dispatch when finish arrives", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "error", error: new Error("transient artifact") },
        { type: "tool_call", toolCall: { id: "c1", name: "Mock", input: { value: "x" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("act"));
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events.some((e) => e.type === "loop_end" && e.reason === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });
  });

  it("forgives a trailing in-stream error that arrives after finish", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "hello" },
        { type: "finish", finishReason: "stop", usage: {} },
        { type: "error", error: new Error("trailing artifact") },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    expect(types(events)).toContain("error");
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });
  });

  it("resets both the error and finish flags on stream_retry so a stuck sawFinish from a forgiven pre-retry attempt cannot forgive the final attempt's real error", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t0", text: "pre-retry" },
        { type: "finish", finishReason: "stop", usage: {} },
        { type: "error", error: new Error("pre-retry trailing error") },
        {
          type: "stream_retry",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 0,
          reason: "stream stalled: no events for 90000ms",
        },
        { type: "error", error: new Error("final attempt error") },
        { type: "finish", finishReason: "error", usage: {} },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    expect(types(events)).toContain("stream_retry");
    expect(events.filter((e) => e.type === "loop_end")).toHaveLength(1);
    // If stream_retry failed to reset sawFinish, the pre-retry attempt's real
    // "stop" finish would still be set, and the final attempt's error would be
    // wrongly forgiven as "completed" instead of failing the turn.
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });
});

describe("AgentLoop.runTurn — stream_retry resets step accumulators (design slice-2.3-cut.md, tail 4)", () => {
  it("keeps only the final attempt's text and tool calls after a mid-step stream_retry", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "partial-before-retry" },
        { type: "tool_call", toolCall: { id: "stale", name: "Mock", input: { value: "stale" } } },
        {
          type: "stream_retry",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 0,
          reason: "stream stalled: no events for 90000ms",
        },
        { type: "text_delta", id: "t2", text: "final" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    expect(types(events)).toContain("stream_retry");
    // The stale pre-retry tool call must never reach dispatch.
    expect(events.some((e) => e.type === "tool_execution_start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });

    const messages = loop.history.toMessages();
    const assistant = messages.find((m) => m.role === "assistant");
    // Only the final attempt's text; no duplication and no stale tool_call part.
    expect(assistant).toEqual({ role: "assistant", content: [{ type: "text", text: "final" }] });
  });
});

describe("AgentLoop.runTurn — terminal retry metadata (TASK.33 W7b)", () => {
  function findErrorEvent(events: AgentEvent[]): Extract<AgentEvent, { type: "error" }> | undefined {
    return events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
  }

  it("carries attemptsMade:0 and no maxAttempts on a same-attempt terminal error (no stream_retry this turn)", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "error", error: Object.assign(new Error("invalid api key"), { statusCode: 401 }) },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    const errorEvent = findErrorEvent(events);

    expect(errorEvent?.retry).toEqual({
      attemptsMade: 0,
      retryable: false,
      hadModelOutput: false,
      code: "auth",
    });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("counts attemptsMade across every stream_retry seen this turn and reports it on the terminal error", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 0, reason: "reset" },
        { type: "stream_retry", attempt: 2, maxAttempts: 3, delayMs: 0, reason: "reset" },
        { type: "stream_retry", attempt: 3, maxAttempts: 3, delayMs: 0, reason: "reset" },
        { type: "error", error: new Error("Cannot connect to API: Connect Timeout Error") },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    const errorEvent = findErrorEvent(events);

    expect(errorEvent?.retry).toEqual({
      attemptsMade: 3,
      maxAttempts: 3,
      retryable: true,
      hadModelOutput: false,
      code: "connect_timeout",
    });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("reports hadModelOutput:true when text already streamed before the (unforgiven) terminal error", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "partial" },
        { type: "error", error: new Error("mid-stream boom") },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    const errorEvent = findErrorEvent(events);

    expect(errorEvent?.retry).toEqual({
      attemptsMade: 0,
      retryable: false,
      hadModelOutput: true,
      code: "unknown",
    });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("quota-coherence: retried on every attempt but offers no button — 3 stream_retry, terminal retry {attemptsMade:3, retryable:false, code:quota} (W7b-FIX #2)", async () => {
    // Proves "we auto-retried but do NOT offer the manual button" is a coherent
    // terminal state: a before-content quota-429 auto-retries (429 is retryable)
    // yet a manual Try-again can never succeed.
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "stream_retry", attempt: 1, maxAttempts: 3, delayMs: 0, reason: "quota" },
        { type: "stream_retry", attempt: 2, maxAttempts: 3, delayMs: 0, reason: "quota" },
        { type: "stream_retry", attempt: 3, maxAttempts: 3, delayMs: 0, reason: "quota" },
        {
          type: "error",
          error: Object.assign(new Error("Insufficient quota for this account (code 1308)"), { statusCode: 429 }),
        },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    const errorEvent = findErrorEvent(events);

    expect(events.filter((e) => e.type === "stream_retry")).toHaveLength(3);
    expect(errorEvent?.retry).toEqual({
      attemptsMade: 3,
      maxAttempts: 3,
      retryable: false,
      hadModelOutput: false,
      code: "quota",
    });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("plain-connect-coherence: a thrown plain connect-Error offers the button — 0 stream_retry, terminal retry {attemptsMade:0, retryable:true, code:connect_timeout} (W7b-FIX #2)", async () => {
    // Complement: no auto-retry happened (the shapeless Error gives the port
    // nothing to act on), yet the class is transient so the manual button is
    // offered — no maxAttempts key because the turn never retried.
    const throwingPort: ModelPort = {
      streamText: () =>
        (async function* () {
          yield { type: "start" } as ModelStreamEvent;
          throw new Error("Cannot connect to API: Connect Timeout Error");
        })(),
    };
    const loop = makeLoop({ modelPort: throwingPort });

    const events = await collect(loop.runTurn("hi"));
    const errorEvent = findErrorEvent(events);

    expect(events.some((e) => e.type === "stream_retry")).toBe(false);
    expect(errorEvent?.retry).toEqual({
      attemptsMade: 0,
      retryable: true,
      hadModelOutput: false,
      code: "connect_timeout",
    });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("preserves hadModelOutput:true across a stall stream_retry that fired after model output (W7b-FIX #3)", async () => {
    // The STALL retry path (model-port.ts) deliberately permits a stream_retry
    // AFTER model output has already reached the consumer. Once output was
    // delivered this turn, hadModelOutput must STAY true across the retry — a
    // reset would make the terminal metadata claim no output was delivered and
    // W8 would offer Try-again on a step whose re-send risks double-dispatch
    // (TASK.33 invariant #1).
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "partial answer" },
        {
          type: "stream_retry",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 0,
          reason: "stream stalled: no events for 90000ms",
        },
        { type: "error", error: new Error("boom after stall") },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    const errorEvent = findErrorEvent(events);

    expect(errorEvent?.retry).toEqual({
      attemptsMade: 1,
      maxAttempts: 3,
      retryable: false,
      hadModelOutput: true,
      code: "unknown",
    });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("keeps hadModelOutput:false when no output preceded the failure even after stream_retry (connect class stays green)", async () => {
    // Complement to the fix: with no model output before the failure, the flag
    // must remain false so a genuinely no-output connect failure still offers
    // Try-again (retryable && !hadModelOutput).
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        {
          type: "stream_retry",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 0,
          reason: "stream stalled: no events for 90000ms",
        },
        { type: "error", error: new Error("Cannot connect to API: Connect Timeout Error") },
      ],
    ]);
    const loop = makeLoop({ modelPort });

    const events = await collect(loop.runTurn("hi"));
    const errorEvent = findErrorEvent(events);

    expect(errorEvent?.retry).toEqual({
      attemptsMade: 1,
      maxAttempts: 3,
      retryable: true,
      hadModelOutput: false,
      code: "connect_timeout",
    });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });

  it("enriches the catch-throw error path (stream iterator threw) the same way as an in-stream error event", async () => {
    const throwingPort: ModelPort = {
      streamText: () =>
        (async function* () {
          yield { type: "start" } as ModelStreamEvent;
          throw Object.assign(new Error("server blew up"), { statusCode: 503 });
        })(),
    };
    const loop = makeLoop({ modelPort: throwingPort });

    const events = await collect(loop.runTurn("hi"));
    const errorEvent = findErrorEvent(events);

    expect(errorEvent?.retry).toEqual({
      attemptsMade: 0,
      retryable: true,
      hadModelOutput: false,
      code: "server",
    });
    expect(events.at(-1)).toMatchObject({ type: "loop_end", reason: "error" });
  });
});

describe("AgentLoop.compactNow — manual compaction (design slice-2.3-cut.md, tail 3)", () => {
  function seedFourItemHistory(loop: AgentLoop): void {
    loop.history.append({ role: "user", content: "u1" });
    loop.history.append({ role: "assistant", content: [{ type: "text", text: "a1" }] });
    loop.history.append({ role: "user", content: "u2" });
    loop.history.append({ role: "assistant", content: [{ type: "text", text: "a2" }] });
  }

  it("emits manual compaction_start/end and replaces history with [compact_summary, tail]", async () => {
    const modelPort = new MockModelPort([], [
      { type: "text_delta", id: "s", text: "Summary of the earlier conversation." },
      { type: "finish", finishReason: "stop", usage: {} },
    ]);
    const loop = makeLoop({ modelPort, context: { keepRecentMessages: 0 } });
    seedFourItemHistory(loop);

    const events = await collect(loop.compactNow());
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "compaction_start", trigger: "manual" });
    expect(events[1]).toMatchObject({ type: "compaction_end", ok: true });

    const messages = loop.history.toMessages();
    expect(messages).toHaveLength(3); // [compact_summary, u2, a2]
    expect(messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Summary of the earlier conversation."),
    });
    expect(messages[1]).toEqual({ role: "user", content: "u2" });
    expect(messages[2]).toEqual({ role: "assistant", content: [{ type: "text", text: "a2" }] });
  });

  it("still reaches the model on a second call even after the auto-compact circuit breaker has tripped", async () => {
    const modelPort = new MockModelPort([
      [{ type: "finish", finishReason: "stop", usage: {} }], // empty summary -> 1st attempt fails
      [
        { type: "text_delta", id: "s", text: "Summary." },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const loop = makeLoop({
      modelPort,
      context: { keepRecentMessages: 0, maxConsecutiveCompactionFailures: 1 },
    });
    seedFourItemHistory(loop);

    const firstRun = await collect(loop.compactNow());
    expect(firstRun.at(-1)).toMatchObject({ type: "compaction_end", ok: false });
    expect(modelPort.step).toBe(1);

    // maxConsecutiveCompactionFailures: 1 means the auto-compact breaker has now
    // tripped; a manual call must still reach the model (it never calls
    // shouldAutoCompact/consults the breaker).
    const secondRun = await collect(loop.compactNow());
    expect(secondRun.at(-1)).toMatchObject({ type: "compaction_end", ok: true });
    expect(modelPort.step).toBe(2);
  });

  it("emits compaction_end{ok:false} without touching the model on an empty prefix", async () => {
    const modelPort = new MockModelPort([]);
    const loop = makeLoop({ modelPort });
    loop.history.append({ role: "user", content: "just one message" });

    const events = await collect(loop.compactNow());
    expect(events[0]).toEqual({ type: "compaction_start", trigger: "manual" });
    expect(events[1]).toMatchObject({ type: "compaction_end", ok: false });
    expect(modelPort.step).toBe(0);
  });

  it("leaves the history untouched when the signal is already aborted", async () => {
    const modelPort = new MockModelPort([], [
      { type: "text_delta", id: "s", text: "Summary" },
      { type: "finish", finishReason: "stop", usage: {} },
    ]);
    const loop = makeLoop({ modelPort, context: { keepRecentMessages: 0 } });
    seedFourItemHistory(loop);
    const before = loop.history.toMessages();

    const controller = new AbortController();
    controller.abort();
    const events = await collect(loop.compactNow({ signal: controller.signal }));
    expect(events.at(-1)).toMatchObject({ type: "compaction_end", ok: false });
    expect(loop.history.toMessages()).toEqual(before);
  });
});

describe("AgentLoop.runTurn — system prompt", () => {
  it("passes the system prompt out-of-band on every step and keeps it out of history", async () => {
    const completedStep: ModelStreamEvent[] = [
      { type: "text_delta", id: "t", text: "hi" },
      { type: "finish", finishReason: "stop", usage: {} },
    ];
    const modelPort = new MockModelPort([completedStep, completedStep]);
    const loop = makeLoop({ modelPort, systemPrompt: "you are a helper" });

    await collect(loop.runTurn("first"));
    await collect(loop.runTurn("second"));

    // Every model request carries the system prompt as ModelRequest.system.
    expect(modelPort.requests).toHaveLength(2);
    for (const request of modelPort.requests) {
      expect(request.system).toBe("you are a helper");
      expect(request.messages.every((m) => ["user", "assistant", "tool"].includes(m.role))).toBe(
        true,
      );
    }

    // History stays pure user/assistant/tool: (user, assistant) * 2.
    const messages = loop.history.toMessages();
    expect(messages[0]).toEqual({ role: "user", content: "first" });
    expect(messages).toHaveLength(4);
  });

  it("adds ephemeral system context to one run without changing user history or later runs", async () => {
    const completedStep: ModelStreamEvent[] = [
      { type: "start" },
      { type: "finish", finishReason: "stop", usage: {} },
    ];
    const modelPort = new MockModelPort([completedStep, completedStep]);
    const loop = makeLoop({ modelPort, systemPrompt: "base system" });

    await collect(loop.runTurn("first", { systemContext: "workspace changed" }));
    await collect(loop.runTurn("second"));

    expect(modelPort.requests[0]?.system).toBe("base system\n\nworkspace changed");
    expect(modelPort.requests[1]?.system).toBe("base system");
    expect(modelPort.requests[0]?.messages[0]).toEqual({ role: "user", content: "first" });
    expect(loop.history.toMessages().filter((message) => message.role === "user")).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Plan-mode exit arc (design slice-4.3-cut.md §2.3/§5.2 item 1). The real
// ModePermissionEngine drives rulings so the mid-turn mode flip is observable
// through what the broker is asked to approve; a recording allow-broker stands
// in for the human, and the real exitPlanModeTool is registered alongside a
// non-readOnly "Write" mock.

function recordingAllowBroker(seen: PermissionRequest[]): PermissionBroker {
  return {
    requestPermission: async (request: PermissionRequest) => {
      seen.push(request);
      return { behavior: "allow" };
    },
  };
}

function toolResult(events: AgentEvent[], toolName: string) {
  for (const event of events) {
    if (event.type === "tool_result" && event.outcome.toolName === toolName) {
      return event.outcome;
    }
  }
  return undefined;
}

const writeMock = makeTool({
  metadata: { ...baseMetadata, name: "Write" },
  handler: async () => ({ ok: true, output: { written: true } }),
});

function makePlanLoop(overrides: {
  modelPort: MockModelPort;
  seen: PermissionRequest[];
  mode: PermissionMode;
  planExitMode?: "build" | "edit" | "auto";
  onModeChange?: (mode: PermissionMode) => void;
}): AgentLoop {
  return makeLoop({
    modelPort: overrides.modelPort,
    registry: makeRegistry({ ExitPlanMode: exitPlanModeTool, Write: writeMock }),
    permissionEngine: new ModePermissionEngine(),
    permissionBroker: recordingAllowBroker(overrides.seen),
    mode: overrides.mode,
    ...(overrides.planExitMode !== undefined ? { planExitMode: overrides.planExitMode } : {}),
    ...(overrides.onModeChange !== undefined ? { onModeChange: overrides.onModeChange } : {}),
  });
}

describe("AgentLoop.runTurn — plan-mode exit arc (design §2.3)", () => {
  it("an approved ExitPlanMode escalates a LATER same-turn Write into build (ask), not plan (deny)", async () => {
    const seen: PermissionRequest[] = [];
    const onModeChange = vi.fn();
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "p1", name: "ExitPlanMode", input: { plan: "do the thing" } } },
        { type: "tool_call", toolCall: { id: "w1", name: "Write", input: { value: "y" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const loop = makePlanLoop({ modelPort, seen, mode: "plan", planExitMode: "build", onModeChange });

    const events = await collect(loop.runTurn("please plan"));

    // The plan approval succeeded and told the model it may proceed.
    const exit = toolResult(events, "ExitPlanMode");
    expect(exit?.status).toBe("success");
    expect(exit?.modelText).toContain("Plan approved");

    // The arc fired exactly once, advancing to build.
    expect(onModeChange).toHaveBeenCalledTimes(1);
    expect(onModeChange).toHaveBeenCalledWith("build");

    // The mid-turn proof: the Write's PermissionRequest was built in BUILD mode
    // (had the flip not happened it would have been a plan-deny before the broker).
    const writeRequest = seen.find((request) => request.toolName === "Write");
    expect(writeRequest?.mode).toBe("build");
    expect(toolResult(events, "Write")?.status).toBe("success");
  });

  it("advances config.mode so a subsequent turn's Write is build (ask), not plan (deny)", async () => {
    const seen: PermissionRequest[] = [];
    const onModeChange = vi.fn();
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "p1", name: "ExitPlanMode", input: { plan: "the plan" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [{ type: "start" }, { type: "finish", finishReason: "stop", usage: {} }],
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "w1", name: "Write", input: { value: "y" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [{ type: "start" }, { type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const loop = makePlanLoop({ modelPort, seen, mode: "plan", planExitMode: "build", onModeChange });

    await collect(loop.runTurn("plan it"));
    const secondTurn = await collect(loop.runTurn("now write"));

    expect(onModeChange).toHaveBeenCalledTimes(1);
    const writeRequest = seen.find((request) => request.toolName === "Write");
    expect(writeRequest?.mode).toBe("build");
    expect(toolResult(secondTurn, "Write")?.status).toBe("success");
  });

  it("exitPlan is a null no-op when the turn is not in plan mode (zero mutations)", async () => {
    const seen: PermissionRequest[] = [];
    const onModeChange = vi.fn();
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "p1", name: "ExitPlanMode", input: { plan: "the plan" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [{ type: "start" }, { type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const loop = makePlanLoop({ modelPort, seen, mode: "build", planExitMode: "build", onModeChange });

    const events = await collect(loop.runTurn("try to exit"));

    const exit = toolResult(events, "ExitPlanMode");
    expect(exit?.status).toBe("error");
    expect(exit?.modelText).toContain("not in plan mode (current mode: build)");
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("fails closed as 'unavailable' when planExitMode is unset (no control is built)", async () => {
    const seen: PermissionRequest[] = [];
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "p1", name: "ExitPlanMode", input: { plan: "the plan" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [{ type: "start" }, { type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const loop = makePlanLoop({ modelPort, seen, mode: "plan" });

    const events = await collect(loop.runTurn("try to exit"));

    const exit = toolResult(events, "ExitPlanMode");
    expect(exit?.status).toBe("error");
    expect(exit?.modelText).toContain("unavailable");
  });

  it("still honours the per-turn options.mode override (snapshotted at entry)", async () => {
    const seen: PermissionRequest[] = [];
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "w1", name: "Write", input: { value: "y" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [{ type: "start" }, { type: "finish", finishReason: "stop", usage: {} }],
    ]);
    const loop = makePlanLoop({ modelPort, seen, mode: "plan", planExitMode: "build" });

    // config.mode is plan, but the per-turn override says build: the Write must be
    // evaluated in build (ask -> broker), proving the snapshot uses options.mode.
    const events = await collect(loop.runTurn("write it", { mode: "build" }));

    const writeRequest = seen.find((request) => request.toolName === "Write");
    expect(writeRequest?.mode).toBe("build");
    expect(toolResult(events, "Write")?.status).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// Auto-checkpoint arc (design slice-4.7-cut.md §2.4). The loop threads a
// promise-memoized TurnCheckpointControl into the DispatchContext when
// config.checkpoints is set; the first write-effect tool of the turn captures
// exactly once. `writeMock` (readOnly:false) trips checkpointRequired; a
// concurrentSafe process-scope "Agent" mock drives the parallel-batch race.

interface CapturerProbe {
  port: CheckpointCapturer;
  calls: TurnCheckpointRequest[];
}

function makeCapturer(result: CheckpointCaptureResult, opts?: { delayMs?: number }): CapturerProbe {
  const calls: TurnCheckpointRequest[] = [];
  return {
    calls,
    port: {
      capture: async (req: TurnCheckpointRequest) => {
        calls.push(req);
        if (opts?.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
        }
        return result;
      },
    },
  };
}

// Agent-shaped mock: readOnly:true + process-scope (trips checkpointRequired via
// the process branch) + concurrentSafe (two calls batch in parallel).
const agentLikeConcurrent = makeTool({
  metadata: {
    ...baseMetadata,
    name: "Agent",
    readOnly: true,
    sideEffectScope: "process",
    concurrentSafe: true,
  },
  handler: async () => ({ ok: true, output: { spawned: true } }),
});

const createdResult: CheckpointCaptureResult = {
  kind: "created",
  id: "cp-abcdef123456",
  label: "do the write",
};

function writeStep(...ids: string[]): ModelStreamEvent[] {
  return [
    ...ids.map(
      (id): ModelStreamEvent => ({
        type: "tool_call",
        toolCall: { id, name: "Write", input: { value: id } },
      }),
    ),
    { type: "finish", finishReason: "tool_calls", usage: {} },
  ];
}

const stopStep: ModelStreamEvent[] = [{ type: "finish", finishReason: "stop", usage: {} }];

describe("AgentLoop.runTurn — auto-checkpoint arc (design slice-4.7-cut.md §2.4)", () => {
  it("never invokes the capturer on a read-only turn (laziness — zero git, zero disk)", async () => {
    const cap = makeCapturer(createdResult);
    // The only tool is the default read-only-none Mock; no write effect all turn.
    const readOnlyMock = makeTool({
      metadata: { ...baseMetadata, name: "Reader", readOnly: true, sideEffectScope: "none" },
    });
    const modelPort = new MockModelPort([
      [
        { type: "tool_call", toolCall: { id: "r1", name: "Reader", input: { value: "x" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      stopStep,
    ]);
    const loop = makeLoop({
      modelPort,
      registry: makeRegistry({ Reader: readOnlyMock }),
      checkpoints: cap.port,
    });

    const events = await collect(loop.runTurn("just read"));

    expect(cap.calls).toHaveLength(0);
    expect(events.some((e) => e.type.startsWith("checkpoint_"))).toBe(false);
  });

  it("captures exactly once for a turn with two sequential write tools", async () => {
    const cap = makeCapturer(createdResult);
    const modelPort = new MockModelPort([writeStep("w1", "w2"), stopStep]);
    const loop = makeLoop({
      modelPort,
      registry: makeRegistry({ Write: writeMock }),
      checkpoints: cap.port,
    });

    const events = await collect(loop.runTurn("do the write"));

    // One capture for the whole turn even though two writes trip the predicate.
    expect(cap.calls).toHaveLength(1);
    // And exactly one announcement event (the second write's ensure() returns null).
    expect(events.filter((e) => e.type === "checkpoint_created")).toHaveLength(1);
  });

  it("captures exactly once for a PARALLEL concurrentSafe batch (promise-memoization, A7/A3)", async () => {
    // delayMs keeps the capture in flight while BOTH parallel ensure() calls run:
    // a flag-set-after-await memoization would double-capture here; the
    // promise-memoized `pending ??= capture(...)` resolves both to one in-flight call.
    const cap = makeCapturer(createdResult, { delayMs: 15 });
    const modelPort = new MockModelPort([
      [
        { type: "tool_call", toolCall: { id: "a1", name: "Agent", input: { value: "x" } } },
        { type: "tool_call", toolCall: { id: "a2", name: "Agent", input: { value: "y" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      stopStep,
    ]);
    const loop = makeLoop({
      modelPort,
      registry: makeRegistry({ Agent: agentLikeConcurrent }),
      checkpoints: cap.port,
    });

    const events = await collect(loop.runTurn("spawn two agents"));

    expect(cap.calls).toHaveLength(1);
    expect(events.filter((e) => e.type === "checkpoint_created")).toHaveLength(1);
    // Both Agent calls still produced their outcomes.
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(2);
  });

  it("emits checkpoint_created in-stream BEFORE the triggering tool's tool_result", async () => {
    const cap = makeCapturer(createdResult);
    const modelPort = new MockModelPort([writeStep("w1"), stopStep]);
    const loop = makeLoop({
      modelPort,
      registry: makeRegistry({ Write: writeMock }),
      checkpoints: cap.port,
    });

    const events = await collect(loop.runTurn("do the write"));

    const createdIdx = events.findIndex((e) => e.type === "checkpoint_created");
    const resultIdx = events.findIndex(
      (e) => e.type === "tool_result" && e.outcome.toolName === "Write",
    );
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(createdIdx);
    const created = events[createdIdx];
    expect(created).toEqual({ type: "checkpoint_created", id: "cp-abcdef123456", label: "do the write" });
  });

  it("emits a single checkpoint_failed when the capturer reports failure", async () => {
    const cap = makeCapturer({ kind: "failed", reason: "git binary not found" });
    const modelPort = new MockModelPort([writeStep("w1", "w2"), stopStep]);
    const loop = makeLoop({
      modelPort,
      registry: makeRegistry({ Write: writeMock }),
      checkpoints: cap.port,
    });

    const events = await collect(loop.runTurn("do the write"));

    const failures = events.filter((e) => e.type === "checkpoint_failed");
    expect(failures).toEqual([{ type: "checkpoint_failed", reason: "git binary not found" }]);
    expect(cap.calls).toHaveLength(1);
  });

  it("snapshots pre-turn history: historySnapshot excludes the current turn's user message", async () => {
    const cap = makeCapturer(createdResult);
    const modelPort = new MockModelPort([writeStep("w1"), stopStep]);
    const loop = makeLoop({
      modelPort,
      registry: makeRegistry({ Write: writeMock }),
      checkpoints: cap.port,
    });
    // Two pre-existing items from an earlier turn.
    loop.history.append({ role: "user", content: "earlier" });
    loop.history.append({ role: "assistant", content: [{ type: "text", text: "ack" }] });

    await collect(loop.runTurn("do the write"));

    expect(cap.calls).toHaveLength(1);
    // The snapshot is exactly the pre-append state (2 items), NOT 3.
    expect(cap.calls[0]?.historySnapshot).toHaveLength(2);
    expect(cap.calls[0]?.userInput).toBe("do the write");
  });

  it("hands the capturer the RAW userInput, not the hook-augmented prompt", async () => {
    const cap = makeCapturer(createdResult);
    const hooks = {
      register: () => {},
      runPreToolUse: async () => ({}),
      runUserPromptSubmit: async () => ({ additionalContext: "INJECTED-CONTEXT" }),
      runObservers: async () => {},
    } as unknown as HookRunner;
    const modelPort = new MockModelPort([writeStep("w1"), stopStep]);
    const loop = makeLoop({
      modelPort,
      registry: makeRegistry({ Write: writeMock }),
      hooks,
      checkpoints: cap.port,
    });

    await collect(loop.runTurn("raw prompt"));

    expect(cap.calls[0]?.userInput).toBe("raw prompt");
    // The augmented prompt (with <hook-context>) went to history, not the capturer.
    const userMessage = loop.history.toMessages().find((m) => m.role === "user");
    expect(userMessage?.content).toContain("INJECTED-CONTEXT");
  });

  it("byte-identical when checkpoints is unset: no checkpoint events on a write turn (L2)", async () => {
    const modelPort = new MockModelPort([writeStep("w1"), stopStep]);
    const loop = makeLoop({
      modelPort,
      registry: makeRegistry({ Write: writeMock }),
      // no checkpoints config
    });

    const events = await collect(loop.runTurn("do the write"));

    expect(events.some((e) => e.type.startsWith("checkpoint_"))).toBe(false);
    expect(toolResult(events, "Write")?.status).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// Microcompact is pressure-gated in ContextManager. These loop-level cases
// retain the event path when a small window fills, while proving ordinary
// default-window turns do not emit a destructive clear notice.

describe("AgentLoop microcompact pressure gate", () => {
  const readOutput = "r".repeat(4_000);
  const toolCalls = Array.from({ length: 8 }, (_, i) => ({
    id: `read-${i}`,
    name: "Mock",
    input: { value: `${i}` },
  }));
  const steps = (): ModelStreamEvent[][] => [
    [
      { type: "start" },
      ...toolCalls.map((toolCall) => ({ type: "tool_call" as const, toolCall })),
      { type: "finish", finishReason: "tool_calls", usage: {} },
    ],
    [
      { type: "start" },
      { type: "text_delta", id: "done", text: "done" },
      { type: "finish", finishReason: "stop", usage: {} },
    ],
  ];
  const readTool = (): AnyToolDefinition =>
    makeTool({
      handler: async () => ({ ok: true, output: { result: readOutput } }),
    });

  it("still emits microcompact mid-session when a low window is under pressure", async () => {
    const loop = makeLoop({
      modelPort: new MockModelPort(steps()),
      registry: makeRegistry({ Mock: readTool() }),
      context: { contextWindowTokens: 10_000, outputReserveTokens: 0 },
    });

    const events = await collect(loop.runTurn("read several files"));

    expect(events.find((event) => event.type === "microcompact")).toMatchObject({
      clearedToolResults: 3,
    });
  });

  it("does not emit microcompact for the same small history on the default window", async () => {
    const loop = makeLoop({
      modelPort: new MockModelPort(steps()),
      registry: makeRegistry({ Mock: readTool() }),
    });

    const events = await collect(loop.runTurn("read several files"));

    expect(events.some((event) => event.type === "microcompact")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// slice 6.4: contextInfo() introspection snapshot + setContextWindow re-budget.
// contextInfo is a pure read (no event, no history touch); setContextWindow
// re-resolves the window over the current budget so BOTH the context_usage
// denominator and the manager's compaction threshold follow the new window.

describe("AgentLoop.contextInfo / setContextWindow (slice 6.4)", () => {
  it("reports an estimate-source virgin snapshot with the default budget", () => {
    const loop = makeLoop({});
    const info = loop.contextInfo();
    expect(info.estimatedTokens).toBe(0);
    expect(info.source).toBe("estimate");
    expect(info.contextWindowTokens).toBe(200_000);
    expect(info.outputReserveTokens).toBe(24_000);
    expect(info.effectiveWindowTokens).toBe(176_000);
    expect(info.compactThresholdTokens).toBe(161_920);
    expect(info.breakerTripped).toBe(false);
  });

  it("switches source to 'provider' after a finish carrying provider usage", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t", text: "hi" },
        { type: "finish", finishReason: "stop", usage: { inputTokens: 5_000 } },
      ],
    ]);
    const loop = makeLoop({ modelPort });
    expect(loop.contextInfo().source).toBe("estimate");

    await collect(loop.runTurn("go"));

    const info = loop.contextInfo();
    expect(info.source).toBe("provider");
    expect(info.estimatedTokens).toBeGreaterThanOrEqual(5_000);
  });

  it("re-budgets so the SMALL window fires auto-compaction where the large window did not", async () => {
    const fallback: ModelStreamEvent[] = [
      { type: "start" },
      { type: "text_delta", id: "s", text: "condensed summary" },
      { type: "finish", finishReason: "stop", usage: {} },
    ];
    const modelPort = new MockModelPort([], fallback);
    const loop = makeLoop({ modelPort, context: { keepRecentMessages: 2 } });
    // A fat history: above a tight window's threshold, far below the default's.
    for (let i = 0; i < 8; i += 1) {
      loop.history.append({ role: "user", content: "x".repeat(4_000) });
      loop.history.append({ role: "assistant", content: [{ type: "text", text: `a${i}` }] });
    }

    const estimate = loop.contextInfo().estimatedTokens;
    expect(estimate).toBeGreaterThan(1_000);
    expect(estimate).toBeLessThan(161_920);

    // Turn 1 on the DEFAULT (200k) window: no auto-compaction; denominator 176 000.
    const largeEvents = await collect(loop.runTurn("large window turn"));
    expect(largeEvents.some((e) => e.type === "compaction_start")).toBe(false);
    expect(largeEvents.find((e) => e.type === "context_usage")).toMatchObject({
      budgetTokens: 176_000,
    });

    // Re-budget to a tight window: ew=1_000, threshold=920. The manager's
    // compaction threshold follows the new window (not just the denominator).
    loop.setContextWindow(4_000);
    expect(loop.contextInfo().effectiveWindowTokens).toBe(1_000);
    expect(loop.contextInfo().compactThresholdTokens).toBe(920);

    // Turn 2 now trips auto-compaction, and context_usage carries the new budget.
    const smallEvents = await collect(loop.runTurn("small window turn"));
    expect(smallEvents.some((e) => e.type === "compaction_start")).toBe(true);
    expect(smallEvents.find((e) => e.type === "context_usage")).toMatchObject({
      budgetTokens: 1_000,
    });
  });
});

// ---------------------------------------------------------------------------
// slice P7.17 W1: contextBreakdown() — the ctx-meter hover popover's per-
// category token source. Pure read mirroring contextInfo's contract; every
// test below pins a lengthTokenizer so the subtraction/split arithmetic is
// exact rather than tied to HeuristicTokenizer's CJK-weighted heuristic.

describe("AgentLoop.contextBreakdown (design slice-P7.17-cut.md §2.1)", () => {
  it("collapses the whole systemPrompt into systemPromptTokens when systemPromptComponents is absent (backward-compat)", () => {
    const loop = makeLoop({ tokenizer: lengthTokenizer, systemPrompt: "0123456789" });
    // A history message gives the provider-anchored total (P7.17/F12 W1-FIX P2)
    // something nonzero to anchor to; with no components, none of the raw
    // systemPrompt weight (10) leaks into skills/meta, and the shared
    // anchor-scale (anchor=40, rawTotal=50, k=0.8) lands on exact integers.
    loop.history.append({ role: "user", content: "h".repeat(40) });
    const breakdown = loop.contextBreakdown();
    expect(breakdown.skillsTokens).toBe(0);
    expect(breakdown.metaTokens).toBe(0);
    expect(breakdown.systemToolsTokens).toBe(0);
    expect(breakdown.mcpToolsTokens).toBe(0);
    expect(breakdown.messagesTokens).toBe(32);
    expect(breakdown.systemPromptTokens).toBe(8);
    expect(breakdown.totalEstimatedTokens).toBe(40);
    expect(breakdown.totalEstimatedTokens).toBe(loop.contextInfo().estimatedTokens);
  });

  it("treats an absent config.systemPrompt as an empty base (0 tokens, never throws)", () => {
    const loop = makeLoop({ tokenizer: lengthTokenizer });
    const breakdown = loop.contextBreakdown();
    expect(breakdown.systemPromptTokens).toBe(0);
    expect(breakdown.totalEstimatedTokens).toBe(0);
  });

  it("splits systemPromptComponents by kind (skills vs memory/workflows/profiles/repoMap => meta) and derives the base by subtraction", () => {
    const base = "x".repeat(20);
    const memory = "m".repeat(5);
    const skills = "s".repeat(7);
    const workflows = "w".repeat(4);
    const profiles = "p".repeat(3);
    const repoMap = "r".repeat(6);
    const loop = makeLoop({
      tokenizer: lengthTokenizer,
      systemPrompt: base + memory + skills + workflows + profiles + repoMap,
      systemPromptComponents: [
        { kind: "memory", text: memory },
        { kind: "skills", text: skills },
        { kind: "workflows", text: workflows },
        { kind: "profiles", text: profiles },
        { kind: "repoMap", text: repoMap },
      ],
    });
    // Raw leaves before the anchor-scale: messages=50, skills=7, systemPrompt
    // (base, by subtraction)=20, meta=5+4+3+6=18; anchor=50 (local, no
    // provider usage — the same field contextInfo() reports), rawTotal=95,
    // k=50/95. The kind-based bucket assignment and the base/skills/meta
    // ordering (20 > 18 > 7) survive that single shared scale factor exactly.
    loop.history.append({ role: "user", content: "h".repeat(50) });
    const breakdown = loop.contextBreakdown();
    expect(breakdown.skillsTokens).toBe(4);
    expect(breakdown.metaTokens).toBe(9);
    expect(breakdown.systemPromptTokens).toBe(11);
    expect(breakdown.messagesTokens).toBe(26);
    expect(breakdown.totalEstimatedTokens).toBe(50);
    expect(breakdown.totalEstimatedTokens).toBe(
      breakdown.messagesTokens +
        breakdown.systemToolsTokens +
        breakdown.mcpToolsTokens +
        breakdown.skillsTokens +
        breakdown.systemPromptTokens +
        breakdown.metaTokens,
    );
    expect(breakdown.totalEstimatedTokens).toBe(loop.contextInfo().estimatedTokens);
  });

  it("clamps the base to 0 rather than going negative when component texts outweigh the full systemPrompt (concatenation drift)", () => {
    const loop = makeLoop({
      tokenizer: lengthTokenizer,
      systemPrompt: "short",
      systemPromptComponents: [{ kind: "memory", text: "this text is way longer than the full prompt" }],
    });
    const breakdown = loop.contextBreakdown();
    expect(breakdown.systemPromptTokens).toBe(0);
    expect(breakdown.totalEstimatedTokens).toBeGreaterThanOrEqual(0);
  });

  it("messagesTokens mirrors history.totalTokenEstimate() exactly", () => {
    const loop = makeLoop({ tokenizer: lengthTokenizer });
    loop.history.append({ role: "user", content: "hello there" });
    loop.history.append({ role: "assistant", content: [{ type: "text", text: "hi" }] });
    const breakdown = loop.contextBreakdown();
    expect(breakdown.messagesTokens).toBe(loop.history.totalTokenEstimate());
    expect(breakdown.messagesTokens).toBeGreaterThan(0);
  });

  it("splits tool declarations into systemToolsTokens vs mcpToolsTokens by the mcp__ name prefix", async () => {
    const decl1 = { name: "Read", description: "reads a file", inputJsonSchema: {} };
    const decl2 = { name: "mcp__srv__tool", description: "bridged tool", inputJsonSchema: {} };
    const expectedSystem = JSON.stringify({
      name: decl1.name,
      description: decl1.description,
      inputSchema: decl1.inputJsonSchema,
    }).length; // 61
    const expectedMcp = JSON.stringify({
      name: decl2.name,
      description: decl2.description,
      inputSchema: decl2.inputJsonSchema,
    }).length; // 71

    // Anchor the turn's provider usage to EXACTLY the raw total (messages "go"
    // = 2, systemTools = 61, mcpTools = 71 => 134) so the anchor-scale factor
    // is 1 and the split's raw numbers survive untouched — isolates the
    // mcp__-prefix split from the anchor-rescale this fix introduces. The
    // scripted finish carries no text_delta, so the assistant reply is empty
    // (0 tokens under lengthTokenizer) and the provider number anchors exactly.
    const modelPort = new MockModelPort([
      [{ type: "finish", finishReason: "stop", usage: { inputTokens: 134 } }],
    ]);
    const loop = makeLoop({ tokenizer: lengthTokenizer, modelPort });
    await collect(loop.runTurn("go"));

    vi.mocked(toToolDeclarations).mockReturnValueOnce([decl1, decl2]);
    const breakdown = loop.contextBreakdown();
    expect(breakdown.systemToolsTokens).toBe(expectedSystem);
    expect(breakdown.mcpToolsTokens).toBe(expectedMcp);
    expect(breakdown.messagesTokens).toBe(2);
    expect(breakdown.totalEstimatedTokens).toBe(loop.contextInfo().estimatedTokens);
  });

  it("reads the tool registry live on every call — a late-connected MCP tool shows up without loop reconstruction", () => {
    const loop = makeLoop({ tokenizer: lengthTokenizer });
    // A nonzero history anchor is needed so a nonzero mcpToolsTokens raw share
    // actually survives the anchor-scale rather than being multiplied by an
    // anchor=0 factor (P7.17/F12 W1-FIX P2) — the anchor itself doesn't depend
    // on the registry, only on this appended message.
    loop.history.append({ role: "user", content: "keeps the anchor nonzero" });
    vi.mocked(toToolDeclarations).mockReturnValueOnce([]);
    expect(loop.contextBreakdown().mcpToolsTokens).toBe(0);
    vi.mocked(toToolDeclarations).mockReturnValueOnce([
      { name: "mcp__srv__tool", description: "d", inputJsonSchema: {} },
    ]);
    expect(loop.contextBreakdown().mcpToolsTokens).toBeGreaterThan(0);
  });

  it("is a pure read: never appends to history and is safe to call repeatedly / mid-turn", () => {
    const loop = makeLoop({ tokenizer: lengthTokenizer, systemPrompt: "prompt text" });
    const before = loop.history.items.length;
    const first: ContextBreakdown = loop.contextBreakdown();
    const second: ContextBreakdown = loop.contextBreakdown();
    expect(loop.history.items.length).toBe(before);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// P7.17/F12 W1-FIX P2: codex found that contextBreakdown() independently
// tokenized each category and summed the raw estimates as the total — but
// tokenization is NOT additive (count(a)+count(b)+count(c) != count(a+b+c)),
// so the categories could sum to more than the measured whole, desyncing the
// popover from the ctx-ring's total. The fix anchors totalEstimatedTokens to
// contextInfo().estimatedTokens and proportionally rescales the six raw
// per-category estimates to sum to that anchor exactly. lengthTokenizer
// (near-additive: character counts just add) never exposed this, so every
// test below pins subAdditiveTokenizer, whose flat per-call overhead makes
// summing independently-tokenized parts strictly overshoot tokenizing their
// concatenation once.

describe("AgentLoop.contextBreakdown proportional anchor invariant (P7.17/F12 W1-FIX P2)", () => {
  it("keeps the six categories summing exactly to totalEstimatedTokens under a sub-additive tokenizer", () => {
    const loop = makeLoop({
      tokenizer: subAdditiveTokenizer,
      systemPrompt: "alpha beta gamma delta",
      systemPromptComponents: [
        { kind: "skills", text: "alpha beta" },
        { kind: "memory", text: "gamma" },
        { kind: "workflows", text: "delta" },
      ],
    });
    loop.history.append({ role: "user", content: "one two three" });
    loop.history.append({ role: "assistant", content: [{ type: "text", text: "four five" }] });
    const breakdown = loop.contextBreakdown();
    const partsSum =
      breakdown.messagesTokens +
      breakdown.systemToolsTokens +
      breakdown.mcpToolsTokens +
      breakdown.skillsTokens +
      breakdown.systemPromptTokens +
      breakdown.metaTokens;
    expect(partsSum).toBe(breakdown.totalEstimatedTokens);
  });

  it("anchors totalEstimatedTokens to contextInfo().estimatedTokens exactly, not to an independent raw category sum", () => {
    const loop = makeLoop({
      tokenizer: subAdditiveTokenizer,
      systemPrompt: "alpha beta gamma",
      systemPromptComponents: [{ kind: "skills", text: "alpha beta" }],
    });
    loop.history.append({ role: "user", content: "hello world" });
    const breakdown = loop.contextBreakdown();
    expect(breakdown.totalEstimatedTokens).toBe(loop.contextInfo().estimatedTokens);
  });

  it("keeps every category within [0, total] even under sub-additive tokenization", () => {
    const loop = makeLoop({
      tokenizer: subAdditiveTokenizer,
      systemPrompt: "alpha beta gamma delta",
      systemPromptComponents: [
        { kind: "skills", text: "alpha beta" },
        { kind: "memory", text: "gamma" },
        { kind: "workflows", text: "delta" },
      ],
    });
    loop.history.append({ role: "user", content: "one two three four five" });
    const breakdown = loop.contextBreakdown();
    for (const value of [
      breakdown.messagesTokens,
      breakdown.systemToolsTokens,
      breakdown.mcpToolsTokens,
      breakdown.skillsTokens,
      breakdown.systemPromptTokens,
      breakdown.metaTokens,
    ]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(breakdown.totalEstimatedTokens);
    }
  });

  it("with provider usage recorded, totalEstimatedTokens tracks the PROVIDER number, not the tiny raw local category sum", async () => {
    const modelPort = new MockModelPort([
      [{ type: "finish", finishReason: "stop", usage: { inputTokens: 50_000 } }],
    ]);
    const loop = makeLoop({
      tokenizer: subAdditiveTokenizer,
      modelPort,
      systemPrompt: "alpha beta gamma",
    });
    await collect(loop.runTurn("go"));
    const breakdown = loop.contextBreakdown();
    const info = loop.contextInfo();
    expect(info.source).toBe("provider");
    expect(breakdown.totalEstimatedTokens).toBe(info.estimatedTokens);
    // The raw local sum here (messages + systemPrompt, all tiny word counts
    // under subAdditiveTokenizer) is nowhere near 10k; only the provider
    // anchor explains a total this large.
    expect(breakdown.totalEstimatedTokens).toBeGreaterThan(10_000);
  });

  it("guards rawTotal===0 (empty systemPrompt, no components, no history, no tools) without dividing by zero — every category 0", () => {
    // lengthTokenizer here deliberately, not subAdditiveTokenizer: the
    // sub-additive counter's flat "+1" per-call floor makes even "" count as
    // 1 token, which would never let rawTotal reach exactly 0. This test
    // isolates the div-by-0 guard itself, not the sub-additive-rounding
    // invariant covered by the tests above.
    const loop = makeLoop({ tokenizer: lengthTokenizer });
    const breakdown = loop.contextBreakdown();
    expect(breakdown.messagesTokens).toBe(0);
    expect(breakdown.systemToolsTokens).toBe(0);
    expect(breakdown.mcpToolsTokens).toBe(0);
    expect(breakdown.skillsTokens).toBe(0);
    expect(breakdown.systemPromptTokens).toBe(0);
    expect(breakdown.metaTokens).toBe(0);
    expect(breakdown.totalEstimatedTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// slice 6.6: the generic eventTap observer seam. runTurn/compactNow delegate to
// private *Inner generators; when config.eventTap is set the public wrappers
// invoke it exactly once per event immediately before yielding. Absent eventTap
// is the byte-identical delegation path — EVERY describe above runs with no
// eventTap and is the live lock proving the default path is unchanged.

describe("AgentLoop eventTap seam (slice 6.6)", () => {
  it("taps every yielded event in the exact consumer order", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "working" },
        { type: "tool_call", toolCall: { id: "c1", name: "Mock", input: { value: "x" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t2", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const tapped: AgentEvent[] = [];
    const loop = makeLoop({ modelPort, eventTap: (event) => tapped.push(event) });

    const consumed = await collect(loop.runTurn("please act"));

    // Same objects, same order: the tap sees exactly what the consumer sees.
    expect(tapped).toEqual(consumed);
    expect(tapped.length).toBeGreaterThan(0);
    expect(tapped.at(-1)).toMatchObject({ type: "loop_end", reason: "completed" });
  });

  it("a throwing tap leaves the event stream and turn outcome identical to a no-tap run", async () => {
    const steps = (): ModelStreamEvent[][] => [
      [
        { type: "start" },
        { type: "tool_call", toolCall: { id: "c1", name: "Mock", input: { value: "x" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ];

    const plain = makeLoop({ modelPort: new MockModelPort(steps()) });
    const baseline = await collect(plain.runTurn("act"));

    const observed = makeLoop({
      modelPort: new MockModelPort(steps()),
      eventTap: () => {
        throw new Error("observer boom");
      },
    });
    const withTap = await collect(observed.runTurn("act"));

    // The event-type sequence and the terminal outcome are identical: the
    // observer's exception is swallowed and never perturbs the turn.
    expect(types(withTap)).toEqual(types(baseline));
    expect(withTap.at(-1)).toEqual(baseline.at(-1));
    // The persisted conversation is byte-identical too — the observer changed nothing.
    expect(observed.history.toMessages()).toEqual(plain.history.toMessages());
  });

  it("routes compactNow (manual /compact) events through the tap", async () => {
    const modelPort = new MockModelPort([], [
      { type: "text_delta", id: "s", text: "Summary of the earlier conversation." },
      { type: "finish", finishReason: "stop", usage: {} },
    ]);
    const tapped: AgentEvent[] = [];
    const loop = makeLoop({
      modelPort,
      context: { keepRecentMessages: 0 },
      eventTap: (event) => tapped.push(event),
    });
    loop.history.append({ role: "user", content: "u1" });
    loop.history.append({ role: "assistant", content: [{ type: "text", text: "a1" }] });
    loop.history.append({ role: "user", content: "u2" });
    loop.history.append({ role: "assistant", content: [{ type: "text", text: "a2" }] });

    const consumed = await collect(loop.compactNow());

    expect(tapped).toEqual(consumed);
    expect(types(tapped)).toEqual(["compaction_start", "compaction_end"]);
  });

  it("stops tapping once the consumer breaks out of the for-await (generator return)", async () => {
    const modelPort = new MockModelPort([
      [
        { type: "start" },
        { type: "text_delta", id: "t1", text: "working" },
        { type: "tool_call", toolCall: { id: "c1", name: "Mock", input: { value: "x" } } },
        { type: "finish", finishReason: "tool_calls", usage: {} },
      ],
      [
        { type: "start" },
        { type: "text_delta", id: "t2", text: "done" },
        { type: "finish", finishReason: "stop", usage: {} },
      ],
    ]);
    const tapped: AgentEvent[] = [];
    const loop = makeLoop({ modelPort, eventTap: (event) => tapped.push(event) });

    for await (const event of loop.runTurn("please act")) {
      // Break on the very first event; the public wrapper is suspended at
      // `yield event`, so its .return() unwinds the inner for-await and no
      // further event is ever tapped.
      if (event.type === "turn_start") {
        break;
      }
    }

    expect(tapped).toEqual([{ type: "turn_start", turn: 1 }]);
  });
});
