import { describe, expect, it } from "vitest";
import { createDesktopStore } from "./store.js";

const hello = { type: "host_ready" as const, workspace: "/work", mode: "build" as const, model: "model", sessionId: "session" };
const protocol = { version: 1 as const, hostIncarnation: "host", connectionId: "connection", atomicSubmit: true, correlatedToggle: true };

describe("orchestration delivery recovery", () => {
  it("treats a legacy host as unsupported and restores the host snapshot on reconnect", () => {
    const store = createDesktopStore();
    store.getState().applyHostMessage(hello);
    expect(store.getState().orchestration.protocol).toBeNull();
    expect(store.getState().beginOrchestrationToggle("old")).toBeNull();
    store.getState().applyHostMessage({ ...hello, orchestration: { enabled: true, available: true, posture: "on" }, orchestrationProtocol: protocol });
    expect(store.getState().orchestrateActive).toBe(true);
    expect(store.getState().orchestration.posture).toBe("on");
  });

  it("holds both typed prompts and deduplicated reports until a correlated result", () => {
    const store = createDesktopStore();
    store.getState().applyHostMessage({ ...hello, orchestration: { enabled: false, available: true, posture: "off" }, orchestrationProtocol: protocol });
    expect(store.getState().beginOrchestrationToggle("toggle")).toBe("connection");
    store.getState().enqueuePrompt({ text: "typed", images: [] });
    store.getState().applyHostMessage({ type: "child_report", id: "child", text: "report" });
    store.getState().applyHostMessage({ type: "child_report", id: "child", text: "report" });
    expect(store.getState().takeQueueHead("send")).toBeNull();
    expect(store.getState().promptQueue).toHaveLength(2);
    store.getState().applyHostMessage({ type: "orchestrate_result", requestId: "toggle", connectionId: "stale", outcome: "applied", enabled: true });
    expect(store.getState().orchestration.posture).toBe("transitioning");
    store.getState().applyHostMessage({ type: "orchestrate_result", requestId: "toggle", connectionId: "connection", outcome: "applied", enabled: true });
    expect(store.getState().takeQueueHead("send")?.text).toBe("typed");
  });

  it("quarantines an uncertain transition until a fresh host snapshot", () => {
    const store = createDesktopStore();
    store.getState().applyHostMessage({ ...hello, orchestration: { enabled: false, available: true }, orchestrationProtocol: protocol });
    store.getState().beginOrchestrationToggle("toggle");
    store.getState().applyHostMessage({ type: "orchestrate_result", requestId: "toggle", connectionId: "connection", outcome: "unknown" });
    store.getState().enqueuePrompt({ text: "held", images: [] });
    expect(store.getState().takeQueueHead("send")).toBeNull();
    store.getState().applyHostMessage({ ...hello, orchestration: { enabled: false, available: false, posture: "quarantined" }, orchestrationProtocol: protocol });
    expect(store.getState().takeQueueHead("send")).toBeNull();
  });
});
