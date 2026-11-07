import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { CORE_ENGINE_CAPABILITIES } from "./engines/session-engine.js";
import type { SessionEngine } from "./engines/session-engine.js";
import type { AgentEnvelope } from "../shared/communication.js";
import type { UiToHostMessage } from "../shared/protocol.js";
import { createDesktopStore } from "../renderer/src/store.js";
import { createTabRegistry } from "../renderer/src/tab-registry.js";
import { createTabsStore } from "../renderer/src/tabs-store.js";
import { createHarness, nodeWirePort } from "./test-harness.js";

type Reason = "completed" | "cancelled" | "error" | "max_turns";

async function rig(id: "core" | "codex" | "claude", registered = false) {
  const inputs: string[] = [];
  const finishes: Array<(reason?: Reason) => void> = [];
  const tails: Array<() => void> = [];
  let holdTail = false;
  const engine: SessionEngine = {
    id, capabilities: CORE_ENGINE_CAPABILITIES, mode: () => "build",
    reasoningEffort: () => undefined, setReasoningEffort: () => {},
    historyItems: () => [], dispose: async () => {},
    async *runTurn(input, options) {
      inputs.push(input);
      yield { type: "turn_start", turn: inputs.length };
      const reason = await new Promise<Reason>(resolve => {
        const finish = (reason: Reason = "completed") => resolve(reason);
        finishes.push(finish);
        options.signal.addEventListener("abort", () => finish("cancelled"), { once: true });
      });
      yield { type: "loop_end", reason, turns: 1 };
      if (holdTail) await new Promise<void>(resolve => tails.push(resolve));
    },
  };
  const h = createHarness({ steps: [], engine });
  h.session.configurePeerDrain({
    request: async messageId => ({ type: "session_peer_drain_permit", messageId, nonce: "permit", recipientSessionId: h.session.communicationStatus().sessionId, generation: 1 }),
    consume: () => true, discard: () => true,
  });
  const registry = createTabRegistry(createTabsStore(), () => createDesktopStore({ schedule: fn => fn() }));
  const channel = new MessageChannel();
  const frames: Extract<UiToHostMessage, { type: "user_message" }>[] = [];
  const delayed: Array<() => void> = [];
  let delay = true;
  const wire = nodeWirePort(channel.port2);
  h.session.bindPort({ ...wire, onMessage: cb => wire.onMessage(raw => {
    const message = raw as UiToHostMessage;
    if (message.type === "user_message") {
      frames.push(message);
      if (delay) { delayed.push(() => cb(message)); return; }
    }
    cb(message);
  }) });
  registry.registerPort("queue", "/work", channel.port1 as never);
  const store = registry.getStore("queue")!;
  await vi.waitFor(() => expect(store.getState().connection).toBe("ready"));
  const sendAgent = (messageId: string) => h.session.receiveAgentMessage({
    messageId, sender: "supervisor", recipientSessionId: h.session.communicationStatus().sessionId,
    payload: messageId, mode: "next_turn", kind: "agent_message", createdAt: new Date().toISOString(),
  } satisfies AgentEnvelope, registered);
  return { h, store, inputs, finishes, frames, tails, sendAgent,
    holdTail: () => { holdTail = true; },
    release: () => { delay = false; for (const deliver of delayed.splice(0)) deliver(); },
    close: async () => {
      holdTail = false;
      for (const finish of finishes) finish();
      for (const release of tails) release();
      await h.session.shutdown(); registry.disposeTab("queue");
      channel.port1.close(); channel.port2.close(); h.close();
    },
  };
}

