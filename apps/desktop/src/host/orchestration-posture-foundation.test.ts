import { describe, expect, it, vi } from "vitest";
import { createDesktopStore } from "../renderer/src/store.js";
import type { AgentEnvelope } from "../shared/communication.js";
import type { HostToUiMessage } from "../shared/protocol.js";
import type { Session } from "./session.js";
import { createHarness } from "./test-harness.js";

// The posture is deliberately unreachable in production. These tests inject
// it into the real Session and use the harness's actual MessageChannel.
type Internals = {
  orchestrationPosture: "stable" | "transitioning" | "quarantined";
  busy: boolean;
  agentInbox: AgentEnvelope[];
  continuationPending: boolean;
  currentTurn: Promise<void> | null;
  settingsBarrierActive: boolean;
  settingsBarrier: Promise<void>;
  drainAgentInbox(settledChild?: boolean): boolean;
  acceptUserMessage(id: string, text: string): boolean;
};
const internal = (session: Session): Internals => session as unknown as Internals;
const diagnostic = (id: string) => (message: HostToUiMessage): message is Extract<HostToUiMessage, {type: "user_message_unavailable"}> => message.type === "user_message_unavailable" && message.requestId === id;

describe("dormant orchestration posture admission foundation", () => {
  it.each(["transitioning", "quarantined"] as const)("keeps repeated started ID frame-level after admissions close in %s", async (posture) => {
    const h = createHarness({ steps: [], gated: { parkAfterIndex: 0 } });
    try {
      h.send({ type: "ui_ready" });
      const ready = await h.waitFor((m): m is Extract<HostToUiMessage, {type:"host_ready"}> => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "same", text: "first" });
      const started = await h.waitFor((m): m is Extract<HostToUiMessage, {type:"turn_started"}> => m.type === "turn_started" && m.requestId === "same");
      internal(h.session).orchestrationPosture = posture;
      h.session.closeAdmissions();
      h.send({ type: "user_message", requestId: "same", text: "repeated frame" });
      h.send({ type: "set_orchestrate", enabled: true, requestId: "sentinel" });
      await h.waitFor((m): m is Extract<HostToUiMessage, {type:"orchestrate_result"}> => m.type === "orchestrate_result" && m.requestId === "sentinel");
      const refused = h.received.find(diagnostic("same"));
      expect(refused).toMatchObject({ type: "user_message_unavailable", requestId: "same", reason: "posture_unavailable" });
      expect(h.received.filter(m => m.type === "turn_rejected" && m.requestId === "same")).toEqual([]);
      const store = createDesktopStore({ schedule: () => {} });
      store.getState().applyHostMessage(ready);
      store.getState().recordSentMessage("first", [], "same", undefined, undefined, undefined, undefined, true);
      store.getState().applyHostMessage(started);
      store.getState().applyHostMessage(refused!);
      expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ requestId: "same", status: "started", turnId: started.turnId, text: "first" });
    } finally { h.gated?.release(); h.close(); }
  });

  it("keeps the legacy shutdown rejection in stable posture", async () => {
    const h = createHarness({ steps: [] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m): m is Extract<HostToUiMessage, {type:"host_ready"}> => m.type === "host_ready");
      h.session.closeAdmissions();
      h.send({ type: "user_message", requestId: "legacy", text: "message" });
      expect(await h.waitFor((m): m is Extract<HostToUiMessage, {type:"turn_rejected"}> => m.type === "turn_rejected" && m.requestId === "legacy")).toMatchObject({ reason: "not_ready" });
      expect(h.received.find(diagnostic("legacy"))).toBeUndefined();
    } finally { h.close(); }
  });

  it.each(["stable", "quarantined"] as const)("keeps the reserved intent diagnostic during shutdown in %s", async (posture) => {
    const h = createHarness({ steps: [] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m): m is Extract<HostToUiMessage, {type:"host_ready"}> => m.type === "host_ready");
      internal(h.session).orchestrationPosture = posture;
      h.session.closeAdmissions();
      h.send({ type: "user_message", requestId: "reserved", text: "task", orchestrate: "enable" });
      expect(await h.waitFor(diagnostic("reserved"))).toMatchObject({ reason: "orchestrate_unavailable" });
      expect(h.received.filter(m => m.type === "turn_rejected" && m.requestId === "reserved")).toEqual([]);
    } finally { h.close(); }
  });
  it.each(["transitioning", "quarantined"] as const)("holds direct, system and initial frames in %s without claiming terminal rejection", async (posture) => {
    const h = createHarness({ steps: [] });
    const run = vi.spyOn(h.engine, "runTurn");
    try {
      h.send({ type: "ui_ready" });
      const ready = await h.waitFor((m): m is Extract<HostToUiMessage, {type:"host_ready"}> => m.type === "host_ready");
      expect(ready.orchestration?.available).toBe(false);
      internal(h.session).orchestrationPosture = posture;
      const image = { mediaType: "image/png" as const, data: "YQ==" };
      h.send({ type: "user_message", requestId: "direct", text: "direct", images: [image] });
      h.send({ type: "user_message", requestId: "system", text: "report", origin: "system" });
      h.send({ type: "user_message", requestId: "initial", text: "initial", images: [image] });
      h.send({ type: "steer_message", requestId: "steer", text: "steer" });
      for (const id of ["direct", "system", "initial", "steer"]) {
        expect(await h.waitFor(diagnostic(id))).toMatchObject({ reason: "posture_unavailable" });
      }
      expect(run).not.toHaveBeenCalled();
      expect(h.received.filter(m => m.type === "turn_started" || m.type === "turn_rejected" || m.type === "steer_requeued")).toEqual([]);
      expect(internal(h.session).acceptUserMessage("internal", "payload")).toBe(false);

      // The current renderer intentionally ignores this frame diagnostic: it
      // must not turn an old started/unknown ID into a fabricated rejection.
      const store = createDesktopStore({ schedule: () => {} });
      store.getState().applyHostMessage(ready);
      const saved = { name: "a.png", sizeBytes: 1, attachment: image };
      store.getState().recordSentMessage("direct", [saved], "direct", undefined, undefined, undefined, undefined, true);
      store.getState().applyHostMessage(await h.waitFor(diagnostic("direct")));
      expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ requestId: "direct", status: "pending", images: [saved] });
      store.getState().recordSentMessage("initial", [saved], "initial", undefined, {});
      store.getState().applyHostMessage(await h.waitFor(diagnostic("initial")));
      expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "initial")).toMatchObject({ status: "pending", images: [saved], initialPicks: {} });
      store.setState({ queueInFlight: { requestId: "system", item: { id: "report", text: "report", images: [], origin: "system", originId: "child-report" } } });
      store.getState().applyHostMessage(await h.waitFor(diagnostic("system")));
      expect(store.getState().queueInFlight).toMatchObject({ requestId: "system", item: { text: "report", origin: "system", originId: "child-report" } });
      expect(store.getState().promptQueue).toEqual([]);
    } finally { h.close(); }
  });

  it("keeps an already queued inbox entry and rejects a new internal message before drain", async () => {
    const h = createHarness({ steps: [] });
    try {
      const state = internal(h.session);
      const envelope: AgentEnvelope = { messageId: "old", sender: "synthetic", recipientSessionId: "test-session", kind: "agent_message", payload: "held", mode: "next_turn", createdAt: "2026-01-01T00:00:00Z" };
      state.busy = true;
      expect((await h.session.receiveAgentMessage(envelope)).state).toBe("queued");
      state.orchestrationPosture = "quarantined";
      state.busy = false;
      expect(state.drainAgentInbox()).toBe(false);
      expect(state.agentInbox).toEqual([envelope]);
      expect(h.session.agentMessageStatus("old")?.state).toBe("queued");
      const newer = { ...envelope, messageId: "new" };
      expect((await h.session.receiveAgentMessage(newer)).state).toBe("rejected");
      expect(state.agentInbox).toEqual([envelope]);
    } finally { h.close(); }
  });

  it("responds to blocked maintenance without changing the engine mode", async () => {
    const h = createHarness({ steps: [] });
    try {
      h.send({ type: "ui_ready" });
      await h.waitFor((m): m is Extract<HostToUiMessage, {type:"host_ready"}> => m.type === "host_ready");
      internal(h.session).orchestrationPosture = "quarantined";
      const before = h.engine.mode();
      h.send({ type: "set_mode", mode: "plan" });
      h.send({ type: "compact_request" });
      h.send({ type: "engine_switch_request", requestId: "engine", engine: "codex" });
      h.send({ type: "rewind_request", requestId: "rewind", checkpointId: "synthetic", scope: "both" });
      expect((await h.waitFor((m): m is Extract<HostToUiMessage, {type:"mode_change_rejected"}> => m.type === "mode_change_rejected")).reason).toBe("Session posture unavailable");
      expect((await h.waitFor((m): m is Extract<HostToUiMessage, {type:"compact_rejected"}> => m.type === "compact_rejected")).reason).toBe("Session posture unavailable");
      expect((await h.waitFor((m): m is Extract<HostToUiMessage, {type:"engine_switch_failed"}> => m.type === "engine_switch_failed")).requestId).toBe("engine");
      expect(await h.waitFor((m): m is Extract<HostToUiMessage, {type:"rewind_result"}> => m.type === "rewind_result")).toMatchObject({ requestId: "rewind", ok: false, conversationRestored: false });
      expect(h.engine.mode()).toBe(before);
    } finally { h.close(); }
  });

  it("does not turn a duplicate ID into a terminal rejection of the earlier started turn", async () => {
    const h = createHarness({ steps: [], gated: { parkAfterIndex: 0 } });
    try {
      h.send({ type: "ui_ready" });
      const ready = await h.waitFor((m): m is Extract<HostToUiMessage, {type:"host_ready"}> => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "duplicate", text: "first" });
      const started = await h.waitFor((m): m is Extract<HostToUiMessage, {type:"turn_started"}> => m.type === "turn_started" && m.requestId === "duplicate");
      internal(h.session).orchestrationPosture = "quarantined";
      h.send({ type: "user_message", requestId: "duplicate", text: "other frame" });
      const refusedFrame = await h.waitFor(diagnostic("duplicate"));
      expect(h.received.filter(m => m.type === "turn_rejected" && m.requestId === "duplicate")).toEqual([]);
      const store = createDesktopStore({ schedule: () => {} });
      store.getState().applyHostMessage(ready);
      store.getState().recordSentMessage("first", [], "duplicate", undefined, undefined, undefined, undefined, true);
      store.getState().applyHostMessage(started);
      store.getState().applyHostMessage(refusedFrame);
      expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ requestId: "duplicate", status: "started", turnId: started.turnId, text: "first" });
    } finally { h.gated?.release(); h.close(); }
  });

  it("does not invoke the engine after posture changes during the settings barrier", async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const h = createHarness({ steps: [] });
    const run = vi.spyOn(h.engine, "runTurn");
    try {
      const state = internal(h.session);
      h.send({ type: "ui_ready" });
      await h.waitFor((m): m is Extract<HostToUiMessage, {type:"host_ready"}> => m.type === "host_ready");
      state.settingsBarrierActive = true;
      state.settingsBarrier = gate;
      h.send({ type: "user_message", requestId: "r", text: "input" });
      await h.waitFor((m): m is Extract<HostToUiMessage, {type:"turn_started"}> => m.type === "turn_started" && m.requestId === "r");
      const turn = state.currentTurn;
      expect(turn).not.toBeNull();
      state.orchestrationPosture = "quarantined";
      release();
      await turn;
      expect(run).not.toHaveBeenCalled();
      expect(h.received.filter(m => m.type === "turn_rejected" && m.requestId === "r")).toEqual([]);
    } finally { release(); h.close(); }
  });

  it("preserves continuation pending before ui_ready while blocked", async () => {
    const h = createHarness({ steps: [], continuationPending: true, continuationMode: "model" });
    const run = vi.spyOn(h.engine, "runTurn");
    try {
      internal(h.session).orchestrationPosture = "quarantined";
      h.send({ type: "ui_ready" });
      await h.waitFor((m): m is Extract<HostToUiMessage, {type:"host_ready"}> => m.type === "host_ready");
      h.send({ type: "user_message", requestId: "sentinel", text: "sentinel" });
      await h.waitFor(diagnostic("sentinel"));
      expect(internal(h.session).continuationPending).toBe(true);
      expect(run).not.toHaveBeenCalled();
    } finally { h.close(); }
  });

  it("rechecks posture after continuation readiness awaits and retains the claim", async () => {
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const complete = vi.fn(async () => {});
    const h = createHarness({ steps: [], continuationPending: true, continuationMode: "model", onContinuationReady: async () => { enter(); await gate; }, onContinuationComplete: complete });
    const run = vi.spyOn(h.engine, "runTurn");
    try {
      h.send({ type: "ui_ready" });
      await entered;
      internal(h.session).orchestrationPosture = "quarantined";
      const continuation = internal(h.session).currentTurn;
      expect(continuation).not.toBeNull();
      release();
      await continuation;
      expect(internal(h.session).continuationPending).toBe(true);
      expect(run).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    } finally { release(); h.close(); }
  });
});
