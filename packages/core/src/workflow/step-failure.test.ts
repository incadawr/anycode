/**
 * TASK.193 slice S1: the per-step failure record and the model-facing summary.
 *
 * The arithmetic tests here deliberately re-derive the framing from the format
 * strings themselves rather than from a number copied out of the plan: a
 * summary cap that is only true for the numbers someone wrote down once is not
 * a cap.
 */

import { describe, expect, it } from "vitest";
import {
  INCOMPLETE_RESULT_LABEL,
  WORKFLOW_STEP_NO_ERROR_TEXT,
  buildFailureSummary,
  stepFailure,
  type StepFailure,
} from "./step-failure.js";
import {
  WORKFLOW_FAILURE_SUMMARY_MAX_BYTES,
  WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES,
} from "../types/config.js";
import type { WorkflowStepOutcome } from "../ports/workflow.js";
import type { WorkflowOutput } from "../tools/schemas.js";

type PayloadStep = WorkflowOutput["steps"][number];

const bytes = (text: string): number => new TextEncoder().encode(text).length;

/** A lone (unpaired) surrogate anywhere in the string. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function outcome(overrides: Partial<WorkflowStepOutcome> = {}): WorkflowStepOutcome {
  return {
    stepId: "s1",
    agentType: "general-purpose",
    status: "error",
    finalText: "boom",
    truncated: false,
    turns: 1,
    toolCalls: 0,
    durationMs: 5,
    ...overrides,
  };
}

function payloadStep(stepId: string, failure: StepFailure | undefined, status = "error"): PayloadStep {
  return {
    stepId,
    agentType: "general-purpose",
    status,
    turns: 1,
    toolCalls: 0,
    durationMs: 5,
    ...(failure !== undefined ? { failure } : {}),
  };
}

describe("stepFailure", () => {
  it("returns null for every step that carries no reason (completed, skipped, cancelled)", () => {
    expect(stepFailure(outcome({ status: "completed", finalText: "the answer" }))).toBeNull();
    expect(stepFailure(outcome({ status: "skipped", finalText: "" }))).toBeNull();
    // A cancelled step's finalText is its LAST FINISHED TURN, not a cause: the
    // cause is the run-level cancellation, so a non-empty text must still
    // produce no record.
    expect(stepFailure(outcome({ status: "cancelled", finalText: "half of a report" }))).toBeNull();
  });

  it("carries an error step's message verbatim", () => {
    const message = 'Agent: agent type "reviewer" runs on the "codex" engine.';
    expect(stepFailure(outcome({ status: "error", failureKind: "error", finalText: message }))).toEqual({
      kind: "error",
      text: message,
      truncated: false,
    });
  });

  it("labels the text by the engine's stamp, falling back to the status when unstamped", () => {
    expect(
      stepFailure(outcome({ status: "error", failureKind: "degenerate", finalText: "loop loop" }))?.kind,
    ).toBe("degenerate");
    expect(stepFailure(outcome({ status: "max_turns", finalText: "partial" }))?.kind).toBe("max_turns");
    expect(stepFailure(outcome({ status: "error", finalText: "boom" }))?.kind).toBe("error");
  });

  it("names an empty ERROR message but leaves an empty PARTIAL empty", () => {
    // An error status with no message is a hole worth naming. "produced
    // nothing before it was cut" is itself the fact for the partial kinds, and
    // inventing text there would make an empty partial read as a real one.
    expect(stepFailure(outcome({ status: "error", failureKind: "error", finalText: "" }))?.text).toBe(
      WORKFLOW_STEP_NO_ERROR_TEXT,
    );
    expect(stepFailure(outcome({ status: "max_turns", finalText: "" }))?.text).toBe("");
    expect(
      stepFailure(outcome({ status: "error", failureKind: "degenerate", finalText: "" }))?.text,
    ).toBe("");
  });

  it("caps the text at WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES and reports it, never leaving a partial char", () => {
    const ascii = stepFailure(outcome({ finalText: "a".repeat(9_000) }));
    expect(ascii?.truncated).toBe(true);
    expect(bytes(ascii?.text ?? "")).toBe(WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES);

    // The cut lands mid-emoji: the trailing partial sequence must be dropped,
    // not handed over as U+FFFD (which the model would read as content).
    const multibyte = stepFailure(outcome({ finalText: `a${"\u{1F600}".repeat(2_250)}` }));
    expect(multibyte?.truncated).toBe(true);
    expect(bytes(multibyte?.text ?? "")).toBeLessThanOrEqual(WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES);
    expect(multibyte?.text.endsWith("�")).toBe(false);
  });

  it("normalizes lone surrogates even when the text is well under the cap", () => {
    const failure = stepFailure(outcome({ finalText: "ab\uD800cd" }));
    expect(LONE_SURROGATE.test(failure?.text ?? "")).toBe(false);
    expect(failure?.text).toBe("ab�cd");
    // Replacing a lone surrogate is NOT truncation: the bit must stay honest.
    expect(failure?.truncated).toBe(false);
  });
});

describe("buildFailureSummary", () => {
  it("keeps today's one-line summary byte-identical as its first line", () => {
    const summary = buildFailureSummary("build", [
      payloadStep("a", undefined, "completed"),
      payloadStep("b", { kind: "error", text: "boom", truncated: false }),
      payloadStep("c", undefined, "skipped"),
    ]);
    expect(summary.split("\n\n")[0]).toBe('Workflow "build" failed. Failed: b. Skipped: c.');
  });

  it("passes a single 8192-byte failure text through whole, with no truncation marker", () => {
    const text = "x".repeat(WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES);
    const summary = buildFailureSummary("build", [
      payloadStep("b", { kind: "error", text, truncated: false }),
    ]);
    expect(summary).toContain(`Step "b" failed: ${text}`);
    expect(summary).not.toContain("step text truncated at");
    expect(bytes(summary)).toBeLessThanOrEqual(WORKFLOW_FAILURE_SUMMARY_MAX_BYTES);
  });

  it("passes two 8192-byte failure texts through whole", () => {
    const text = "x".repeat(WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES);
    const summary = buildFailureSummary("build", [
      payloadStep("a", { kind: "error", text, truncated: false }),
      payloadStep("b", { kind: "error", text, truncated: false }),
    ]);
    expect(summary).toContain(`Step "a" failed: ${text}`);
    expect(summary).toContain(`Step "b" failed: ${text}`);
    expect(summary).not.toContain("step text truncated at");
  });

  it("holds the WHOLE summary under the aggregate cap in the worst case (16 max-length ids, all degenerate, all over-long)", () => {
    // Legal maximum identifiers: schema.ts's NAME_RE allows 64 chars for the
    // workflow name and for every step id, and MAX_WORKFLOW_STEPS is 16 — every
    // one of which can fail, so this is a reachable shape, not a hypothetical.
    const name = "w".repeat(64);
    const ids = Array.from({ length: 16 }, (_, i) => `s${String(i).padStart(2, "0")}${"z".repeat(61)}`);
    expect(ids.every((id) => id.length === 64)).toBe(true);
    const text = "y".repeat(WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES);
    const summary = buildFailureSummary(
      name,
      ids.map((id) => payloadStep(id, { kind: "degenerate", text, truncated: false })),
    );

    expect(bytes(summary)).toBeLessThanOrEqual(WORKFLOW_FAILURE_SUMMARY_MAX_BYTES);

    // The share is re-derived here from the format strings, independently of
    // the builder's own arithmetic.
    const firstLine = `Workflow "${name}" failed. Failed: ${ids.join(", ")}.`;
    const framing = ids.reduce(
      (acc, id) =>
        acc +
        bytes(
          `\n\nStep "${id}" was cut off: its output degenerated into a repetition loop.\n${INCOMPLETE_RESULT_LABEL}\n`,
        ) +
        bytes("\n[step text truncated at 1000 bytes]"),
      bytes(firstLine),
    );
    const share = Math.floor((WORKFLOW_FAILURE_SUMMARY_MAX_BYTES - framing) / 16);
    expect(share).toBeGreaterThanOrEqual(1_024);
    expect(share).toBeLessThan(WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES);

    // Every block is cut to the SAME share and says so.
    const markers = summary.match(/\n\[step text truncated at \d+ bytes\]/g) ?? [];
    expect(markers).toHaveLength(16);
    expect(new Set(markers)).toEqual(new Set([`\n[step text truncated at ${share} bytes]`]));
    for (const id of ids) {
      expect(summary).toContain(
        `Step "${id}" was cut off: its output degenerated into a repetition loop.\n${INCOMPLETE_RESULT_LABEL}\n${"y".repeat(share)}\n[step text truncated at ${share} bytes]`,
      );
    }
  });

  it("leaves 16 short failure texts uncut: the share only bites over-long ones", () => {
    const steps = Array.from({ length: 16 }, (_, i) =>
      payloadStep(`s${i}`, { kind: "error", text: "e".repeat(100), truncated: false }),
    );
    const summary = buildFailureSummary("build", steps);
    expect(summary).not.toContain("step text truncated at");
    expect(bytes(summary)).toBeLessThan(WORKFLOW_FAILURE_SUMMARY_MAX_BYTES);
    for (let i = 0; i < 16; i += 1) {
      expect(summary).toContain(`Step "s${i}" failed: ${"e".repeat(100)}`);
    }
  });

  it("marks a text that arrived already truncated, even when the share does not cut it further", () => {
    const summary = buildFailureSummary("build", [
      payloadStep("b", { kind: "error", text: "short", truncated: true }),
    ]);
    expect(summary).toContain("step text truncated at");
  });

  it("labels a partial with the Agent tool's verbatim wording, and says so when there is no partial at all", () => {
    const withText = buildFailureSummary("build", [
      payloadStep("b", { kind: "max_turns", text: "half a plan", truncated: false }),
    ]);
    expect(withText).toContain('Step "b" ran out of turns without finishing.');
    expect(withText).toContain("INCOMPLETE SUBAGENT RESULT — DO NOT TREAT AS A FINISHED REPORT.");
    expect(withText).toContain("half a plan");

    const empty = buildFailureSummary("build", [
      payloadStep("b", { kind: "max_turns", text: "", truncated: false }),
    ]);
    expect(empty).toContain(
      'Step "b" ran out of turns without finishing and produced no partial result.',
    );
    expect(empty).not.toContain(INCOMPLETE_RESULT_LABEL);

    const degenerate = buildFailureSummary("build", [
      payloadStep("b", { kind: "degenerate", text: "loop loop loop", truncated: false }),
    ]);
    expect(degenerate).toContain("degenerated into a repetition loop");
    expect(degenerate).toContain(INCOMPLETE_RESULT_LABEL);

    const degenerateEmpty = buildFailureSummary("build", [
      payloadStep("b", { kind: "degenerate", text: "", truncated: false }),
    ]);
    expect(degenerateEmpty).toContain(
      'Step "b" was cut off: its output degenerated into a repetition loop and produced no partial result.',
    );
  });

  it("is the bare first line when nothing carries a failure record", () => {
    const summary = buildFailureSummary("build", [
      payloadStep("a", undefined, "completed"),
      payloadStep("c", undefined, "skipped"),
    ]);
    expect(summary).toBe('Workflow "build" failed. Skipped: c.');
  });
});
