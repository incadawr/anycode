import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import type { HostToUiMessage } from "../../shared/protocol.js";
import { createTabRegistry } from "./tab-registry.js";
import { createTabsStore } from "./tabs-store.js";

const ready: HostToUiMessage = { type: "host_ready", workspace: "/synthetic", sessionId: "session", mode: "build", model: "model" };
const image = () => ({ name: "synthetic.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } });

describe("unknown delivery over real MessageChannel", () => {
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
