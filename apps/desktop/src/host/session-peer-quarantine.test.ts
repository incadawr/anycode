/**
 * Native peer authority is revoked by the REAL quarantine paths: a failed
 * Orchestrate-off save (the controller quarantines), and a failed saved-overlay
 * restore whose recovery also fails (the posture quarantines). While a restore
 * is still in progress the root reports plan/false too.
 */

import { describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { RuntimeSessionHistory } from "./runtime-session-history.js";
import { createHarness, finishStep } from "./test-harness.js";

type Internals = { orchestrationController: { state: { status: string } }; orchestrate: boolean };

function codexSeam(preset: string) {
  return { snapshot: () => ({ model: "m", activePresetId: preset }), pendingSnapshot: () => null,
    models: () => [], presets: () => [], onSettingsApplied: () => () => {} };
}

function nativeCodexPolicy(h: ReturnType<typeof createHarness>, verifyOff: () => Promise<void>) {
  Object.defineProperty(h.engine, "id", { value: "codex" });
  Object.defineProperty(h.engine, "verifyOrchestrationOff", { value: verifyOff });
  Object.defineProperty(h.engine, "orchestrationPolicy", { value: {
    nativeBase: () => ({ version: 1, engine: "codex", model: "m", preset: "ask", configDigest: "a".repeat(64) }),
    availability: () => ({ supported: true }),
    apply: async (enabled: boolean, baseAuthority: unknown) => ({ enabled, baseAuthority }),
  } });
}

describe("Session - native peer authority on real quarantine", () => {
  it("revokes authority at once when a failed Orchestrate-off save quarantines the controller", async () => {
    const store = new SqlitePersistenceAdapter(":memory:");
    await store.createSession({ id: "test-session", workspace: "/workspace", model: "m", mode: "build", engineId: "codex" });
    const history = new RuntimeSessionHistory(store, "test-session");
    history.state();
    const h = createHarness({ steps: [finishStep()], runtimeHistory: history, engineSettings: codexSeam("full-access") as never });
    nativeCodexPolicy(h, async () => {});
    const seen: Array<[string, boolean]> = [];
    let mode = "";
    h.session.observePermissionMode(m => { mode = m; }, enabled => seen.push([mode, enabled]));
    const failure = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.send({ type: "ui_ready", orchestrationProtocol: 1 });
      await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
      const ready = h.received.find(m => m.type === "host_ready") as any;
      const toggle = async (enabled: boolean, requestId: string) => {
        h.send({ type: "set_orchestrate", enabled, requestId, connectionId: ready.orchestrationProtocol.connectionId });
        await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_result" && m.requestId === requestId));
        return h.received.find(m => m.type === "orchestrate_result" && m.requestId === requestId);
      };
      expect(await toggle(true, "on")).toMatchObject({ outcome: "applied" });
      expect(seen.at(-1)).toEqual(["yolo", true]);
      const save = vi.spyOn(history, "settings").mockImplementation(() => { throw new Error("disk full"); });
      expect(await toggle(false, "off")).toMatchObject({ outcome: "unknown" });
      const internals = h.session as unknown as Internals;
      expect(internals.orchestrationController.state.status).toBe("quarantined");
      expect(internals.orchestrate).toBe(false);
      // Revoked at the transition itself, with no further trigger needed.
      expect(seen.at(-1)).toEqual(["plan", false]);
      expect(h.session.peerAuthorityClosed()).toBe(true);
      // A later settings publication stays closed.
      h.outbound.emit({ type: "engine_settings_changed", model: "m", activePresetId: "full-access", state: "applied", appliesFrom: "next_turn" });
      expect(seen.at(-1)).toEqual(["plan", false]);
      save.mockRestore();
    } finally { failure.mockRestore(); h.close(); await store.close(); }
  });

  it("reports plan/false while a saved restore runs and stays closed when restore and recovery both fail", async () => {
    const store = new SqlitePersistenceAdapter(":memory:");
    await store.createSession({ id: "test-session", workspace: "/workspace", model: "m", mode: "build", engineId: "codex" });
    const history = new RuntimeSessionHistory(store, "test-session");
    const active = history.state();
    const saved = { model: "m", mode: "full-access", orchestration: { enabled: true as const, baseMode: "build" as const } };
    store.updateRuntimeSettings("test-session", active.activeSegmentId, saved, saved);
    const h = createHarness({ steps: [finishStep()], runtimeHistory: new RuntimeSessionHistory(store, "test-session"), engineSettings: codexSeam("full-access") as never });
    nativeCodexPolicy(h, async () => { throw new Error("OFF cannot be proven"); });
    const seen: Array<[string, boolean]> = [];
    let mode = "";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.session.observePermissionMode(m => { mode = m; }, enabled => seen.push([mode, enabled]));
    try {
      // Restore has not started yet: the saved overlay already closes authority.
      expect(seen).toEqual([["plan", false]]);
      h.send({ type: "ui_ready", orchestrationProtocol: 1 });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "engine_notice" && m.event.message.includes("Conversation admission is closed") || m.type === "agent_event" && m.event.type === "engine_notice" && m.event.message.includes("requires a verified OFF runtime")));
      expect((h.session as unknown as { orchestrationPosture: string }).orchestrationPosture).toBe("quarantined");
      expect(h.session.peerAuthorityClosed()).toBe(true);
      expect(seen.every(entry => entry[0] === "plan" && entry[1] === false)).toBe(true);
      h.outbound.emit({ type: "engine_settings_changed", model: "m", activePresetId: "full-access", state: "applied", appliesFrom: "next_turn" });
      expect(seen.at(-1)).toEqual(["plan", false]);
    } finally { warn.mockRestore(); error.mockRestore(); await h.session.shutdown(); h.close(); await store.close(); }
  });
});
