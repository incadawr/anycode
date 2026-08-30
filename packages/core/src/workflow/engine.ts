/**
 * Workflow engine (Phase 3 slice 3.4, design §3.3-3.5 + §2.10). Backs the
 * WorkflowPort with a declarative DAG driven ENTIRELY through the parent's
 * SubagentPort — no new spawn path, no engine-local semaphore (a run shares the
 * one MAX_CONCURRENT_SUBAGENTS semaphore of the runner, §0.1), and no new kill
 * code (cancellation cascades into the existing child-loop SIGTERM/SIGKILL chain).
 *
 * Import direction (§2.10): workflow/ imports ONLY ports/types/util (+ the
 * personas data leaf for the fail-fast fallback, §3.3) and a TYPE-ONLY
 * AgentLoopConfig — it never imports the runner or AgentLoop, and loop/ knows
 * only the WorkflowPort type (the mirror of the SubagentPort arrow).
 *
 * DAG semantics (§3.4):
 *   - ready-set = steps whose deps are ALL completed; every ready step is
 *     launched immediately through SubagentPort.run — the runner's shared
 *     semaphore (=2) is the ONLY limiter, so the engine adds no parallelism cap.
 *   - each step's prompt is rendered from ${input} + prior completed steps'
 *     finalText (renderTemplate); data flows only along declared edges.
 *   - per-step timeout is armed on the child's start-progress (POST-semaphore),
 *     so a step parked behind the semaphore never burns its budget while queued.
 *   - fail-fast: the first non-completed step (max_turns counts as a failure)
 *     stops NEW launches; in-flight steps finish and their outcomes are recorded;
 *     never-launched steps become "skipped"; the run status is "failed".
 *   - cancellation: the run signal aborts every in-flight step controller, which
 *     cascades into the child loops and their processes; the run status is
 *     "cancelled".
 */

import type { AgentLoopConfig } from "../loop/agent-loop.js";
import type {
  SubagentOutcome,
  SubagentPort,
  SubagentProgress,
  SubagentRunOptions,
} from "../ports/subagent.js";
import type {
  WorkflowDefinition,
  WorkflowMeta,
  WorkflowPort,
  WorkflowProgress,
  WorkflowRunOptions,
  WorkflowRunOutcome,
  WorkflowStepDefinition,
  WorkflowStepOutcome,
} from "../ports/workflow.js";
import { listPersonaNames } from "../subagents/personas.js";
import {
  WORKFLOW_OUTPUT_MAX_BYTES,
  WORKFLOW_STEP_PROMPT_MAX_BYTES,
  WORKFLOW_STEP_TIMEOUT_MS,
} from "../types/config.js";
import { capUtf8Bytes } from "../util/bytes.js";
import { renderTemplate } from "./template.js";

/** Internal knobs the frozen createWorkflowRunner does not expose (test seam only). */
interface WorkflowRunnerOptions {
  /** Per-step wall-clock timeout, armed on the child's start-progress. */
  stepTimeoutMs?: number;
}

/**
 * Builds a WorkflowPort backed by DAG runs over `subagents` (design §2.10). The
 * engine drives every step through this SubagentPort, so a run never adds a
 * spawn path and shares the runner's single semaphore. `opts` is an internal
 * test seam (per-step timeout override); the public wrapper below keeps the
 * frozen two-argument signature.
 */
