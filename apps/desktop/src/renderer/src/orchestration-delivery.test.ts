import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRecovery, saveRecovery } from "./orchestration-recovery-storage.js";
import { createDesktopStore } from "./store.js";

const hello = { type: "host_ready" as const, workspace: "/work", mode: "build" as const, model: "model", sessionId: "session" };
const protocol = { version: 1 as const, hostIncarnation: "host", connectionId: "connection", atomicSubmit: true, correlatedToggle: true };

describe("orchestration delivery recovery", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("omits large attachments from quota-limited recovery and holds restored drafts", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { setItem: (key: string, value: string) => { if (value.length > 2000) throw new Error("quota"); data.set(key, value); }, getItem: (key: string) => data.get(key) ?? null });
    const store = createDesktopStore();
    const image = { name: "large.png", sizeBytes: 10000, attachment: { mediaType: "image/png" as const, data: "A".repeat(10000) } };
    store.getState().enqueuePrompt({ text: "draft", images: [image] });
    expect(saveRecovery("tab", store.getState())).toBe(true);
    expect(loadRecovery("tab")?.promptQueue).toMatchObject([{ text: "draft", images: [], attachmentsOmitted: true, requiresRestore: true }]);
    expect([...data.values()].join("")).not.toContain("A".repeat(100));
    vi.stubGlobal("sessionStorage", { setItem: () => { throw new Error("quota"); } });
    expect(saveRecovery("tab", store.getState())).toBe(false);
  });
  it("retains an ordinary draft refused during a policy transition", () => {
    const store = createDesktopStore();
    store.getState().applyHostMessage(hello);
    store.getState().appendUserText("ordinary", "draft");
    store.getState().recordSentMessage("draft", [], "ordinary");
    store.getState().applyHostMessage({ type: "user_message_unavailable", requestId: "ordinary", reason: "posture_unavailable" });
    expect(store.getState().promptQueue).toMatchObject([{ id: "ordinary", text: "draft", requiresRestore: true }]);
    expect(store.getState().queuePaused).toBe(true);
  });
  it.each(["core", "codex", "claude"] as const)("retains %s unconfirmed intent through reload without automatic resend", engine => {
    const data = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { setItem: (key: string, value: string) => data.set(key, value), getItem: (key: string) => data.get(key) ?? null });
    const first = createDesktopStore();
    first.setState({ engine: { id: engine } as never });
    first.getState().applyHostMessage({ ...hello, orchestration: { enabled: false, available: true }, orchestrationProtocol: protocol });
    expect(first.getState().beginOrchestrationSubmit("request")).toBe("connection");
    first.getState().recordSentMessage("task", [], "request", "enable");
    first.getState().applyHostMessage({ type: "child_report", id: "report", text: "result" });
    expect(saveRecovery("tab", first.getState())).toBe(true);
    const next = createDesktopStore();
    next.setState(loadRecovery("tab")!);
    next.getState().setAwaitingHostReady();
    next.getState().applyHostMessage({ ...hello, orchestration: { enabled: true, available: true, posture: "on" }, orchestrationProtocol: { ...protocol, connectionId: "new" } });
    expect(next.getState().orchestrationDeliveries).toMatchObject([{ requestId: "request", text: "task", status: "unknown" }]);
    expect(next.getState().promptQueue).toMatchObject([{ origin: "system", originId: "report", text: "result" }]);
    next.getState().applyHostMessage({ type: "child_report", id: "report", text: "result" });
    expect(next.getState().promptQueue).toHaveLength(1);
  });
  it("keeps the queue held while the atomic admission is awaiting turn_started", () => {
    const store = createDesktopStore();
    store.getState().applyHostMessage({ ...hello, orchestration: { enabled: false, available: true }, orchestrationProtocol: protocol });
    store.getState().beginOrchestrationSubmit("request");
    store.getState().recordSentMessage("task", [], "request", "enable");
    store.getState().applyHostMessage({ type: "orchestrate_changed", enabled: true });
    store.getState().applyHostMessage({ type: "child_report", id: "report", text: "result" });
    expect(store.getState().orchestrateActive).toBe(false);
    expect(store.getState().takeQueueHead("other")).toBeNull();
    store.getState().applyHostMessage({ type: "turn_started", requestId: "request", turnId: "turn" });
    expect(store.getState().orchestrateActive).toBe(true);
    expect(store.getState().turn.status).toBe("running");
    expect(store.getState().promptQueue).toHaveLength(1);
  });
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

  it("does not turn a prior unknown delivery into rejection on a malformed duplicate", () => {
    const store = createDesktopStore();
    store.getState().applyHostMessage({ ...hello, orchestration: { enabled: false, available: true }, orchestrationProtocol: protocol });
    store.getState().beginOrchestrationSubmit("same");
    store.getState().recordSentMessage("task", [], "same", "enable");
    store.getState().markOrchestrationDeliveryUnknown("same");
    store.getState().applyHostMessage({ type: "user_message_unavailable", requestId: "same", reason: "orchestrate_unavailable" });
    expect(store.getState().orchestrationDeliveries[0]?.status).toBe("unknown");
    expect(store.getState().takeQueueHead("other")).toBeNull();
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
