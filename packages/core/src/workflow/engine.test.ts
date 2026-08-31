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

  it("a degenerate step (finalTurnFinishReason==='degenerate') is NOT a satisfied dependency, even though SubagentOutcome.status stays 'completed' (TASK.210 codex review finding)", async () => {
    const port = new FakeSubagentPort(["general-purpose"], async (id, req, opts) => {
      opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
      if (id === "B") {
        // The loop's own sentinel/loop_end reports "completed" — this
        // outcome shape is exactly what a real degenerate-cutoff subagent
        // run returns (outcomeToResult's own comment on the accepted
        // internal/external status mismatch, TASK.210 plan §8).
        return completedOutcome("...ends inside a degenerate loop", { finalTurnFinishReason: "degenerate" });
      }
      return completedOutcome(`out:${id}`);
    });
    const wf = def("degenerate-dep", [
      { id: "A", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "B", agentType: "general-purpose", promptTemplate: "${steps.A}", dependsOn: ["A"] },
      { id: "C", agentType: "general-purpose", promptTemplate: "${steps.B}", dependsOn: ["B"] },
    ]);

    const outcome = await createWorkflowRunner(port, [wf]).run({ name: "degenerate-dep", input: "go" }, {});

    expect(outcome.status).toBe("failed");
    // The internal SubagentOutcome.status legitimately stays "completed" (the
    // loop reached its sentinel cleanly) — the fix lives entirely in the
    // WORKFLOW step outcome, which must NOT read "completed": that would let
    // a dependent step treat the looping partial as satisfied input.
    expect(outcomeOf(outcome.steps, "B").status).not.toBe("completed");
    expect(outcomeOf(outcome.steps, "C").status).toBe("skipped");
    expect(port.calls).not.toContain("C");
  });

  // TASK.191 slice S3: before this, a never-launched step's "skipped" fact
  // lived ONLY in the returned WorkflowRunOutcome.steps array — a client fed
  // exclusively by onProgress (the desktop card) got no wire event for it at
  // all and the node stayed "not started" forever, even after the run's own
  // terminal workflow_end had already landed.
  it("emits a step_end{skipped} for a step that never launched, BEFORE the run's end event", async () => {
    const port = new FakeSubagentPort(["general-purpose"], async (id, req, opts) => {
      opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
      if (id === "B") return statusOutcome("error", "boom");
      return completedOutcome(`out:${id}`);
    });
    const wf = def("ff-events", [
      { id: "A", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "B", agentType: "general-purpose", promptTemplate: "${steps.A}", dependsOn: ["A"] },
      { id: "C", agentType: "general-purpose", promptTemplate: "${steps.B}", dependsOn: ["B"] },
    ]);

    const events: WorkflowProgress[] = [];
    const outcome = await createWorkflowRunner(port, [wf]).run(
      { name: "ff-events", input: "go" },
      { onProgress: (progress) => events.push(progress) },
    );

    expect(outcome.status).toBe("failed");
    expect(outcomeOf(outcome.steps, "C").status).toBe("skipped");
    // C never launched, so it never got a step_start — but it MUST still get
    // a terminal step_end, and it must land before the run's own "end".
    expect(events).not.toContainEqual(expect.objectContaining({ kind: "step_start", stepId: "C" }));
    const cEnd = events.findIndex((e) => e.kind === "step_end" && e.stepId === "C");
    const runEnd = events.findIndex((e) => e.kind === "end");
    expect(cEnd).toBeGreaterThan(-1);
    expect(events[cEnd]).toEqual({ kind: "step_end", stepId: "C", status: "skipped", turns: 0, durationMs: 0 });
    expect(runEnd).toBeGreaterThan(cEnd);
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

  // TASK.191 slice S3 consequence, NOT a regression of this slice: this
  // early return sits BEFORE `onProgress?.({kind:"start",...})` at the top
  // of `run()`, so a caller fed exclusively by onProgress (the desktop card)
  // never gets a `workflow_start` at all for this outcome — the card simply
  // never seeds a workflow sub-status, and the failure is visible only
  // through the returned WorkflowRunOutcome / the settling tool_result. This
  // is intentional (nothing has streamed yet, so there is nothing for a
  // client to hold a graph FOR), documented here rather than left implicit.
  it("emits ZERO progress events for an unknown-agentType fail-fast (documented silence, not a regression)", async () => {
    const port = new FakeSubagentPort(["general-purpose"], (id, req, opts) =>
      emitAndComplete(opts, req, "x"),
    );
    const wf = def("badtype-silent", [{ id: "B", agentType: "nope", promptTemplate: "${input}" }]);

    const events: WorkflowProgress[] = [];
    const outcome = await createWorkflowRunner(port, [wf]).run(
      { name: "badtype-silent", input: "x" },
      { onProgress: (progress) => events.push(progress) },
    );

    expect(outcome.status).toBe("failed");
    expect(events).toEqual([]);
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

  // TASK.191 slice S3 consequence, NOT a regression of this slice: the
  // `if (signal?.aborted)` early return also sits BEFORE the start-progress
  // emission — same documented silence as the unknown-agentType fail-fast
  // above, same reason (nothing has streamed yet).
  it("emits ZERO progress events for a pre-aborted run (documented silence, not a regression)", async () => {
    const port = new FakeSubagentPort(["general-purpose"], (id, req, opts) =>
      emitAndComplete(opts, req, "x"),
    );
    const wf = def("pre-silent", [{ id: "A", agentType: "general-purpose", promptTemplate: "${input}" }]);

    const controller = new AbortController();
    controller.abort();
    const events: WorkflowProgress[] = [];
    const outcome = await createWorkflowRunner(port, [wf]).run(
      { name: "pre-silent" },
      { signal: controller.signal, onProgress: (progress) => events.push(progress) },
    );

    expect(outcome.status).toBe("cancelled");
    expect(events).toEqual([]);
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
    // TASK.191 slice S3: the start event now carries the run's step graph so
    // a client can hold/order all N steps before the first step_start lands
    // — a client that ignored `steps` entirely would still pass every OTHER
    // assertion in this file, which is exactly why this needs its own exact
    // pin (a `toMatchObject` here would silently accept a start event with
    // the field missing or wrong).
    expect(events[0]).toEqual({
      kind: "start",
      workflow: "chain2",
      totalSteps: 2,
      steps: [
        { id: "A", agentType: "general-purpose" },
        { id: "B", agentType: "general-purpose", dependsOn: ["A"] },
      ],
    });
    const end = events.at(-1);
    expect(end?.kind).toBe("end");
    expect(end).toMatchObject({ status: "completed", completedSteps: 2, totalSteps: 2 });

    const aEnd = events.findIndex((e) => e.kind === "step_end" && e.stepId === "A");
    const bStart = events.findIndex((e) => e.kind === "step_start" && e.stepId === "B");
    expect(aEnd).toBeGreaterThan(0);
    expect(bStart).toBeGreaterThan(aEnd); // chain: A fully precedes B
    expect(events.some((e) => e.kind === "step_progress")).toBe(true);
  });

  // TASK.191 slice S1. Before this slice the child's `tool` progress had no
  // branch in the engine at all: counters travelled, the tool names were
  // dropped on the floor, and a workflow run named not one thing it did.
  it("forwards each step's child tool activity as step_activity, stamped with that step's id", async () => {
    const port = new FakeSubagentPort(["general-purpose"], async (id, req, opts) => {
      opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
      opts.onProgress?.({ kind: "tool", toolName: "Read", summary: `${id}.ts` });
      opts.onProgress?.({ kind: "tool", toolName: "Bash", summary: "" });
      return completedOutcome(`out:${id}`);
    });
    // Two INDEPENDENT steps: the lane is shared by concurrent steps, so the
    // stamp is the only thing that attributes a row to its producer.
    const wf = def("fan2", [
      { id: "A", agentType: "general-purpose", promptTemplate: "${input}" },
      { id: "B", agentType: "general-purpose", promptTemplate: "${input}" },
    ]);

    const events: WorkflowProgress[] = [];
    const outcome = await createWorkflowRunner(port, [wf]).run(
      { name: "fan2", input: "go" },
      { onProgress: (progress) => events.push(progress) },
    );

    expect(outcome.status).toBe("completed");
    const activity = events.filter((e) => e.kind === "step_activity");
    expect(activity).toHaveLength(4);
    expect(activity).toContainEqual({ kind: "step_activity", stepId: "A", toolName: "Read", summary: "A.ts" });
    expect(activity).toContainEqual({ kind: "step_activity", stepId: "B", toolName: "Read", summary: "B.ts" });
    // An empty summary is forwarded as-is, not swallowed: it is the producer's
    // documented fallback for a tool with no per-call subject, and the
    // renderer already turns it into the bare verb.
    expect(activity.filter((e) => e.toolName === "Bash").map((e) => e.summary)).toEqual(["", ""]);
  });

  it("stamps each step's token spend onto step_progress and step_end (TASK.191 slice S2)", async () => {
    const port = new FakeSubagentPort(["general-purpose"], async (id, req, opts) => {
      opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
      opts.onProgress?.({
        kind: "progress",
        turns: 1,
        toolCalls: 1,
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      });
      // The FINAL number comes off the outcome, not off the last progress: a
      // step whose closing turn calls no tool emits its last progress before
      // that turn's spend exists.
      return completedOutcome(`out:${id}`, {
        usage: { inputTokens: 30, cachedInputTokens: 12, outputTokens: 6, totalTokens: 36 },
      });
    });
    const wf = def("spend", [{ id: "A", agentType: "general-purpose", promptTemplate: "${input}" }]);

    const events: WorkflowProgress[] = [];
    await createWorkflowRunner(port, [wf]).run({ name: "spend", input: "go" }, {
      onProgress: (progress) => events.push(progress),
    });

    expect(events).toContainEqual({
      kind: "step_progress",
      stepId: "A",
      turns: 1,
      toolCalls: 1,
      lastTool: undefined,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
    const end = events.find((e) => e.kind === "step_end");
    expect(end).toMatchObject({
      stepId: "A",
      usage: { inputTokens: 30, cachedInputTokens: 12, outputTokens: 6, totalTokens: 36 },
    });
  });

  it("omits usage entirely for a tier that reports none, rather than stamping zeros", async () => {
    const port = new FakeSubagentPort(["general-purpose"], async (id, req, opts) => {
      opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
      opts.onProgress?.({ kind: "progress", turns: 1, toolCalls: 0 });
      return completedOutcome(`out:${id}`);
    });
    const wf = def("silent", [{ id: "A", agentType: "general-purpose", promptTemplate: "${input}" }]);

    const events: WorkflowProgress[] = [];
    await createWorkflowRunner(port, [wf]).run({ name: "silent", input: "go" }, {
      onProgress: (progress) => events.push(progress),
    });

    // "not reported" must stay distinguishable from "reported as none" all the
    // way out: engine and session-tier children never surface spend at all.
    for (const event of events) {
      expect(event).not.toHaveProperty("usage");
    }
  });

  // The two SESSION-tier progress kinds stay deliberately unbridged (see the
  // engine's own comment): a workflow step is inline, so neither can occur —
  // and inventing a workflow event for them would fabricate a state the
  // renderer has no honest way to show.
  it("ignores attention and stalled progress rather than inventing a workflow event", async () => {
    const port = new FakeSubagentPort(["general-purpose"], async (id, req, opts) => {
      opts.onProgress?.({ kind: "start", agentType: req.agentType, description: req.description });
      opts.onProgress?.({ kind: "attention", waiting: true });
      opts.onProgress?.({
        kind: "stalled",
        agentType: req.agentType,
        description: req.description,
        silentMs: 60_000,
        waitingForApproval: false,
      });
      return completedOutcome(`out:${id}`);
    });
    const wf = def("solo", [{ id: "A", agentType: "general-purpose", promptTemplate: "${input}" }]);

    const events: WorkflowProgress[] = [];
    const outcome = await createWorkflowRunner(port, [wf]).run(
      { name: "solo", input: "go" },
      { onProgress: (progress) => events.push(progress) },
    );

    expect(outcome.status).toBe("completed");
    // step_running (TASK.191 slice S3) rides the same child "start" progress
    // as attention/stalled just above — it fires between step_start and
    // step_end, not instead of either.
    expect(events.map((e) => e.kind)).toEqual(["start", "step_start", "step_running", "step_end", "end"]);
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

    const events: WorkflowProgress[] = [];
    const runPromise = createWorkflowRunner(subagents, [wf]).run(
      { name: "fan", input: "x" },
      { onProgress: (progress) => events.push(progress) },
    );

    await delay(40);
    expect(started).toBe(2); // the 3rd step is parked behind the shared semaphore
    // TASK.191 slice S3 (§B7): step_start fires for ALL THREE steps up front —
    // launchStep's onProgress({kind:"step_start"}) runs BEFORE subagents.run,
    // which is where the semaphore wait actually happens. So step_start alone
    // is exactly the wire-indistinguishable signal the plan's rejected
    // client-side heuristic tried (and failed) to read a queue state from.
    expect(events.filter((e) => e.kind === "step_start")).toHaveLength(3);
    // step_running (the honest post-semaphore signal) has landed for the two
    // that actually acquired a permit, but NOT for the one still parked.
    const runningIds = events.filter((e) => e.kind === "step_running").map((e) => e.stepId);
    expect(runningIds.sort()).toEqual(["s1", "s2"]);

    releaseGate();
    const outcome = await runPromise;
    expect(started).toBe(3); // it ran only after a permit freed
    expect(outcome.status).toBe("completed");
    expect(outcome.steps.every((step) => step.status === "completed")).toBe(true);
    // Once the permit frees, s3 finally gets its own step_running too.
    expect(events.filter((e) => e.kind === "step_running").map((e) => e.stepId).sort()).toEqual(["s1", "s2", "s3"]);
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
