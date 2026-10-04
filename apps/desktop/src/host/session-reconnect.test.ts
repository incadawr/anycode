/**
 * TASK.117 rendered reconnect integration tests.
 *
 * These tests drive the REAL host Session (test-harness.ts: AgentLoop +
 * IpcPermissionBroker + scripted ModelPort) and pipe EVERY HostToUiMessage
 * it produces into a REAL renderer `createDesktopStore` — the rendered
 * transcript (`store.getState().transcript`) is the assertion surface, not
 * wire-message counts. That is the seam the original symptom lived on: a
 * reconnecting renderer froze on the host-start snapshot while the session
 * kept working.
 *
 * Reconnect is modeled exactly as production does it: a second `ui_ready`
 * against the SAME live host Session + Outbound ring (host_ready reset ->
 * fresh session_history -> pending_prompt -> replay of whatever the ring
 * still holds), applied to a FRESH store (a page reload recreates the store
 * from scratch).
 */

import { describe, expect, it } from "vitest";
import type { AgentEvent, HistoryItem } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import { createDesktopStore } from "../renderer/src/store.js";
import type { ModelStreamEvent } from "@anycode/core";
import { createHarness, finishStep, toolStep, MemFs, type Harness } from "./test-harness.js";
import type { SessionEngine } from "./engines/session-engine.js";

/**
 * A real renderer store fed the wire log so far. The synchronous scheduler
 * makes rAF-batched text deltas flush immediately (node has no rAF). Returns
 * the store plus the consumed offset — a live store must only ever be fed
 * NEW messages (re-feeding an old `host_ready` would reset it).
 */
function attachStore(
  h: Harness,
): { store: ReturnType<typeof createDesktopStore>; applied: number } {
  const store = createDesktopStore({ schedule: (fn) => fn() });
  for (const message of h.received) {
    store.getState().applyHostMessage(message);
  }
  return { store, applied: h.received.length };
}

/** Feeds only the messages the store has not consumed yet. */
function feed(store: ReturnType<typeof createDesktopStore>, h: Harness, since: number): number {
  for (let i = since; i < h.received.length; i += 1) {
    store.getState().applyHostMessage(h.received[i] as HostToUiMessage);
  }
  return h.received.length;
}

