import { MessageChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import type { HostToUiMessage } from "../../shared/protocol.js";
import { createTabRegistry } from "./tab-registry.js";
import { createTabsStore } from "./tabs-store.js";
import { COMPLETED_DIRECT_CORRELATION_LIMIT, createDesktopStore } from "./store.js";

const ready: HostToUiMessage = { type: "host_ready", workspace: "/synthetic", sessionId: "session", mode: "build", model: "model" };
const image = () => ({ name: "synthetic.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } });

describe("unknown delivery over real MessageChannel", () => {
  it.each(["unknown", "rejected"] as const)("keeps request B and terminal attribution when %s A reports B's turn ID", (status) => {
    const store = createDesktopStore({ schedule: () => {} });
    const saved = image();
    store.getState().applyHostMessage(ready);
    store.getState().recordSentMessage("A", [saved], "A", undefined, undefined, undefined, undefined, true);
    if (status === "unknown") store.getState().markOrchestrationDeliveryUnknown("A");
    else store.getState().applyHostMessage({ type: "turn_rejected", requestId: "A", reason: "busy" });
    store.getState().recordSentMessage("B", [], "B", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "B", turnId: "shared" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "shared" });
    expect(store.getState().turn).toMatchObject({ status: "running", requestId: "B", turnId: "shared" });
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "A")).toMatchObject({ status: "conflict", turnId: "shared", images: [saved] });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "shared", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(store.getState().turn.status).toBe("idle");
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "A")).toMatchObject({ status: "conflict", images: [saved] });
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "A")?.terminalReason).toBeUndefined();
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "B")).toMatchObject({ terminalReason: "completed" });
  });

  it("does not infer ownership of a legacy running turn with null requestId", () => {
    const store = createDesktopStore({ schedule: () => {} });
    const saved = image();
    store.getState().applyHostMessage(ready);
    store.getState().recordSentMessage("A", [saved], "A", undefined, undefined, undefined, undefined, true);
    store.getState().markOrchestrationDeliveryUnknown("A");
    store.setState({ turn: { status: "running", turnId: "shared", requestId: null } });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "shared" });
    expect(store.getState().turn).toMatchObject({ status: "running", requestId: null, turnId: "shared" });
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", images: [saved] });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "shared", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(store.getState().turn.status).toBe("idle");
    expect(store.getState().orchestrationDeliveries[0]?.terminalReason).toBeUndefined();
  });

  it("accepts a late start matching both IDs of the active turn", () => {
    const store = createDesktopStore({ schedule: () => {} });
    const saved = image();
    store.getState().applyHostMessage(ready);
    store.getState().recordSentMessage("A", [saved], "A", undefined, undefined, undefined, undefined, true);
    store.getState().markOrchestrationDeliveryUnknown("A");
    store.setState({ turn: { status: "running", turnId: "turn-A", requestId: "A" } });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "turn-A" });
    expect(store.getState().turn).toMatchObject({ status: "running", requestId: "A", turnId: "turn-A" });
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "started", turnId: "turn-A", images: [saved] });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "turn-A", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ terminalReason: "completed", images: [saved] });
  });
  it.each([true, false])("preserves manual compaction (ok=%s) during a late unknown start", (ok) => {
    const store = createDesktopStore({ schedule: () => {} });
    const saved = image();
    store.getState().applyHostMessage(ready);
    store.getState().recordSentMessage("A payload", [saved], "A", undefined, undefined, undefined, undefined, true);
    store.getState().markOrchestrationDeliveryUnknown("A");
    store.getState().applyHostMessage(ready);
    store.getState().applyHostMessage({ type: "agent_event", turnId: "manual-compaction", event: { type: "compaction_start", trigger: "manual" } });
    expect(store.getState().turn.status).toBe("compacting");
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "turn-A" });
    expect(store.getState().turn.status).toBe("compacting");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", requestId: "A", turnId: "turn-A", text: "A payload", images: [saved] });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "manual-compaction", event: { type: "compaction_end", ok, durationMs: 1, ...(ok ? { postTokens: 1 } : { error: "synthetic" }) } });
    expect(store.getState().turn.status).toBe("idle");
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "turn-A" });
    expect(store.getState().turn.status).toBe("idle");
    expect(store.getState().claimRecoveryAttempt("A", "unsafe", "retry", [saved], undefined)).toBe(false);
  });

  it("keeps manual compaction when a rejected request receives a contradictory start", () => {
    const store = createDesktopStore({ schedule: () => {} });
    const saved = image();
    store.getState().applyHostMessage(ready);
    store.getState().recordSentMessage("A", [saved], "A", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "A", reason: "busy" });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "manual-compaction", event: { type: "compaction_start", trigger: "manual" } });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "turn-A" });
    expect(store.getState().turn.status).toBe("compacting");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", turnId: "turn-A", images: [saved] });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "manual-compaction", event: { type: "compaction_end", ok: true, postTokens: 1, durationMs: 1 } });
    expect(store.getState().turn.status).toBe("idle");
  });

  it("preserves manual compaction across a late unknown start on a reconnected MessageChannel", async () => {
    const registry = createTabRegistry(createTabsStore());
    const first = new MessageChannel();
    const second = new MessageChannel();
    const sent: Array<{type: string; requestId?: string}> = [];
    first.port2.on("message", message => sent.push(message));
    second.port2.on("message", message => sent.push(message));
    try {
      registry.registerPort("tab", "/synthetic", first.port1 as unknown as MessagePort);
      first.port2.postMessage(ready);
      await vi.waitFor(() => expect(registry.getStore("tab")?.getState().connection).toBe("ready"));
      const store = registry.getStore("tab")!;
      const saved = image();
      store.getState().recordSentMessage("A", [saved], "A", undefined, undefined, undefined, undefined, true);
      registry.sendToTab("tab", { type: "user_message", requestId: "A", text: "A", images: [saved.attachment] });
      await vi.waitFor(() => expect(sent.some(message => message.type === "user_message" && message.requestId === "A")).toBe(true));
      first.port2.close();
      await vi.waitFor(() => expect(store.getState().connection).toBe("awaiting_port"));
      registry.registerPort("tab", "/synthetic", second.port1 as unknown as MessagePort);
      second.port2.postMessage(ready);
      second.port2.postMessage({ type: "agent_event", turnId: "manual-compaction", event: { type: "compaction_start", trigger: "manual" } });
      await vi.waitFor(() => expect(store.getState().turn.status).toBe("compacting"));
      second.port2.postMessage({ type: "turn_started", requestId: "A", turnId: "turn-A" });
      await vi.waitFor(() => expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", turnId: "turn-A", images: [saved] }));
      expect(store.getState().turn.status).toBe("compacting");
      second.port2.postMessage({ type: "agent_event", turnId: "manual-compaction", event: { type: "compaction_end", ok: true, postTokens: 1, durationMs: 1 } });
      await vi.waitFor(() => expect(store.getState().turn.status).toBe("idle"));
      expect(sent.filter(message => message.type === "user_message").map(message => message.requestId)).toEqual(["A"]);
    } finally { registry.disposeTab("tab"); first.port1.close(); first.port2.close(); second.port1.close(); second.port2.close(); }
  });
  it("keeps active B when an unknown A receives its first late start", () => {
    const store = createDesktopStore({ schedule: () => {} });
    const saved = image();
    store.getState().applyHostMessage(ready);
    store.getState().recordSentMessage("A payload", [saved], "A", undefined, undefined, undefined, undefined, true);
    store.getState().markOrchestrationDeliveryUnknown("A");
    store.getState().applyHostMessage(ready);
    store.getState().recordSentMessage("B payload", [], "B", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "B", turnId: "turn-B" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "turn-A" });
    expect(store.getState().turn).toMatchObject({ status: "running", requestId: "B", turnId: "turn-B" });
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "A")).toMatchObject({ status: "conflict", turnId: "turn-A", images: [saved], text: "A payload" });
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "A", reason: "busy" });
    expect(store.getState().turn).toMatchObject({ status: "running", requestId: "B", turnId: "turn-B" });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "turn-B", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(store.getState().turn.status).toBe("idle");
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "turn-A" });
    expect(store.getState().turn.status).toBe("idle");
    expect(store.getState().claimRecoveryAttempt("A", "unsafe", "retry", [saved], undefined)).toBe(false);
  });

  it("accepts the first late start for unknown A when the session is idle", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    const saved = image();
    store.getState().recordSentMessage("A", [saved], "A", undefined, undefined, undefined, undefined, true);
    store.getState().markOrchestrationDeliveryUnknown("A");
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "turn-A" });
    expect(store.getState().turn).toMatchObject({ status: "running", requestId: "A", turnId: "turn-A" });
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "started", turnId: "turn-A", images: [saved], preservePayload: true });
  });

  it.each(["turn-A", "turn-B"])("reaches a late unknown A start (%s) over a reconnected MessageChannel while B is active", async (lateTurnId) => {
    const registry = createTabRegistry(createTabsStore());
    const first = new MessageChannel();
    const second = new MessageChannel();
    const sent: Array<{type: string; requestId?: string}> = [];
    first.port2.on("message", message => sent.push(message));
    second.port2.on("message", message => sent.push(message));
    try {
      registry.registerPort("tab", "/synthetic", first.port1 as unknown as MessagePort);
      first.port2.postMessage(ready);
      await vi.waitFor(() => expect(registry.getStore("tab")?.getState().connection).toBe("ready"));
      const store = registry.getStore("tab")!;
      const saved = image();
      store.getState().recordSentMessage("A payload", [saved], "A", undefined, undefined, undefined, undefined, true);
      registry.sendToTab("tab", { type: "user_message", requestId: "A", text: "A payload", images: [saved.attachment] });
      await vi.waitFor(() => expect(sent.some(message => message.type === "user_message" && message.requestId === "A")).toBe(true));
      first.port2.close();
      await vi.waitFor(() => expect(store.getState().connection).toBe("awaiting_port"));
      expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ requestId: "A", status: "unknown", images: [saved] });
      registry.registerPort("tab", "/synthetic", second.port1 as unknown as MessagePort);
      second.port2.postMessage(ready);
      await vi.waitFor(() => expect(store.getState().connection).toBe("ready"));
      store.getState().recordSentMessage("B payload", [], "B", undefined, undefined, undefined, undefined, true);
      registry.sendToTab("tab", { type: "user_message", requestId: "B", text: "B payload" });
      await vi.waitFor(() => expect(sent.some(message => message.type === "user_message" && message.requestId === "B")).toBe(true));
      second.port2.postMessage({ type: "turn_started", requestId: "B", turnId: "turn-B" });
      await vi.waitFor(() => expect(store.getState().turn).toMatchObject({ status: "running", requestId: "B" }));
      second.port2.postMessage({ type: "turn_started", requestId: "A", turnId: lateTurnId });
      await vi.waitFor(() => expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "A")).toMatchObject({ status: "conflict", turnId: lateTurnId, images: [saved] }));
      expect(store.getState().turn).toMatchObject({ status: "running", requestId: "B", turnId: "turn-B" });
      second.port2.postMessage({ type: "agent_event", turnId: "turn-B", event: { type: "loop_end", reason: "completed", turns: 1 } });
      await vi.waitFor(() => expect(store.getState().turn.status).toBe("idle"));
      expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "A")?.terminalReason).toBeUndefined();
      expect(sent.filter(message => message.type === "user_message").map(message => message.requestId)).toEqual(["A", "B"]);
      expect(store.getState().claimRecoveryAttempt("A", "unsafe", "retry", [saved], undefined)).toBe(false);
    } finally { registry.disposeTab("tab"); first.port1.close(); first.port2.close(); second.port1.close(); second.port2.close(); }
  });
  it.each(["started-first", "rejected-first"] as const)("keeps conflicted %s turn terminal and does not replace a newer active turn", (order) => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    const saved = image();
    store.getState().recordSentMessage("A", [saved], "A", undefined, undefined, undefined, undefined, true);
    const started = () => store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "turn-A" });
    const rejected = () => store.getState().applyHostMessage({ type: "turn_rejected", requestId: "A", reason: "busy" });
    if (order === "started-first") { started(); rejected(); } else { rejected(); started(); }
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", turnId: "turn-A", images: [saved] });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "turn-A", event: { type: "loop_end", reason: "error", turns: 1 } });
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", terminalReason: "error", turnId: "turn-A", images: [saved] });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "B", turnId: "turn-B" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "different-A" });
    expect(store.getState().turn).toMatchObject({ status: "running", requestId: "B", turnId: "turn-B" });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "turn-A", event: { type: "loop_end", reason: "error", turns: 1 } });
    expect(store.getState().turn).toMatchObject({ status: "running", requestId: "B", turnId: "turn-B" });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "turn-B", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(store.getState().turn.status).toBe("idle");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", terminalReason: "error", images: [saved] });
  });

  it("does not replace a running turn when one request reports a different turn before ending", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    const saved = image();
    store.getState().recordSentMessage("A", [saved], "A", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "turn-A" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "different-A" });
    expect(store.getState().turn).toMatchObject({ status: "running", turnId: "turn-A" });
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", turnId: "turn-A", images: [saved] });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "turn-A", event: { type: "loop_end", reason: "cancelled", turns: 1 } });
    expect(store.getState().turn.status).toBe("idle");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", turnId: "turn-A", terminalReason: "cancelled", images: [saved] });
  });

  it("preserves a different active turn when a rejected request has a late first start", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    store.getState().recordSentMessage("A", [image()], "A", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "A", reason: "busy" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "B", turnId: "turn-B" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "A", turnId: "turn-A" });
    expect(store.getState().turn).toMatchObject({ status: "running", requestId: "B", turnId: "turn-B" });
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", turnId: "turn-A" });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "turn-B", event: { type: "loop_end", reason: "completed", turns: 1 } });
    expect(store.getState().turn.status).toBe("idle");
  });
  it("keeps a completed recovery payload when a late rejection conflicts", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    const saved = image();
    store.getState().recordSentMessage("parent", [saved], "parent", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "parent", reason: "busy" });
    expect(store.getState().claimRecoveryAttempt("parent", "child", "retry", [saved], undefined)).toBe(true);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "child", turnId: "child-turn" });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "child-turn", event: { type: "loop_end", reason: "completed", turns: 1 } });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "child", turnId: "child-turn" });
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "child")).toMatchObject({ status: "finished", terminalReason: "completed", images: [saved] });
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "child", reason: "busy" });
    store.getState().dismissRejectedDelivery("parent");
    expect(store.getState().orchestrationDeliveries).toMatchObject([{ requestId: "parent", status: "rejected", images: [saved] }, { requestId: "child", status: "conflict", images: [saved] }]);
    expect(store.getState().claimRecoveryAttempt("parent", "unsafe", "retry", [saved], undefined)).toBe(false);
  });

  it.each(["completed", "error", "cancelled", "max_turns"] as const)("keeps %s recovery terminal through late starts, including a conflicting turn", (reason) => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    const saved = image();
    store.getState().recordSentMessage("parent", [saved], "parent", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "parent", reason: "busy" });
    expect(store.getState().claimRecoveryAttempt("parent", "child", "retry", [saved], undefined)).toBe(true);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "child", turnId: "child-turn" });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "child-turn", event: { type: "loop_end", reason, turns: 1 } });
    expect(store.getState().turn.status).toBe("idle");
    store.getState().applyHostMessage({ type: "turn_started", requestId: "child", turnId: "child-turn" });
    expect(store.getState().turn.status).toBe("idle");
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "child")).toMatchObject({ status: "finished", terminalReason: reason, images: [saved] });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "child", turnId: "contradictory-turn" });
    expect(store.getState().turn.status).toBe("idle");
    store.getState().applyHostMessage({ type: "turn_started", requestId: "other", turnId: "other-turn" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "child", turnId: "contradictory-turn" });
    expect(store.getState().turn).toMatchObject({ status: "running", requestId: "other", turnId: "other-turn" });
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "child")).toMatchObject({ status: "conflict", terminalReason: reason, images: [saved] });
    store.getState().dismissRejectedDelivery("parent");
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "parent")).toMatchObject({ status: "rejected", images: [saved] });
    expect(store.getState().claimRecoveryAttempt("parent", "unsafe", "retry", [saved], undefined)).toBe(false);
  });

  it("does not stall the actual drainer after a replayed start on reconnect", async () => {
    const registry = createTabRegistry(createTabsStore());
    const channel = new MessageChannel();
    const sent: Array<{type: string; text?: string}> = [];
    channel.port2.on("message", message => sent.push(message));
    try {
      registry.registerPort("tab", "/synthetic", channel.port1 as unknown as MessagePort);
      channel.port2.postMessage(ready);
      await vi.waitFor(() => expect(registry.getStore("tab")?.getState().connection).toBe("ready"));
      const store = registry.getStore("tab")!;
      const saved = image();
      store.getState().recordSentMessage("parent", [saved], "parent", undefined, undefined, undefined, undefined, true);
      store.getState().applyHostMessage({ type: "turn_rejected", requestId: "parent", reason: "busy" });
      expect(store.getState().claimRecoveryAttempt("parent", "child", "retry", [saved], undefined)).toBe(true);
      channel.port2.postMessage({ type: "turn_started", requestId: "child", turnId: "child-turn" });
      channel.port2.postMessage({ type: "agent_event", turnId: "child-turn", event: { type: "loop_end", reason: "completed", turns: 1 } });
      await vi.waitFor(() => expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "child")?.status).toBe("finished"));
      const replayDelivered = new Promise<void>(resolve => {
        const listener = (message: {type: string}) => {
          if (message.type === "turn_started") { channel.port1.off("message", listener); resolve(); }
        };
        channel.port1.on("message", listener);
      });
      channel.port2.postMessage(ready);
      channel.port2.postMessage({ type: "turn_started", requestId: "child", turnId: "child-turn" });
      await replayDelivered;
      expect(store.getState().turn.status).toBe("idle");
      store.getState().enqueuePrompt({ text: "independent task", images: [] });
      await vi.waitFor(() => expect(sent.filter(message => message.type === "user_message" && message.text === "independent task")).toHaveLength(1));
    } finally { registry.disposeTab("tab"); channel.port1.close(); channel.port2.close(); }
  });

  it("fences late starts for a completed ordinary direct after reconnect", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    store.getState().recordSentMessage("direct", [image()], "direct", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "direct", turnId: "direct-turn" });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "direct-turn", event: { type: "loop_end", reason: "completed", turns: 1 } });
    store.getState().applyHostMessage(ready);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "direct", turnId: "direct-turn" });
    expect(store.getState().turn.status).toBe("idle");
    store.getState().applyHostMessage({ type: "turn_started", requestId: "direct", turnId: "different-turn" });
    expect(store.getState().turn.status).toBe("idle");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", terminalReason: "completed", payloadOmitted: true });
  });
  it("bounds a fully dismissed chain of 300 while retaining recent correlation", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    const saved = image();
    const chain = Array.from({ length: 300 }, (_, i) => ({
      requestId: `chain-${i}`, ...(i ? { parentRequestId: `chain-${i - 1}` } : {}),
      text: i === 299 ? "last" : "", images: i === 299 ? [saved] : [], status: "rejected" as const,
      restored: false, reviewed: false, ...(i === 299 ? {} : { dismissed: true as const, payloadOmitted: true as const }),
    }));
    store.setState({ orchestrationDeliveries: chain });
    store.getState().dismissRejectedDelivery("chain-299");
    const retained = store.getState().orchestrationDeliveries;
    expect(retained).toHaveLength(COMPLETED_DIRECT_CORRELATION_LIMIT);
    expect(retained[0]).toMatchObject({ requestId: "chain-44", dismissed: true, payloadOmitted: true });
    expect(retained[0]!.parentRequestId).toBeUndefined();
    expect(store.getState().claimRecoveryAttempt("chain-44", "unsafe", "retry", [saved], undefined)).toBe(false);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "chain-299", turnId: "late" });
    expect(store.getState().orchestrationDeliveries.at(-1)).toMatchObject({ requestId: "chain-299", status: "conflict", payloadOmitted: true });
  });

  it("pins a large unresolved family even when other tombstones exceed the horizon", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    const saved = image();
    const chain = Array.from({ length: 300 }, (_, i) => ({
      requestId: `pinned-${i}`, ...(i ? { parentRequestId: `pinned-${i - 1}` } : {}),
      text: i ? "" : "unknown", images: i ? [] : [saved], status: i ? "rejected" as const : "unknown" as const,
      restored: false, reviewed: false, ...(i ? { dismissed: true as const, payloadOmitted: true as const } : {}),
    }));
    const independent = Array.from({ length: 270 }, (_, i) => ({ requestId: `other-${i}`, text: "", images: [], status: "rejected" as const, restored: false, reviewed: false, dismissed: true as const, payloadOmitted: true as const }));
    store.setState({ orchestrationDeliveries: [...chain, ...independent, { requestId: "trigger", text: "trigger", images: [saved], status: "rejected", restored: false, reviewed: false }] });
    store.getState().dismissRejectedDelivery("trigger");
    expect(store.getState().orchestrationDeliveries.filter(item => item.requestId.startsWith("pinned-"))).toHaveLength(300);
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "pinned-0")).toMatchObject({ status: "unknown", images: [saved] });
    expect(store.getState().orchestrationDeliveries.filter(item => item.requestId.startsWith("other-") || item.requestId === "trigger")).toHaveLength(COMPLETED_DIRECT_CORRELATION_LIMIT);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "pinned-299", turnId: "late" });
    expect(store.getState().claimRecoveryAttempt("pinned-0", "unsafe", "retry", [saved], undefined)).toBe(false);
  });
  it("dismisses a branched tree bottom-up, blocks active descendants, and fences late events", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    const saved = image();
    store.getState().recordSentMessage("parent", [saved], "parent", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "parent", reason: "busy" });
    const parent = store.getState().orchestrationDeliveries[0]!;
    const rejectedChild = { ...parent, requestId: "child-a", parentRequestId: "parent", text: "child-a", ordinaryDirect: undefined };
    const pendingChild = { ...parent, requestId: "child-b", parentRequestId: "parent", text: "child-b", status: "pending" as const, ordinaryDirect: undefined };
    const grandchild = { ...parent, requestId: "grandchild", parentRequestId: "child-a", text: "grandchild", ordinaryDirect: undefined };
    store.setState({ orchestrationDeliveries: [parent, rejectedChild, pendingChild, grandchild] });
    store.getState().dismissRejectedDelivery("grandchild");
    store.getState().dismissRejectedDelivery("parent");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "rejected", images: [saved] });
    store.getState().dismissRejectedDelivery("child-a");
    store.getState().dismissRejectedDelivery("parent");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "rejected", images: [saved] });
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "child-b", reason: "busy" });
    store.getState().dismissRejectedDelivery("child-b");
    store.getState().dismissRejectedDelivery("parent");
    expect(store.getState().orchestrationDeliveries).toMatchObject([
      { requestId: "parent", dismissed: true, images: [] }, { requestId: "child-a", dismissed: true, images: [] },
      { requestId: "child-b", dismissed: true, images: [] }, { requestId: "grandchild", dismissed: true, images: [] },
    ]);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "grandchild", turnId: "late-grandchild" });
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "grandchild")).toMatchObject({ status: "conflict", payloadOmitted: true });
    expect(store.getState().claimRecoveryAttempt("parent", "unsafe", "retry", [saved], undefined)).toBe(false);
  });

  it("pins dismissed descendant correlation when an ancestor still owns a rejected payload", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    const saved = image();
    store.getState().recordSentMessage("parent", [saved], "parent", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "parent", reason: "busy" });
    const parent = store.getState().orchestrationDeliveries[0]!;
    store.setState({ orchestrationDeliveries: [parent, { ...parent, requestId: "child", parentRequestId: "parent", ordinaryDirect: undefined }] });
    store.getState().dismissRejectedDelivery("child");
    for (let i = 0; i < COMPLETED_DIRECT_CORRELATION_LIMIT + 10; i++) {
      const id = `pressure-${i}`;
      store.getState().recordSentMessage("completed", [saved], id, undefined, undefined, undefined, undefined, true);
      store.getState().applyHostMessage({ type: "turn_started", requestId: id, turnId: id });
      store.getState().applyHostMessage({ type: "agent_event", turnId: id, event: { type: "loop_end", reason: "completed", turns: 1 } });
    }
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "child")).toMatchObject({ dismissed: true, parentRequestId: "parent" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "child", turnId: "late-child" });
    store.getState().dismissRejectedDelivery("parent");
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "parent")).toMatchObject({ status: "rejected", images: [saved] });
    expect(store.getState().claimRecoveryAttempt("parent", "unsafe", "retry", [saved], undefined)).toBe(false);
  });
  it("cannot dismiss unknown, active, or rejected ancestors with dependent attempts", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    const saved = image();
    store.getState().recordSentMessage("parent", [saved], "parent", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "parent", reason: "busy" });
    const parent = store.getState().orchestrationDeliveries[0]!;
    store.setState({ orchestrationDeliveries: [parent, { ...parent, requestId: "child", parentRequestId: "parent", status: "pending" }] });
    store.getState().dismissRejectedDelivery("parent");
    store.getState().dismissRejectedDelivery("child");
    expect(store.getState().orchestrationDeliveries).toMatchObject([{ requestId: "parent", status: "rejected", images: [saved] }, { requestId: "child", status: "pending", images: [saved] }]);
    store.setState({ orchestrationDeliveries: [parent], promptQueue: [{ id: "queued", text: "retry", images: [], recoverySourceId: "parent" }] });
    store.getState().dismissRejectedDelivery("parent");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "rejected", images: [saved] });
    store.setState({ promptQueue: [], queueInFlight: { requestId: "retry", item: { id: "queued", text: "retry", images: [], recoverySourceId: "parent" } } });
    store.getState().dismissRejectedDelivery("parent");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "rejected", images: [saved] });
    store.setState({ queueInFlight: null });
    store.setState({ orchestrationDeliveries: [{ ...parent, status: "unknown" }] });
    store.getState().dismissRejectedDelivery("parent");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "unknown", images: [saved] });
    store.setState({ orchestrationDeliveries: [{ ...parent, status: "started", turnId: "running" }] });
    store.getState().dismissRejectedDelivery("parent");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "started", images: [saved] });
  });
  it.each(["started-first", "rejected-first"] as const)("correlates child steer conflict in %s order without redelivery", async (order) => {
    const registry = createTabRegistry(createTabsStore());
    const channel = new MessageChannel();
    const sent: unknown[] = [];
    channel.port2.on("message", message => sent.push(message));
    try {
      registry.registerPort("tab", "/synthetic", channel.port1 as unknown as MessagePort);
      channel.port2.postMessage(ready);
      await vi.waitFor(() => expect(registry.getStore("tab")?.getState().connection).toBe("ready"));
      const store = registry.getStore("tab")!;
      const saved = image();
      store.getState().recordPendingSteer("steer-conflict", "child", [saved.attachment], { text: "child", images: [saved] });
      registry.sendToTab("tab", { type: "user_message", requestId: "steer-conflict", text: "child", images: [saved.attachment] });
      const started = { type: "turn_started", requestId: "steer-conflict", turnId: "child-turn" };
      const rejected = { type: "turn_rejected", requestId: "steer-conflict", reason: "busy" };
      channel.port2.postMessage(order === "started-first" ? started : rejected);
      channel.port2.postMessage(order === "started-first" ? rejected : started);
      await vi.waitFor(() => expect(store.getState().orchestrationDeliveries).toMatchObject([{ requestId: "steer-conflict", text: "child", images: [saved], status: "conflict" }]));
      expect(store.getState().promptQueue).toEqual([]);
      expect(store.getState().pendingSteers).toEqual([]);
      expect(sent.filter((message: any) => message.type === "user_message")).toHaveLength(1);
    } finally { registry.disposeTab("tab"); channel.port1.close(); channel.port2.close(); }
  });

  it("bounds completed child-steer correlation while retaining a recent late conflict", async () => {
    const registry = createTabRegistry(createTabsStore());
    const channel = new MessageChannel();
    try {
      registry.registerPort("tab", "/synthetic", channel.port1 as unknown as MessagePort);
      channel.port2.postMessage(ready);
      await vi.waitFor(() => expect(registry.getStore("tab")?.getState().connection).toBe("ready"));
      const store = registry.getStore("tab")!;
      const saved = image();
      for (let i = 0; i < COMPLETED_DIRECT_CORRELATION_LIMIT + 10; i++) {
        const id = `child-${i}`;
        store.getState().recordPendingSteer(id, "child", [saved.attachment], { text: "child", images: [saved] });
        channel.port2.postMessage({ type: "turn_started", requestId: id, turnId: id });
        channel.port2.postMessage({ type: "agent_event", turnId: id, event: { type: "loop_end", reason: "completed", turns: 1 } });
      }
      const last = `child-${COMPLETED_DIRECT_CORRELATION_LIMIT + 9}`;
      await vi.waitFor(() => expect(store.getState().orchestrationDeliveries.find(item => item.requestId === last)?.payloadOmitted).toBe(true));
      expect(store.getState().orchestrationDeliveries.filter(item => item.childSteer && item.payloadOmitted)).toHaveLength(COMPLETED_DIRECT_CORRELATION_LIMIT);
      expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "child-0")).toBeUndefined();
      channel.port2.postMessage({ type: "turn_rejected", requestId: last, reason: "busy" });
      await vi.waitFor(() => expect(store.getState().orchestrationDeliveries.find(item => item.requestId === last)).toMatchObject({ status: "conflict", payloadOmitted: true }));
    } finally { registry.disposeTab("tab"); channel.port1.close(); channel.port2.close(); }
  });
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