function createRunner(
  subagents: SubagentPort,
  definitions: readonly WorkflowDefinition[],
  opts?: WorkflowRunnerOptions,
): WorkflowPort {
  const stepTimeoutMs = opts?.stepTimeoutMs ?? WORKFLOW_STEP_TIMEOUT_MS;

  // First definition wins on a duplicate name; discovery (3.4.3) already dedupes
  // project>user, so this only guards a hand-built list.
  const byName = new Map<string, WorkflowDefinition>();
  for (const def of definitions) {
    if (!byName.has(def.name)) {
      byName.set(def.name, def);
    }
  }

  return {
    list(): WorkflowMeta[] {
      return [...byName.values()].map((def) => ({
        name: def.name,
        description: def.description,
        stepCount: def.steps.length,
        source: def.source,
      }));
    },

    async run(
      req: { name: string; input?: string },
      runOpts: WorkflowRunOptions,
    ): Promise<WorkflowRunOutcome> {
      const startedAt = Date.now();
      const input = req.input ?? "";
      const { signal, onProgress } = runOpts;

      const definition = byName.get(req.name);
      if (!definition) {
        const names = [...byName.keys()].join(", ") || "(none)";
        return {
          status: "failed",
          output: `Unknown workflow "${req.name}". Available workflows: ${names}.`,
          truncated: false,
          steps: [],
          durationMs: Date.now() - startedAt,
        };
      }

      const steps = definition.steps;

      // Pre-aborted: never start anything (mirror of the subagent runner).
      if (signal?.aborted) {
        return {
          status: "cancelled",
          output: "",
          truncated: false,
          steps: steps.map((step) => skippedOutcome(step)),
          durationMs: Date.now() - startedAt,
        };
      }

      // Fail-fast pre-check (§3.3): an unknown agentType fails the whole run
      // BEFORE any child launches — zero tokens spent. Prefer the port's live
      // agent-type list; fall back to built-in personas for a port without it.
      const available = new Set(subagents.listAgentTypes?.() ?? listPersonaNames());
      const unknownSteps = steps.filter((step) => !available.has(step.agentType));
      if (unknownSteps.length > 0) {
        const availableList = [...available].join(", ");
        const outcomes = steps.map((step) =>
          available.has(step.agentType)
            ? skippedOutcome(step)
            : errorOutcome(
                step,
                `Unknown agentType "${step.agentType}" (available: ${availableList}).`,
              ),
        );
        const summary = unknownSteps
          .map((step) => `step ${step.id}: unknown agentType "${step.agentType}"`)
          .join("\n");
        return {
          status: "failed",
          output: summary,
          truncated: false,
          steps: outcomes,
          durationMs: Date.now() - startedAt,
        };
      }

      onProgress?.({
        kind: "start",
        workflow: definition.name,
        totalSteps: steps.length,
        // TASK.191 slice S3: field-by-field, not `steps` verbatim — the
        // engine's own WorkflowStepDefinition carries promptTemplate/maxTurns
        // too, neither of which belongs on the wire (never rendered, and
        // promptTemplate can hold arbitrary-length user content).
        steps: steps.map((step) => ({
          id: step.id,
          agentType: step.agentType,
          ...(step.dependsOn !== undefined ? { dependsOn: step.dependsOn } : {}),
        })),
      });

      // --- run state -------------------------------------------------------
      const outcomes = new Map<string, WorkflowStepOutcome>();
      const completedOutputs = new Map<string, string>();
      const stepControllers = new Set<AbortController>();
      const launched = new Set<string>();
      const running = new Map<string, Promise<{ id: string; outcome: WorkflowStepOutcome }>>();
      let failed = false;
      let aborted = false;

      // Run-level abort cascades into every in-flight step (design §3.4); the
      // per-step signals reach the child loops and their processes through the
      // existing SIGTERM/SIGKILL chain — no new kill path.
      const onRunAbort = (): void => {
        aborted = true;
        for (const controller of stepControllers) {
          controller.abort();
        }
      };
      signal?.addEventListener("abort", onRunAbort, { once: true });

      const depsSatisfied = (step: WorkflowStepDefinition): boolean =>
        (step.dependsOn ?? []).every((dep) => completedOutputs.has(dep));

      const launchStep = async (
        step: WorkflowStepDefinition,
      ): Promise<{ id: string; outcome: WorkflowStepOutcome }> => {
        const stepStartedAt = Date.now();
        onProgress?.({ kind: "step_start", stepId: step.id, agentType: step.agentType });

        // Render the prompt from prior completed outputs. A reference to a step
        // absent from the map throws (renderTemplate contract); static
        // validation (refs ⊆ dependsOn, 3.4.3) makes it unreachable on a valid
        // graph, so a throw here is an engine-level step error.
        let prompt: string;
        try {
          prompt = renderTemplate(step.promptTemplate, { input, steps: completedOutputs });
        } catch (error) {
          const outcome = errorOutcome(
            step,
            error instanceof Error ? error.message : String(error),
            Date.now() - stepStartedAt,
          );
          onProgress?.({
            kind: "step_end",
            stepId: step.id,
            status: outcome.status,
            turns: 0,
            durationMs: outcome.durationMs,
          });
          return { id: step.id, outcome };
        }
        const cappedPrompt = capUtf8Bytes(prompt, WORKFLOW_STEP_PROMPT_MAX_BYTES);

        const controller = new AbortController();
        stepControllers.add(controller);
        // Lost race: the run aborted between the ready-check and here.
        if (aborted) {
          controller.abort();
        }

        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const subOpts: SubagentRunOptions = {
          signal: controller.signal,
          onProgress: (progress: SubagentProgress) => {
            if (progress.kind === "start") {
              // Arm the per-step timeout on the child's ACTUAL start (post-
              // semaphore, §3.4) so a queued step never times out while parked.
              if (timer === undefined) {
                timer = setTimeout(() => {
                  timedOut = true;
                  controller.abort();
                }, stepTimeoutMs);
              }
              // TASK.191 slice S3: this SAME post-semaphore moment is the
              // honest "queued -> running" transition — step_start above
              // already fired, ready-but-unlaunched, before the semaphore.
              onProgress?.({ kind: "step_running", stepId: step.id });
            } else if (progress.kind === "progress") {
              onProgress?.({
                kind: "step_progress",
                stepId: step.id,
                turns: progress.turns,
                toolCalls: progress.toolCalls,
                lastTool: progress.lastTool,
                // TASK.191 slice S2: the child's own running spend, restamped
                // with this step's id. Forwarded unchanged — the engine never
                // sums across steps, because a run's total is derived from the
                // per-step numbers by whoever displays them.
                ...(progress.usage !== undefined ? { usage: progress.usage } : {}),
              });
            } else if (progress.kind === "tool") {
              // TASK.191 slice S1. The child's per-tool one-liner, restamped
              // with this step's id. Until this branch existed the whole
              // `tool` kind fell through to nothing here, which is why a
              // workflow run showed counters and never named a single tool.
              onProgress?.({
                kind: "step_activity",
                stepId: step.id,
                toolName: progress.toolName,
                summary: progress.summary,
              });
            }
            // progress.kind === "end" is ignored: step_end is emitted from the
            // resolved outcome so the reported status includes a timeout
            // override the subagent cannot know about.
            //
            // `attention` and `stalled` are ignored too: both describe a
            // SESSION-tier child, and a workflow step is inline (TASK.192 —
            // an engine-profile step cannot start at all today), so neither
            // can occur on this path. They get their own branches when a
            // workflow step can reach the session tier, not before.
          },
        };

        let sub: SubagentOutcome;
        try {
          sub = await subagents.run(
            {
              agentType: step.agentType,
              description: `workflow ${definition.name} step ${step.id}`,
              prompt: cappedPrompt.text,
              maxTurns: step.maxTurns,
            },
            subOpts,
          );
        } catch (error) {
          // The port contract says run() never throws; stay defensive anyway.
          sub = {
            status: "error",
            finalText: error instanceof Error ? error.message : String(error),
            truncated: false,
            turns: 0,
            toolCalls: 0,
            durationMs: Date.now() - stepStartedAt,
          };
        } finally {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          stepControllers.delete(controller);
        }

        // A per-step timeout aborts the child, which returns "cancelled"; the
        // engine reports that as "error" (the step failed, §3.4), distinct from
        // a run-level cancellation.
        const status: WorkflowStepOutcome["status"] = timedOut ? "error" : sub.status;
        const outcome: WorkflowStepOutcome = {
          stepId: step.id,
          agentType: step.agentType,
          status,
          finalText: timedOut
            ? `Step "${step.id}" timed out after ${stepTimeoutMs}ms.`
            : sub.finalText,
          truncated: sub.truncated,
          turns: sub.turns,
          toolCalls: sub.toolCalls,
          durationMs: sub.durationMs,
        };
        onProgress?.({
          kind: "step_end",
          stepId: step.id,
          status: outcome.status,
          turns: outcome.turns,
          durationMs: outcome.durationMs,
          // TASK.191 slice S2: the step's FINAL spend, taken from the child's
          // own outcome rather than from the last progress event — a step whose
          // final turn made no tool call emits its last progress before that
          // turn's spend is even known.
          ...(sub.usage !== undefined ? { usage: sub.usage } : {}),
        });
        return { id: step.id, outcome };
      };

      const launchReady = (): void => {
        // Fail-fast / cancellation freeze new launches; in-flight steps finish.
        if (failed || aborted) {
          return;
        }
        for (const step of steps) {
          if (launched.has(step.id) || !depsSatisfied(step)) {
            continue;
          }
          launched.add(step.id);
          running.set(step.id, launchStep(step));
        }
      };

      launchReady();
      while (running.size > 0) {
        const { id, outcome } = await Promise.race(running.values());
        running.delete(id);
        outcomes.set(id, outcome);
        if (outcome.status === "completed") {
          completedOutputs.set(id, outcome.finalText);
        } else {
          // First non-completed step trips fail-fast (max_turns included).
          failed = true;
        }
        launchReady();
      }

      signal?.removeEventListener("abort", onRunAbort);

      // Never-launched steps (deps failed, or launches frozen) are skipped.
      // TASK.191 slice S3: each ALSO gets a synthetic step_end here, not just
      // a slot in the returned outcome array — until now a step that never
      // launched got no wire event at all (this map was the ONLY place its
      // "skipped" fact was recorded), so a client fed exclusively by
      // onProgress never learned a pending node was actually done and it sat
      // "not started" forever after a fail-fast/cancelled run. Emitted BEFORE
      // kind:"end" so the run's terminal event never lands ahead of a step it
      // explains.
      const orderedOutcomes = steps.map((step) => {
        const outcome = outcomes.get(step.id);
        if (outcome) {
          return outcome;
        }
        const skipped = skippedOutcome(step);
        onProgress?.({
          kind: "step_end",
          stepId: skipped.stepId,
          status: skipped.status,
          turns: skipped.turns,
          durationMs: skipped.durationMs,
        });
        return skipped;
      });

      const status: WorkflowRunOutcome["status"] = aborted
        ? "cancelled"
        : failed
          ? "failed"
          : "completed";

      const rendered = renderRunOutput(definition, input, completedOutputs, orderedOutcomes);
      const cappedOutput = capUtf8Bytes(rendered, WORKFLOW_OUTPUT_MAX_BYTES);

      const durationMs = Date.now() - startedAt;
      onProgress?.({
        kind: "end",
        status,
        completedSteps: completedOutputs.size,
        totalSteps: steps.length,
        durationMs,
      });

      return {
        status,
        output: cappedOutput.text,
        truncated: cappedOutput.truncated,
        steps: orderedOutcomes,
        durationMs,
      };
    },
  };
}