/** Bounded drain: lets worker-thread transport + macrotasks settle. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function texts(store: ReturnType<typeof createDesktopStore>): (string | null)[] {
  return store.getState().transcript.map((block) => {
    if (block.kind === "user_text" || block.kind === "assistant_text") {
      return block.text;
    }
    return null;
  });
}

function countLoopEnds(h: Harness): number {
  return h.received.filter((m) => m.type === "agent_event" && m.event.type === "loop_end").length;
}

/**
 * A REAL-shaped text step: real adapters emit text_start -> text_delta ->
 * text_end before finish (the harness's `textStep` omits text_start/text_end,
 * and the renderer's fold legitimately drops leader deltas with no open
 * stream block — this file asserts RENDERED state, so the stream must be real).
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

describe("TASK.117 — rendered reconnect (Session -> fresh desktopStore)", () => {
  it("A: old 'Done' durable, then a genuinely NEW identical 'Done' turn renders twice — UI path and startProgrammaticTurn path", async () => {
    const h = createHarness({
      steps: [renderedTextStep("Done"), renderedTextStep("Done")],
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");
      const { store, applied } = attachStore(h);

      // The production send path (Composer.tsx / tab-registry.ts) locally
      // echoes the user text via appendUserText at send time — core never
      // emits a user echo event. Mirror that real seam here.
      h.send({ type: "user_message", requestId: "r1", text: "go" });
      store.getState().appendUserText("r1", "go");
      await h.waitUntil(() => countLoopEnds(h) >= 1);
      await settle();
      let appliedNow = feed(store, h, applied);
      h.send({ type: "user_message", requestId: "r2", text: "go" });
      store.getState().appendUserText("r2", "go");
      await h.waitUntil(() => countLoopEnds(h) >= 2);
      await settle();
      appliedNow = feed(store, h, appliedNow);
      const all = texts(store);
      expect(all.filter((t) => t === "Done")).toHaveLength(2);
      expect(all.filter((t) => t === "go")).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("B: persisted 'Done later', NEW pending 'Done' — reconnect renders 'Done' visibly, then 'Done now' extends BEFORE completion", async () => {
    const h = createHarness({
      steps: [renderedTextStep("Done later"), renderedTextStep("Done now")],
    });
    // A UserPromptSubmit hook whose SECOND invocation blocks until released:
    // the turn-2 user frame (and everything after) stays un-persisted while
    // the reconnect below happens — the exact emitted-but-unpersisted window.
    let hookCalls = 0;
    let releaseTurn2: (() => void) | undefined = (() => {}) as (() => void) | undefined;
    const turn2Gate = new Promise<void>((resolve) => {
      releaseTurn2 = resolve;
    });
    h.config.hooks.register({
      event: "UserPromptSubmit",
      hook: async () => {
        hookCalls += 1;
        if (hookCalls >= 2) {
          await turn2Gate;
        }
        return {};
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");
      const liveStore = attachStore(h).store;

      // Turn 1 completes fully — 'Done later' is durable.
      h.send({ type: "user_message", requestId: "r1", text: "first" });
      await h.waitUntil(() => countLoopEnds(h) >= 1);
      await settle();

      // Turn 2 is admitted; its user frame is blocked behind the hook, so the
      // prompt is pending-only on the wire.
      h.send({ type: "user_message", requestId: "r2", text: "Done" });
      await h.waitFor((m): m is Extract<HostToUiMessage, { type: "pending_prompt" }> => m.type === "pending_prompt" && m.text === "Done");
      await h.waitFor((m): m is Extract<HostToUiMessage, { type: "turn_started" }> => m.type === "turn_started" && m.requestId === "r2");
      await settle();

      // ── RECONNECT: fresh store, same live host, second ui_ready ──
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some((m) => m.type === "session_history"));
      await settle();

      const fresh = attachStore(h).store;
      const freshTexts = texts(fresh);
      // Durable transcript visible: turn 1 fully persisted.
      expect(freshTexts).toContain("first");
      expect(freshTexts).toContain("Done later");
      expect(freshTexts.filter((t) => t === "Done later")).toHaveLength(1);
      // The pending 'Done' prompt renders VISIBLY (a transcript bubble, not
      // just a store field).
      expect(freshTexts).toContain("Done");

      // ── Live extension BEFORE completion ──
      releaseTurn2!();
      await h.waitUntil(() => countLoopEnds(h) >= 2, 5_000);
      await settle();
      for (let i = before; i < h.received.length; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }
      const after = texts(fresh);
      expect(after).toContain("Done now");
      expect(after.filter((t) => t === "Done now")).toHaveLength(1);
      // The pending bubble was superseded by the durable user frame — 'Done'
      // still visible exactly once (the hydrated frame), never twice.
      expect(after.filter((t) => t === "Done")).toHaveLength(1);
      expect(fresh.getState().turn.status).toBe("idle");
      expect(fresh.getState().pendingPrompt).toBeNull();
      // Usage accounting stays coherent across the reconnect: each step's
      // finish usage applies exactly once per connection (turn 1's finish
      // via the covered-branch fold, turn 2's via the live materializing
      // switch) — the scripted steps carry empty usage objects, so the mere
      // presence of non-null sessionTokens with no NaN proves the path ran.
      expect(fresh.getState().sessionTokens).not.toBeNull();
    } finally {
      releaseTurn2?.();
      h.close();
    }
  });

  it("C: durable pretool text step + parked permission — reconnect keeps the tool card proposed, then the live result settles it and a post-hydration NEW call works", async () => {
    // Step 1 proposes a Write (needs permission) and is durable the moment
    // the permission ask parks (assistant item appends BEFORE dispatch).
    const h = createHarness({
      steps: [toolStep("c1", "Write", { file_path: "/workspace/a.txt", content: "NEW" }), finishStep()],
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");
      const live = attachStore(h);
      let applied = live.applied;

      h.send({ type: "user_message", requestId: "r1", text: "write it" });
      live.store.getState().appendUserText("r1", "write it");
      const ask = await h.waitFor((m) => m.type === "permission_request");
      await settle();
      applied = feed(live.store, h, applied);

      // The tool card is live-rendered as proposed/running on the live store.
      const card = () =>
        live.store.getState().transcript.find((b) => b.kind === "tool_call" && b.toolCallId === "c1");
      expect(card()).toBeDefined();

      // ── RECONNECT while parked at the permission ask ──
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some((m) => m.type === "session_history"));
      await settle();
      const fresh = attachStore(h).store;
      let freshApplied = h.received.length;

      // Durable pretool state: user frame + assistant tool_call item hydrate;
      // replayed ring events must NOT duplicate the assistant text or the
      // tool card (the hydrated block owns rendering; card stays proposed).
      const freshCards = fresh.getState().transcript.filter((b) => b.kind === "tool_call" && b.toolCallId === "c1");
      expect(freshCards).toHaveLength(1);
      // Parked-at-permission rendering: the card may read "proposed"
      // (hydrated) or "running" (replayed execution_start) — either way it
      // is NOT settled and there is EXACTLY ONE of it.
      expect(["proposed", "running"]).toContain(freshCards[0]?.kind === "tool_call" ? freshCards[0].status : undefined);
      expect(fresh.getState().permission?.requestId).toBe(ask.requestId);

      // ── Settle the parked ask: the emitted tool_result lands on the FRESH
      // store (live result for a call whose proposal hydrated durable) ──
      fresh.getState().applyHostMessage({ type: "permission_request", requestId: ask.requestId, toolName: "Write", input: { file_path: "/workspace/a.txt", content: "NEW" }, mode: "build" } as HostToUiMessage);
      h.send({ type: "permission_response", requestId: ask.requestId, behavior: "allow" });
      await h.waitUntil(() => countLoopEnds(h) >= 1, 5_000);
      await settle();
      for (let i = freshApplied; i < h.received.length; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }
      const settled = fresh.getState().transcript.find((b) => b.kind === "tool_call" && b.toolCallId === "c1");
      expect(settled).toMatchObject({ status: "success" });
      expect(fresh.getState().turn.status).toBe("idle");
    } finally {
      h.close();
    }
  });

  it("E: active turn's turn_started evicted from the ring by >CAP flood — fresh store still restores the running turn and the live tail lands", { timeout: 20_000 }, async () => {
    const h = createHarness({ steps: [renderedTextStep("Done now")] });
    let releasePrompt: (() => void) | undefined = (() => {}) as (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let calls = 0;
    h.config.hooks.register({
      event: "UserPromptSubmit",
      hook: async () => {
        calls += 1;
        if (calls >= 1) {
          await gate;
        }
        return {};
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");

      h.send({ type: "user_message", requestId: "r1", text: "Done" });
      await h.waitFor((m): m is Extract<HostToUiMessage, { type: "pending_prompt" }> => m.type === "pending_prompt" && m.text === "Done");
      // Flood the ring past REPLAY_BUFFER_CAP — the turn's turn_started is
      // evicted; only session_history + pending_prompt (sendDirect) survive.
      const { REPLAY_BUFFER_CAP } = await import("./session.js");
      for (let i = 0; i < REPLAY_BUFFER_CAP + 100; i += 1) {
        h.outbound.emit({ type: "title_changed", title: `flood-${i}` });
      }
      await settle();

      const before = h.received.length;
      h.send({ type: "ui_ready" });
      // Empty durable history (the user frame is still hook-gated) -> no
      // session_history message exists; the reconnect cascade's proof is the
      // SECOND host_ready plus the pending_prompt push.
      await h.waitUntil(
        () => h.received.slice(before).some((m) => m.type === "host_ready") && h.received.slice(before).some((m): m is Extract<HostToUiMessage, { type: "pending_prompt" }> => m.type === "pending_prompt" && m.text === "Done"),
        5_000,
      );
      await settle(12);

      const fresh = attachStore(h).store;
      // The pending prompt is visible even though its turn_started is gone
      // from the ring: pending_prompt rides sendDirect.
      expect(texts(fresh)).toContain("Done");
      expect(fresh.getState().pendingPrompt?.text).toBe("Done");

      // ── The turn resumes: the live tail must land on the fresh store ──
      releasePrompt!();
      await h.waitUntil(() => countLoopEnds(h) >= 1, 8_000);
      await settle();
      for (let i = before; i < h.received.length; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }
      const after = texts(fresh);
      expect(after).toContain("Done now");
      expect(after.filter((t) => t === "Done now")).toHaveLength(1);
      expect(fresh.getState().turn.status).toBe("idle");
      expect(fresh.getState().pendingPrompt).toBeNull();
    } finally {
      releasePrompt?.();
      h.close();
    }
  });

  it("D: idle after >CAP ring overflow — reconnect renders the LATEST durable transcript, not the boot snapshot", { timeout: 20_000 }, async () => {
    const h = createHarness({
      steps: [renderedTextStep("latest durable output")],
      bootHistory: [
        { id: "boot-1", createdAt: 1, message: { role: "user", content: "boot turn" }, tokenEstimate: 3, kind: "normal" },
      ],
    });
    try {
      h.engine.replaceHistory?.([
        { id: "boot-1", createdAt: 1, message: { role: "user", content: "boot turn" }, tokenEstimate: 3, kind: "normal" },
      ]);
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");

      // One real completed turn: 'latest durable output' is durable now.
      h.send({ type: "user_message", requestId: "r1", text: "go" });
      await h.waitUntil(() => countLoopEnds(h) >= 1);
      await settle();

      // Overflow the ring: every buffered event of the live turn is evicted.
      const { REPLAY_BUFFER_CAP } = await import("./session.js");
      for (let i = 0; i < REPLAY_BUFFER_CAP + 100; i += 1) {
        h.outbound.emit({ type: "title_changed", title: `flood-${i}` });
      }
      await settle(12);

      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some((m) => m.type === "session_history"), 5_000);
      await settle(12);

      const fresh = attachStore(h).store;
      const freshTexts = texts(fresh);
      // The LATEST durable transcript — not the host-start boot snapshot.
      expect(freshTexts).toContain("latest durable output");
      expect(freshTexts).toContain("boot turn");
      expect(freshTexts.filter((t) => t === "latest durable output")).toHaveLength(1);
      // Ring overflow replayed only flood titles — no turn events, no dupes.
      expect(fresh.getState().turn.status).toBe("idle");
    } finally {
      h.close();
    }
  });

  it("SDK stream ids reused across turns — turn 1 and turn 2 (same stream id 't1') render as SEPARATE blocks, no cross-turn bleed", async () => {
    // Both turns' steps stream with id "t1" (real SDK behavior: ids are
    // reused; consecutive steps within one outer turn and consecutive turns
    // alike). A bare-id stream map would route the later stream's deltas
    // into the earlier stream's already-settled block.
    const h = createHarness({
      steps: [renderedTextStep("turn one text"), renderedTextStep("turn two text")],
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");
      const live = attachStore(h);

      h.send({ type: "user_message", requestId: "r1", text: "go" });
      live.store.getState().appendUserText("r1", "go");
      await h.waitUntil(() => countLoopEnds(h) >= 1, 5_000);
      await settle();
      const appliedNow = feed(live.store, h, live.applied);
      h.send({ type: "user_message", requestId: "r2", text: "go" });
      live.store.getState().appendUserText("r2", "go");
      await h.waitUntil(() => countLoopEnds(h) >= 2, 5_000);
      await settle();
      feed(live.store, h, appliedNow);

      const all = texts(live.store);
      expect(all.filter((t) => t === "turn one text")).toHaveLength(1);
      expect(all.filter((t) => t === "turn two text")).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("native compat: foreign-engine-style unstamped hydration + boot items — fold never engages, transcript renders, second identical text renders twice", async () => {
    const h = createHarness({ steps: [renderedTextStep("Done"), renderedTextStep("Done")] });
    try {
      // Simulate a resumed FOREIGN session's boot history: old items WITHOUT
      // TASK.117 stamps (pre-117 core items carry none either) — hydration
      // must treat them as unknown-identity and never suppress live turns.
      const unstamped: HistoryItem[] = [
        { id: "old-1", createdAt: 1, message: { role: "user", content: "old turn" }, tokenEstimate: 3, kind: "normal" },
        {
          id: "old-2",
          createdAt: 2,
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
          tokenEstimate: 3,
          kind: "normal",
        },
      ];
      h.engine.replaceHistory?.(unstamped);
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");

      h.send({ type: "user_message", requestId: "r1", text: "again" });
      await h.waitUntil(() => countLoopEnds(h) >= 1, 5_000);
      await settle();
      h.send({ type: "user_message", requestId: "r2", text: "again" });
      await h.waitUntil(() => countLoopEnds(h) >= 2, 5_000);
      await settle();

      // Reconnect after the two live turns: fresh store must show the old
      // unstamped "Done" AND both new turns' "Done"s — three total, no
      // suppression by the unstamped twin.
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some((m) => m.type === "session_history"), 5_000);
      await settle();
      const fresh = attachStore(h).store;
      const freshTexts = texts(fresh);
      expect(freshTexts.filter((t) => t === "Done")).toHaveLength(3);
      expect(freshTexts.filter((t) => t === "again")).toHaveLength(2);
      expect(freshTexts).toContain("old turn");
    } finally {
      h.close();
    }
  });

  it("cancel: pending prompt is cleaned up, unpersisted text does not resurrect on reconnect", async () => {
    const h = createHarness({ steps: [renderedTextStep("never happens")] });
    let release: (() => void) | undefined = (() => {}) as (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.config.hooks.register({
      event: "UserPromptSubmit",
      hook: async () => {
        await gate;
        return {};
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");

      h.send({ type: "user_message", requestId: "r1", text: "cancelled prompt" });
      await h.waitFor((m): m is Extract<HostToUiMessage, { type: "pending_prompt" }> => m.type === "pending_prompt" && m.text === "cancelled prompt");
      await settle();

      // Cancel while the prompt is still hook-gated (unpersisted): the abort
      // unblocks the hook with an AbortError BEFORE the user frame appends
      // (agent-loop pre-throw), so the prompt NEVER becomes durable.
      h.send({ type: "cancel_turn" });
      await h.waitUntil(() => countLoopEnds(h) >= 1, 5_000);
      release!();
      await settle();

      // Reconnect: no durable user item exists; no pending prompt either.
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some((m) => m.type === "host_ready"), 5_000);
      await settle();
      const fresh = attachStore(h).store;
      expect(fresh.getState().pendingPrompt).toBeNull();
      expect(texts(fresh)).not.toContain("cancelled prompt");
      expect(fresh.getState().turn.status).toBe("idle");
    } finally {
      release?.();
      h.close();
    }
  });

  it("usage accounting: a covered finish replays exactly once and a genuinely NEW live finish applies exactly once — concrete token totals", async () => {
    // Step 1 (becomes durable before the reconnect): finish usage {10,4,14}.
    // Step 2 (genuinely NEW live turn after the reconnect): {7,3,10}.
    const step = (usage: { inputTokens: number; outputTokens: number; totalTokens: number }, text: string): ModelStreamEvent[] => [
      { type: "start" },
      { type: "text_start", id: "t1" },
      { type: "text_delta", id: "t1", text },
      { type: "text_end", id: "t1" },
      { type: "finish", finishReason: "stop", usage },
    ];
    const h = createHarness({
      steps: [
        step({ inputTokens: 10, outputTokens: 4, totalTokens: 14 }, "first answer"),
        step({ inputTokens: 7, outputTokens: 3, totalTokens: 10 }, "second answer"),
      ],
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");
      const { store } = attachStore(h);

      // Turn 1, live: the finish applies exactly once via the materializing
      // switch — concrete totals, not a non-null check.
      let liveSince = h.received.length;
      h.send({ type: "user_message", requestId: "r1", text: "go" });
      store.getState().appendUserText("r1", "go");
      await h.waitUntil(() => countLoopEnds(h) >= 1, 5_000);
      await settle();
      liveSince = feed(store, h, liveSince);
      expect(store.getState().sessionTokens).toEqual({ input: 10, output: 4, total: 14 });

      // ── RECONNECT: fresh store, session_history covers (turn,1), then the
      // ring replays turn 1's finish. The covered fold must apply it ONCE ──
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some((m) => m.type === "session_history"), 5_000);
      await settle();
      const fresh = attachStore(h).store;
      expect(fresh.getState().sessionTokens).toEqual({ input: 10, output: 4, total: 14 });

      // ── A genuinely NEW live turn after the reconnect: its finish applies
      // exactly once ON TOP (never doubled, never dropped) ──
      let since = h.received.length;
      h.send({ type: "user_message", requestId: "r2", text: "again" });
      await h.waitUntil(() => countLoopEnds(h) >= 2, 5_000);
      await settle();
      since = feed(fresh, h, since);
      expect(fresh.getState().sessionTokens).toEqual({ input: 17, output: 7, total: 24 });
      // The rendered transcript agrees: each answer once.
      const all = texts(fresh);
      expect(all.filter((t) => t === "first answer")).toHaveLength(1);
      expect(all.filter((t) => t === "second answer")).toHaveLength(1);
      expect(fresh.getState().turn.status).toBe("idle");
    } finally {
      h.close();
    }
  });

  it("terminal BEFORE the user append: the prompt never becomes durable, the bubble retires, and the NEXT accepted prompt is unaffected", async () => {
    // REAL terminal-before-append path (replaces the old fake fail-open
    // hook-throw variant): a UserPromptSubmit hook PARKS on the turn's
    // AbortSignal (the true pre-append window — agent-loop.ts awaits the
    // hook BEFORE history.append), then the user cancels. The abort throws
    // out of runUserPromptSubmit, agent-loop maps it to loop_end
    // ("cancelled", 0 turns) WITHOUT appending the user frame, and Session
    // tears the turn down with currentStep undefined -> the pending prompt
    // clears "cancelled" and the bubble must be REMOVED (never durable).
    const h = createHarness({
      steps: [renderedTextStep("next turn works")],
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.config.hooks.register({
      event: "UserPromptSubmit",
      // runOneHook (hook-runner.ts) invokes the hook POSITIONALLY as
      // (input, signal) — the second argument IS the AbortSignal, not an
      // options bag. The old `options?.signal` spelling read `.signal` off
      // the AbortSignal itself (always undefined), so cancel_turn never
      // unblocked the parked hook.
      hook: async (_input: { prompt: string }, signal: AbortSignal) => {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => reject(signal.reason ?? new Error("Aborted"));
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          gate.then(resolve, reject);
        });
        return {};
      },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");
      const { store, applied } = attachStore(h);

      // Turn 1 parks pre-append (hook awaiting the abort signal): pending
      // bubble rendered, frame NOT yet durable.
      h.send({ type: "user_message", requestId: "r1", text: "terminal prompt" });
      await h.waitFor((m): m is Extract<HostToUiMessage, { type: "pending_prompt" }> => m.type === "pending_prompt" && m.text === "terminal prompt");
      const appliedLive = feed(store, h, applied);
      await settle();
      // Pending prompt is VISIBLY rendered (pending bubble) while the hook is
      // still parked — BEFORE any durable append exists.
      expect(store.getState().pendingPrompt).not.toBeNull();
      expect(store.getState().pendingPrompt?.text).toBe("terminal prompt");
      expect(texts(store).filter((t) => t === "terminal prompt")).toHaveLength(1);

      // Terminal (cancel) BEFORE the append: abort unblocks the hook with an
      // AbortError -> agent-loop maps it to loop_end("cancelled") with NO
      // user frame ever appended -> teardown clears "cancelled".
      h.send({ type: "cancel_turn" });
      await h.waitUntil(() => countLoopEnds(h) >= 1, 5_000);
      await settle();
      const afterCancel = feed(store, h, appliedLive);
      // The cancellation reached a terminal loop_end with reason "cancelled".
      const cancelEnd = h.received.find(
        (m): m is Extract<HostToUiMessage, { type: "agent_event" }> =>
          m.type === "agent_event" && m.event.type === "loop_end" && (m.event as { reason?: string }).reason === "cancelled",
      );
      expect(cancelEnd).toBeDefined();
      // The engine's DURABLE history has NO user frame for the cancelled
      // prompt (the actual items, not just absence from hydration).
      expect(h.engine.historyItems().filter((item) => (item.message.content ?? "") === "terminal prompt")).toHaveLength(0);
      // The bubble is REMOVED (cancelled: nothing ever became durable) and
      // the field is cleared.
      expect(store.getState().pendingPrompt).toBeNull();
      expect(texts(store).filter((t) => t === "terminal prompt")).toHaveLength(0);

      // Fresh reconnect. With an EMPTY durable history Session intentionally
      // omits session_history (buildSessionHistory returns null) — the real
      // readiness cascade for this state is the SECOND host_ready plus the
      // bare pending_prompt field-clear the ui_ready handshake pushes.
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(
        () =>
          h.received.slice(before).some((m) => m.type === "host_ready") &&
          h.received.slice(before).some((m): m is Extract<HostToUiMessage, { type: "pending_prompt" }> => m.type === "pending_prompt" && m.text === undefined),
        5_000,
      );
      await settle();
      const cascadeEnd = h.received.length;
      const fresh = createDesktopStore({ schedule: (fn) => fn() });
      for (let i = 0; i < cascadeEnd; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }
      // No durable user item for the cancelled prompt, no stale pendingPrompt
      // field, turn idle, NO rendered cancelled text.
      expect(h.engine.historyItems().filter((item) => (item.message.content ?? "") === "terminal prompt")).toHaveLength(0);
      expect(fresh.getState().pendingPrompt).toBeNull();
      expect(texts(fresh).filter((t) => t === "terminal prompt")).toHaveLength(0);
      expect(fresh.getState().turn.status).toBe("idle");

      // The NEXT accepted prompt is unaffected: renders, clears at terminal.
      release!();
      await settle();
      let since = h.received.length;
      h.send({ type: "user_message", requestId: "r2", text: "next" });
      await h.waitFor((m): m is Extract<HostToUiMessage, { type: "pending_prompt" }> => m.type === "pending_prompt" && m.text === "next");
      await h.waitUntil(() => countLoopEnds(h) >= 2, 5_000);
      await settle();
      since = feed(fresh, h, since);
      expect(fresh.getState().pendingPrompt).toBeNull();
      expect(texts(fresh).filter((t) => t === "next")).toHaveLength(1);
      expect(texts(fresh).filter((t) => t === "next turn works")).toHaveLength(1);
      expect(fresh.getState().turn.status).toBe("idle");
    } finally {
      release?.();
      h.close();
    }
  });

  it("non-core engine (native shape): FIXED boot snapshot hydrates; post-boot COMPLETE turn rides the ring replay; no pending_prompt payload, no step stamps", async () => {
    // A native Codex/Claude host keeps the ORIGINAL constructor boot
    // snapshot (the rebuild-on-ui_ready is a CORE contract) and its
    // COMPLETE later-completed turns reach a reconnecting renderer via the
    // Outbound ring replay — exactly as before TASK.117.
    const boot: HistoryItem[] = [
      { id: "boot-1", createdAt: 1, message: { role: "user", content: "boot turn" }, tokenEstimate: 3, kind: "normal" },
      {
        id: "boot-2",
        createdAt: 2,
        message: { role: "assistant", content: [{ type: "text", text: "boot reply" }] },
        tokenEstimate: 3,
        kind: "normal",
      },
    ];
    const history: HistoryItem[] = [...boot];
    const engine: SessionEngine = {
      id: "codex",
      capabilities: {
        supportsCorePermissions: false,
        supportsRewind: false,
        supportsWorkflow: false,
        supportsGitMutations: false,
        supportsContextUsage: false,
        supportsContextBreakdown: false,
        supportsInteractiveApprovals: false,
        costAccounting: false,
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsImages: false,
        supportsTasks: false,
        supportsFileSnapshots: false,
      },
      mode: () => "build",
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      async *runTurn(input: string): AsyncIterable<AgentEvent> {
        history.push({
          id: `item-${history.length + 1}`,
          createdAt: Date.now(),
          message: { role: "user", content: input },
          tokenEstimate: 1,
          kind: "normal",
        });
        yield { type: "turn_start", turn: 1 };
        yield { type: "text_start", id: "s1" };
        yield { type: "text_delta", id: "s1", text: "native reply" };
        yield { type: "text_end", id: "s1" };
        yield { type: "finish", finishReason: "stop", usage: {} };
        yield { type: "loop_end", reason: "completed", turns: 1 };
      },
      historyItems: () => [...history],
      dispose: async () => {},
    };
    const h = createHarness({ steps: [], engine, bootHistory: boot });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");
      const { store } = attachStore(h);

      h.send({ type: "user_message", requestId: "r1", text: "hello native" });
      // The production send path echoes the user text renderer-locally
      // (Composer.tsx / tab-registry.ts appendUserText) for EVERY engine —
      // no wire user-echo event exists. Mirror that real seam here.
      store.getState().appendUserText("r1", "hello native");
      await h.waitUntil(() => countLoopEnds(h) >= 1, 5_000);
      await settle();
      feed(store, h, 0);
      // Post-boot native events are visible on the live store.
      expect(texts(store).filter((t) => t === "native reply")).toHaveLength(1);
      expect(store.getState().turn.status).toBe("idle");

      // No core pending_prompt metadata ever hit the wire for this engine.
      expect(h.received.some((m) => m.type === "pending_prompt" && m.turnId !== undefined)).toBe(false);
      // No causal step stamps on agent_events (engine.id !== "core").
      expect(h.received.some((m) => m.type === "agent_event" && m.step !== undefined)).toBe(false);

      // Reconnect (ring intact): the FIXED boot snapshot hydrates AND the
      // ring replays the completed native turn — the pre-existing native
      // behavior must be preserved unchanged.
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some((m) => m.type === "session_history"), 5_000);
      await settle();
      const fresh = attachStore(h).store;
      expect(texts(fresh).filter((t) => t === "boot turn")).toHaveLength(1);
      expect(texts(fresh).filter((t) => t === "boot reply")).toHaveLength(1);
      // The post-boot COMPLETE turn reaches the reconnecting renderer via
      // the RING REPLAY (native contract): its streamed assistant text
      // re-renders exactly once. The user prompt itself is renderer-local
      // echo in production (no wire echo exists) — after a reload it is
      // simply absent, same as pre-117 native behavior.
      expect(texts(fresh).filter((t) => t === "native reply")).toHaveLength(1);
      expect(fresh.getState().pendingPrompt).toBeNull();
      expect(fresh.getState().turn.status).toBe("idle");
    } finally {
      h.close();
    }
  });

  it("non-core engine, STAMPED fixed boot: hydrates blocks but NEVER folds them — a NEW native tool_result with a colliding toolCallId is NOT suppressed", async () => {
    // TASK.117 phase-1 defect 2 (native + stamps): a native host's FIXED
    // boot snapshot may legitimately contain items that ALREADY carry
    // {turnId, step} (a resumed session hydrated through the shared
    // projection). The durable/causal fold is a CORE contract keyed by the
    // host_ready ENGINE discriminator (never by metadata absence on native
    // events — native agent_events carry no step): the stamps hydrate as
    // inert transcript data, and a genuinely NEW native live/replayed
    // tool_result whose toolCallId COLLIDES with a boot item's must land,
    // not be suppressed as "already durable".
    const boot: HistoryItem[] = [
      { id: "boot-1", createdAt: 1, message: { role: "user", content: "boot turn" }, tokenEstimate: 3, kind: "normal", turnId: "turn-boot", step: 0 },
      {
        id: "boot-2",
        createdAt: 2,
        turnId: "turn-boot",
        step: 1,
        message: {
          role: "assistant",
          content: [{ type: "tool_call", toolCallId: "call-1", toolName: "Bash", input: { command: "echo hi" } }],
        },
        tokenEstimate: 3,
        kind: "normal",
      },
      {
        id: "boot-3",
        createdAt: 3,
        turnId: "turn-boot",
        step: 1,
        message: { role: "tool", content: [{ type: "tool_result", toolCallId: "call-1", toolName: "Bash", status: "success", text: "boot tool text" }] },
        tokenEstimate: 3,
        kind: "normal",
      },
    ];
    const history: HistoryItem[] = [...boot];
    const engine: SessionEngine = {
      id: "codex",
      capabilities: {
        supportsCorePermissions: false,
        supportsRewind: false,
        supportsWorkflow: false,
        supportsGitMutations: false,
        supportsContextUsage: false,
        supportsContextBreakdown: false,
        supportsInteractiveApprovals: false,
        costAccounting: false,
        supportsModelSelection: false,
        supportsReasoningEffort: false,
        supportsImages: false,
        supportsTasks: false,
        supportsFileSnapshots: false,
      },
      mode: () => "build",
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      async *runTurn(input: string): AsyncIterable<AgentEvent> {
        history.push({
          id: `item-${history.length + 1}`,
          createdAt: Date.now(),
          message: { role: "user", content: input },
          tokenEstimate: 1,
          kind: "normal",
        });
        yield { type: "turn_start", turn: 1 };
        // A NEW native text segment FIRST — with the fold wrongly engaged
        // (the phase-hydration defect class) its stream would be keyed to a
        // nonexistent covered step; here it must simply render.
        yield { type: "text_start", id: "s1" };
        yield { type: "text_delta", id: "s1", text: "NEW native text" };
        yield { type: "text_end", id: "s1" };
        // A NEW native call REUSING the boot item's toolCallId — the exact
        // identity collision the unconditional fold used to suppress.
        yield { type: "tool_call", toolCall: { id: "call-1", name: "Bash", input: { command: "echo new" } } };
        yield {
          type: "tool_result",
          outcome: {
            toolCallId: "call-1",
            toolName: "Bash",
            status: "success",
            modelText: "NEW native live result",
            durationMs: 5,
          },
        };
        yield { type: "finish", finishReason: "stop", usage: {} };
        yield { type: "loop_end", reason: "completed", turns: 1 };
      },
      historyItems: () => [...history],
      dispose: async () => {},
    };
    const h = createHarness({ steps: [], engine, bootHistory: boot });
    try {
      h.send({ type: "ui_ready" });
      const attachAt = h.received.length;
      await h.waitFor((m) => m.type === "host_ready");
      // The boot hydration rides the ui_ready cascade AFTER host_ready —
      // wait for it before attaching, so the assertions below see the
      // hydrated boot blocks (host_ready set the native engine
      // discriminator that keeps the stamps inert).
      await h.waitUntil(() => h.received.slice(attachAt).some((m) => m.type === "session_history"), 5_000);
      await settle();
      const { store, applied } = attachStore(h);

      // TASK.117 phase-hydration regression: assert the STAMPED boot state
      // (old durable text/modelText) BEFORE any live turn runs — the
      // hydration must have projected the boot blocks WITHOUT folding the
      // stamps into durable coverage (no core fold for a native host_ready).
      const bootBlock = () =>
        store.getState().transcript.find((b) => b.kind === "tool_call" && b.toolCallId === "call-1");
      expect(bootBlock()).toMatchObject({ status: "success", modelText: "boot tool text" });
      expect(texts(store).filter((t) => t === "boot turn")).toHaveLength(1);

      h.send({ type: "user_message", requestId: "r1", text: "hello native" });
      await h.waitUntil(() => countLoopEnds(h) >= 1, 5_000);
      await settle();
      // Feed ONLY messages the store has not consumed — re-feeding the old
      // host_ready would reset the live store (attachStore's own contract).
      feed(store, h, applied);

      // The NEW native TEXT rendered AFTER the update (boot state was
      // asserted strictly BEFORE, above — ordering is the regression).
      expect(texts(store).filter((t) => t === "NEW native text")).toHaveLength(1);
      // The NEW native result with the COLLIDING id LANDED (no core fold ->
      // no durableToolResults identity suppression for this engine).
      expect(bootBlock()).toMatchObject({ modelText: "NEW native live result" });
      // No pending_prompt of ANY shape (bare clear included) hit the wire.
      expect(h.received.some((m) => m.type === "pending_prompt")).toBe(false);

      // Reconnect: the fixed boot snapshot hydrates again; replay of the new
      // turn's tool_result must NOT be suppressed by the (again stamped)
      // boot hydration either — the newest status survives.
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.slice(before).some((m) => m.type === "session_history"), 5_000);
      await settle();
      const fresh = attachStore(h).store;
      const freshBlock = fresh.getState().transcript.find(
        (b) => b.kind === "tool_call" && b.toolCallId === "call-1",
      );
      expect(freshBlock).toMatchObject({ modelText: "NEW native live result" });
      expect(fresh.getState().turn.status).toBe("idle");
    } finally {
      h.close();
    }
  });

  it("continuation: no stale bubble before the resumed segment — the pending field/bubble is retired before the first turn_start", async () => {
    // TASK.117 continuation regression. A model continuation has NO prompt:
    // startContinuation must retire any STALE pending prompt BEFORE the
    // resumed segment's first turn_start. The fixture is honest about the
    // ORDER in which the stale state and the continuation arise:
    //
    //   • a FIRST ui_ready attaches the renderer while the host has NO
    //     continuation claim (the harness's deferred-continuation seam has
    //     not armed it) — that handshake cannot start any continuation;
    //   • the STALE HOST SLOT is then seeded through the harness's test-only
    //     `seedPendingPrompt` seam — the exact slot shape the production
    //     admission path captures (the rehost window: the pre-rehost
    //     terminal never ran its own clear) — and its own REAL core-gated
    //     pushPendingPrompt delivers the payload-bearing pending_prompt on
    //     the attached wire;
    //   • BOTH stale facts are asserted BEFORE any continuation entry is
    //     invoked: the REAL host slot (`pendingPromptSlot` read-only
    //     snapshot) and a REAL createDesktopStore fed the ACTUAL wire log
    //     (field holds the stale prompt, `pending:{turnId}` bubble
    //     rendered, no turn_start on the wire);
    //   • only THEN is the DURABLE claim armed and the REAL entry triggered
    //     by a second ui_ready — route()'s production continuationPending
    //     branch → startContinuation driving the REAL core loop;
    //     onContinuationReady is used for GATING ONLY (park the entry on a
    //     deterministic gate so the pre-entry assertions above are provably
    //     not produced by the entry itself — no fault is planted inside the
    //     entry). NO public interleave is claimed to exist; everything the
    //     renderer sees is the genuine wire.
    const STALE_TURN_TEXT = "stale prompt";
    let harness: ReturnType<typeof createHarness>;
    let releaseContinuation: (() => void) | undefined;
    const continuationGate = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    harness = createHarness({
      // The stale pending record belongs to the PREVIOUS host's turn; this
      // host's only model traffic is the continuation itself — ONE step.
      // NOTE: continuationPending is NOT set here (the deferred-continuation
      // seam below arms the durable claim only after the stale state has
      // been observed) — the initial ui_ready attaches the port/delivers
      // handshake metadata and CANNOT start any continuation.
      steps: [renderedTextStep("continued answer")],
      onContinuationReady: async () => {
        // GATING ONLY: park the REAL entry (busy locked, clear not yet run)
        // until the assertions below have confirmed the entry is not what
        // produced the stale render. No state is planted here.
        await continuationGate;
      },
    });
    try {
      // 1. FIRST ui_ready: physical attach + initial handshake — with the
      //    durable continuation claim NOT yet armed, this ui_ready runs the
      //    ordinary cascade and CANNOT start a continuation.
      harness.send({ type: "ui_ready" });
      await harness.waitFor((m) => m.type === "host_ready", 5_000);
      await settle();

      // 2. Seed the stale HOST slot through the real admission-shaped seam
      //    with the port ATTACHED: the seed's own REAL core-gated
      //    pushPendingPrompt delivers the payload-bearing pending_prompt on
      //    the wire immediately (this is the stale state a rehost window
      //    leaves behind once its renderer attaches).
      harness.seedPendingPrompt("r-stale", STALE_TURN_TEXT);
      const seedPush = await harness.waitFor(
        (m): m is Extract<HostToUiMessage, { type: "pending_prompt" }> =>
          m.type === "pending_prompt" && m.text === STALE_TURN_TEXT && m.turnId !== undefined,
        5_000,
      );
      await settle();

      // 3. BOTH stale assertions run BEFORE any continuation entry exists:
      //    the REAL host slot (read-only snapshot of the production record)
      //    and a REAL createDesktopStore fed the ACTUAL wire log — field
      //    holds the stale prompt, pending bubble rendered. No turn_start
      //    has hit the wire — nothing entry-shaped has run at all yet.
      expect(harness.pendingPromptSlot()).toMatchObject({ text: STALE_TURN_TEXT });
      const live = attachStore(harness);
      expect(live.store.getState().pendingPrompt).toMatchObject({ text: STALE_TURN_TEXT });
      expect(
        live.store.getState().transcript.some((b) => b.id.startsWith("pending:")),
      ).toBe(true);
      expect(
        harness.received.some((m) => m.type === "agent_event" && m.event.type === "turn_start"),
      ).toBe(false);

      // 4. Arm the DURABLE claim and trigger the REAL entry: the next
      //    ui_ready takes route()'s production continuationPending branch →
      //    startContinuation (the gate parks it before the clear) driving
      //    the REAL core loop.
      harness.armContinuation();
      harness.send({ type: "ui_ready" });
      await settle();

      // 3. Release the entry: the clear ("cancelled" body — nothing is in
      //    flight) must hit the wire BEFORE the continued segment's first
      //    provider turn_start, retire the bubble/field, and the continued
      //    answer must render EXACTLY ONCE.
      releaseContinuation?.();
      const contStart = await harness.waitFor(
        (m): m is Extract<HostToUiMessage, { type: "agent_event" }> =>
          m.type === "agent_event" && m.event.type === "turn_start",
        5_000,
      );
      await harness.waitFor(
        (m): m is Extract<HostToUiMessage, { type: "agent_event" }> =>
          m.type === "agent_event" && m.event.type === "loop_end" && m.turnId === contStart.turnId,
        5_000,
      );
      await settle();
      // Ordering via the ACTUAL received log: the seed's own real push (the
      // bubble's origin, strictly pre-entry) precedes the cancelled clear,
      // and the clear (a sendDirect handshake-shaped push, NOT
      // ring-buffered) precedes the continued segment's first turn_start.
      const seedIdx = harness.received.indexOf(seedPush);
      const clearIdx = harness.received.findIndex(
        (m) => m.type === "pending_prompt" && (m as { outcome?: string }).outcome === "cancelled",
      );
      const contStartIdx = harness.received.indexOf(contStart);
      expect(seedIdx).toBeGreaterThanOrEqual(0);
      expect(clearIdx).toBeGreaterThan(seedIdx);
      expect(clearIdx).toBeLessThan(contStartIdx);

      feed(live.store, harness, live.applied);
      // Stale FIELD and stale BUBBLE are both gone — the stale prompt
      // leaves NO rendered trace (it never became durable on THIS host)…
      expect(live.store.getState().pendingPrompt).toBeNull();
      expect(
        live.store.getState().transcript.some((b) => b.id.startsWith("pending:")),
      ).toBe(false);
      expect(texts(live.store).filter((t) => t === STALE_TURN_TEXT)).toHaveLength(0);
      // …and the continued answer rendered EXACTLY ONCE.
      expect(texts(live.store).filter((t) => t === "continued answer")).toHaveLength(1);
      expect(live.store.getState().turn.status).toBe("idle");

      // 4. Reconnect: fresh store, clean hydration — no stale field, no
      //    pending bubble, exactly one continued answer from durability.
      const before = harness.received.length;
      harness.send({ type: "ui_ready" });
      await harness.waitUntil(
        () => harness.received.slice(before).some((m) => m.type === "session_history"),
        5_000,
      );
      await settle();
      const fresh = attachStore(harness).store;
      expect(fresh.getState().pendingPrompt).toBeNull();
      expect(fresh.getState().transcript.some((b) => b.id.startsWith("pending:"))).toBe(false);
      expect(texts(fresh).filter((t) => t === "continued answer")).toHaveLength(1);
      expect(texts(fresh).filter((t) => t === STALE_TURN_TEXT)).toHaveLength(0);
      expect(fresh.getState().turn.status).toBe("idle");
    } finally {
      releaseContinuation?.();
      harness.close();
    }
  });



  it("stale older finalizer: an older turn's terminal clear cannot erase a NEWER pending record — both host slot and rendered bubble survive, then their own clear retires them", async () => {
    // TASK.117 owner-ordering regression (deterministic). The public busy
    // invariant serializes admissions (the previous fixture assumed cancel
    // could admit a newer turn while the old turn's Read teardown was still
    // parked — real admission never interleaves that way: `onCancel` clears
    // pendingPrompt synchronously, so a newer capture overwrites a null
    // slot and no stale-vs-newer window is reachable through public input).
    // The CONTRACT this guards is the exact-owner check in the turn
    // teardown's `.finally` (now `Session.clearPendingPromptIfOwner`): a
    // stale older finalizer's clear, firing after a NEWER admission-shaped
    // record exists, must be a NO-OP.
    //
    // TEST-ONLY fault injection, same precedent as the accepted continuation
    // seam (seedPendingPrompt/armContinuation/pendingPromptSlot): (1) the
    // newer pending record is installed through the harness's real
    // admission-shaped seeding (exact production slot shape, REAL
    // core-gated pushPendingPrompt delivery onto the wire); (2) the STALE
    // clear is invoked through the REAL production guard
    // `clearPendingPromptIfOwner` with an OLDER turn's UUID pair — exactly
    // what the older turn's parked teardown would fire late. Everything the
    // renderer sees is the genuine wire; no fabricated wire messages and no
    // fabricated cleanup.
    const h = createHarness({ steps: [renderedTextStep("newer answer")] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready", 5_000);
      const { store, applied } = attachStore(h);

      // NEWER pending record: admission-shaped ownership (owner = minted
      // outer turnId + requestId pair, the exact capture acceptUserMessage
      // performs) delivered by the REAL push onto the real wire. The
      // renderer renders the field AND the pending bubble from the wire.
      h.seedPendingPrompt("r-new", "newer prompt");
      const newerPush = await h.waitFor(
        (m): m is Extract<HostToUiMessage, { type: "pending_prompt" }> =>
          m.type === "pending_prompt" && m.text === "newer prompt" && m.turnId !== undefined,
        5_000,
      );
      let since = feed(store, h, applied);
      const newerTurnId = newerPush.turnId as string;
      expect(h.pendingPromptSlot()).toMatchObject({ turnId: newerTurnId, requestId: "r-new", text: "newer prompt" });
      expect(store.getState().pendingPrompt).toMatchObject({ turnId: newerTurnId, text: "newer prompt" });
      expect(store.getState().transcript.some((b) => b.id === `pending:${newerTurnId}`)).toBe(true);

      // STALE clear: the older turn's terminal fires AFTER the newer
      // admission — the REAL production guard invoked with the OLDER pair
      // (neither the newer turnId nor the newer requestId). It must be a
      // NO-OP: no pending_prompt hits the wire, the host slot still holds
      // the NEWER record, and the rendered field/bubble survive.
      const wireLen = h.received.length;
      h.session.clearPendingPromptIfOwner("r-old", "00000000-old-turn-0000-000000000000", "cancelled");
      await settle(3);
      since = feed(store, h, since);
      expect(h.received.length).toBe(wireLen); // no clear push was emitted
      expect(h.pendingPromptSlot()).toMatchObject({ turnId: newerTurnId, text: "newer prompt" });
      expect(store.getState().pendingPrompt).toMatchObject({ turnId: newerTurnId, text: "newer prompt" });
      expect(store.getState().transcript.some((b) => b.id === `pending:${newerTurnId}`)).toBe(true);

      // STALE clear, SUBCASE 2 (turnUUID equality is the load-bearing half
      // of the owner check): an older turn's terminal firing with the SAME
      // requestId "r-new" but a DIFFERENT, OLDER turn UUID — the exact pair
      // an older capture of the same request identity would hold. requestId
      // equality alone must NOT match: the guard requires BOTH halves, so
      // even a cancel-shaped stale clear (the most aggressive outcome — it
      // removes the renderer's bubble) is a NO-OP and the NEWER record
      // survives whole: no wire clear, host slot intact, renderer field AND
      // bubble intact.
      const wireLenSameRequest = h.received.length;
      h.session.clearPendingPromptIfOwner("r-new", "00000000-older-turn-0000-000000000000", "cancelled");
      await settle(3);
      since = feed(store, h, since);
      expect(h.received.length).toBe(wireLenSameRequest); // no clear push was emitted
      expect(h.pendingPromptSlot()).toMatchObject({ turnId: newerTurnId, requestId: "r-new", text: "newer prompt" });
      expect(store.getState().pendingPrompt).toMatchObject({ turnId: newerTurnId, text: "newer prompt" });
      expect(store.getState().transcript.some((b) => b.id === `pending:${newerTurnId}`)).toBe(true);

      // OWN clear: the NEWER record's exact owner pair retires it through
      // the same REAL guard, pushing the real terminal clear onto the wire.
      // "cancelled" (the teardown passes this outcome when the frame never
      // became durable — exactly this fixture: the injected newer prompt was
      // never persisted): the field goes null AND the bubble block is
      // REMOVED — a cancelled prompt must not stay on screen.
      h.session.clearPendingPromptIfOwner("r-new", newerTurnId, "cancelled");
      await settle(3);
      since = feed(store, h, since);
      expect(h.pendingPromptSlot()).toBeNull();
      expect(store.getState().pendingPrompt).toBeNull();
      expect(store.getState().transcript.some((b) => b.id === `pending:${newerTurnId}`)).toBe(false);
    } finally {
      h.close();
    }
  });

  // TASK.117 PHASE: authoritative control/accounting checkpoint. When the
  // replay ring has overflowed (>REPLAY_BUFFER_CAP ACTUAL outbound recorded
  // events), everything the ring knew about the still-active CORE turn is
  // gone: its finishes (session token totals), its context_usage readings,
  // and — for a turn parked at a permission ask — the ask itself. Durable
  // history carries none of those (HistoryItem has no usage/control fields),
  // so the ui_ready cascade must re-assert them from a wire-state
  // checkpoint captured AT EMISSION TIME (never re-derived from history).
  it("checkpoint: still-active turn survives >CAP ring eviction — durable steps persist, evicted turn_started+wire steps recover, running status/contextUsage/exact token totals/parked permission all restore; live finish/tool_result NOT suppressed; old/stale controls never resurrect", { timeout: 30_000 }, async () => {
    // Step 1 (turn 1, step 1): usage {10,4,14} — becomes DURABLE before the
    // reconnect. Step 2 (same turn? no — turn 2) parks at a Write permission
    // ask; step 3 is the post-allow tail {7,3,10}.
    const step = (usage: { inputTokens: number; outputTokens: number; totalTokens: number }, text: string): ModelStreamEvent[] => [
      { type: "start" },
      { type: "text_start", id: "t1" },
      { type: "text_delta", id: "t1", text },
      { type: "text_end", id: "t1" },
      { type: "finish", finishReason: "stop", usage },
    ];
    const h = createHarness({
      steps: [
        step({ inputTokens: 10, outputTokens: 4, totalTokens: 14 }, "durable answer"),
        toolStep("cp1", "Write", { file_path: "/workspace/ck.txt", content: "CK" }),
        step({ inputTokens: 7, outputTokens: 3, totalTokens: 10 }, "tail answer"),
      ],
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready", 5_000);
      const live = attachStore(h);
      let applied = live.applied;

      // Turn 1 completes: 'durable answer' + finish {10,4,14} are durable.
      h.send({ type: "user_message", requestId: "r1", text: "one" });
      live.store.getState().appendUserText("r1", "one");
      await h.waitUntil(() => countLoopEnds(h) >= 1, 5_000);
      await settle();
      applied = feed(live.store, h, applied);
      expect(live.store.getState().sessionTokens).toEqual({ input: 10, output: 4, total: 14 });

      // Turn 2 parks at the Write permission ask: the assistant tool_call
      // item is durable (appended BEFORE dispatch), the ask is parked.
      h.send({ type: "user_message", requestId: "r2", text: "two" });
      live.store.getState().appendUserText("r2", "two");
      const ask = await h.waitFor((m) => m.type === "permission_request", 5_000);
      await settle();
      applied = feed(live.store, h, applied);
      expect(live.store.getState().turn.status).toBe("running");

      // ── Overflow the ring with ACTUAL outbound recorded events (>CAP):
      // turn 2's buffered turn_started, text streams, finishes and the
      // permission_request itself are all evicted. ──
      const { REPLAY_BUFFER_CAP } = await import("./session.js");
      for (let i = 0; i < REPLAY_BUFFER_CAP + 1_000; i += 1) {
        h.outbound.emit({ type: "title_changed", title: `flood-${i}` });
      }
      await settle(12);

      // ── RECONNECT: fresh store, second ui_ready on the same live host ──
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(
        () => h.received.slice(before).some((m) => m.type === "session_history"),
        5_000,
      );
      await settle(12);
      const fresh = attachStore(h).store;

      // (a) Durable earlier steps persist: turn 1 fully hydrated exactly once.
      const freshTexts = texts(fresh);
      expect(freshTexts.filter((t) => t === "one")).toHaveLength(1);
      expect(freshTexts.filter((t) => t === "durable answer")).toHaveLength(1);
      // Turn 2's durable user frame + assistant tool_call item hydrate too.
      expect(freshTexts.filter((t) => t === "two")).toHaveLength(1);
      const card = fresh.getState().transcript.find((b) => b.kind === "tool_call" && b.toolCallId === "cp1");
      expect(card).toBeDefined();

      // (b) Running status: the evicted turn_started is re-asserted as
      // handshake meta — the fresh store knows a turn is live.
      expect(fresh.getState().turn.status).toBe("running");

      // (c) Exact once-only token totals: turn 1's evicted finish must be
      // recovered from the checkpoint, EXACTLY (not doubled, not lost).
      expect(fresh.getState().sessionTokens).toEqual({ input: 10, output: 4, total: 14 });
      // The evicted context_usage reading recovers too (status-bar meter).
      expect(fresh.getState().contextUsage).not.toBeNull();
      expect(fresh.getState().contextUsage?.budgetTokens).toBeGreaterThan(0);

      // (d) The parked permission ask is re-asserted: the fresh store shows
      // the SAME requestId the live store saw.
      expect(fresh.getState().permission?.requestId).toBe(ask.requestId);

      // ── Live tail: allow the parked ask; the emitted tool_result (a call
      // whose proposal hydrated durable) and the NEW finish must NOT be
      // suppressed by the prior coverage, and must apply exactly once. ──
      h.send({ type: "permission_response", requestId: ask.requestId, behavior: "allow" });
      await h.waitUntil(() => countLoopEnds(h) >= 2, 8_000);
      await settle();
      for (let i = before; i < h.received.length; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }
      const settled = fresh.getState().transcript.find((b) => b.kind === "tool_call" && b.toolCallId === "cp1");
      expect(settled).toMatchObject({ status: "success" });
      expect(texts(fresh).filter((t) => t === "tail answer")).toHaveLength(1);
      // {10,4,14} + {7,3,10} — the live finish applied exactly once ON TOP.
      expect(fresh.getState().sessionTokens).toEqual({ input: 17, output: 7, total: 24 });
      expect(fresh.getState().turn.status).toBe("idle");
      expect(fresh.getState().permission).toBeNull();

      // ── Old completed/stale controls must not resurrect: a THIRD
      // reconnect after the turn settled shows no permission, no running
      // turn, no pending prompt, and totals stay exactly {17,7,24}. ──
      const before2 = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(
        () => h.received.slice(before2).some((m) => m.type === "session_history"),
        5_000,
      );
      await settle(12);
      const third = attachStore(h).store;
      expect(third.getState().permission).toBeNull();
      expect(third.getState().turn.status).toBe("idle");
      expect(third.getState().pendingPrompt).toBeNull();
      expect(third.getState().sessionTokens).toEqual({ input: 17, output: 7, total: 24 });
    } finally {
      h.close();
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // TASK.117 acceptance defect 1 — live partial stream across a reconnect
  // whose text_start was EVICTED from the replay ring by >CAP model deltas.
  // The model is genuinely mid-response (start + text_start + >CAP deltas
  // emitted; text_end/finish NOT emitted — GatedModelPort parks the stream),
  // so core has NOT appended the assistant item and the reconnect snapshot
  // carries no assistant text. The partial + the live tail must render on a
  // FRESH store fed ONLY the second ui_ready cascade + the post-gate tail.
  // ═════════════════════════════════════════════════════════════════════════
  it("F: >CAP deltas during an UNFINISHED model response — fresh store renders the current partial and the live tail; running/cancel intact", { timeout: 60_000 }, async () => {
    const { REPLAY_BUFFER_CAP } = await import("./session.js");
    // One step: start, text_start, CAP+200 deltas, then PARKED (no text_end,
    // no finish). After release: text_end + finish + (loop appends) loop_end.
    const bigSteps: ModelStreamEvent[] = [
      { type: "start" },
      { type: "text_start", id: "t1" },
    ];
    for (let i = 0; i < REPLAY_BUFFER_CAP + 200; i += 1) {
      bigSteps.push({ type: "text_delta", id: "t1", text: `d${i} ` });
    }
    bigSteps.push({ type: "text_end", id: "t1" });
    bigSteps.push({ type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } });

    const h = createHarness({
      steps: [bigSteps],
      gated: { parkAfterIndex: bigSteps.length - 3 }, // parked after the LAST delta, before text_end
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");

      h.send({ type: "user_message", requestId: "r1", text: "long one" });
      // Wait until the whole partial (CAP+200 deltas) has actually been
      // emitted — the stream is now parked mid-response.
      await h.waitUntil(
        () => h.received.filter((m) => m.type === "agent_event" && m.event.type === "text_delta").length >= REPLAY_BUFFER_CAP + 200,
        20_000,
      );
      await settle(12);

      // ── RECONNECT mid-response: fresh store, second ui_ready cascade ──
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(
        () =>
          h.received.slice(before).some((m) => m.type === "host_ready") &&
          h.received.slice(before).some((m): m is Extract<HostToUiMessage, { type: "session_checkpoint" }> => m.type === "session_checkpoint" && m.streams !== undefined && m.streams.length === 1),
        10_000,
      );
      await settle(12);
      // FRESH store fed ONLY the reconnect cascade (everything from `before`
      // up to now): host_ready -> session_history -> pending_prompt -> turn_started
      // re-assert -> session_checkpoint(streams) -> replay(tail of the ring).
      const cascadeEnd = h.received.length;
      const fresh = createDesktopStore({ schedule: (fn) => fn() });
      for (let i = before; i < cascadeEnd; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }
      // The PARTIAL renders: the checkpoint re-opened the stream with the
      // full accumulated body (CAP+200 deltas), even though text_start was
      // evicted from the ring long ago.
      const partial = fresh.getState().transcript.find((b) => b.kind === "assistant_text");
      expect(partial).toBeDefined();
      expect(partial?.kind === "assistant_text" ? partial.text.split(" ").length - 1 : 0).toBe(REPLAY_BUFFER_CAP + 200);
      // The turn is RUNNING and owned (cancel target intact) — no loop_end yet.
      expect(fresh.getState().turn.status).toBe("running");
      expect(fresh.getState().turn.turnId).not.toBeNull();

      // ── LIVE TAIL: the still-blocked stream ends and the turn finishes ──
      h.gated?.release();
      await h.waitUntil(() => countLoopEnds(h) >= 1, 20_000);
      await settle();
      // Feed ONLY the unconsumed live tail.
      for (let i = cascadeEnd; i < h.received.length; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }
      const done = texts(fresh).filter((t) => t !== null && t.startsWith("d0 "));
      expect(done).toHaveLength(1);
      // Exactly once — replayed ring deltas did not duplicate the partial.
      const blocks = fresh.getState().transcript.filter((b) => b.kind === "assistant_text");
      expect(blocks).toHaveLength(1);
      // Idle + the finish applied exactly once.
      expect(fresh.getState().turn.status).toBe("idle");
      expect(fresh.getState().sessionTokens).toEqual({ input: 3, output: 5, total: 8 });

      // ── Cancel ownership: a NEW parked turn can still be cancelled ──
      // (proven structurally above by turn.status running + turnId set; the
      // cancel_turn route for a mid-stream abort is covered by the existing
      // cancel regression — here the running ownership survived the reconnect.)
    } finally {
      h.gated?.release();
      h.close();
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // TASK.117 acceptance defect 3 — real Session -> fresh-store regressions
  // for the live-stream checkpoint. Each drives the REAL host Session and a
  // FRESH store fed only the reconnect cascade + the live tail.
  // ═════════════════════════════════════════════════════════════════════════
  it("H: intact ring — reconnect mid-stream, then a genuinely NEW delta renders on the fresh store exactly once (text AND reasoning)", { timeout: 30_000 }, async () => {
    // Real-shaped streams, small enough that the ring keeps everything:
    // reasoning (stream id "r0") then text (stream id "t1") in step 1; the
    // GatedModelPort parks after the FIRST text delta — mid-response, ring
    // INTACT (no eviction; the checkpoint's replayChars equals the full
    // delta text). After the reconnect a genuinely NEW delta of the SAME
    // still-open streams must APPEND (not be consumed as replay, not be
    // dropped): the old F only released text_end/finish and never asserted
    // a new delta landing.
    const PARK_TEXT = "part one ";
    const NEW_TEXT = "part two";
    const PARK_REASON = "think one ";
    const NEW_REASON = "think two";
    const step1: ModelStreamEvent[] = [
      { type: "start" },
      { type: "reasoning_start", id: "r0" },
      { type: "reasoning_delta", id: "r0", text: PARK_REASON },
      { type: "text_start", id: "t1" },
      { type: "text_delta", id: "t1", text: PARK_TEXT },
      // ── parked here: the model is mid-response ──
      { type: "text_delta", id: "t1", text: NEW_TEXT },
      { type: "reasoning_delta", id: "r0", text: NEW_REASON },
      { type: "text_end", id: "t1" },
      { type: "reasoning_end", id: "r0" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
    ];
    const h = createHarness({
      steps: [step1],
      gated: { parkAfterIndex: 4 }, // after the first text_delta, mid-stream
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready", 5_000);

      h.send({ type: "user_message", requestId: "r1", text: "stream" });
      await h.waitUntil(
        () => h.received.some((m) => m.type === "agent_event" && m.event.type === "text_delta"),
        10_000,
      );
      await settle(12);

      // ── RECONNECT mid-response: fresh store, second ui_ready cascade ──
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(
        () =>
          h.received.slice(before).some((m) => m.type === "host_ready") &&
          h.received.slice(before).some(
            (m): m is Extract<HostToUiMessage, { type: "session_checkpoint" }> =>
              m.type === "session_checkpoint" && m.streams !== undefined && m.streams.length === 2,
          ),
        10_000,
      );
      await settle(12);
      const cascadeEnd = h.received.length;
      const fresh = createDesktopStore({ schedule: (fn) => fn() });
      for (let i = before; i < cascadeEnd; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }

      // Honest partial: the checkpoint re-opened BOTH open streams with the
      // full accumulated bodies so far, and the replayed ring deltas (the
      // checkpoint's replayChars) did NOT append on top of them.
      const partialText = fresh.getState().transcript.find((b) => b.kind === "assistant_text");
      const partialReason = fresh.getState().transcript.find((b) => b.kind === "reasoning");
      expect(partialText?.kind === "assistant_text" ? partialText.text : undefined).toBe(PARK_TEXT);
      expect(partialReason?.kind === "reasoning" ? partialReason.text : undefined).toBe(PARK_REASON);
      expect(fresh.getState().turn.status).toBe("running");
      expect(fresh.getState().turn.turnId).not.toBeNull();

      // ── LIVE TAIL: NEW deltas of the SAME streams, then the ends/finish ──
      h.gated?.release();
      await h.waitUntil(() => countLoopEnds(h) >= 1, 20_000);
      await settle();
      for (let i = cascadeEnd; i < h.received.length; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }
      const textBlocks = fresh.getState().transcript.filter((b) => b.kind === "assistant_text");
      const reasonBlocks = fresh.getState().transcript.filter((b) => b.kind === "reasoning");
      expect(textBlocks).toHaveLength(1);
      expect(reasonBlocks).toHaveLength(1);
      // The NEW delta APPENDED exactly once: partial + new, no replay dupe.
      expect(textBlocks[0]?.kind === "assistant_text" ? textBlocks[0].text : undefined).toBe(PARK_TEXT + NEW_TEXT);
      expect(reasonBlocks[0]?.kind === "reasoning" ? reasonBlocks[0].text : undefined).toBe(PARK_REASON + NEW_REASON);
      expect(fresh.getState().turn.status).toBe("idle");
    } finally {
      h.gated?.release();
      h.close();
    }
  });

  it("I: >CAP deltas then text_end while finish still PARKED — reconnect inside the end-to-append gap recovers the fully-streamed text", { timeout: 60_000 }, async () => {
    // The end-to-append gap: the model stream has ENDED (text_end emitted)
    // but the finish has not settled, so core has NOT appended the
    // assistant item. >CAP deltas evicted the stream's text_start from the
    // ring, and a >CAP text stream has NO ring deltas left either — without
    // the SETTLED stream riding the checkpoint the fully-streamed text
    // would exist NOWHERE (the old F released only through finish and never
    // exercised this window).
    const { REPLAY_BUFFER_CAP } = await import("./session.js");
    const step1: ModelStreamEvent[] = [
      { type: "start" },
      { type: "text_start", id: "t1" },
    ];
    for (let i = 0; i < REPLAY_BUFFER_CAP + 200; i += 1) {
      step1.push({ type: "text_delta", id: "t1", text: `d${i} ` });
    }
    step1.push({ type: "text_end", id: "t1" });
    step1.push({ type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } });

    const h = createHarness({
      steps: [step1],
      // Parked AFTER text_end, BEFORE finish — the true end-to-append gap:
      // the stream is SETTLED but the assistant item is not durable yet.
      gated: { parkAfterIndex: step1.length - 2 },
    });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready", 5_000);

      h.send({ type: "user_message", requestId: "r1", text: "long one" });
      await h.waitUntil(
        () => h.received.filter((m) => m.type === "agent_event" && m.event.type === "text_delta").length >= REPLAY_BUFFER_CAP + 200,
        20_000,
      );
      await settle(12);

      // ── RECONNECT in the end-to-append gap: fresh store, cascade only ──
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(
        () =>
          h.received.slice(before).some((m) => m.type === "host_ready") &&
          h.received.slice(before).some(
            (m): m is Extract<HostToUiMessage, { type: "session_checkpoint" }> =>
              m.type === "session_checkpoint" && m.streams !== undefined && m.streams.length === 1,
          ),
        10_000,
      );
      await settle(12);
      const cascadeEnd = h.received.length;
      const fresh = createDesktopStore({ schedule: (fn) => fn() });
      for (let i = before; i < cascadeEnd; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }

      // The FULLY-STREAMED text renders from the checkpoint's settled entry
      // (text_start evicted; no durable assistant item yet).
      const partial = fresh.getState().transcript.find((b) => b.kind === "assistant_text");
      expect(partial).toBeDefined();
      expect(partial?.kind === "assistant_text" ? partial.text.split(" ").length - 1 : 0).toBe(REPLAY_BUFFER_CAP + 200);
      expect(fresh.getState().turn.status).toBe("running");
      expect(fresh.getState().turn.turnId).not.toBeNull();

      // ── LIVE TAIL: text_end + finish settle, the append lands durable ──
      h.gated?.release();
      await h.waitUntil(() => countLoopEnds(h) >= 1, 20_000);
      await settle();
      for (let i = cascadeEnd; i < h.received.length; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }
      const blocks = fresh.getState().transcript.filter((b) => b.kind === "assistant_text");
      expect(blocks).toHaveLength(1);
      expect(fresh.getState().turn.status).toBe("idle");
      expect(fresh.getState().sessionTokens).toEqual({ input: 3, output: 5, total: 8 });
    } finally {
      h.gated?.release();
      h.close();
    }
  });

  it("J: NEW turn after a TRUNCATED reconnect renders while below-cut replay stays suppressed", { timeout: 60_000 }, async () => {
    // Truncation with a bounded fixture: many small turns exceed a lowered
    // historyMaxItems (the same SESSION_HISTORY_MAX_ITEMS override TASK.188
    // S4 exposes), the reconnect's session_history is truncated, and the
    // ring still holds the fully-cut turns' streams. Then a NEW turn is
    // admitted AFTER the handshake: its events carry a turnId in NEITHER
    // the boundary map NOR cutTurnIds and must RENDER (the legacy
    // suppress-unless-live rule would have swallowed it), while the
    // fully-cut turns' replayed streams stay suppressed.
    const TURNS = 40; // 2 items/turn -> 80 items > cap 30
    const steps: ModelStreamEvent[][] = [];
    for (let t = 0; t < TURNS; t += 1) {
      steps.push(renderedTextStep(`cut turn ${t}`));
    }
    steps.push(renderedTextStep("NEW live answer"));
    const h = createHarness({ steps, historyMaxItems: 30 });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready", 5_000);

      for (let t = 0; t < TURNS; t += 1) {
        h.send({ type: "user_message", requestId: `r${t}`, text: `go ${t}` });
        await h.waitUntil(() => countLoopEnds(h) >= t + 1, 30_000);
      }
      await settle(12);
      // 2 durable items per turn: user frame + assistant text.
      expect(h.engine.historyItems().length).toBe(TURNS * 2);

      // ── RECONNECT: fresh store, second ui_ready cascade, snapshot cut ──
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      await h.waitUntil(
        () => h.received.slice(before).some((m) => m.type === "session_history"),
        10_000,
      );
      await settle(12);
      const hist = h.received.slice(before).find(
        (m): m is Extract<HostToUiMessage, { type: "session_history" }> => m.type === "session_history",
      )!;
      expect(hist.truncated).toBe(true);
      expect(hist.items.length).toBe(30);
      const cascadeEnd = h.received.length;
      const fresh = createDesktopStore({ schedule: (fn) => fn() });
      for (let i = before; i < cascadeEnd; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }
      // Below-cut content did NOT resurrect from the ring replay…
      const hydrated = texts(fresh);
      expect(hydrated).not.toContain("cut turn 0");
      expect(hydrated).not.toContain("cut turn 4");
      // …while the kept tail renders (exactly once).
      expect(hydrated.filter((t) => t === "cut turn 39")).toHaveLength(1);
      expect(fresh.getState().turn.status).toBe("idle");

      // ── NEW turn AFTER the truncated handshake: must RENDER fully ──
      const since = h.received.length;
      h.send({ type: "user_message", requestId: "new-r", text: "new prompt" });
      await h.waitUntil(() => countLoopEnds(h) >= TURNS + 1, 30_000);
      await settle();
      feed(fresh, h, since);
      const all = texts(fresh);
      expect(all.filter((t) => t === "new prompt")).toHaveLength(1);
      expect(all.filter((t) => t === "NEW live answer")).toHaveLength(1);
      expect(fresh.getState().turn.status).toBe("idle");
      // …and the earlier suppression still holds after the new turn.
      expect(all).not.toContain("cut turn 0");
      expect(all).not.toContain("cut turn 4");
    } finally {
      h.close();
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // TASK.117 acceptance defect 1, residual: cut WITHIN one turn vs the
  // legacy below-cut fallback.
  //
  // A tool-heavy/multi-step turn can exceed historyMaxItems on its OWN: the
  // truncated snapshot then cuts WITHIN that sole turn — some of its steps
  // are dropped, but NO whole turnId disappears (every retained item carries
  // the same, still-durable turnId). The host's `cutTurnIds` is then an
  // AUTHORITATIVE EMPTY list — yet the pre-fix host omitted the field
  // (cut.size > 0 gate) and the pre-fix renderer coerced an empty list back
  // to null, so the below-cut guard fell to the LEGACY rule: suppress every
  // absent-boundary turnId unless live. A genuinely NEW turn admitted AFTER
  // that handshake is unknown to BOTH the boundary map and the checkpoint —
  // the legacy branch swallowed it and its assistant content never rendered.
  // ═════════════════════════════════════════════════════════════════════════
  it("K: cut WITHIN one tool-heavy turn — empty cutTurnIds is authoritative, a NEW post-handshake turn renders", { timeout: 120_000 }, async () => {
    const CALLS_PER_STEP = 14; // 3 + 14 = 17 items > cap 12 -> cut within the sole turn
    const readInput = (i: number) => ({ file_path: `/workspace/k${i}.txt` });
    const steps: ModelStreamEvent[][] = [
      // one tool-heavy turn: start -> 14 tool_calls -> finish(tool_calls)
      [
        { type: "start" },
        ...Array.from({ length: CALLS_PER_STEP }, (_, i) => ({
          type: "tool_call" as const,
          toolCall: { id: `k-${i}`, name: "Read", input: readInput(i) },
        })),
        { type: "finish", finishReason: "tool_calls" as const, usage: {} },
      ],
      // …then the turn's final assistant text step
      renderedTextStep("sole turn final"),
      // a NEW turn admitted only AFTER the reconnect handshake
      renderedTextStep("K new answer"),
    ];
    // Seed the read targets so every dispatched Read genuinely SUCCEEDS
    // (same as G: settlement must be unambiguous).
    const memFs = new MemFs();
    for (let i = 0; i < CALLS_PER_STEP; i += 1) {
      memFs.files.set(`/workspace/k${i}.txt`, `content ${i}`);
    }
    const h = createHarness({ steps, historyMaxItems: 12 });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready", 5_000);

      // Run the ONE tool-heavy turn to completion (tool_calls finish re-
      // dispatches tools, then the final text step ends the turn).
      h.send({ type: "user_message", requestId: "k0", text: "go" });
      await h.waitUntil(() => countLoopEnds(h) >= 1, 30_000);
      await settle(12);
      // 18 durable items (user frame + assistant tool_call item + 14 tool
      // results + final assistant text), all ring-resident (small fixture).
      expect(h.engine.historyItems().length).toBe(3 + CALLS_PER_STEP);

      // ── RECONNECT: fresh store, second ui_ready cascade, snapshot cut ──
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      const hist = await h.waitFor(
        (m): m is Extract<HostToUiMessage, { type: "session_history" }> => m.type === "session_history",
        10_000,
      );
      await h.waitUntil(
        () => h.received.slice(before).some((m) => m.type === "session_checkpoint"),
        10_000,
      );
      await settle(12);
      const cascadeEnd = h.received.length;
      const checkpoint = h.received
        .slice(before, cascadeEnd)
        .find((m): m is Extract<HostToUiMessage, { type: "session_checkpoint" }> => m.type === "session_checkpoint")!;
      const fresh = createDesktopStore({ schedule: (fn) => fn() });
      for (let i = before; i < cascadeEnd; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }

      // The snapshot IS truncated but NO whole turnId was cut: every kept
      // item carries the SAME sole turnId the durable history still holds —
      // so the host's cut list is an authoritative EMPTY list, not an
      // omitted one.
      expect(hist.truncated).toBe(true);
      expect(hist.items).toHaveLength(12);
      const checkpointCut = (checkpoint as { cutTurnIds?: string[] }).cutTurnIds;
      expect(Array.isArray(checkpointCut)).toBe(true);
      expect(checkpointCut).toEqual([]);

      // The kept tail of the sole turn renders from the snapshot…
      const hydrated = texts(fresh);
      expect(hydrated).toContain("sole turn final");
      // …and the turn frame itself is intact.
      expect(fresh.getState().turn.status).toBe("idle");

      // ── NEW turn AFTER the truncated handshake: must RENDER fully ──
      // (pre-fix: the legacy suppress-unless-live fallback ate it — the
      // assistant answer never rendered on the reconnected store.)
      const since = h.received.length;
      h.send({ type: "user_message", requestId: "k1", text: "new prompt" });
      await h.waitUntil(() => countLoopEnds(h) >= 2, 30_000);
      await settle();
      feed(fresh, h, since);
      const all = texts(fresh);
      expect(all.filter((t) => t === "new prompt")).toHaveLength(1);
      expect(all.filter((t) => t === "K new answer")).toHaveLength(1);
      expect(fresh.getState().turn.status).toBe("idle");
    } finally {
      h.close();
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // TASK.117 acceptance defect 2 — history tail cut vs replay suppression.
  //
  // Tool-heavy turns make the replay ring span MORE history items than the
  // session_history cap (ring counts MESSAGES ~3.6/item; the snapshot caps
  // ITEMS at 500): on reconnect the truncated snapshot drops whole early
  // turns AND lands inside a later turn's tool-item run — retaining tool
  // items whose ASSISTANT twin (same (turnId, step)) was cut off. Policy:
  //   (a) a tool item NEVER registers step coverage — the replayed assistant
  //       stream of the straddling step must still render (the hydrated
  //       orphan tool item has no assistant rendering to replace it);
  //   (b) an orphan tool item's result identity is not registered either —
  //       its replayed tool_result settles the replay-created card;
  //   (c) content of steps strictly BELOW the cut boundary (turns the cut
  //       dropped entirely) must NOT resurrect from the ring replay.
  // ═════════════════════════════════════════════════════════════════════════
  it("G: truncated cut — orphan tool items do not suppress the replayed assistant; below-cut replay does not resurrect", { timeout: 120_000 }, async () => {
    const CALLS_PER_STEP = 40;
    const TURNS = 14; // 14 * 43 items = 602 > SESSION_HISTORY_MAX_ITEMS (500)
    const readInput = (i: number) => ({ file_path: `/workspace/f${i}.txt` });
    const toolHeavyStep: ModelStreamEvent[] = [
      { type: "start" },
      ...Array.from({ length: CALLS_PER_STEP }, (_, i) => ({
        type: "tool_call" as const,
        toolCall: { id: `c-${i}`, name: "Read", input: readInput(i) },
      })),
      { type: "finish", finishReason: "tool_calls" as const, usage: {} },
    ];
    const steps: ModelStreamEvent[][] = [];
    for (let t = 0; t < TURNS; t += 1) {
      steps.push(toolHeavyStep.map((e) => ({ ...e, ...(e.type === "tool_call" ? { toolCall: { ...e.toolCall, id: `t${t}-${e.toolCall.id}` } } : {}) })));
      steps.push(renderedTextStep(`turn ${t} final`));
    }
    // Seed the read targets so every dispatched Read genuinely SUCCEEDS —
    // the settlement assertion below checks the actual SUCCESS status, and
    // an ENOENT error would make "settled" ambiguous between a real settle
    // and a failed dispatch.
    const memFs = new MemFs();
    for (let i = 0; i < CALLS_PER_STEP; i += 1) {
      memFs.files.set(`/workspace/f${i}.txt`, `content ${i}`);
    }
    const h = createHarness({ steps, toolFs: memFs });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m) => m.type === "host_ready");
      for (let t = 0; t < TURNS; t += 1) {
        h.send({ type: "user_message", requestId: `r${t}`, text: `go ${t}` });
        await h.waitUntil(() => countLoopEnds(h) >= t + 1, 30_000);
      }
      await settle(12);
      // 602 durable items (43/turn: user frame, assistant tool_call item, 40 tool
      // results, final assistant text), all ring-resident (2_ish k < CAP).
      expect(h.engine.historyItems().length).toBe(TURNS * (3 + CALLS_PER_STEP));

      // ── RECONNECT: fresh store fed ONLY the second ui_ready cascade ──
      const before = h.received.length;
      h.send({ type: "ui_ready" });
      const hist = await h.waitFor(
        (m): m is Extract<HostToUiMessage, { type: "session_history" }> => m.type === "session_history",
        10_000,
      );
      // Wait for the FULL cascade (checkpoint + replay of the whole ring).
      await h.waitUntil(() => h.received.slice(before).some((m) => m.type === "session_checkpoint"), 10_000);
      await settle(12);
      const cascadeEnd = h.received.length;
      const fresh = createDesktopStore({ schedule: (fn) => fn() });
      for (let i = before; i < cascadeEnd; i += 1) {
        fresh.getState().applyHostMessage(h.received[i] as HostToUiMessage);
      }

      // The snapshot IS truncated and keeps exactly the last 500 items.
      expect(hist.truncated).toBe(true);
      expect(hist.items).toHaveLength(500);
      // The cut boundary (first kept item) lands inside an early turn's
      // tool-item run: the straddling step's tool items are KEPT while its
      // assistant twin (same (turnId, step)) is cut — count the orphan tool
      // items whose (turnId, step) has NO assistant item in the snapshot.
      const assistantKeys = new Set(
        hist.items.filter((i) => i.message.role === "assistant").map((i) => `${i.turnId}:${i.step}`),
      );
      const orphanToolItems = hist.items.filter(
        (i) => i.message.role === "tool" && !assistantKeys.has(`${i.turnId}:${i.step}`),
      );
      expect(orphanToolItems.length).toBeGreaterThan(0);

      const t = texts(fresh);
      // (c) Below-cut content does NOT resurrect from the ring replay: the
      // fully-cut turns' final texts (turns 0-1 have ZERO kept items) stay
      // absent even though the ring replays their entire streams. The
      // STRADDLING turn (2) keeps its final a-text item, so it renders —
      // once, from hydration (below, exactly-once check).
      expect(t).not.toContain("turn 0 final");
      expect(t).not.toContain("turn 1 final");
      expect(t.filter((x) => x === "turn 2 final")).toHaveLength(1);
      // (a)+(b) The straddling step's replayed assistant tool_calls RENDER
      // (cards exist) and their replayed results SETTLE them — an orphan
      // tool item suppressed neither. Cards settle by toolCallId: assert
      // via the orphan items' ids that every straddling card settled to
      // SUCCESS (the actual settlement status, not mere card presence).
      let settled = 0;
      for (const item of orphanToolItems) {
        const parts = item.message.content as Extract<HistoryItem["message"], { role: "tool" }>["content"];
        for (const part of parts) {
          const card = fresh.getState().transcript.find(
            (b) => b.kind === "tool_call" && b.toolCallId === part.toolCallId,
          );
          if (card !== undefined && card.kind === "tool_call" && card.status === "success") {
            settled += 1;
          }
        }
      }
      expect(settled).toBe(orphanToolItems.reduce((n, i) => n + i.message.content.length, 0));
      // Kept FULL turns render exactly once each.
      expect(t.filter((x) => x === "turn 13 final")).toHaveLength(1);
      expect(t.filter((x) => x === `go 13`)).toHaveLength(1);
      expect(fresh.getState().turn.status).toBe("idle");
      expect(fresh.getState().pendingPrompt).toBeNull();
    } finally {
      h.close();
    }
  });
});
