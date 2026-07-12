/**

 *
 * Two layers, mirroring the subagent runner suite:
 *   - Unit tests drive a scripted FAKE SubagentPort with controlled resolution
 *     order, so DAG ordering, fail-fast/skipped, template flow, output/prompt
 *     caps, cancellation, pre-abort and the per-step timeout are deterministic.
 *   - Integration tests use the REAL createSubagentRunner + a ScriptedModelPort
 *     (two levels): a workflow runs end-to-end, steps share the runner's one
 *     semaphore (concurrency ≤ 2), both non-recursion locks hold on the workflow
 *     path, plan-mode denies a step child's Write, and — on the real
 *     NodeExecutionAdapter — an abort mid-run tears the child process down with
 *     zero orphans.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryTodoStore } from "../tools/todo-store.js";
import { createDefaultToolRegistry } from "../tools/registry.js";
import { ModePermissionEngine, DenyPermissionBroker } from "../permissions/index.js";
import { NodeExecutionAdapter } from "../adapters/node/node-execution.js";
import { buildChildConfig, createSubagentRunner } from "../subagents/runner.js";
import { getPersona } from "../subagents/personas.js";
import {
  WORKFLOW_OUTPUT_MAX_BYTES,
  WORKFLOW_STEP_PROMPT_MAX_BYTES,
} from "../types/config.js";
import type { AgentLoopConfig } from "../loop/agent-loop.js";
import type { ModelPort, ModelRequest } from "../ports/model.js";
import type { ModelStreamEvent } from "../types/events.js";
import type { CorePorts, ExecutionPort, FileSystemPort, HttpPort } from "../ports/index.js";
import type { HookRunner } from "../types/hooks.js";
import type {
  SubagentOutcome,
  SubagentPort,
  SubagentRequest,
  SubagentRunOptions,
} from "../ports/subagent.js";
import type {
  WorkflowDefinition,
  WorkflowProgress,
  WorkflowStepOutcome,
} from "../ports/workflow.js";
import { createWorkflowRunner, createWorkflowRunnerForTest, withWorkflows } from "./engine.js";

// ---------------------------------------------------------------------------
// Fake SubagentPort: a scripted stand-in with controllable resolution so the
// engine's scheduling is deterministic. It records call order, the peak
// concurrent in-flight count, and the prompt each step received.

/** Parses the step id from the engine's "workflow <name> step <id>" description. */
function stepIdOf(req: SubagentRequest): string {
  const match = /step (\S+)$/.exec(req.description);
  return match?.[1] ?? req.description;
}

type StepBehavior = (
  stepId: string,
  req: SubagentRequest,
  opts: SubagentRunOptions,
) => Promise<SubagentOutcome>;

class FakeSubagentPort implements SubagentPort {
  maxInflight = 0;
  private inflight = 0;
  readonly calls: string[] = [];
  readonly prompts = new Map<string, string>();

  constructor(
    private readonly agentTypes: string[],
    private readonly behavior: StepBehavior,
  ) {}

  listAgentTypes(): string[] {
    return [...this.agentTypes];
  }

  async run(req: SubagentRequest, opts: SubagentRunOptions): Promise<SubagentOutcome> {
    const id = stepIdOf(req);
    this.calls.push(id);
    this.prompts.set(id, req.prompt);
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      return await this.behavior(id, req, opts);
    } finally {
      this.inflight -= 1;
    }
  }
}

function completedOutcome(finalText: string, extra: Partial<SubagentOutcome> = {}): SubagentOutcome {
  return { status: "completed", finalText, truncated: false, turns: 1, toolCalls: 1, durationMs: 1, ...extra };
}

function statusOutcome(status: SubagentOutcome["status"], finalText = ""): SubagentOutcome {
  return { status, finalText, truncated: false, turns: 1, toolCalls: 1, durationMs: 1 };
}

/** Standard behavior: emit start + one progress, then complete with `finalText`. */
async function emitAndComplete(
  opts: SubagentRunOptions,
  req: SubagentRequest,
  finalText: string,
): Promise<SubagentOutcome> {
  opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
  opts.onProgress?.({ kind: "progress", turns: 1, toolCalls: 1, lastTool: "Read" });
  return completedOutcome(finalText);
}

