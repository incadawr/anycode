/**
 * A failed workflow step's reason, on its way out of the engine (TASK.193).
 *
 * The engine builds a truthful reason for every step that did not complete and
 * the tool boundary used to drop it, leaving the owner with nothing but
 * `Workflow "x" failed. Failed: b.`. This module owns the two shapes that carry
 * it instead:
 *
 *   - `stepFailure()` — the per-step record for the channels that are NOT the
 *     model's context (tool payload, wire event, persisted card), capped at
 *     WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES;
 *   - `buildFailureSummary()` — the single string the model reads, capped as a
 *     WHOLE at WORKFLOW_FAILURE_SUMMARY_MAX_BYTES. The per-step share is what
 *     is left after the REAL framing (first line, block headers, truncation
 *     markers) has been subtracted, so the cap is a fact about the produced
 *     string rather than a hope about it.
 *
 * The text is labelled with what it IS: an "error" record carries an error
 * message, while "max_turns"/"degenerate" carry a PARTIAL output the child
 * never finished — marked with the Agent tool's own verbatim wording so the
 * same words mean the same thing on both spawn paths.
 */

import { capUtf8Bytes } from "../util/bytes.js";
import {
  WORKFLOW_FAILURE_SUMMARY_MAX_BYTES,
  WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES,
} from "../types/config.js";
import type { WorkflowStepOutcome } from "../ports/workflow.js";
import type { WorkflowOutput } from "../tools/schemas.js";

/** Stand-in when a failed step reported an error status but no message at all. */
export const WORKFLOW_STEP_NO_ERROR_TEXT = "(the step reported no error text)";

/** Verbatim from tools/agent.ts (:151, :205): one wording for one meaning. */
export const INCOMPLETE_RESULT_LABEL =
  "INCOMPLETE SUBAGENT RESULT — DO NOT TREAT AS A FINISHED REPORT.";

