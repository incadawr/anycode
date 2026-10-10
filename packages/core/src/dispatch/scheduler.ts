/**
 * ToolScheduler (design §2.7). Groups one step's proposed calls into batches
 * (proposal order preserved, batches sequential, parallel inside a batch up to
 * maxConcurrency) and executes them through the dispatcher.
 *
 * TASK.229 execution model: planning still produces cap-bounded SAFE batches and
 * solo barriers, but execution merges adjacent safe batches (including a safe
 * cap-remainder) into ONE run served by a rolling FIFO slot pool — as soon as
 * any safe handler finishes, the next waiting call starts. Solo barriers
 * (destructive/unknown/non-concurrentSafe/terminalControl) remain absolute: a
 * barrier run drains completely before the next run begins.
 *
 * Parallel-safe rule: destructive -> NEVER (solo barrier); concurrentSafe ->
 * parallel; not concurrentSafe -> solo barrier; unknown tool -> solo barrier
 * (fail-safe); terminalControl -> solo barrier. No dependsOn/toposort —
 * proposal order is the batch order. Every proposal receives exactly one outcome.
 */

import type { ProposedToolCall } from "../types/events.js";
import type { ToolCallOutcome, ToolEmittedEvent } from "../types/tools.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { DispatchContext } from "./dispatcher.js";
import { executeToolCall } from "./dispatcher.js";
import { DEFAULT_TOOL_CONCURRENCY } from "../types/config.js";

export interface ToolSchedulerConfig {
  /** DEFAULT_TOOL_CONCURRENCY = 4. */
  maxConcurrency: number;
}

/**
 * Normalizes a concurrency width identically for planning and execution: a
 * finite value is floored and clamped to >= 1; a non-finite (NaN/Infinity) or
 * unsafe value falls back to DEFAULT_TOOL_CONCURRENCY. NaN/Infinity are never
 * admitted into capacity logic.
 */
function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TOOL_CONCURRENCY;
  }
  const floored = Math.floor(value);
  if (!Number.isSafeInteger(floored)) {
    return DEFAULT_TOOL_CONCURRENCY;
  }
  return Math.max(1, floored);
}

/**
 * Events interleaved by runToolBatches while outcomes accumulate. Besides the
 * two lifecycle events, a running handler may push ToolEmittedEvent items
 * through ctx.emit (design §3.2) — the "long-tool progress" seam — which flow
 * through the same completion-order channel. Every member is also an AgentEvent
 * variant, so the loop re-yields these values unchanged.
 */
export type ToolBatchEvent =
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_result"; outcome: ToolCallOutcome }
  | ToolEmittedEvent;

/**
 * A call is parallel-safe (mergeable into a shared batch) only when its tool is
 * known, non-destructive, and explicitly concurrentSafe. Everything else —
 * destructive tools, non-concurrentSafe tools, and unknown tools — runs solo
 * (fail-safe): the RCE surface never widens through parallelism.
 */
function isParallelSafe(call: ProposedToolCall, registry: ToolRegistry): boolean {
  const tool = registry.get(call.name);
  if (!tool) {
    return false;
  }
  if (tool.metadata.destructive) {
    return false;
  }
  if (tool.metadata.terminalControl) {
    return false;
  }
  return tool.metadata.concurrentSafe === true;
}

/**
 * Plans batches without executing anything. Order of proposals is preserved;
 * grouping follows the parallel-safe rule above. Adjacent parallel-safe calls
 * merge into one batch, capped at maxConcurrency entries — a longer run splits
 * into consecutive full-then-remainder batches so a batch is never wider than
 * the concurrency cap.
 */
export function planToolBatches(
  calls: readonly ProposedToolCall[],
  registry: ToolRegistry,
  config: ToolSchedulerConfig,
): ProposedToolCall[][] {
  const cap = normalizeConcurrency(config.maxConcurrency);
  const batches: ProposedToolCall[][] = [];
  let current: ProposedToolCall[] | null = null;

  for (const call of calls) {
    if (!isParallelSafe(call, registry)) {
      current = null;
      batches.push([call]);
      continue;
    }
    if (current === null || current.length >= cap) {
      current = [];
      batches.push(current);
    }
    current.push(call);
  }

  return batches;
}