/** Resolves when `signal` aborts (or immediately if already aborted). */
function whenAborted(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** N-party barrier: every caller blocks until the Nth arrives, then all proceed. */
function barrier(n: number): () => Promise<void> {
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    count += 1;
    if (count >= n) release();
    await gate;
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function def(
  name: string,
  steps: WorkflowDefinition["steps"],
  extra: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    name,
    description: `wf ${name}`,
    source: "project",
    path: `/wf/${name}.json`,
    steps,
    ...extra,
  };
}

function outcomeOf(steps: readonly WorkflowStepOutcome[], id: string): WorkflowStepOutcome {
  const outcome = steps.find((step) => step.stepId === id);
  if (!outcome) throw new Error(`no outcome for step ${id}`);
  return outcome;
}

// ---------------------------------------------------------------------------
// Integration harness (mirror of subagents/runner.test.ts): a ScriptedModelPort
// drives real child loops through the real createSubagentRunner.

type ModelScript = (req: ModelRequest) => ModelStreamEvent[];

class ScriptedModelPort implements ModelPort {
  calls = 0;
  readonly requests: ModelRequest[] = [];
  constructor(private readonly script: ModelScript) {}

  streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    this.requests.push(request);
    const events = this.script(request);
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

function textStep(text: string): ModelStreamEvent[] {
  return [
    { type: "start" },
    { type: "text_delta", id: "t", text },
    { type: "finish", finishReason: "stop", usage: {} },
  ];
}

function toolStep(id: string, name: string, input: unknown): ModelStreamEvent[] {
  return [
    { type: "start" },
    { type: "tool_call", toolCall: { id, name, input } },
    { type: "finish", finishReason: "tool_calls", usage: {} },
  ];
}

function lastUserText(req: ModelRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const message = req.messages[i];
    if (message && message.role === "user") return message.content;
  }
  return "";
}

function stubHooks(): HookRunner {
  return {
    register: () => {},
    runPreToolUse: async () => ({}),
    runUserPromptSubmit: async () => ({}),
    runObservers: async () => {},
  } as unknown as HookRunner;
}

function makePorts(overrides: Partial<CorePorts> = {}): CorePorts {
  return {
    fs: {} as FileSystemPort,
    exec: {} as ExecutionPort,
    http: {} as HttpPort,
    todos: new InMemoryTodoStore(),
    ...overrides,
  };
}

function makeParent(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  return {
    modelPort: new ScriptedModelPort(() => textStep("")),
    registry: createDefaultToolRegistry(),
    hooks: stubHooks(),
    permissionEngine: new ModePermissionEngine(),
    permissionBroker: new DenyPermissionBroker(),
    mode: "build",
    ports: makePorts(),
    cwd: "/work",
    ...overrides,
  };
}

/** FileSystemPort that records writeFile paths — proves a plan-denied Write never reaches the fs. */
function recordingFs(): FileSystemPort & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    readFile: async () => {
      throw new Error("ENOENT");
    },
    writeFile: async (path: string) => {
      writes.push(path);
    },
    stat: async () => ({ size: 0, mtimeMs: 0, isFile: false, isDirectory: false }),
    exists: async () => false,
    mkdir: async () => {},
    readdir: async () => [],
  } as unknown as FileSystemPort & { writes: string[] };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await stat(path);
      return;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) {
      throw new Error(`file ${path} did not appear within ${timeoutMs}ms`);
    }
    await delay(20);
  }
}

// ===========================================================================
// Port surface: list() + withWorkflows wiring

describe("WorkflowPort surface", () => {
  it("list() projects definitions to WorkflowMeta (name/description/stepCount/source)", () => {
    const port = createWorkflowRunner(new FakeSubagentPort([], async () => completedOutcome("")), [
      def("one", [{ id: "a", agentType: "general-purpose", promptTemplate: "x" }]),
      def(
        "two",
        [
          { id: "a", agentType: "general-purpose", promptTemplate: "x" },
          { id: "b", agentType: "general-purpose", promptTemplate: "y", dependsOn: ["a"] },
        ],
        { description: "the two" },
      ),
    ]);
    expect(port.list()).toEqual([
      { name: "one", description: "wf one", stepCount: 1, source: "project" },
      { name: "two", description: "the two", stepCount: 2, source: "project" },
    ]);
  });

  it("withWorkflows attaches a port only when config.subagents is set", () => {
    const wf = def("x", [{ id: "a", agentType: "general-purpose", promptTemplate: "${input}" }]);

    const withSub = makeParent();
    withSub.subagents = new FakeSubagentPort(["general-purpose"], async () => completedOutcome(""));
    withWorkflows(withSub, [wf]);
    expect(withSub.workflows).toBeDefined();
    expect(withSub.workflows?.list().map((meta) => meta.name)).toEqual(["x"]);

    const noSub = makeParent();
    withWorkflows(noSub, [wf]);
    expect(noSub.workflows).toBeUndefined();
  });
});