describe.each(["codex", "claude", "core"] as const)("%s composer queue admission", engine => {
  it.each([false, true])("sends once when Sessions API next_turn wins the completed seam (registered=%s)", async registered => {
    const r = await rig(engine, registered);
    try {
      await r.sendAgent("initial");
      await vi.waitFor(() => expect(r.store.getState().turn.status).toBe("running"));
      const oldTurn = r.store.getState().turn.turnId!;
      r.store.getState().enqueuePrompt({ text: "owner message", images: [] });
      await r.sendAgent("competing next_turn");
      r.finishes.shift()!();
      await vi.waitFor(() => expect(r.inputs).toHaveLength(2));
      await vi.waitFor(() => expect(r.frames).toHaveLength(1));
      r.release();
      await r.h.flush();
      expect(r.store.getState().promptQueue).toEqual([]);
      expect(r.store.getState().queuePaused).toBe(false);
      expect(r.store.getState().queueInFlight?.requestId).toBe(r.frames[0]!.requestId);
      r.finishes.shift()!();
      await vi.waitFor(() => expect(r.inputs).toHaveLength(3));
      await vi.waitFor(() => expect(r.store.getState().turn.requestId).toBe(r.frames[0]!.requestId));
      expect(r.store.getState().queueInFlight).toBeNull();
      // A stale rejection/terminal event and Resume cannot revive the dispatched item.
      r.h.outbound.sendDirect({ type: "turn_rejected", requestId: r.frames[0]!.requestId, reason: "busy" });
      r.h.outbound.sendDirect({ type: "agent_event", turnId: oldTurn, event: { type: "loop_end", reason: "cancelled", turns: 1 } });
      r.store.getState().resumeQueue();
      r.finishes.shift()!();
      await vi.waitFor(() => expect(r.store.getState().turn.status).toBe("idle"));
      expect(r.frames).toHaveLength(1);
      expect(r.inputs.filter(input => input === "owner message")).toHaveLength(1);
      expect(r.store.getState().transcript.filter(block => block.kind === "user_text" && block.text === "owner message")).toHaveLength(1);
      expect(r.store.getState().queuePaused).toBe(false);
    } finally { await r.close(); }
  });

  it("holds a dispatched item through the engine's post-completed tail", async () => {
    const r = await rig(engine);
    try {
      await r.sendAgent("initial");
      await vi.waitFor(() => expect(r.store.getState().turn.status).toBe("running"));
      r.holdTail();
      r.store.getState().enqueuePrompt({ text: "after tail", images: [] });
      r.finishes.shift()!();
      await vi.waitFor(() => expect(r.tails).toHaveLength(1));
      await vi.waitFor(() => expect(r.frames).toHaveLength(1));
      r.release(); await r.h.flush();
      expect(r.store.getState().promptQueue).toEqual([]);
      expect(r.store.getState().queuePaused).toBe(false);
      r.tails.shift()!();
      await vi.waitFor(() => expect(r.inputs).toHaveLength(2));
      expect(r.inputs[1]).toBe("after tail");
    } finally { await r.close(); }
  });

  it.each(["cancelled", "error", "max_turns"] as const)("returns an unstarted dispatch only after a real %s", async reason => {
    const r = await rig(engine);
    try {
      await r.sendAgent("initial");
      await vi.waitFor(() => expect(r.store.getState().turn.status).toBe("running"));
      r.store.getState().enqueuePrompt({ text: "held by anomaly", images: [] });
      await r.sendAgent("competing next_turn");
      r.finishes.shift()!();
      await vi.waitFor(() => expect(r.inputs).toHaveLength(2));
      await vi.waitFor(() => expect(r.frames).toHaveLength(1));
      r.release(); await r.h.flush();
      if (reason === "cancelled") r.h.session.communicationCancelTurn();
      else r.finishes.shift()!(reason);
      await vi.waitFor(() => expect(r.store.getState().queuePaused).toBe(true));
      expect(r.store.getState().promptQueue.map(item => item.text)).toEqual(["held by anomaly"]);
      expect(r.store.getState().queueInFlight).toBeNull();
      expect(r.store.getState().queuePauseReason).toBe(reason);
      expect(r.store.getState().transcript.some(block => block.kind === "user_text" && block.text === "held by anomaly")).toBe(false);
      expect(r.inputs).toHaveLength(2);
    } finally { await r.close(); }
  });
});
