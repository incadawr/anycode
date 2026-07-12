/**
 * ToolScheduler (design §2.7): groups one step's proposed calls into batches
 * (proposal order preserved, batches sequential, parallel inside a batch up to
 * maxConcurrency) and executes them through the dispatcher.
 *
 * Parallel-safe rule: destructive -> NEVER (solo batch); concurrentSafe ->
 * parallel; not concurrentSafe -> solo; unknown tool -> solo (fail-safe).
 * Adjacent parallel-safe calls merge into one batch. No dependsOn/toposort —
 * proposal order is the batch order.
 */

import type { ProposedToolCall } from "../types/events.js";
import type { ToolCallOutcome, ToolEmittedEvent } from "../types/tools.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { DispatchContext } from "./dispatcher.js";
import { executeToolCall } from "./dispatcher.js";

export interface ToolSchedulerConfig {
  /** DEFAULT_TOOL_CONCURRENCY = 4. */
  maxConcurrency: number;
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
  const cap = Math.max(1, Math.floor(config.maxConcurrency));
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
 * FIFO channel bridging the concurrent per-call tasks of a batch to the single
 * consuming generator: producers push events, the consumer drains them in
 * arrival order and stops once close() has been called and the buffer is empty.
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
 * Executes the planned batches. Yields tool_execution_start/tool_result in
 * completion order (live UI) while the returned outcomes are STRICTLY in
 * proposal order (deterministic history). Guarantees exactly one outcome per
 * call — including cancellation (post-abort calls flow through the dispatcher,
 * which returns an instant cancelled outcome). Never throws.
 */
export async function* runToolBatches(
  ctx: DispatchContext,
  calls: readonly ProposedToolCall[],
  config: ToolSchedulerConfig,
  parentSignal?: AbortSignal,
): AsyncGenerator<ToolBatchEvent, ToolCallOutcome[], unknown> {
  const batches = planToolBatches(calls, ctx.registry, config);
  const outcomes: ToolCallOutcome[] = [];

  for (const batch of batches) {
    // Slot per call, filled at its proposal position so the batch contributes
    // outcomes in proposal order regardless of completion order.
    const batchOutcomes: ToolCallOutcome[] = new Array(batch.length);
    const channel = new EventChannel<ToolBatchEvent>();
    let remaining = batch.length;

    batch.forEach((call, index) => {
      // Start events are pushed synchronously as tasks launch (proposal order);
      // result events land in completion order as each dispatch settles.
      channel.push({
        type: "tool_execution_start",
        toolCallId: call.id,
        toolName: call.name,
        input: call.input,
      });
      // The handler's ctx.emit pushes coarse progress into the SAME FIFO channel
      // (design §3.2): each emitted event surfaces between this call's start and
      // its result, in emission order. No timers — determinism holds for tests.
      const emit = (event: ToolEmittedEvent): void => {
        channel.push(event);
      };
      void (async () => {
        const outcome = await runOne(ctx, call, parentSignal, emit);
        batchOutcomes[index] = outcome;
        channel.push({ type: "tool_result", outcome });
        remaining -= 1;
        if (remaining === 0) {
          channel.close();
        }
      })();
    });

    for await (const event of channel.drain()) {
      yield event;
    }

    for (const outcome of batchOutcomes) {
      outcomes.push(outcome);
    }
  }

  return outcomes;
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
