import { describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter, type RuntimeSettings } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import { RuntimeSessionHistory, createRuntimeSessionHistory } from "./runtime-session-history.js";
import { createHarness, finishStep } from "./test-harness.js";

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;
async function setup(native: boolean, offProof: () => Promise<void> = async () => {}) {
  const store = new SqlitePersistenceAdapter(":memory:");
  await store.createSession({ id: "test-session", workspace: "/workspace", model: "m", mode: "plan", engineId: native ? "claude" : "core" });
  const history = new RuntimeSessionHistory(store, "test-session");
  history.state();
  const h = createHarness({ steps: [finishStep()], runtimeHistory: history });
  if (native) {
    Object.defineProperty(h.engine, "id", { value: "claude" });
    Object.defineProperty(h.engine, "verifyOrchestrationOff", { value: offProof });
    Object.defineProperty(h.engine, "orchestrationPolicy", { value: { nativeBase: () => ({ version: 1, engine: "claude", model: "m", preset: "read-only", permissionMode: "plan", mcpDigest: "a".repeat(64), tools: ["Read"] }), availability: () => ({ supported: true }),
      apply: async (enabled: boolean, baseAuthority: unknown) => ({ enabled, baseAuthority }) } });
  }
  h.send({ type: "ui_ready", orchestrationProtocol: 1 });
  const ready = await h.waitFor((m): m is Of<"host_ready"> => m.type === "host_ready");
  const toggle = async (enabled: boolean, requestId: string) => {
    h.send({ type: "set_orchestrate", enabled, requestId, connectionId: ready.orchestrationProtocol!.connectionId });
    return h.waitFor((m): m is Of<"orchestrate_result"> => m.type === "orchestrate_result" && m.requestId === requestId);
  };
  return { h, store, history, toggle };
}
describe("checked orchestration settings", () => {
  it.each([false, true])("quarantines failed ON and OFF writes, native=%s", async native => {
    for (const failingOn of [true, false]) {
      const { h, store, history, toggle } = await setup(native);
      try {
        if (!failingOn) expect(await toggle(true, "on")).toMatchObject({ outcome: "applied" });
        const before = history.state();
        const write = vi.spyOn(history, "settings").mockImplementation(() => { throw new Error("disk full"); });
        const index = h.received.length;
        expect(await toggle(failingOn, "failed")).toMatchObject({ outcome: "unknown" });
        expect(h.received.slice(index).some(m => m.type === "orchestrate_changed")).toBe(false);
        expect(history.state()).toEqual(before);
        // A late best-effort acknowledgement cannot clear durable intent in quarantine.
        (h.session as unknown as { persistRuntimeSettings(): void }).persistRuntimeSettings();
        expect(write).toHaveBeenCalledTimes(1);
        h.send({ type: "user_message", requestId: "blocked", text: "hello" });
        await h.waitFor((m): m is Of<"user_message_unavailable"> => m.type === "user_message_unavailable" && m.requestId === "blocked");
        write.mockRestore();
      } finally { h.close(); await store.close(); }
    }
  });
  it("uses plan when a core overlay has lost its captured base", async () => {
    const { h, store, toggle } = await setup(false);
    try {
      expect(await toggle(true, "on")).toMatchObject({ outcome: "applied" });
      (h.session as unknown as { preOrchestrateMode: null }).preOrchestrateMode = null;
      expect(h.session.childSpawnMode()).toBe("plan");
      expect(await toggle(false, "off")).toMatchObject({ outcome: "applied" });
      expect(h.engine.mode()).toBe("plan");
    } finally { h.close(); await store.close(); }
  });
  it("does not commit a late OFF proof after shutdown", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const proof = vi.fn(() => gate);
    const { h, store, history, toggle } = await setup(true, proof);
    try {
      expect(await toggle(true, "on")).toMatchObject({ outcome: "applied" });
      const before = history.state();
      const ready = h.received.find((m): m is Of<"host_ready"> => m.type === "host_ready")!;
      h.send({ type: "set_orchestrate", enabled: false, requestId: "late", connectionId: ready.orchestrationProtocol!.connectionId });
      await h.waitUntil(() => proof.mock.calls.length === 1);
      const shutdown = h.session.shutdown();
      release(); await shutdown; await h.flush();
      expect(history.state()).toEqual(before);
      expect(h.received.some(m => m.type === "orchestrate_result" && m.requestId === "late" && m.outcome === "applied")).toBe(false);
    } finally { release(); h.close(); await store.close(); }
  });
  it("commits both projections before publishing applied", async () => {
    const { h, store, history, toggle } = await setup(true);
    try {
      expect(await toggle(true, "on")).toMatchObject({ outcome: "applied" });
      const active = () => history.state().segments[0]!;
      expect(active().selected.orchestration).toEqual(active().applied.orchestration);
      expect(active().applied.orchestration?.enabled).toBe(true);
      expect(active().applied.orchestration?.nativeBase).toMatchObject({ version: 1, engine: "claude", preset: "read-only" });
      const before = active();
      (h.session as unknown as { persistRuntimeSettings(): void }).persistRuntimeSettings();
      expect(active()).toEqual(before);
      expect(await toggle(false, "off")).toMatchObject({ outcome: "applied" });
      expect(active().selected.orchestration).toBeUndefined();
      expect(active().applied.orchestration).toBeUndefined();
    } finally { h.close(); await store.close(); }
  });
  it("loads saved ON at revision zero with both flags off and leaves legacy sessions lazy", async () => {
    const store = new SqlitePersistenceAdapter(":memory:");
    try {
      await store.createSession({ id: "s", workspace: "/workspace", model: "m", mode: "plan", engineId: "claude" });
      expect(createRuntimeSessionHistory(store, "s", false)).toBeUndefined();
      expect(createRuntimeSessionHistory(store, "s", true)).toBeDefined();
      const state = store.ensureRuntimeSession("s");
      expect(state.revision).toBe(0);
      const on: RuntimeSettings = { model: "m", mode: "read-only", orchestration: { enabled: true, baseMode: "plan" } };
      store.updateRuntimeSettings("s", state.activeSegmentId, on, on);
      expect(createRuntimeSessionHistory(store, "s", false)).toBeDefined();
      expect(createRuntimeSessionHistory(store, "s", false, true)).toBeUndefined();
      store.updateRuntimeSettings("s", state.activeSegmentId, { model: "m", mode: "read-only" }, { model: "m", mode: "read-only" });
      expect(createRuntimeSessionHistory(store, "s", false)).toBeUndefined();
    } finally { await store.close(); }
  });
});