/**
 * FIFO channel bridging the concurrent per-call tasks of a RUN (a rolling safe
 * group, or one solo barrier) to the single consuming generator: producers push
 * events, the consumer drains them in arrival order and stops once close() has
 * been called and the buffer is empty. Every proposal pushes exactly one result
 * through here — admittance never changes that, only whether a start precedes it.
 */
class EventChannel<T> {
  private readonly buffer: T[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    this.buffer.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve();
    }
  }

  async *drain(): AsyncGenerator<T, void, unknown> {
    for (;;) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift() as T;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

/**
 * Bounded FIFO slot pool (TASK.229) that makes a run of parallel-safe calls
 * ROLLING: as soon as any admitted call releases, the next waiting call is
 * admitted — it does not wait for the whole group to finish.
 *
 * `acquire(signal)` resolves `true` when a slot is handed over and `false` when
 * the waiter was cancelled. Admission is FIFO. A pre-aborted signal yields
 * `false` without ever consuming a free slot. A queued abort removes the waiter
 * and resolves `false`. On handoff the abort listener is removed BEFORE the
 * waiter is resolved `true`, so no stale listener survives. Settlement/removal
 * is idempotent. An immediately-available slot still resolves on a microtask
 * (never synchronously), so callers always yield before their continuation and
 * FIFO admission order determines start order.
 */
class SlotPool {
  private free: number;
  private readonly waiters: Array<{
    resolve: (admitted: boolean) => void;
    cleanup: () => void;
  }> = [];

  constructor(width: number) {
    this.free = width;
  }

  acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) {
      return Promise.resolve(false);
    }
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter = { resolve, cleanup: () => {} };
      if (signal) {
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) {
            // Already settled by a handoff: idempotent, no double resolve.
            return;
          }
          this.waiters.splice(index, 1);
          waiter.cleanup();
          resolve(false);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Remove the abort listener BEFORE handing the slot over: once resolved
      // true the waiter owns the slot, so a later abort must not also resolve
      // it (idempotent settlement).
      next.cleanup();
      next.resolve(true);
    } else {
      this.free += 1;
    }
  }
}

/**
 * Executes the planned runs. Yields tool_execution_start/tool_result in
 * completion order (live UI) while the returned outcomes are STRICTLY in
 * proposal order (deterministic history). Guarantees exactly one outcome per
 * call — including cancellation. A cancelled waiter (aborted before admission)
 * gets a typed cancelled outcome with no start event and no handler; an
 * admitted call re-checks the parent signal before dispatch and releases its
 * slot in `finally`. Never throws.
 */
