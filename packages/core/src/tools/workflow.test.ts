/**
 * Workflow tool contract guards (Phase 3 slice 3.4, design §2.7). Covers the
 * fail-closed lock, name validation against the port snapshot, the outcome
 * mapping (completed/failed/cancelled), and the WorkflowProgress -> ctx.emit
 * bridge. The real DAG orchestration is exercised by slice 3.4.2's hermetic
 * tests; here the port is a fake.
 */

import { describe, expect, it } from "vitest";
import { workflowTool } from "./workflow.js";
import { WORKFLOW_OUTPUT_MAX_BYTES, WORKFLOW_TOOL_TIMEOUT_MS } from "../types/config.js";
import type { ToolContext, ToolEmittedEvent } from "../types/tools.js";
import type { CorePorts } from "../ports/index.js";
import type {
  WorkflowMeta,
  WorkflowPort,
  WorkflowProgress,
  WorkflowRunOptions,
  WorkflowRunOutcome,
  WorkflowStepOutcome,
} from "../ports/workflow.js";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    toolCallId: "call-1",
    abortSignal: new AbortController().signal,
    cwd: "/work",
    ports: {} as CorePorts,
    ...overrides,
  };
}

function meta(name: string): WorkflowMeta {
  return { name, description: `the ${name} workflow`, stepCount: 2, source: "project" };
}

function step(overrides: Partial<WorkflowStepOutcome> = {}): WorkflowStepOutcome {
  return {
    stepId: "s1",
    agentType: "general-purpose",
    status: "completed",
    finalText: "step text",
    truncated: false,
    turns: 1,
    toolCalls: 0,
    durationMs: 5,
    ...overrides,
  };
}

/** A WorkflowPort with a fixed list() and a run() returning `outcome`. */
function fakePort(
  names: string[],
  outcome: WorkflowRunOutcome,
  onRun?: (req: { name: string; input?: string }, opts: WorkflowRunOptions) => void,
): WorkflowPort {
  return {
    list: () => names.map(meta),
    run: async (req, opts) => {
      onRun?.(req, opts);
      return outcome;
    },
  };
}

