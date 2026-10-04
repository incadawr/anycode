/**
 * TASK.117 supervisor correction (2026-10-04) — the two acceptance defects a
 * reconnect after replay-ring overflow (>REPLAY_BUFFER_CAP) still had:
 *
 *  1. A RUNNING tool card regressed to "proposed": the assistant item with
 *     the tool_call IS durable (core appends it before dispatch), so a fresh
 *     store hydrates the card from `session_history` as `proposed`; the only
 *     thing that ever flips a hydrated card to `running` is the ring-replayed
 *     `tool_execution_start` — and after a >CAP overflow that event is
 *     EVICTED, so the card stays `proposed` forever (until the live result
 *     settles). Neither the host checkpoint nor the store carried "this tool
 *     is executing right now" state.
 *  2. A MANUAL compaction's post-swap `context_usage` (sentinel turn
 *     `manual-compaction`, plain ring `emit` in onCompact) never reached
 *     `checkpointContextUsage`, so a reconnect after overflow restored a
 *     STALE pre-compaction reading while the ring copy was gone.
 *
 * Both regressions drive the REAL host Session (test-harness.ts) and a REAL
 * renderer store, and reconnect exactly as production does: a second
 * `ui_ready` on the same live host, cascade applied to a FRESH store.
 */

import { describe, expect, it } from "vitest";
import type { HostToUiMessage } from "../shared/protocol.js";
import { createDesktopStore } from "../renderer/src/store.js";
import type { ModelStreamEvent } from "@anycode/core";
import { createHarness, MemFs, type Harness } from "./test-harness.js";

/** Bounded drain: lets worker-thread transport + macrotasks settle. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function countLoopEnds(h: Harness): number {
  return h.received.filter((m) => m.type === "agent_event" && m.event.type === "loop_end").length;
}

/**
 * A REAL-shaped text step: real adapters emit text_start -> text_delta ->
 * text_end before finish (this file asserts RENDERED state, so the stream
 * must be real).
 */
function renderedTextStep(text: string): ModelStreamEvent[] {
  return [
    { type: "start" },
    { type: "text_start", id: "t1" },
    { type: "text_delta", id: "t1", text },
    { type: "text_end", id: "t1" },
    { type: "finish", finishReason: "stop", usage: {} },
  ];
}