// ===========================================================================
// DAG scheduling (fake port)

describe("DAG scheduling", () => {
  it("chain runs strictly sequentially (maxInflight 1), threading each output forward", async () => {
    const port = new FakeSubagentPort(["general-purpose"], (id, req, opts) =>
      emitAndComplete(opts, req, `out:${id}`),
    );
    const wf = def("chain", [
      { id: "A", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "B", agentType: "general-purpose", promptTemplate: "B<-${steps.A}", dependsOn: ["A"] },
      { id: "C", agentType: "general-purpose", promptTemplate: "C<-${steps.B}", dependsOn: ["B"] },
    ]);

    const outcome = await createWorkflowRunner(port, [wf]).run({ name: "chain", input: "go" }, {});

    expect(outcome.status).toBe("completed");
    expect(port.maxInflight).toBe(1);
    expect(port.calls).toEqual(["A", "B", "C"]);
    expect(port.prompts.get("B")).toBe("B<-out:A");
    expect(port.prompts.get("C")).toBe("C<-out:B");
    expect(outcome.output).toBe("out:C"); // C is the only sink
  });

  it("diamond: B and C run concurrently after A, D substitutes both outputs, steps[] in definition order", async () => {
    const bc = barrier(2);
    const port = new FakeSubagentPort(["general-purpose"], async (id, req, opts) => {
      opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
      if (id === "B" || id === "C") await bc();
      return completedOutcome(`out:${id}`);
    });
    const wf = def("diamond", [
      { id: "A", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "B", agentType: "general-purpose", promptTemplate: "B<-${steps.A}", dependsOn: ["A"] },
      { id: "C", agentType: "general-purpose", promptTemplate: "C<-${steps.A}", dependsOn: ["A"] },
      {
        id: "D",
        agentType: "general-purpose",
        promptTemplate: "D<-${steps.B}+${steps.C}",
        dependsOn: ["B", "C"],
      },
    ]);

    const outcome = await createWorkflowRunner(port, [wf]).run({ name: "diamond", input: "go" }, {});

    expect(outcome.status).toBe("completed");
    expect(port.maxInflight).toBe(2); // B∥C — engine adds no limiter beyond the semaphore
    expect(port.prompts.get("B")).toBe("B<-out:A");
    expect(port.prompts.get("D")).toBe("D<-out:B+out:C");
    expect(outcome.steps.map((step) => step.stepId)).toEqual(["A", "B", "C", "D"]);
    expect(outcome.output).toBe("out:D"); // D is the only sink
  });

  it("independent steps all run concurrently (the engine imposes no parallelism cap)", async () => {
    const all = barrier(3);
    const port = new FakeSubagentPort(["general-purpose"], async (id, req, opts) => {
      opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
      await all();
      return completedOutcome(`out:${id}`);
    });
    const wf = def("fanout", [
      { id: "a", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "b", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "c", agentType: "general-purpose", promptTemplate: "${input}" },
    ]);

    const outcome = await createWorkflowRunner(port, [wf]).run({ name: "fanout", input: "x" }, {});

    expect(outcome.status).toBe("completed");
    expect(port.maxInflight).toBe(3);
    expect(outcome.output).toBe("out:a\n\nout:b\n\nout:c"); // all three are sinks
  }, 5_000);
});

// ===========================================================================
// Fail-fast + failure statuses