export interface StepFailure {
  /** What `text` is: an error message, or an unfinished partial output. */
  kind: "error" | "degenerate" | "max_turns";
  text: string;
  /** True when `text` is a prefix of what the step actually produced. */
  truncated: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Replaces lone surrogates with U+FFFD by round-tripping through UTF-8. Done
 * UNCONDITIONALLY, not only when the cap bites: a child's final text can end
 * mid-surrogate-pair for reasons of its own, and a lone surrogate in a payload
 * survives JSON.stringify only to break the reader (structured clone, SQLite
 * text, a JSON parse on the far side).
 */
function normalizeSurrogates(text: string): string {
  return decoder.decode(encoder.encode(text));
}

/**
 * The per-step failure record, or null for a step that carries no reason:
 * `completed` and `skipped` have none, and `cancelled` steps' text is the last
 * finished turn rather than a cause (the cause is the run-level cancellation).
 */
export function stepFailure(
  outcome: Pick<WorkflowStepOutcome, "status" | "finalText" | "failureKind">,
  maxBytes: number = WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES,
): StepFailure | null {
  if (
    outcome.status === "completed" ||
    outcome.status === "skipped" ||
    outcome.status === "cancelled"
  ) {
    return null;
  }
  // The stamp is the truth when present; the fallback keeps an outcome built by
  // an older/foreign WorkflowPort implementation labelled rather than unlabelled.
  const kind: StepFailure["kind"] =
    outcome.failureKind ?? (outcome.status === "max_turns" ? "max_turns" : "error");
  const capped = capUtf8Bytes(normalizeSurrogates(outcome.finalText), maxBytes);
  // An empty error message is a hole worth naming. An empty PARTIAL is a fact —
  // the child produced nothing before it was cut — and stays empty, so the
  // summary can say "produced no partial result" instead of inventing text.
  const text = capped.text.length === 0 && kind === "error" ? WORKFLOW_STEP_NO_ERROR_TEXT : capped.text;
  return { kind, text, truncated: capped.truncated };
}

/** One-line failure summary: the workflow name + its failed and skipped step ids. */
function summaryFirstLine(name: string, steps: WorkflowOutput["steps"]): string {
  const failed = steps
    .filter((step) => step.status !== "completed" && step.status !== "skipped")
    .map((step) => step.stepId);
  const skipped = steps.filter((step) => step.status === "skipped").map((step) => step.stepId);
  const parts = [`Workflow "${name}" failed.`];
  if (failed.length > 0) {
    parts.push(`Failed: ${failed.join(", ")}.`);
  }
  if (skipped.length > 0) {
    parts.push(`Skipped: ${skipped.join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * The header a block opens with — everything but the failure text itself. It
 * absorbs the "no partial result" wording, so a block with no text is a header
 * and nothing else and the arithmetic below stays exact.
 */
function blockHeader(stepId: string, kind: StepFailure["kind"], hasText: boolean): string {
  if (kind === "error") {
    return `Step "${stepId}" failed: `;
  }
  if (kind === "max_turns") {
    return hasText
      ? `Step "${stepId}" ran out of turns without finishing.\n${INCOMPLETE_RESULT_LABEL}\n`
      : `Step "${stepId}" ran out of turns without finishing and produced no partial result.`;
  }
  return hasText
    ? `Step "${stepId}" was cut off: its output degenerated into a repetition loop.\n${INCOMPLETE_RESULT_LABEL}\n`
    : `Step "${stepId}" was cut off: its output degenerated into a repetition loop and produced no partial result.`;
}

function truncationMarker(share: number): string {
  return `\n[step text truncated at ${share} bytes]`;
}

/** Separator between the first line and each block, and between blocks. */
const BLOCK_SEPARATOR = "\n\n";

/**
 * The whole string the model reads for a failed run: today's one-line summary
 * followed by one labelled block per failed step, the whole thing within
 * WORKFLOW_FAILURE_SUMMARY_MAX_BYTES.
 *
 * The share each step's text gets is `(cap - framing) / failedCount`, with the
 * framing measured from the strings this function actually emits — the first
 * line with its real step ids, each block's real header, and one truncation
 * marker per step whether or not that step ends up needing one. The marker is
 * budgeted with a four-digit number, an upper bound because the share can never
 * exceed the four-digit WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES. Every term is
 * therefore an over-estimate of what is emitted, which is what makes the cap a
 * guarantee rather than an average.
 */
export function buildFailureSummary(name: string, steps: WorkflowOutput["steps"]): string {
  const firstLine = summaryFirstLine(name, steps);
  const blocks = steps.flatMap((step) => {
    const failure = step.failure;
    if (failure === undefined) {
      return [];
    }
    const text =
      failure.kind === "error" && failure.text.length === 0
        ? WORKFLOW_STEP_NO_ERROR_TEXT
        : failure.text;
    return [{ stepId: step.stepId, failure, text, header: blockHeader(step.stepId, failure.kind, text.length > 0) }];
  });
  if (blocks.length === 0) {
    return firstLine;
  }

  const markerBudget = byteLength(truncationMarker(1000));
  const framing = blocks.reduce(
    (acc, block) => acc + byteLength(BLOCK_SEPARATOR + block.header) + markerBudget,
    byteLength(firstLine),
  );
  const share = Math.min(
    WORKFLOW_STEP_FAILURE_TEXT_MAX_BYTES,
    Math.max(0, Math.floor((WORKFLOW_FAILURE_SUMMARY_MAX_BYTES - framing) / blocks.length)),
  );

  const rendered = blocks.map((block) => {
    const recap = capUtf8Bytes(block.text, share);
    // The incoming record may ALREADY be a prefix (the per-step cap bit): the
    // marker is owed either way, so the model is never handed a partial text
    // that reads as complete.
    const marker = block.failure.truncated || recap.truncated ? truncationMarker(share) : "";
    return `${BLOCK_SEPARATOR}${block.header}${recap.text}${marker}`;
  });
  return `${firstLine}${rendered.join("")}`;
}