describe("workflowTool", () => {
  it("carries the frozen metadata (design §2.7)", () => {
    expect(workflowTool.metadata).toMatchObject({
      name: "Workflow",
      readOnly: true,
      destructive: false,
      concurrentSafe: false,
      riskLevel: "low",
      sideEffectScope: "process",
      needsApproval: false,
      timeoutMs: WORKFLOW_TOOL_TIMEOUT_MS,
      maxTimeoutMs: WORKFLOW_TOOL_TIMEOUT_MS,
      maxOutputBytes: WORKFLOW_OUTPUT_MAX_BYTES,
    });
  });

  it("fails closed with an 'unavailable' error-outcome when no workflow port is present (non-recursion lock)", async () => {
    const result = await workflowTool.handler({ name: "build" }, makeCtx()); // workflows undefined
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unavailable");
    expect(result.errorKind).toBeUndefined();
  });

  it("returns invalid_input listing the available workflows for an unknown name", async () => {
    const port = fakePort(["release", "triage"], {
      status: "completed",
      output: "",
      truncated: false,
      steps: [],
      durationMs: 1,
    });
    const result = await workflowTool.handler({ name: "ghost" }, makeCtx({ workflows: port }));
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("invalid_input");
    expect(result.error).toContain("ghost");
    expect(result.error).toContain("release");
    expect(result.error).toContain("triage");
  });

  it("returns invalid_input with a 'no workflows' message when the snapshot is empty", async () => {
    const port = fakePort([], {
      status: "completed",
      output: "",
      truncated: false,
      steps: [],
      durationMs: 1,
    });
    const result = await workflowTool.handler({ name: "any" }, makeCtx({ workflows: port }));
    expect(result.errorKind).toBe("invalid_input");
    expect(result.error).toContain("No workflows are available");
  });

  it("maps a completed outcome onto the tool result and forwards {name, input} + signal", async () => {
    let seen: { name: string; input?: string } | undefined;
    let seenSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const outcome: WorkflowRunOutcome = {
      status: "completed",
      output: "the rendered output",
      truncated: false,
      steps: [step({ stepId: "a" }), step({ stepId: "b", agentType: "explore" })],
      durationMs: 42,
    };
    const port = fakePort(["build"], outcome, (req, opts) => {
      seen = req;
      seenSignal = opts.signal;
    });

    const result = await workflowTool.handler(
      { name: "build", input: "ship it" },
      makeCtx({ workflows: port, abortSignal: controller.signal }),
    );

    expect(seen).toEqual({ name: "build", input: "ship it" });
    expect(seenSignal).toBe(controller.signal);
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      status: "completed",
      output: "the rendered output",
      durationMs: 42,
    });
    // The step projection drops finalText/truncated.
    expect(result.output?.steps).toEqual([
      { stepId: "a", agentType: "general-purpose", status: "completed", turns: 1, toolCalls: 0, durationMs: 5 },
      { stepId: "b", agentType: "explore", status: "completed", turns: 1, toolCalls: 0, durationMs: 5 },
    ]);
    // The model sees the rendered output, not the JSON envelope.
    expect(workflowTool.formatResultForModel?.(result)).toBe("the rendered output");
  });

  it("appends a truncation marker in the model text when the output was capped", async () => {
    const port = fakePort(["build"], {
      status: "completed",
      output: "partial",
      truncated: true,
      steps: [],
      durationMs: 1,
    });
    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));
    expect(result.ok).toBe(true);
    expect(workflowTool.formatResultForModel?.(result)).toContain("partial");
    expect(workflowTool.formatResultForModel?.(result)).toContain("truncated");
  });

  it("maps a failed outcome onto an error-outcome naming the failed and skipped steps", async () => {
    const port = fakePort(["build"], {
      status: "failed",
      output: "partial output",
      truncated: false,
      steps: [
        step({ stepId: "a", status: "completed" }),
        step({ stepId: "b", status: "error" }),
        step({ stepId: "c", status: "skipped" }),
      ],
      durationMs: 9,
    });
    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed");
    expect(result.error).toContain("b"); // failed step
    expect(result.error).toContain("c"); // skipped step
    // The model text carries the summary AND the (partial) rendered output.
    const modelText = workflowTool.formatResultForModel?.(result);
    expect(modelText).toContain("b");
    expect(modelText).toContain("partial output");
  });

  it("maps a cancelled outcome onto an errorKind:'cancelled' outcome", async () => {
    const port = fakePort(["build"], {
      status: "cancelled",
      output: "",
      truncated: false,
      steps: [step({ status: "cancelled" })],
      durationMs: 3,
    });
    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));
    expect(result.ok).toBe(false);
    expect(result.errorKind).toBe("cancelled");
    expect(result.error).toContain("cancelled");
  });

  it("bridges every WorkflowProgress kind to a workflow_* event stamped with the tool call id", async () => {
    // Every field this bridge is supposed to copy field-by-field (S3's own
    // discipline note) gets a NON-default value here on purpose: a bridge
    // case that drops a spread still type-checks green (the field is
    // optional on the wire type) and a toMatchObject elsewhere would miss it
    // if the fixture never carried the field in the first place.
    const progressSequence: WorkflowProgress[] = [
      {
        kind: "start",
        workflow: "build",
        totalSteps: 2,
        steps: [
          { id: "a", agentType: "general-purpose" },
          { id: "b", agentType: "explore", dependsOn: ["a"] },
        ],
      },
      { kind: "step_start", stepId: "a", agentType: "general-purpose" },
      { kind: "step_running", stepId: "a" },
      {
        kind: "step_progress",
        stepId: "a",
        turns: 1,
        toolCalls: 2,
        lastTool: "Grep",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      },
      { kind: "step_activity", stepId: "a", toolName: "Read", summary: "a.ts" },
      {
        kind: "step_end",
        stepId: "a",
        status: "completed",
        turns: 2,
        durationMs: 7,
        usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 },
      },
      { kind: "end", status: "completed", completedSteps: 2, totalSteps: 2, durationMs: 20 },
    ];
    const port: WorkflowPort = {
      list: () => [meta("build")],
      run: async (_req, opts) => {
        for (const p of progressSequence) {
          opts.onProgress?.(p);
        }
        return { status: "completed", output: "ok", truncated: false, steps: [], durationMs: 20 };
      },
    };

    const emitted: ToolEmittedEvent[] = [];
    await workflowTool.handler(
      { name: "build" },
      makeCtx({ toolCallId: "wf-7", workflows: port, emit: (e) => emitted.push(e) }),
    );

    expect(emitted.map((e) => e.type)).toEqual([
      "workflow_start",
      "workflow_step_start",
      "workflow_step_running",
      "workflow_step_progress",
      "workflow_step_activity",
      "workflow_step_end",
      "workflow_end",
    ]);
    for (const event of emitted) {
      expect((event as { toolCallId: string }).toolCallId).toBe("wf-7");
    }
    expect(emitted[0]).toMatchObject({
      type: "workflow_start",
      workflow: "build",
      totalSteps: 2,
      steps: [
        { id: "a", agentType: "general-purpose" },
        { id: "b", agentType: "explore", dependsOn: ["a"] },
      ],
    });
    expect(emitted[2]).toMatchObject({ type: "workflow_step_running", stepId: "a" });
    expect(emitted[3]).toMatchObject({
      type: "workflow_step_progress",
      stepId: "a",
      turns: 1,
      toolCalls: 2,
      lastTool: "Grep",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
    expect(emitted[4]).toMatchObject({ type: "workflow_step_activity", stepId: "a", toolName: "Read", summary: "a.ts" });
    expect(emitted[5]).toMatchObject({
      type: "workflow_step_end",
      stepId: "a",
      status: "completed",
      usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 },
    });
    expect(emitted[6]).toMatchObject({ type: "workflow_end", status: "completed", completedSteps: 2, totalSteps: 2 });
  });
});

