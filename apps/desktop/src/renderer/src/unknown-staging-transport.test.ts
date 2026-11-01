import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import type { HostToUiMessage } from "../../shared/protocol.js";
import { createTabRegistry } from "./tab-registry.js";
import { createTabsStore } from "./tabs-store.js";
import { COMPLETED_DIRECT_CORRELATION_LIMIT } from "./store.js";

const ready: HostToUiMessage = { type: "host_ready", workspace: "/synthetic", sessionId: "session", mode: "build", model: "model" };
const image = () => ({ name: "synthetic.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } });

describe("unknown delivery over real MessageChannel", () => {
  it("retains an explicitly rejected child steer once, including its attachment", async () => {
    const registry = createTabRegistry(createTabsStore());
    const channel = new MessageChannel();
    const received: unknown[] = [];
    channel.port2.on("message", message => received.push(message));
    try {
      registry.registerPort("tab", "/synthetic", channel.port1 as unknown as MessagePort);
      channel.port2.postMessage(ready);
      await vi.waitFor(() => expect(registry.getStore("tab")?.getState().connection).toBe("ready"));
      const store = registry.getStore("tab")!;
      const saved = image();
      store.getState().recordPendingSteer("steer", "child message", [saved.attachment], { text: "child message", images: [saved] });
      registry.sendToTab("tab", { type: "user_message", requestId: "steer", text: "child message", images: [saved.attachment] });
      channel.port2.postMessage({ type: "turn_rejected", requestId: "steer", reason: "unsupported_images" });
      channel.port2.postMessage({ type: "turn_rejected", requestId: "steer", reason: "unsupported_images" });
      await vi.waitFor(() => expect(store.getState().orchestrationDeliveries).toMatchObject([{ requestId: "steer", text: "child message", images: [saved], status: "rejected" }]));
      expect(store.getState().pendingSteers).toEqual([]);
      expect(store.getState().promptQueue).toEqual([]);
      expect(received.filter((message: any) => message.type === "user_message")).toHaveLength(1);
    } finally { registry.disposeTab("tab"); channel.port1.close(); channel.port2.close(); }
  });

  it("bounds completed direct payloads while retaining active, rejected and unknown payloads and recent conflict IDs", async () => {
    const registry = createTabRegistry(createTabsStore());
    const channel = new MessageChannel();
    try {
      registry.registerPort("tab", "/synthetic", channel.port1 as unknown as MessagePort);
      channel.port2.postMessage(ready);
      await vi.waitFor(() => expect(registry.getStore("tab")?.getState().connection).toBe("ready"));
      const store = registry.getStore("tab")!;
      const saved = image();
      store.getState().recordSentMessage("unknown", [saved], "unknown", undefined, undefined, undefined, undefined, true);
      store.getState().markOrchestrationDeliveryUnknown("unknown");
      store.getState().recordSentMessage("rejected", [saved], "rejected", undefined, undefined, undefined, undefined, true);
      channel.port2.postMessage({ type: "turn_rejected", requestId: "rejected", reason: "busy" });
      for (let i = 0; i < COMPLETED_DIRECT_CORRELATION_LIMIT + 20; i++) {
        const id = `done-${i}`;
        store.getState().recordSentMessage(`payload-${i}`, [saved], id, undefined, undefined, undefined, undefined, true);
        channel.port2.postMessage({ type: "turn_started", requestId: id, turnId: id });
        channel.port2.postMessage({ type: "agent_event", turnId: id, event: { type: "loop_end", reason: "completed", turns: 1 } });
      }
      const last = `done-${COMPLETED_DIRECT_CORRELATION_LIMIT + 19}`;
      await vi.waitFor(() => expect(store.getState().orchestrationDeliveries.find(item => item.requestId === last)?.payloadOmitted).toBe(true));
      channel.port2.postMessage({ type: "turn_started", requestId: "unknown", turnId: "late-unknown" });
      channel.port2.postMessage({ type: "agent_event", turnId: "late-unknown", event: { type: "loop_end", reason: "completed", turns: 1 } });
      await vi.waitFor(() => expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "unknown")?.turnId).toBe("late-unknown"));
      store.getState().recordSentMessage("active", [saved], "active", undefined, undefined, undefined, undefined, true);
      channel.port2.postMessage({ type: "turn_started", requestId: "active", turnId: "active-turn" });
      await vi.waitFor(() => expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "active")?.status).toBe("started"));
      const deliveries = store.getState().orchestrationDeliveries;
      expect(deliveries.filter(item => item.payloadOmitted)).toHaveLength(COMPLETED_DIRECT_CORRELATION_LIMIT);
      expect(deliveries.find(item => item.requestId === "done-0")).toBeUndefined();
      expect(deliveries.find(item => item.requestId === "unknown")).toMatchObject({ status: "started", preservePayload: true, text: "unknown", images: [saved] });
      expect(deliveries.find(item => item.requestId === "rejected")).toMatchObject({ status: "rejected", text: "rejected", images: [saved] });
      expect(deliveries.find(item => item.requestId === "active")).toMatchObject({ status: "started", text: "active", images: [saved] });
      channel.port2.postMessage({ type: "turn_rejected", requestId: last, reason: "busy" });
      await vi.waitFor(() => expect(store.getState().orchestrationDeliveries.find(item => item.requestId === last)).toMatchObject({ status: "conflict", payloadOmitted: true, text: "", images: [] }));
    } finally { registry.disposeTab("tab"); channel.port1.close(); channel.port2.close(); }
  });
  it.each(["direct", "child-steer"] as const)("retains immutable %s payload after close and does not resend on reconnect", async (kind) => {
    const registry = createTabRegistry(createTabsStore());
    const first = new MessageChannel();
    const second = new MessageChannel();
    const received: unknown[] = [];
    first.port2.on("message", message => received.push(message));
    const nextReceived: unknown[] = [];
    second.port2.on("message", message => nextReceived.push(message));
    try {
      registry.registerPort("tab", "/synthetic", first.port1 as unknown as MessagePort);
      first.port2.postMessage(ready);
      await vi.waitFor(() => expect(registry.getStore("tab")?.getState().connection).toBe("ready"));
      const store = registry.getStore("tab")!;
      const saved = image();
      if (kind === "direct") store.getState().recordSentMessage("original", [saved], "attempt", undefined, undefined, undefined, undefined, true);
      else store.getState().recordPendingSteer("attempt", "original", [saved.attachment], { text: "original", images: [saved] });
      registry.sendToTab("tab", { type: "user_message", requestId: "attempt", text: "original", images: [saved.attachment] });
      await vi.waitFor(() => expect(received.some((message: any) => message.type === "user_message" && message.requestId === "attempt")).toBe(true));
      saved.attachment.data = "Yg==";
      first.port2.close();
      await vi.waitFor(() => expect(store.getState().connection).toBe("awaiting_port"));
      expect(store.getState().orchestrationDeliveries).toMatchObject([{ requestId: "attempt", text: "original", images: [image()], status: "unknown" }]);
      registry.registerPort("tab", "/synthetic", second.port1 as unknown as MessagePort);
      second.port2.postMessage(ready);
      if (kind === "child-steer") second.port2.postMessage({ type: "steer_requeued", requestId: "attempt", reason: "replay", text: "original" });
      await vi.waitFor(() => expect(store.getState().connection).toBe("ready"));
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(store.getState().orchestrationDeliveries).toMatchObject([{ requestId: "attempt", images: [image()], status: "unknown" }]);
      expect(store.getState().promptQueue).toEqual([]);
      expect(nextReceived.filter((message: any) => message.type === "user_message" || message.type === "steer_message")).toEqual([]);
      if (kind === "child-steer") {
        second.port2.postMessage({ type: "turn_started", requestId: "attempt", turnId: "late-turn" });
        second.port2.postMessage({ type: "steer_requeued", requestId: "attempt", reason: "late replay", text: "original" });
        await vi.waitFor(() => expect(store.getState().orchestrationDeliveries[0]?.status).toBe("started"));
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(store.getState().promptQueue).toEqual([]);
        expect(nextReceived.filter((message: any) => message.type === "user_message" || message.type === "steer_message")).toEqual([]);
      }
    } finally {
      registry.disposeTab("tab");
      first.port1.close(); first.port2.close(); second.port1.close(); second.port2.close();
    }
  });
});