export async function* runToolBatches(
  ctx: DispatchContext,
  calls: readonly ProposedToolCall[],
  config: ToolSchedulerConfig,
  parentSignal?: AbortSignal,
): AsyncGenerator<ToolBatchEvent, ToolCallOutcome[], unknown> {
  const batches = planToolBatches(calls, ctx.registry, config);
  const width = normalizeConcurrency(config.maxConcurrency);
  const runs = mergeIntoRuns(batches, ctx.registry);
  const outcomes: ToolCallOutcome[] = [];

  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run = runs[runIndex]!;
    // Slot per call, filled at its proposal position so the run contributes
    // outcomes in proposal order regardless of completion order.
    const runOutcomes: ToolCallOutcome[] = new Array(run.length);
    const channel = new EventChannel<ToolBatchEvent>();
    // Fresh rolling pool per run: safe calls roll through it; a barrier run is a
    // singleton and never needs more than one slot.
    const pool = new SlotPool(width);
    let remaining = run.length;

    run.forEach((call, index) => {
      // The handler's ctx.emit pushes coarse progress into the SAME FIFO channel
      // (design §3.2): each emitted event surfaces between this call's start and
      // its result, in emission order. No timers — determinism holds for tests.
      const emit = (event: ToolEmittedEvent): void => {
        channel.push(event);
      };
      void (async () => {
        try {
          const admitted = await pool.acquire(parentSignal);
          if (!admitted) {
            // Cancelled while queued: no start event and no handler ever runs.
            const cancelled: ToolCallOutcome = {
              toolCallId: call.id,
              toolName: call.name,
              status: "cancelled",
              modelText: `Tool ${call.name} was cancelled before it started.`,
              durationMs: 0,
            };
            runOutcomes[index] = cancelled;
            channel.push({ type: "tool_result", outcome: cancelled });
            return;
          }
          try {
            if (parentSignal?.aborted) {
              // Admitted at the same moment the parent aborted (handoff race):
              // cancel before dispatch, then release the slot in the `finally`.
              const cancelled: ToolCallOutcome = {
                toolCallId: call.id,
                toolName: call.name,
                status: "cancelled",
                modelText: `Tool ${call.name} was cancelled before it started.`,
                durationMs: 0,
              };
              runOutcomes[index] = cancelled;
              channel.push({ type: "tool_result", outcome: cancelled });
              return;
            }
            // Start events are pushed in proposal order (admission is FIFO);
            // result events land in completion order as each dispatch settles.
            channel.push({
              type: "tool_execution_start",
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            });
            const outcome = await runOne(ctx, call, parentSignal, emit);
            runOutcomes[index] = outcome;
            channel.push({ type: "tool_result", outcome });
          } finally {
            pool.release();
          }
        } finally {
          remaining -= 1;
          if (remaining === 0) {
            channel.close();
          }
        }
      })();
    });

    for await (const event of channel.drain()) {
      yield event;
    }

    for (const outcome of runOutcomes) {
      outcomes.push(outcome);
    }

    const terminal = runOutcomes.find(
      (candidate) =>
        candidate.status === "success" &&
        candidate.result?.ok === true &&
        candidate.result.control?.type === "workspace_transition",
    );
    if (terminal !== undefined) {
      // Terminal-control tools are planned solo, so nothing else in their run
      // can race the transition. Every later proposal is paired with a typed
      // cancelled result without entering the dispatcher or handler.
      const remainingCalls = runs.slice(runIndex + 1).flat();
      for (const call of remainingCalls) {
        const cancelled: ToolCallOutcome = {
          toolCallId: call.id,
          toolName: call.name,
          status: "cancelled",
          modelText: `Tool ${call.name} was cancelled because ${terminal.toolName} started a workspace transition.`,
          durationMs: 0,
        };
        outcomes.push(cancelled);
        yield { type: "tool_result", outcome: cancelled };
      }
      return outcomes;
    }
  }

  return outcomes;
}

/**
 * Merges adjacent parallel-safe batches (a safe cap-remainder included) into one
 * execution run. A non-parallel-safe batch is a barrier: it flushes any open run
 * and occupies a run of its own, so it drains completely before the next run
 * starts. Proposal order is preserved throughout.
 */
function mergeIntoRuns(
  batches: readonly ProposedToolCall[][],
  registry: ToolRegistry,
): ProposedToolCall[][] {
  const runs: ProposedToolCall[][] = [];
  let current: ProposedToolCall[] | null = null;
  let currentSafe = false;
  for (const batch of batches) {
    const safe = batch.every((call) => isParallelSafe(call, registry));
    if (safe && currentSafe && current !== null) {
      current.push(...batch);
      continue;
    }
    current = [...batch];
    currentSafe = safe;
    runs.push(current);
  }
  return runs;
}

/**
 * Dispatches one call, guaranteeing an outcome even if the dispatcher itself
 * were ever to reject (it is contracted never to): the scheduler must place
 * exactly one outcome per call so the loop's history stays balanced.
 */
async function runOne(
  ctx: DispatchContext,
  call: ProposedToolCall,
  parentSignal?: AbortSignal,
  emit?: (event: ToolEmittedEvent) => void,
): Promise<ToolCallOutcome> {
  try {
    return await executeToolCall(ctx, call, parentSignal, emit);
  } catch (error) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      status: "error",
      modelText: `Tool ${call.name} dispatch failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      durationMs: 0,
    };
  }
}
