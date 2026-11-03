import { describe, expect, it, vi } from "vitest";
import type { HostToUiMessage, WirePort } from "../shared/protocol.js";
import { OrchestrationNotReadyError, type OrchestrationPolicy } from "./orchestration-policy.js";
import { createHarness, finishStep } from "./test-harness.js";

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;

async function ready(h: ReturnType<typeof createHarness>) {
  h.send({ type: "ui_ready", orchestrationProtocol: 1 });
  const result = await h.waitFor((m): m is Of<"host_ready"> => m.type === "host_ready");
  return result.orchestrationProtocol!.connectionId;
}

function nativePolicy(h: ReturnType<typeof createHarness>, policy: OrchestrationPolicy) {
  Object.defineProperty(h.engine, "id", { value: "codex" });
  Object.defineProperty(h.engine, "orchestrationPolicy", { value: policy });
}

describe("session orchestration admission", () => {
  it("atomically enables core before claiming exactly one turn and restores the preset", async () => {
    const changed = vi.fn();
    const h = createHarness({ steps: [finishStep()], mode: "auto", onOrchestrateChanged: changed, gated: { parkAfterIndex: 0 } });
    try {
      const connectionId = await ready(h);
      const frame = { type: "user_message" as const, requestId: "task", text: "work", orchestrate: "enable" as const, connectionId };
      h.send(frame); h.send(frame);
      await h.waitFor((m): m is Of<"turn_started"> => m.type === "turn_started" && m.requestId === "task");
      await h.flush();
      expect(h.engine.mode()).toBe("plan");
      expect(h.session.childSpawnMode()).toBe("auto");
      expect(changed).toHaveBeenCalledTimes(1);
      expect(h.received.filter(m => m.type === "turn_started" && m.requestId === "task")).toHaveLength(1);
      expect(h.received.filter(m => m.type === "turn_rejected" && m.requestId === "task")).toHaveLength(0);
      h.gated?.release();
      await h.waitFor((m): m is Of<"agent_event"> => m.type === "agent_event" && m.event.type === "loop_end");
      await h.waitUntil(() => !(h.session as unknown as { busy: boolean }).busy);
      h.send({ type: "set_orchestrate", enabled: false, requestId: "off", connectionId });
      expect(await h.waitFor((m): m is Of<"orchestrate_result"> => m.type === "orchestrate_result" && m.requestId === "off")).toMatchObject({ outcome: "applied", enabled: false });
      expect(h.engine.mode()).toBe("auto");
    } finally { h.gated?.release(); h.close(); }
  });

  it("holds messages and reports until the native overlay is verified", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const apply = vi.fn(async (enabled: boolean, baseAuthority: unknown) => { await gate; return { enabled, baseAuthority }; });
    const h = createHarness({ steps: [finishStep()] });
    nativePolicy(h, { availability: () => ({ supported: true }), apply });
    const run = vi.spyOn(h.engine, "runTurn");
    try {
      const connectionId = await ready(h);
      h.send({ type: "user_message", requestId: "atomic", text: "task", orchestrate: "enable", connectionId });
      await h.flush();
      h.send({ type: "user_message", requestId: "report", text: "child report", origin: "system" });
      h.send({ type: "steer_message", requestId: "steer", text: "extra" });
      await h.waitFor((m): m is Of<"user_message_unavailable"> => m.type === "user_message_unavailable" && m.requestId === "report");
      await h.waitFor((m): m is Of<"user_message_unavailable"> => m.type === "user_message_unavailable" && m.requestId === "steer");
      expect(run).not.toHaveBeenCalled();
      release();
      await h.waitFor((m): m is Of<"turn_started"> => m.type === "turn_started" && m.requestId === "atomic");
      await h.waitUntil(() => run.mock.calls.length === 1);
      expect(apply).toHaveBeenCalledTimes(1);
    } finally { release(); h.close(); }
  });

  it("quarantines an unconfirmed overlay and blocks ordinary turns", async () => {
    const h = createHarness({ steps: [] });
    nativePolicy(h, { availability: () => ({ supported: true }), apply: async () => { throw new Error("no confirmation"); } });
    const run = vi.spyOn(h.engine, "runTurn");
    try {
      const connectionId = await ready(h);
      h.send({ type: "set_orchestrate", enabled: true, requestId: "on", connectionId });
      expect(await h.waitFor((m): m is Of<"orchestrate_result"> => m.type === "orchestrate_result" && m.requestId === "on")).toMatchObject({ outcome: "unknown" });
      h.send({ type: "user_message", requestId: "ordinary", text: "unsafe" });
      expect(await h.waitFor((m): m is Of<"user_message_unavailable"> => m.type === "user_message_unavailable" && m.requestId === "ordinary")).toMatchObject({ reason: "posture_unavailable" });
      expect(run).not.toHaveBeenCalled();
    } finally { h.close(); }
  });

  it("keeps a pre-transition refusal stable and permits a later ordinary turn", async () => {
    const h = createHarness({ steps: [finishStep()] });
    nativePolicy(h, { availability: () => ({ supported: true }), apply: async () => { throw new OrchestrationNotReadyError("busy"); } });
    try {
      const connectionId = await ready(h);
      h.send({ type: "set_orchestrate", enabled: true, requestId: "on", connectionId });
      expect(await h.waitFor((m): m is Of<"orchestrate_result"> => m.type === "orchestrate_result" && m.requestId === "on")).toMatchObject({ outcome: "rejected", reason: "unavailable" });
      h.send({ type: "user_message", requestId: "ordinary", text: "work" });
      await h.waitFor((m): m is Of<"turn_started"> => m.type === "turn_started" && m.requestId === "ordinary");
    } finally { h.close(); }
  });

  it("captures the native preset for child authority and rejects a preset change while on", async () => {
    const apply = vi.fn(async (enabled: boolean, baseAuthority: unknown) => ({ enabled, baseAuthority }));
    const h = createHarness({ steps: [] });
    nativePolicy(h, { availability: () => ({ supported: true }), apply });
    const settings = { models: () => [], presets: () => [], snapshot: () => ({ model: "m", activePresetId: "full-access" }), pendingSnapshot: () => null, selectPreset: vi.fn() };
    (h.session as unknown as { engineSettings: unknown }).engineSettings = settings;
    try {
      const connectionId = await ready(h);
      h.send({ type: "set_orchestrate", enabled: true, requestId: "on", connectionId });
      await h.waitFor((m): m is Of<"orchestrate_result"> => m.type === "orchestrate_result" && m.requestId === "on");
      expect(apply).toHaveBeenCalledWith(true, { mode: "yolo" });
      expect(h.session.childSpawnMode()).toBe("yolo");
      h.send({ type: "set_engine_preset", presetId: "ask" });
      await h.waitFor((m): m is Of<"mode_change_rejected"> => m.type === "mode_change_rejected");
      expect(settings.selectPreset).not.toHaveBeenCalled();
      h.send({ type: "set_orchestrate", enabled: false, requestId: "off", connectionId });
      expect(await h.waitFor((m): m is Of<"orchestrate_result"> => m.type === "orchestrate_result" && m.requestId === "off")).toMatchObject({ outcome: "applied", enabled: false });
      expect(apply.mock.calls[1]?.[1]).toBe(apply.mock.calls[0]?.[1]);
    } finally { h.close(); }
  });

  it("refuses missing and stale connections and leaves unsupported native engines off", async () => {
    const h = createHarness({ steps: [] });
    Object.defineProperty(h.engine, "id", { value: "claude" });
    try {
      const connectionId = await ready(h);
      h.send({ type: "user_message", requestId: "missing", text: "task", orchestrate: "enable" });
      await h.waitFor((m): m is Of<"user_message_unavailable"> => m.type === "user_message_unavailable" && m.requestId === "missing");
      h.send({ type: "set_orchestrate", requestId: "stale", enabled: true, connectionId: "old" });
      expect(await h.waitFor((m): m is Of<"orchestrate_result"> => m.type === "orchestrate_result" && m.requestId === "stale")).toMatchObject({ outcome: "rejected", reason: "stale" });
      h.send({ type: "set_orchestrate", requestId: "unsupported", enabled: true, connectionId });
      expect(await h.waitFor((m): m is Of<"orchestrate_result"> => m.type === "orchestrate_result" && m.requestId === "unsupported")).toMatchObject({ outcome: "rejected", reason: "unavailable" });
    } finally { h.close(); }
  });

  it("waits for settings before applying, and shutdown prevents a late admission", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const apply = vi.fn(async (enabled: boolean, baseAuthority: unknown) => ({ enabled, baseAuthority }));
    const h = createHarness({ steps: [] });
    nativePolicy(h, { availability: () => ({ supported: true }), apply });
    const run = vi.spyOn(h.engine, "runTurn");
    const internal = h.session as unknown as { settingsBarrierActive: boolean; settingsBarrier: Promise<void> };
    try {
      const connectionId = await ready(h);
      internal.settingsBarrierActive = true;
      internal.settingsBarrier = gate;
      h.send({ type: "user_message", requestId: "task", text: "work", orchestrate: "enable", connectionId });
      await h.flush();
      expect(apply).not.toHaveBeenCalled();
      h.session.closeAdmissions();
      release();
      await h.flush();
      expect(apply).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    } finally { release(); h.close(); }
  });

  it("does not admit an old connection after rebind while the overlay is applying", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = createHarness({ steps: [] });
    nativePolicy(h, { availability: () => ({ supported: true }), apply: async (enabled, baseAuthority) => { await gate; return { enabled, baseAuthority }; } });
    const run = vi.spyOn(h.engine, "runTurn");
    let incoming!: (value: unknown) => void;
    const messages: HostToUiMessage[] = [];
    const port: WirePort = { post: m => messages.push(m as HostToUiMessage), onMessage: cb => { incoming = cb; }, onClose: () => {} };
    try {
      const connectionId = await ready(h);
      h.send({ type: "user_message", requestId: "old", text: "work", orchestrate: "enable", connectionId });
      await h.flush();
      h.session.bindPort(port);
      incoming({ type: "ui_ready", orchestrationProtocol: 1 });
      const next = messages.find((m): m is Of<"host_ready"> => m.type === "host_ready")!;
      expect(next.orchestration?.posture).toBe("transitioning");
      expect(next.orchestrationProtocol?.connectionId).not.toBe(connectionId);
      release();
      await h.flush();
      expect(run).not.toHaveBeenCalled();
      incoming({ type: "ui_ready", orchestrationProtocol: 1 });
      expect(messages.filter((m): m is Of<"host_ready"> => m.type === "host_ready").at(-1)?.orchestration).toMatchObject({ enabled: true, posture: "on" });
    } finally { release(); h.close(); }
  });
});