describe("fail-fast", () => {
  it("a failed step skips its dependents while in-flight siblings finish; run failed", async () => {
    const port = new FakeSubagentPort(["general-purpose"], async (id, req, opts) => {
      opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
      if (id === "B") return statusOutcome("max_turns", "partial"); // max_turns counts as a failure
      return completedOutcome(`out:${id}`);
    });
    const wf = def("ff", [
      { id: "A", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "B", agentType: "general-purpose", promptTemplate: "${steps.A}", dependsOn: ["A"] },
      { id: "C", agentType: "general-purpose", promptTemplate: "${steps.A}", dependsOn: ["A"] },
      { id: "D", agentType: "general-purpose", promptTemplate: "${steps.B}", dependsOn: ["B", "C"] },
    ]);

    const outcome = await createWorkflowRunner(port, [wf]).run({ name: "ff", input: "go" }, {});

    expect(outcome.status).toBe("failed");
    expect(outcomeOf(outcome.steps, "A").status).toBe("completed");
    expect(outcomeOf(outcome.steps, "B").status).toBe("max_turns");
    expect(outcomeOf(outcome.steps, "C").status).toBe("completed"); // in-flight sibling finished
    expect(outcomeOf(outcome.steps, "D").status).toBe("skipped"); // dependent never launched
    expect(port.calls).not.toContain("D");
  });
});

// ===========================================================================
// Template rendering edge cases

describe("template rendering", () => {
  it("a step referencing an unsatisfied output fails cleanly (render throw -> step error, no crash)", async () => {
    // B references ${steps.A} but does NOT declare A as a dep, so A's output is
    // absent when B renders -> renderTemplate throws -> the engine records a
    // clean error step (static validation makes this unreachable in 3.4.3).
    const port = new FakeSubagentPort(["general-purpose"], (id, req, opts) =>
      emitAndComplete(opts, req, `out:${id}`),
    );
    const wf = def("bad", [
      { id: "A", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "B", agentType: "general-purpose", promptTemplate: "needs ${steps.A}" },
    ]);

    const outcome = await createWorkflowRunner(port, [wf]).run({ name: "bad", input: "go" }, {});

    const b = outcomeOf(outcome.steps, "B");
    expect(b.status).toBe("error");
    expect(b.finalText).toContain("Unknown workflow step reference");
    expect(outcome.status).toBe("failed");
    expect(port.calls).not.toContain("B"); // threw before launching the subagent
  });

  it("renders the outputTemplate over all completed steps when present", async () => {
    const port = new FakeSubagentPort(["general-purpose"], (id, req, opts) =>
      emitAndComplete(opts, req, `out:${id}`),
    );
    const wf = def(
      "tmpl",
      [
        { id: "A", agentType: "general-purpose", promptTemplate: "${input}" },
        { id: "B", agentType: "general-purpose", promptTemplate: "${steps.A}", dependsOn: ["A"] },
      ],
      { outputTemplate: "A=${steps.A} B=${steps.B} in=${input}" },
    );

    const outcome = await createWorkflowRunner(port, [wf]).run({ name: "tmpl", input: "GO" }, {});

    expect(outcome.status).toBe("completed");
    expect(outcome.output).toBe("A=out:A B=out:B in=GO");
  });
});

// ===========================================================================
// Output + prompt caps

describe("caps", () => {
  it("caps the run output at WORKFLOW_OUTPUT_MAX_BYTES and sets truncated", async () => {
    const huge = "a".repeat(WORKFLOW_OUTPUT_MAX_BYTES + 1);
    const port = new FakeSubagentPort(["general-purpose"], (id, req, opts) =>
      emitAndComplete(opts, req, huge),
    );
    const wf = def("big", [{ id: "A", agentType: "general-purpose", promptTemplate: "${input}" }]);

    const outcome = await createWorkflowRunner(port, [wf]).run({ name: "big", input: "x" }, {});

    expect(outcome.status).toBe("completed");
    expect(outcome.truncated).toBe(true);
    expect(new TextEncoder().encode(outcome.output).length).toBe(WORKFLOW_OUTPUT_MAX_BYTES);
  });

  it("caps a step's substituted prompt at WORKFLOW_STEP_PROMPT_MAX_BYTES", async () => {
    const bigInput = "b".repeat(WORKFLOW_STEP_PROMPT_MAX_BYTES + 50);
    const port = new FakeSubagentPort(["general-purpose"], (id, req, opts) =>
      emitAndComplete(opts, req, "ok"),
    );
    const wf = def("promptcap", [
      { id: "A", agentType: "general-purpose", promptTemplate: "${input}" },
    ]);

    await createWorkflowRunner(port, [wf]).run({ name: "promptcap", input: bigInput }, {});

    const received = port.prompts.get("A") ?? "";
    expect(new TextEncoder().encode(received).length).toBe(WORKFLOW_STEP_PROMPT_MAX_BYTES);
  });
});

// ===========================================================================
// Unknown name / unknown agentType (fail-fast, never a throw)

