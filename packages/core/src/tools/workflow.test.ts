/**
 * Workflow tool contract guards (Phase 3 slice 3.4, design §2.7). Covers the
 * fail-closed lock, name validation against the port snapshot, the outcome
 * mapping (completed/failed/cancelled), and the WorkflowProgress -> ctx.emit
 * bridge. The real DAG orchestration is exercised by slice 3.4.2's hermetic
 * tests; here the port is a fake.
 */

import { describe, expect, it } from "vitest";
import { workflowTool } from "./workflow.js";
import {
  DEFAULT_TOOL_RESULT_BUDGET,
  WORKFLOW_FAILURE_SUMMARY_MAX_BYTES,
  WORKFLOW_OUTPUT_MAX_BYTES,
  WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES,
  WORKFLOW_TOOL_TIMEOUT_MS,
} from "../types/config.js";
import { capUtf8Bytes } from "../util/bytes.js";
import { applyResultBudget } from "../util/result-budget.js";
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
    // Completed steps carry NO failure record: what the model sees of a
    // successful step is the definition author's call (outputTemplate/sink),
    // never a payload duplicate (TASK.193 DoD #4).
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

  // TASK.221: a precheck-failed outcome reaches the persisted payload with the
  // SAME cap the normal run path applies — the engine caps its unknown-agentType
  // summary via capUtf8Bytes(…, WORKFLOW_OUTPUT_MAX_BYTES) and reports
  // truncated; the tool must render the existing truncation marker for it.
  it("appends the truncation marker for a real oversized PRECHECK result (failed, capped output)", async () => {
    const hugeType = "x".repeat(WORKFLOW_OUTPUT_MAX_BYTES + 100);
    // Exactly what the engine's fail-fast precheck produces for this step.
    const engineOutcome = capUtf8Bytes(
      `step A: unknown agentType "${hugeType}"`,
      WORKFLOW_OUTPUT_MAX_BYTES,
    );
    const port = fakePort(["big-precheck"], {
      status: "failed",
      output: engineOutcome.text,
      truncated: engineOutcome.truncated,
      steps: [step({ stepId: "A", status: "error", finalText: engineOutcome.text })],
      durationMs: 1,
    });

    const result = await workflowTool.handler(
      { name: "big-precheck" },
      makeCtx({ workflows: port }),
    );

    expect(result.ok).toBe(false);
    // The persisted output is capped at exactly WORKFLOW_OUTPUT_MAX_BYTES.
    expect(result.output?.truncated).toBe(true);
    expect(new TextEncoder().encode(result.output?.output ?? "").length).toBe(
      WORKFLOW_OUTPUT_MAX_BYTES,
    );
    // The model text carries the existing marker convention.
    expect(workflowTool.formatResultForModel?.(result)).toContain(
      `[workflow output truncated at ${WORKFLOW_OUTPUT_MAX_BYTES} bytes]`,
    );
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

  it("bridges step_end's failure and unlaunched fields onto workflow_step_end (TASK.193 slice S2)", async () => {
    const port: WorkflowPort = {
      list: () => [meta("build")],
      run: async (_req, opts) => {
        opts.onProgress?.({
          kind: "start",
          workflow: "build",
          totalSteps: 1,
          steps: [{ id: "a", agentType: "general-purpose" }],
        });
        opts.onProgress?.({
          kind: "step_end",
          stepId: "a",
          status: "error",
          turns: 0,
          durationMs: 0,
          failure: { kind: "error", text: 'Unknown agentType "nope".', truncated: false },
          unlaunched: true,
        });
        opts.onProgress?.({ kind: "end", status: "failed", completedSteps: 0, totalSteps: 1, durationMs: 1 });
        return { status: "failed", output: "", truncated: false, steps: [], durationMs: 1 };
      },
    };

    const emitted: ToolEmittedEvent[] = [];
    await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port, emit: (e) => emitted.push(e) }));

    const stepEnd = emitted.find((e) => e.type === "workflow_step_end");
    expect(stepEnd).toMatchObject({
      type: "workflow_step_end",
      stepId: "a",
      failure: { kind: "error", text: 'Unknown agentType "nope".', truncated: false },
      unlaunched: true,
    });
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

  it("carries a failed step's failure and unlaunched into the persisted card result (TASK.193 slice S2)", async () => {
    const reason = 'Unknown agentType "nope" (available: general-purpose).';
    const port: WorkflowPort = {
      list: () => [meta("build")],
      run: async (_req, opts) => {
        opts.onProgress?.({
          kind: "start",
          workflow: "build",
          totalSteps: 1,
          steps: [{ id: "a", agentType: "nope" }],
        });
        opts.onProgress?.({
          kind: "step_end",
          stepId: "a",
          status: "error",
          turns: 0,
          durationMs: 0,
          failure: { kind: "error", text: reason, truncated: false },
          unlaunched: true,
        });
        opts.onProgress?.({ kind: "end", status: "failed", completedSteps: 0, totalSteps: 1, durationMs: 1 });
        return {
          status: "failed",
          output: "",
          truncated: false,
          steps: [
            step({ stepId: "a", status: "error", failureKind: "error", unlaunched: true, finalText: reason }),
          ],
          durationMs: 1,
        };
      },
    };

    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));

    expect(result.presentation?.workflow?.steps[0]?.result).toEqual({
      status: "error",
      turns: 0,
      durationMs: 0,
      failure: { kind: "error", text: reason, truncated: false },
      unlaunched: true,
    });
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

// ---------------------------------------------------------------------------
// TASK.193 slice S1. Before this, the tool boundary built a truthful reason for
// every failed step and then threw it away, leaving the owner with nothing but
// `Workflow "x" failed. Failed: b.` — every failure debugged by guessing.

describe("workflowTool — failure record (TASK.193)", () => {
  const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

  it("carries a failed step's reason into the payload, and only a failed step's", async () => {
    const reason = 'Agent: agent type "reviewer" runs on the "codex" engine. Engine agents now run in their own tier.';
    const port = fakePort(["build"], {
      status: "failed",
      output: "partial output",
      truncated: false,
      steps: [
        step({ stepId: "a" }),
        step({ stepId: "b", status: "error", failureKind: "error", finalText: reason }),
        step({ stepId: "c", status: "skipped", finalText: "" }),
      ],
      durationMs: 9,
    });

    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));

    const steps = result.output?.steps ?? [];
    expect(steps[1]?.failure).toEqual({ kind: "error", text: reason, truncated: false });
    expect(steps[0]).not.toHaveProperty("failure");
    expect(steps[2]).not.toHaveProperty("failure");
    // The port stamped no `unlaunched`, so nobody may invent one.
    for (const projected of steps) {
      expect(projected).not.toHaveProperty("unlaunched");
    }
  });

  it("puts the reason in the model's text, ahead of the rendered (partial) output", async () => {
    const reason = 'Agent: agent type "reviewer" runs on the "codex" engine.';
    const port = fakePort(["build"], {
      status: "failed",
      output: "partial output",
      truncated: false,
      steps: [
        step({ stepId: "a" }),
        step({ stepId: "b", status: "error", failureKind: "error", finalText: reason }),
      ],
      durationMs: 9,
    });

    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));

    expect(result.error).toContain('Step "b" failed: Agent: agent type');
    const modelText = workflowTool.formatResultForModel?.(result) ?? "";
    expect(modelText).toContain('Step "b" failed: Agent: agent type');
    expect(modelText.indexOf('Step "b" failed:')).toBeLessThan(modelText.indexOf("partial output"));
  });

  it("labels an unfinished partial as unfinished, and records nothing for a cancelled step", async () => {
    const port = fakePort(["build"], {
      status: "failed",
      output: "",
      truncated: false,
      steps: [
        step({ stepId: "b", status: "max_turns", failureKind: "max_turns", finalText: "half a plan" }),
        step({ stepId: "d", status: "cancelled", finalText: "the last finished turn" }),
      ],
      durationMs: 9,
    });

    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));

    expect(result.output?.steps[0]?.failure?.kind).toBe("max_turns");
    expect(result.output?.steps[1]).not.toHaveProperty("failure");
    expect(result.error).toContain("INCOMPLETE SUBAGENT RESULT — DO NOT TREAT AS A FINISHED REPORT.");
  });

  it("leaves a cancelled RUN's message and steps untouched (the cause is the cancellation, not a step)", async () => {
    const port = fakePort(["build"], {
      status: "cancelled",
      output: "",
      truncated: false,
      steps: [step({ stepId: "a", status: "cancelled", finalText: "half a report" })],
      durationMs: 3,
    });

    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));

    expect(result.error).toBe('Workflow "build" was cancelled.');
    expect(result.output?.steps[0]).not.toHaveProperty("failure");
  });

  it("forwards `unlaunched` from the outcome and never fabricates it", async () => {
    const port = fakePort(["build"], {
      status: "failed",
      output: "",
      truncated: false,
      steps: [
        step({
          stepId: "b",
          status: "error",
          failureKind: "error",
          unlaunched: true,
          finalText: 'Unknown agentType "nope" (available: general-purpose).',
        }),
        step({ stepId: "c", status: "error", failureKind: "error", finalText: "boom" }),
      ],
      durationMs: 9,
    });

    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));

    expect(result.output?.steps[0]?.unlaunched).toBe(true);
    expect(result.output?.steps[1]).not.toHaveProperty("unlaunched");
  });

  it("does NOT duplicate successful step text into the payload (DoD #4, by weight)", async () => {
    const port = fakePort(["build"], {
      status: "completed",
      output: "",
      truncated: false,
      steps: Array.from({ length: 16 }, (_, i) =>
        step({ stepId: `s${i}`, status: "completed", finalText: "t".repeat(100_000) }),
      ),
      durationMs: 9,
    });

    const result = await workflowTool.handler({ name: "build" }, makeCtx({ workflows: port }));

    expect(JSON.stringify(result.output).length).toBeLessThan(20_000);
  });

  it("keeps the whole summary AND most of the output inside the dispatcher's real budget (worst case)", async () => {
    // The boundary that matters is the string the dispatcher caps —
    // `error + "\n\n" + output` — not `result.error` on its own.
    const name = "w".repeat(64);
    const ids = Array.from({ length: 16 }, (_, i) => `s${String(i).padStart(2, "0")}${"z".repeat(61)}`);
    const port = fakePort([name], {
      status: "failed",
      output: "o".repeat(100_000),
      truncated: false,
      steps: ids.map((id) =>
        step({
          stepId: id,
          status: "error",
          failureKind: "degenerate",
          finalText: "y".repeat(9_000),
        }),
      ),
      durationMs: 9,
    });

    const result = await workflowTool.handler({ name }, makeCtx({ workflows: port }));

    // The payload keeps the full per-step cap; only the model's copy is squeezed.
    for (const projected of result.output?.steps ?? []) {
      expect(bytes(projected.failure?.text ?? "")).toBe(WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES);
    }
    expect(bytes(result.error ?? "")).toBeLessThanOrEqual(WORKFLOW_FAILURE_SUMMARY_MAX_BYTES);

    const modelText = workflowTool.formatResultForModel?.(result) ?? "";
    expect(modelText.startsWith(`${result.error ?? ""}\n\n`)).toBe(true);

    const capped = applyResultBudget(
      modelText,
      DEFAULT_TOOL_RESULT_BUDGET.maxModelBytes,
      DEFAULT_TOOL_RESULT_BUDGET.previewDirection,
    );
    // Every one of the 16 reason blocks survived the cap whole...
    expect(capped.startsWith(result.error ?? "")).toBe(true);
    for (const id of ids) {
      expect(capped).toContain(`Step "${id}" was cut off:`);
    }
    // ...and the rendered output still reached the model in bulk.
    expect(capped).toContain("o".repeat(70_000));
  });

  it("pins the two caps against the channel they are derived from", () => {
    expect(WORKFLOW_FAILURE_SUMMARY_MAX_BYTES * 4).toBeLessThanOrEqual(
      DEFAULT_TOOL_RESULT_BUDGET.maxModelBytes,
    );
    expect(WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES).toBeLessThan(WORKFLOW_FAILURE_SUMMARY_MAX_BYTES);
  });
});
