import { describe, expect, it } from "vitest";
import type { ModelStreamEvent } from "@anycode/core";
import type { HostToUiMessage, UiToHostMessage } from "../../shared/protocol.js";
import { createDesktopStore } from "./store.js";
import { createTabRegistry } from "./tab-registry.js";
import { createTabsStore } from "./tabs-store.js";
import { createHarness, toolStep, type Harness } from "../../host/test-harness.js";

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
function texts(store: ReturnType<typeof createDesktopStore>): (string | null)[] {
  return store.getState().transcript.map((block) => block.kind === "user_text" || block.kind === "assistant_text" ? block.text : null);
}
function countLoopEnds(h: Harness): number {
  return h.received.filter((m) => m.type === "agent_event" && m.event.type === "loop_end").length;
}
function renderedTextStep(text: string): ModelStreamEvent[] {
  return [{ type: "start" }, { type: "text_start", id: "t1" }, { type: "text_delta", id: "t1", text }, { type: "text_end", id: "t1" }, { type: "finish", finishReason: "stop", usage: {} }];
}

describe("rendered reconnect (Session -> fresh desktopStore)", () => {
  it("restores a mid-stream steer once after the turn finishes", async () => {
    const h = createHarness({
      steps: [toolStep("first-tool", "Write", { file_path: "/workspace/first.txt", content: "ok" }), [{ type: "start" }, { type: "text_start", id: "held" }, { type: "text_delta", id: "held", text: "waiting" }, { type: "tool_call", toolCall: { id: "steer-tool", name: "Write", input: { file_path: "/workspace/steer.txt", content: "ok" } } }, { type: "finish", finishReason: "tool_calls", usage: {} }], renderedTextStep("finished")],
      gated: { parkAfterIndex: 3 },
      mode: "yolo",
    });
    let offset = 0;
    let listener: ((event: MessageEvent<HostToUiMessage>) => void) | null = null;
    const port = {
      get onmessage() { return listener; },
      set onmessage(value: typeof listener) { listener = value; },
      postMessage(message: UiToHostMessage) { h.send(message); },
    } as unknown as MessagePort;
    const makeRegistry = () => createTabRegistry(createTabsStore(), () => createDesktopStore({ schedule: (fn) => fn() }));
    let tabs = makeRegistry();
    const pump = setInterval(() => {
      while (offset < h.received.length) listener?.({ data: h.received[offset++] } as MessageEvent<HostToUiMessage>);
    }, 0);
    const waitStore = async (predicate: () => boolean) => {
      for (let i = 0; i < 500 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
      expect(predicate()).toBe(true);
    };
    try {
      tabs.registerPort("tab", "/workspace", port);
      await waitStore(() => tabs.getStore("tab")?.getState().connection === "ready");
      let store = tabs.getStore("tab")!;
      store.getState().appendUserText("prompt", "start");
      h.send({ type: "user_message", requestId: "prompt", text: "start" });
      await h.waitUntil(() => h.received.some((m) => m.type === "agent_event" && m.event.type === "tool_call" && m.event.toolCall.id === "steer-tool"));
      await waitStore(() => store.getState().turn.status === "running");
      store.getState().recordPendingSteer("steer", "change direction", undefined, { text: "change direction", images: [] });
      store.getState().markUiSteer("steer");
      h.send({ type: "steer_message", requestId: "steer", text: "change direction" });
      await settle();
      h.gated!.release();
      await h.waitUntil(() => countLoopEnds(h) >= 1);
      await waitStore(() => texts(store).filter((text) => text === "change direction").length === 1);
      expect(h.engine.historyItems().filter((item) => item.message.role === "user" && item.message.content === "change direction")).toHaveLength(1);
      expect(h.gated!.requests.at(-1)!.messages.filter((message) => message.role === "user" && message.content === "change direction")).toHaveLength(1);
      tabs.disposeTab("tab");
      tabs = makeRegistry();
      const before = h.received.length;
      tabs.registerPort("tab", "/workspace", port);
      store = tabs.getStore("tab")!;
      await h.waitUntil(() => h.received.slice(before).some((m) => m.type === "presentation_replay_end"));
      await settle(15);
      const snapshot = h.received.slice(before).find((m) => m.type === "presentation_snapshot");
      expect(snapshot?.type === "presentation_snapshot" && snapshot.turns[0]?.events.flatMap((entry) => entry.event.type === "user_injected" ? [entry.event.step] : [])).toEqual([2]);
      expect(texts(store).filter((text) => text === "change direction")).toHaveLength(1);
      expect(store.getState().promptQueue).toHaveLength(0);
      expect(h.engine.historyItems().filter((item) => item.message.role === "user" && item.message.content === "change direction")).toHaveLength(1);
      expect(h.gated!.requests).toHaveLength(3);
    } finally {
      clearInterval(pump);
      tabs.disposeTab("tab");
      h.gated?.release();
      h.close();
    }
  });

  for (const historyMaxItems of [500, 2]) {
    it(`delivers a refused steer once after reconnect with journal limit ${historyMaxItems}`, async () => {
      const h = createHarness({ steps: [renderedTextStep("first answer"), renderedTextStep("next answer"), renderedTextStep("later answer")], gated: { parkAfterIndex: 2 }, historyMaxItems });
      let offset = 0;
      const sent: UiToHostMessage[] = [];
      let listener: ((event: MessageEvent<HostToUiMessage>) => void) | null = null;
      const port = {
        get onmessage() { return listener; },
        set onmessage(value: typeof listener) { listener = value; },
        postMessage(message: UiToHostMessage) { sent.push(message); h.send(message); },
      } as unknown as MessagePort;
      const registry = () => createTabRegistry(createTabsStore(), () => createDesktopStore({ schedule: (fn) => fn() }));
      let tabs = registry();
      const waitStore = async (predicate: () => boolean) => {
        for (let i = 0; i < 500 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
        expect(predicate()).toBe(true);
      };
      const pump = setInterval(() => {
        while (offset < h.received.length) listener?.({ data: h.received[offset++] } as MessageEvent<HostToUiMessage>);
      }, 0);
      try {
        tabs.registerPort("tab", "/workspace", port);
        await waitStore(() => tabs.getStore("tab")?.getState().connection === "ready");
        let store = tabs.getStore("tab")!;
        store.getState().appendUserText("first", "first");
        h.send({ type: "user_message", requestId: "first", text: "first" });
        await h.waitUntil(() => h.received.some((m) => m.type === "agent_event" && m.event.type === "text_delta"));
        await waitStore(() => store.getState().turn.status === "running");
        store.getState().recordPendingSteer("refused", "same words", undefined, { text: "same words", images: [] });
        store.getState().markUiSteer("refused");
        h.send({ type: "steer_message", requestId: "refused", text: "same words" });
        await settle();
        h.gated!.release();
        await h.waitUntil(() => countLoopEnds(h) >= 2, 5000);
        await waitStore(() => texts(store).filter((text) => text === "same words").length === 1);
        expect(h.received.some((m) => m.type === "steer_requeued" && m.requestId === "refused")).toBe(true);
        expect(sent.filter((m) => m.type === "user_message" && m.text === "same words")).toHaveLength(1);
        expect(h.engine.historyItems().filter((item) => item.message.role === "user" && item.message.content === "same words")).toHaveLength(1);
        expect(h.gated!.requests).toHaveLength(2);
        expect(h.gated!.requests[1]!.messages.filter((message) => message.role === "user" && message.content === "same words")).toHaveLength(1);
        if (historyMaxItems === 2) {
          store.getState().appendUserText("later", "later");
          h.send({ type: "user_message", requestId: "later", text: "later" });
          await h.waitUntil(() => countLoopEnds(h) >= 3);
          await settle();
        }
        expect(h.outbound.ringView().some((message) => message.type === "steer_requeued" && message.requestId === "refused")).toBe(true);
        tabs.disposeTab("tab");
        tabs = registry();
        const replayStart = h.received.length;
        tabs.registerPort("tab", "/workspace", port);
        store = tabs.getStore("tab")!;
        await h.waitUntil(() => h.received.slice(replayStart).some((m) => m.type === "presentation_replay_end"));
        await settle(15);
        if (historyMaxItems === 500) expect(texts(store).filter((text) => text === "same words")).toHaveLength(1);
        else {
          const snapshot = h.received.slice(replayStart).find((m) => m.type === "presentation_snapshot");
          expect(snapshot?.type === "presentation_snapshot" && snapshot.turns.some((turn) => turn.requestId === "refused")).toBe(false);
        }
        expect(store.getState().promptQueue).toHaveLength(0);
        expect(h.gated!.requests).toHaveLength(historyMaxItems === 500 ? 2 : 3);
        expect(sent.filter((m) => m.type === "user_message" && m.text === "same words")).toHaveLength(1);
        expect(h.engine.historyItems().filter((item) => item.message.role === "user" && item.message.content === "same words")).toHaveLength(1);
      } finally {
        clearInterval(pump);
        tabs.disposeTab("tab");
        h.gated?.release();
        h.close();
      }
    });
  }

});