/**
 * Renders the run output: the outputTemplate (over ${input} + ALL completed
 * steps) when present, else the finalText of the sink steps (steps no other step
 * depends on) joined in definition order. An outputTemplate that references a
 * non-completed step throws (a failed/cancelled run); we fall back to the sink
 * join so the model still receives a best-effort summary.
 */
function renderRunOutput(
  definition: WorkflowDefinition,
  input: string,
  completedOutputs: ReadonlyMap<string, string>,
  orderedOutcomes: readonly WorkflowStepOutcome[],
): string {
  if (definition.outputTemplate !== undefined) {
    try {
      return renderTemplate(definition.outputTemplate, { input, steps: completedOutputs });
    } catch {
      // fall through to the sink join
    }
  }
  return sinkJoin(definition.steps, orderedOutcomes);
}

/** Joins the finalText of every sink step (no dependents) in definition order. */
function sinkJoin(
  steps: readonly WorkflowStepDefinition[],
  orderedOutcomes: readonly WorkflowStepOutcome[],
): string {
  const dependedOn = new Set<string>();
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      dependedOn.add(dep);
    }
  }
  const outcomeById = new Map(orderedOutcomes.map((outcome) => [outcome.stepId, outcome]));
  const parts: string[] = [];
  for (const step of steps) {
    if (dependedOn.has(step.id)) {
      continue;
    }
    const outcome = outcomeById.get(step.id);
    if (outcome && outcome.finalText.length > 0) {
      parts.push(outcome.finalText);
    }
  }
  return parts.join("\n\n");
}