describe("fail-fast validation", () => {
  it("an unknown workflow name is a failed outcome listing available names (never a throw)", async () => {
    const port = new FakeSubagentPort(["general-purpose"], async () => completedOutcome(""));
    const wf = def("known", [{ id: "A", agentType: "general-purpose", promptTemplate: "x" }]);

    const outcome = await createWorkflowRunner(port, [wf]).run({ name: "missing" }, {});

    expect(outcome.status).toBe("failed");
    expect(outcome.output).toContain("missing");
    expect(outcome.output).toContain("known");
    expect(outcome.steps).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it("an unknown step agentType fails fast BEFORE launching any step (zero tokens)", async () => {
    const port = new FakeSubagentPort(["general-purpose"], (id, req, opts) =>
      emitAndComplete(opts, req, "x"),
    );
    const wf = def("badtype", [
      { id: "A", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "B", agentType: "nope", promptTemplate: "${input}" },
    ]);

    const outcome = await createWorkflowRunner(port, [wf]).run({ name: "badtype", input: "x" }, {});

    expect(outcome.status).toBe("failed");
    expect(port.calls).toEqual([]); // nothing launched
    expect(outcomeOf(outcome.steps, "B").status).toBe("error");
    expect(outcomeOf(outcome.steps, "B").finalText).toContain("nope");
    expect(outcomeOf(outcome.steps, "A").status).toBe("skipped");
  });
});

// ===========================================================================
// Cancellation + pre-abort

describe("cancellation", () => {
  it("a run-level abort cancels in-flight steps and skips the not-yet-launched (status cancelled)", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const port = new FakeSubagentPort(["general-purpose"], async (id, req, opts) => {
      if (id === "S1") {
        opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
        markStarted();
        await whenAborted(opts.signal);
        return statusOutcome("cancelled");
      }
      return emitAndComplete(opts, req, `out:${id}`);
    });
    const wf = def("cancelme", [
      { id: "S1", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "S2", agentType: "general-purpose", promptTemplate: "${steps.S1}", dependsOn: ["S1"] },
    ]);

    const controller = new AbortController();
    const runPromise = createWorkflowRunner(port, [wf]).run(
      { name: "cancelme", input: "go" },
      { signal: controller.signal },
    );

    await started;
    controller.abort();
    const outcome = await runPromise;

    expect(outcome.status).toBe("cancelled");
    expect(outcomeOf(outcome.steps, "S1").status).toBe("cancelled");
    expect(outcomeOf(outcome.steps, "S2").status).toBe("skipped");
    expect(port.calls).toEqual(["S1"]); // S2 never launched
  });

  it("a pre-aborted run returns cancelled with all steps skipped and launches nothing", async () => {
    const port = new FakeSubagentPort(["general-purpose"], (id, req, opts) =>
      emitAndComplete(opts, req, "x"),
    );
    const wf = def("pre", [{ id: "A", agentType: "general-purpose", promptTemplate: "${input}" }]);

    const controller = new AbortController();
    controller.abort();
    const outcome = await createWorkflowRunner(port, [wf]).run(
      { name: "pre" },
      { signal: controller.signal },
    );

    expect(outcome.status).toBe("cancelled");
    expect(outcomeOf(outcome.steps, "A").status).toBe("skipped");
    expect(port.calls).toEqual([]);
  });
});

// ===========================================================================
// Per-step timeout (armed on start-progress only)

describe("per-step timeout", () => {
  it("times out a started+hanging step (marked error) but never a step still parked behind the semaphore", async () => {
    const port = new FakeSubagentPort(["general-purpose"], async (id, req, opts) => {
      if (id === "slow") {
        // Emits start -> the engine arms the per-step timer; then hangs until the
        // timeout aborts the step signal.
        opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
        await whenAborted(opts.signal);
        return statusOutcome("cancelled");
      }
      // "parked": NEVER emits start-progress, so no timer is armed even though it
      // resolves well after the timeout window — proves arming is gated on start.
      await delay(120);
      return completedOutcome(`out:${id}`);
    });
    const wf = def("timeouts", [
      { id: "slow", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "parked", agentType: "general-purpose", promptTemplate: "${input}" },
    ]);

    const outcome = await createWorkflowRunnerForTest(port, [wf], { stepTimeoutMs: 30 }).run(
      { name: "timeouts", input: "go" },
      {},
    );

    expect(outcomeOf(outcome.steps, "slow").status).toBe("error");
    expect(outcomeOf(outcome.steps, "slow").finalText).toContain("timed out");
    expect(outcomeOf(outcome.steps, "parked").status).toBe("completed");
    expect(outcome.status).toBe("failed"); // run continues past the timeout per fail-fast
  }, 5_000);
});

// ===========================================================================
// Progress bridge ordering

describe("progress events", () => {
  it("emits start, per-step start/progress/end, then end — in FIFO order", async () => {
    const port = new FakeSubagentPort(["general-purpose"], (id, req, opts) =>
      emitAndComplete(opts, req, `out:${id}`),
    );
    const wf = def("chain2", [
      { id: "A", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "B", agentType: "general-purpose", promptTemplate: "${steps.A}", dependsOn: ["A"] },
    ]);

    const events: WorkflowProgress[] = [];
    const outcome = await createWorkflowRunner(port, [wf]).run(
      { name: "chain2", input: "go" },
      { onProgress: (progress) => events.push(progress) },
    );

    expect(outcome.status).toBe("completed");
    expect(events[0]).toEqual({ kind: "start", workflow: "chain2", totalSteps: 2 });
    const end = events.at(-1);
    expect(end?.kind).toBe("end");
    expect(end).toMatchObject({ status: "completed", completedSteps: 2, totalSteps: 2 });

    const aEnd = events.findIndex((e) => e.kind === "step_end" && e.stepId === "A");
    const bStart = events.findIndex((e) => e.kind === "step_start" && e.stepId === "B");
    expect(aEnd).toBeGreaterThan(0);
    expect(bStart).toBeGreaterThan(aEnd); // chain: A fully precedes B
    expect(events.some((e) => e.kind === "step_progress")).toBe(true);
  });
});

// ===========================================================================
// Integration with the REAL subagent runner (two levels)

describe("integration with the real subagent runner", () => {
  it("runs a two-step workflow end-to-end, threading the first step's output into the second's child", async () => {
    const model = new ScriptedModelPort((req) => textStep(`report(${lastUserText(req)})`));
    const subagents = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));
    const wf = def("pipe", [
      { id: "A", agentType: "general-purpose", promptTemplate: "task: ${input}" },
      { id: "B", agentType: "general-purpose", promptTemplate: "refine ${steps.A}", dependsOn: ["A"] },
    ]);

    const events: WorkflowProgress[] = [];
    const outcome = await createWorkflowRunner(subagents, [wf]).run(
      { name: "pipe", input: "build a thing" },
      { onProgress: (progress) => events.push(progress) },
    );

    expect(outcome.status).toBe("completed");
    expect(outcomeOf(outcome.steps, "A").status).toBe("completed");
    expect(outcomeOf(outcome.steps, "B").status).toBe("completed");
    expect(outcome.output).toBe("report(refine report(task: build a thing))"); // B is the sink

    // B's real child saw A's output substituted into its prompt.
    const bChildReq = model.requests.find((req) => lastUserText(req).startsWith("refine "));
    expect(bChildReq && lastUserText(bChildReq)).toBe("refine report(task: build a thing)");

    expect(events[0]?.kind).toBe("start");
    expect(events.at(-1)?.kind).toBe("end");
  });

  it("steps share the runner's single semaphore: a third ready step waits until a permit frees (cap 2)", async () => {
    let started = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gatedModel: ModelPort = {
      streamText(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
        started += 1;
        const signal = req.abortSignal;
        return (async function* () {
          await gate;
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
          yield { type: "start" };
          yield { type: "text_delta", id: "t", text: "ok" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        })();
      },
    };
    const subagents = createSubagentRunner(makeParent({ modelPort: gatedModel, mode: "yolo" }));
    const wf = def("fan", [
      { id: "s1", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "s2", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "s3", agentType: "general-purpose", promptTemplate: "${input}" },
    ]);

    const runPromise = createWorkflowRunner(subagents, [wf]).run({ name: "fan", input: "x" }, {});

    await delay(40);
    expect(started).toBe(2); // the 3rd step is parked behind the shared semaphore

    releaseGate();
    const outcome = await runPromise;
    expect(started).toBe(3); // it ran only after a permit freed
    expect(outcome.status).toBe("completed");
    expect(outcome.steps.every((step) => step.status === "completed")).toBe(true);
  });

  it("lock: a step child carries no spawn ports and its registry excludes Agent AND Workflow (depth stays 1)", () => {
    const child = buildChildConfig(makeParent(), getPersona("general-purpose"), {
      agentType: "general-purpose",
      description: "workflow x step s",
      prompt: "p",
    });
    expect(child.subagents).toBeUndefined();
    expect(child.workflows).toBeUndefined();
    expect(child.registry.has("Agent")).toBe(false);
    expect(child.registry.has("Workflow")).toBe(false);
  });

  it("lock: a step child that proposes Workflow cannot launch one — the declaration and port are both absent", async () => {
    let step = 0;
    const model = new ScriptedModelPort(() => {
      step += 1;
      // Step 1 proposes the Workflow tool; the child registry has no Workflow, so
      // it becomes an unknown-tool error and the child recovers — no re-entry.
      return step === 1
        ? toolStep("w1", "Workflow", { name: "inner" })
        : textStep("child recovered");
    });
    const subagents = createSubagentRunner(makeParent({ modelPort: model, mode: "yolo" }));
    const inner = def("inner", [
      { id: "x", agentType: "general-purpose", promptTemplate: "${input}" },
    ]);

    const outcome = await createWorkflowRunner(subagents, [inner]).run(
      { name: "inner", input: "go" },
      {},
    );

    expect(outcome.status).toBe("completed");
    expect(outcomeOf(outcome.steps, "x").status).toBe("completed");
    expect(outcomeOf(outcome.steps, "x").finalText).toBe("child recovered");
    // Exactly the child's two steps — a nested workflow would have produced more.
    expect(model.calls).toBe(2);
  });

  it("plan mode: a step child's Write is denied and never reaches the fs (mode snapshot inherited)", async () => {
    const fs = recordingFs();
    let step = 0;
    const model = new ScriptedModelPort(() => {
      step += 1;
      return step === 1
        ? toolStep("w1", "Write", { file_path: "/work/out.txt", content: "hi" })
        : textStep("done after denial");
    });
    const parent = makeParent({ modelPort: model, mode: "plan", ports: makePorts({ fs }) });
    const subagents = createSubagentRunner(parent);
    const wf = def("writer", [
      { id: "w", agentType: "general-purpose", promptTemplate: "${input}" },
    ]);

    const outcome = await createWorkflowRunner(subagents, [wf]).run(
      { name: "writer", input: "write a file" },
      {},
    );

    const w = outcomeOf(outcome.steps, "w");
    expect(w.status).toBe("completed"); // child recovered after the denial
    expect(w.finalText).toBe("done after denial");
    expect(fs.writes).toEqual([]); // the Write was denied — it never reached the fs
    expect(model.calls).toBe(2); // the Write turn was proposed, then recovery
  });
});