describe("TASK.117 supervisor correction — reconnect defects after ring overflow", () => {
  it(
    "defect 1: a RUNNING tool (start emitted, result pending) stays RUNNING on a fresh store after >CAP evicted its tool_execution_start",
    { timeout: 60_000 },
    async () => {
      // Step 1 (turn 1): a completed text turn so the session has durable
      // history and a counted finish. Step 2 (turn 2): proposes a Read that
      // parks inside the tool handler (fsHook gate) — the assistant item is
      // durable, `tool_execution_start` IS emitted, the result never arrives
      // until the test releases the gate.
      const steps: ModelStreamEvent[][] = [
        renderedTextStep("warm"),
        [{ type: "start" }, { type: "tool_call", toolCall: { id: "run1", name: "Read", input: { file_path: "/workspace/park.txt" } } }, { type: "finish", finishReason: "tool_calls", usage: {} }],
        renderedTextStep("after release"),
      ];
      let releaseRead: (() => void) | undefined;
      const readGate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let parked = false;
      const memFs = new MemFs();
      memFs.files.set("/workspace/park.txt", "parked content");
      const h = createHarness({
        steps,
        toolFs: memFs,
        fsHook: async (readFile, path) => {
          if (path === "/workspace/park.txt" && !parked) {
            parked = true;
            await readGate;
          }
          return readFile(path);
        },
      });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor((m) => m.type === "host_ready", 5_000);

        // Turn 1 completes; the session is idle with durable history.
        h.send({ type: "user_message", requestId: "r1", text: "warm up" });
        await h.waitUntil(() => countLoopEnds(h) >= 1, 5_000);
        await settle();

        // Turn 2 dispatches the Read and parks INSIDE the handler: the
        // assistant tool_call item is durable, tool_execution_start emitted,
        // result pending. The card is RUNNING on the wire.
        h.send({ type: "user_message", requestId: "r2", text: "read park" });
        await h.waitFor(
          (m): m is Extract<HostToUiMessage, { type: "agent_event" }> =>
            m.type === "agent_event" && m.event.type === "tool_execution_start" && (m.event as { toolCallId?: string }).toolCallId === "run1",
          5_000,
        );
        await settle();

        // ── Overflow the ring: >CAP events evict the turn's turn_started AND
        // the running tool's tool_execution_start. ──
        const { REPLAY_BUFFER_CAP } = await import("./session.js");
        for (let i = 0; i < REPLAY_BUFFER_CAP + 1_000; i += 1) {
          h.outbound.emit({ type: "title_changed", title: `flood-${i}` });
        }
        await settle(12);

        // ── RECONNECT: fresh store, second ui_ready cascade only ──
        const before = h.received.length;
        h.send({ type: "ui_ready" });
        await h.waitUntil(
          () => h.received.slice(before).some((m) => m.type === "session_history") && h.received.slice(before).some((m) => m.type === "session_checkpoint"),
          10_000,
        );
        await settle(12);
        const cascadeEnd = h.received.length;
        const fresh = createDesktopStore({ schedule: (fn) => fn() });
        for (let i = before; i < cascadeEnd; i += 1) {
          fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
        }

        // THE DEFECT ASSERTION: the card for `run1` hydrated from the durable
        // assistant item; with its tool_execution_start ring-evicted the ONLY
        // surviving source of "this call is executing" is the checkpoint —
        // pre-fix the card reads "proposed" (start evicted, no result yet).
        const card = fresh.getState().transcript.find(
          (b) => b.kind === "tool_call" && b.toolCallId === "run1",
        );
        expect(card).toBeDefined();
        expect(card?.kind === "tool_call" ? card.status : undefined).toBe("running");

        // The turn is running and the tool is genuinely still executing:
        // releasing the gate must settle the card through the LIVE result.
        expect(fresh.getState().turn.status).toBe("running");
        releaseRead!();
        await h.waitUntil(() => countLoopEnds(h) >= 2, 20_000);
        await settle();
        for (let i = cascadeEnd; i < h.received.length; i += 1) {
          fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
        }
        const settled = fresh.getState().transcript.find(
          (b) => b.kind === "tool_call" && b.toolCallId === "run1",
        );
        expect(settled).toMatchObject({ status: "success" });
        expect(fresh.getState().turn.status).toBe("idle");
      } finally {
        releaseRead?.();
        h.close();
      }
    },
  );

  it(
    "defect 2: a MANUAL compaction's post-swap context_usage reaches checkpointContextUsage — a real prior turn's non-null reading is superseded by the different POST-swap reading after a >CAP reconnect",
    { timeout: 120_000 },
    async () => {
      // Supervisor requirement (2026-10-04): the stale defect is about a
      // NON-NULL pre-compaction checkpoint reading, so the pre-reading must
      // come from a REAL prior turn's live context_usage (agent-loop.ts folds
      // one after every finish), captured into checkpointContextUsage by
      // runTurn at emission time — NOT from a seeded history slot. Turn 1
      // appends a genuinely heavy user message so the live pre-reading is
      // real AND strictly greater than the post-swap reading; the manual
      // compaction then swaps 12 items -> 1 summary + tail and must emit a
      // strictly lower post-swap context_usage.
      const heavy = "context pressure token padding ".repeat(400); // ~3.6k tokens
      const steps: ModelStreamEvent[][] = [
        renderedTextStep("real turn one"),
        renderedTextStep("Summary of the earlier conversation."),
      ];
      const h = createHarness({ steps });
      try {
        h.send({ type: "ui_ready" });
        await h.waitFor((m) => m.type === "host_ready", 5_000);

        // ── REAL PRIOR TURN: its finish emits context_usage, runTurn folds
        // it into checkpointContextUsage at emission time (session.ts's
        // core-engine context_usage capture). This is the stale value the
        // defect is about — established while the turn genuinely runs, never
        // seeded. ──
        h.send({ type: "user_message", requestId: "r1", text: `heavy turn ${heavy}` });
        await h.waitUntil(() => countLoopEnds(h) >= 1, 10_000);
        await settle();
        const preMsg = h.received.find(
          (m): m is Extract<HostToUiMessage, { type: "agent_event" }> =>
            m.type === "agent_event" && m.event.type === "context_usage",
        );
        if (preMsg === undefined) {
          throw new Error("prior turn produced no live context_usage on the wire");
        }
        const pre = preMsg.event as { estimatedTokens: number; budgetTokens: number; source: "provider" | "estimate" };

        // Grow the compactable prefix to >0 items: 12 short alternates, the
        // two first ones carrying tokenEstimate 5000 (same shape
        // session.test.ts uses) so the post-swap estimate is strictly lower.
        // boundary > 0 requires more items than the keep-recent window; this
        // mirrors the supervisor's accepted manual-compaction fixtures.
        const items = [];
        for (let i = 0; i < 12; i += 1) {
          items.push({
            id: `seed-${i}`,
            createdAt: i,
            message:
              i % 2 === 0
                ? { role: "user" as const, content: `user turn ${i}` }
                : { role: "assistant" as const, content: [{ type: "text" as const, text: `assistant turn ${i}` }] },
            tokenEstimate: i < 2 ? 5_000 : 10,
            kind: "normal" as const,
          });
        }
        h.engine.replaceHistory!(items);

        // Run the manual compaction to completion; capture the post-swap
        // context_usage the renderer's meter should read after reconnect.
        h.send({ type: "compact_request" });
        await h.waitUntil(
          () =>
            h.received.some(
              (m): m is Extract<HostToUiMessage, { type: "agent_event" }> =>
                m.type === "agent_event" && m.event.type === "compaction_end" && (m.event as { ok?: boolean }).ok === true,
            ),
          10_000,
        );
        await settle(10);
        const postMsg = [...h.received].reverse().find(
          (m): m is Extract<HostToUiMessage, { type: "agent_event" }> => m.type === "agent_event" && m.event.type === "context_usage",
        );
        if (postMsg === undefined) {
          throw new Error("manual compaction produced no context_usage on the wire");
        }
        const postSwap = postMsg.event as { type: "context_usage"; estimatedTokens: number; budgetTokens: number; source: string };

        // The defect's exact shape: a REAL pre-reading exists and is stale.
        expect(pre.estimatedTokens).toBeGreaterThan(0);
        expect(pre.budgetTokens).toBeGreaterThan(0);
        expect(postSwap.estimatedTokens).toBeLessThan(pre.estimatedTokens);
        expect(postSwap.budgetTokens).toBe(pre.budgetTokens);

        // ── Overflow the ring: evicts the compaction's context_usage (the
        // ONLY post-swap reading; every earlier turn's reading is stale). ──
        const { REPLAY_BUFFER_CAP } = await import("./session.js");
        for (let i = 0; i < REPLAY_BUFFER_CAP + 1_000; i += 1) {
          h.outbound.emit({ type: "title_changed", title: `flood-${i}` });
        }
        await settle(12);

        // ── RECONNECT: fresh store, cascade only ──
        const before = h.received.length;
        h.send({ type: "ui_ready" });
        await h.waitUntil(
          () => h.received.slice(before).some((m) => m.type === "session_history") && h.received.slice(before).some((m) => m.type === "session_checkpoint"),
          10_000,
        );
        await settle(12);
        const cascadeEnd = h.received.length;
        const fresh = createDesktopStore({ schedule: (fn) => fn() });
        for (let i = before; i < cascadeEnd; i += 1) {
          fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
        }

        // THE DEFECT ASSERTION: the fresh store's ctx meter reads the exact
        // POST-swap reading (carried by session_checkpoint.contextUsage) —
        // every public field. Pre-fix, the checkpoint still carried the REAL
        // prior turn's pre-compaction reading (the defect's exact stale
        // NON-NULL state), so estimatedTokens matched `pre`, not `postSwap`.
        expect(fresh.getState().contextUsage).not.toBeNull();
        expect(fresh.getState().contextUsage).toEqual({
          estimatedTokens: postSwap.estimatedTokens,
          budgetTokens: pre.budgetTokens, // budget denominator never moves
          source: postSwap.source,
        });
        expect(fresh.getState().contextUsage?.estimatedTokens).not.toBe(pre.estimatedTokens);
      } finally {
        h.close();
      }
    },
  );
});