/** A step that never launched (dependency failed / run aborted before launch). */
function skippedOutcome(step: WorkflowStepDefinition): WorkflowStepOutcome {
  return {
    stepId: step.id,
    agentType: step.agentType,
    status: "skipped",
    finalText: "",
    truncated: false,
    turns: 0,
    toolCalls: 0,
    durationMs: 0,
  };
}

/** A step that failed before or during launch (unknown agentType / render throw). */
function errorOutcome(
  step: WorkflowStepDefinition,
  message: string,
  durationMs = 0,
): WorkflowStepOutcome {
  return {
    stepId: step.id,
    agentType: step.agentType,
    status: "error",
    finalText: message,
    truncated: false,
    turns: 0,
    toolCalls: 0,
    durationMs,
  };
}

/**
 * Builds a WorkflowPort backed by DAG runs over `subagents` (design §2.10, frozen
 * signature). The engine drives every step through this SubagentPort, so a run
 * never adds a spawn path and shares the runner's single semaphore.
 */
export function createWorkflowRunner(
  subagents: SubagentPort,
  definitions: readonly WorkflowDefinition[],
): WorkflowPort {
  return createRunner(subagents, definitions);
}

/**
 * @internal Test-only seam: same as createWorkflowRunner with a per-step timeout
 * override so the timeout path is provable in milliseconds. NOT part of the
 * frozen public contract.
 */
export function createWorkflowRunnerForTest(
  subagents: SubagentPort,
  definitions: readonly WorkflowDefinition[],
  opts: WorkflowRunnerOptions,
): WorkflowPort {
  return createRunner(subagents, definitions, opts);
}

/**
 * Wiring helper: attaches a WorkflowPort to `config` AFTER withSubagents (design
 * §2.10). Reads `config.subagents`; if absent, attaches NOTHING (the Workflow
 * tool stays fail-closed "unavailable"). Mutates and returns the same config.
 * A child loop is created WITHOUT this helper, so it receives no port
 * (non-recursion lock).
 */
export function withWorkflows(
  config: AgentLoopConfig,
  definitions: readonly WorkflowDefinition[],
): AgentLoopConfig {
  if (config.subagents) {
    config.workflows = createWorkflowRunner(config.subagents, definitions);
  }
  return config;
}