// ===========================================================================
// Orphan safety on the real NodeExecutionAdapter

describe("orphan safety (real NodeExecutionAdapter)", () => {
  let tmpDir = "";
  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "aborting a run mid-step tears down the child Bash process group (no orphan)",
    async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-workflow-"));
      const pidFile = join(tmpDir, "pid.txt");
      const model = new ScriptedModelPort(() =>
        toolStep("b1", "Bash", { command: `echo $$ > pid.txt && exec sleep 5` }),
      );
      const parent = makeParent({
        modelPort: model,
        mode: "yolo",
        cwd: tmpDir,
        ports: makePorts({ exec: new NodeExecutionAdapter() }),
      });
      const subagents = createSubagentRunner(parent);
      const wf = def("sleeper", [
        { id: "s", agentType: "general-purpose", promptTemplate: "${input}" },
      ]);

      const controller = new AbortController();
      const runPromise = createWorkflowRunner(subagents, [wf]).run(
        { name: "sleeper", input: "sleep" },
        { signal: controller.signal },
      );

      let pid = Number.NaN;
      try {
        await waitForFile(pidFile, 5_000);
        pid = Number((await readFile(pidFile, "utf-8")).trim());

        controller.abort();
        const outcome = await runPromise;

        expect(outcome.status).toBe("cancelled");
        expect(outcomeOf(outcome.steps, "s").status).toBe("cancelled");
        expect(Number.isNaN(pid)).toBe(false);
        expect(isPidAlive(pid)).toBe(false); // SIGTERM/SIGKILL cascade reached the process
      } finally {
        // Guarantee no orphan survives even if an assertion above threw.
        await runPromise.catch(() => {});
        if (!Number.isNaN(pid) && isPidAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    },
    20_000,
  );
});