// Persisted workflow card snapshot (TASK.191 slice S5). This pins that the
// accumulator built in workflow/card-snapshot.ts actually reaches the tool
// result via `presentation.workflow` — the reducer's own unit tests
// (workflow/card-snapshot.test.ts) prove the reducer is correct in isolation,
// but only THIS file proves the wiring in tools/workflow.ts actually attaches
// it, mirroring tools/agent.test.ts's own "presentation attach" describe.
describe("workflowTool — presentation attach (TASK.191 slice S5)", () => {
  function progressSequence(): WorkflowProgress[] {
    return [
      {
        kind: "start",
        workflow: "build",
        totalSteps: 2,
        steps: [
          { id: "a", agentType: "general-purpose" },
          { id: "b", agentType: "explore", dependsOn: ["a"] },
        ],
      },
      { kind: "step_start", stepId: "a", agentType: "general-purpose" },
      { kind: "step_running", stepId: "a" },
      { kind: "step_activity", stepId: "a", toolName: "Read", summary: "a.ts" },
      {
        kind: "step_end",
        stepId: "a",
        status: "completed",
        turns: 2,
        durationMs: 7,
        usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 },
      },
      // "b" never actually launched — the synthetic skipped end (TASK.191 S3).
      { kind: "step_end", stepId: "b", status: "skipped", turns: 0, durationMs: 0 },
      { kind: "end", status: "failed", completedSteps: 1, totalSteps: 2, durationMs: 20 },
    ];
  }

  it("carries result.presentation.workflow with dependsOn, the skipped step's result, and per-step usage", async () => {
    const port: WorkflowPort = {
      list: () => [meta("build")],
      run: async (_req, opts) => {
        for (const p of progressSequence()) {
          opts.onProgress?.(p);
        }
        return {
          status: "failed",
          output: "partial",
          truncated: false,
          steps: [step({ stepId: "a" }), step({ stepId: "b", status: "skipped" })],
          durationMs: 20,
        };
      },
    };

    const result = await workflowTool.handler({ name: "build" }, makeCtx({ toolCallId: "wf-9", workflows: port }));

    expect(result.presentation?.workflow).toMatchObject({
      kind: "workflow",
      version: 1,
      workflow: "build",
      totalSteps: 2,
      final: { status: "failed", durationMs: 20 },
    });
    expect(result.presentation?.workflow?.steps).toEqual([
      {
        id: "a",
        agentType: "general-purpose",
        result: {
          status: "completed",
          turns: 2,
          durationMs: 7,
          usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 },
        },
      },
      {
        id: "b",
        agentType: "explore",
        dependsOn: ["a"],
        result: { status: "skipped", turns: 0, durationMs: 0 },
      },
    ]);
    expect(result.presentation?.workflow?.activity.entries).toEqual([{ stepId: "a", toolName: "Read", summary: "a.ts" }]);
  });

  it("a completed run (ok branch) also carries presentation", async () => {
    const port: WorkflowPort = {
      list: () => [meta("build")],
      run: async (_req, opts) => {
        opts.onProgress?.({ kind: "start", workflow: "build", totalSteps: 1, steps: [{ id: "a", agentType: "explore" }] });
        opts.onProgress?.({ kind: "step_end", stepId: "a", status: "completed", turns: 1, durationMs: 5 });
        opts.onProgress?.({ kind: "end", status: "completed", completedSteps: 1, totalSteps: 1, durationMs: 5 });
        return { status: "completed", output: "ok", truncated: false, steps: [step({ stepId: "a" })], durationMs: 5 };
      },
    };
    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));
    expect(result.ok).toBe(true);
    expect(result.presentation?.workflow?.final).toEqual({ status: "completed", durationMs: 5 });
  });

  it("a cancelled run (errorKind branch) also carries presentation", async () => {
    const port: WorkflowPort = {
      list: () => [meta("build")],
      run: async (_req, opts) => {
        opts.onProgress?.({ kind: "start", workflow: "build", totalSteps: 1, steps: [{ id: "a", agentType: "explore" }] });
        opts.onProgress?.({ kind: "end", status: "cancelled", completedSteps: 0, totalSteps: 1, durationMs: 3 });
        return { status: "cancelled", output: "", truncated: false, steps: [step({ status: "cancelled" })], durationMs: 3 };
      },
    };
    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));
    expect(result.errorKind).toBe("cancelled");
    expect(result.presentation?.workflow?.final).toEqual({ status: "cancelled", durationMs: 3 });
  });

  it("a run that never reaches workflow_start (e.g. an unknown-name failure resolved with no progress at all) attaches NO presentation — the card is not fabricated", async () => {
    // Mirrors the port's own contract for the unknown-name/pre-aborted/
    // unknown-agentType early-return paths (workflow/engine.ts): onProgress is
    // never called at all.
    const port = fakePort(["build"], {
      status: "failed",
      output: "",
      truncated: false,
      steps: [],
      durationMs: 1,
    });
    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));
    expect(result.presentation).toBeUndefined();
  });

  it("accumulates presentation even with no ctx.emit wired (accumulation is unconditional, emission is not)", async () => {
    const port: WorkflowPort = {
      list: () => [meta("build")],
      run: async (_req, opts) => {
        opts.onProgress?.({ kind: "start", workflow: "build", totalSteps: 1, steps: [{ id: "a", agentType: "explore" }] });
        opts.onProgress?.({ kind: "step_activity", stepId: "a", toolName: "Bash", summary: "cmd-0" });
        opts.onProgress?.({ kind: "step_end", stepId: "a", status: "completed", turns: 1, durationMs: 5 });
        opts.onProgress?.({ kind: "end", status: "completed", completedSteps: 1, totalSteps: 1, durationMs: 5 });
        return { status: "completed", output: "ok", truncated: false, steps: [step({ stepId: "a" })], durationMs: 5 };
      },
    };
    // makeCtx() carries no `emit` override.
    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));
    expect(result.presentation?.workflow?.activity.entries).toEqual([{ stepId: "a", toolName: "Bash", summary: "cmd-0" }]);
  });
});
