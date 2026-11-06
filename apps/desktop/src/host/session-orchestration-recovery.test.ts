import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlitePersistenceAdapter, type RuntimeSettings } from "@anycode/core";
import type { HostToUiMessage } from "../shared/protocol.js";
import { RuntimeSessionHistory, createRuntimeSessionHistory } from "./runtime-session-history.js";
import { bindRuntimeOrchestration } from "./runtime-orchestration.js";
import { createHarness, finishStep } from "./test-harness.js";

type Of<T extends HostToUiMessage["type"]> = Extract<HostToUiMessage, { type: T }>;
const nativeBase = { version: 1 as const, engine: "claude" as const, model: "m", preset: "read-only" as const,
  permissionMode: "plan" as const, mcpDigest: "a".repeat(64), tools: ["Read"] };
const saved: RuntimeSettings = { model: "m", mode: "read-only", orchestration: { enabled: true, baseMode: "plan", nativeBase } };
afterEach(() => vi.restoreAllMocks());
async function savedStore() {
  const store = new SqlitePersistenceAdapter(":memory:");
  await store.createSession({ id: "test-session", workspace: "/workspace", model: "m", mode: "plan", engineId: "claude" });
  const state = store.ensureRuntimeSession("test-session");
  store.updateRuntimeSettings("test-session", state.activeSegmentId, saved, saved);
  return store;
}
function reopen(store: SqlitePersistenceAdapter, options: { available?: boolean; failApply?: boolean; rollback?: boolean; proof?: boolean; hold?: Promise<void>; failSave?: boolean } = {}) {
  const history = createRuntimeSessionHistory(store, "test-session", false) ?? new RuntimeSessionHistory(store, "test-session");
  let posture = "off";
  const h = createHarness({ steps: [finishStep()], runtimeHistory: history });
  Object.defineProperty(h.engine, "id", { value: "claude" });
  const verify = vi.fn(async () => { await options.hold; if (options.proof === false || posture !== "off") throw new Error("OFF proof unavailable"); });
  const apply = vi.fn(async (enabled: boolean, baseAuthority: unknown) => {
    if (enabled) { posture = options.failApply ? "unknown" : "on"; if (options.failApply) throw new Error("partial apply"); }
    else { if (!options.rollback) throw new Error("rollback refused"); posture = "off"; }
    return { enabled, baseAuthority };
  });
  Object.defineProperty(h.engine, "verifyOrchestrationOff", { value: verify });
  Object.defineProperty(h.engine, "orchestrationPolicy", { value: {
    availability: () => options.available ? { supported: true } : { supported: false, reason: "unavailable" },
    nativeBase: () => posture === "on" ? nativeBase : undefined, apply } });
  bindRuntimeOrchestration(h.engine, { ownerSessionId: "test-session", port: { hasRunningChildren: () => false, cancelAllBackgroundChildren() {} }, baseMode: () => "plan" });
  const write = vi.spyOn(history, "settings");
  if (options.failSave) write.mockImplementationOnce(() => { throw new Error("disk full"); });
  const boot = async () => {
    h.send({ type: "ui_ready", orchestrationProtocol: 1 });
    return h.waitFor((m): m is Of<"host_ready"> => m.type === "host_ready");
  };
  return { h, history, verify, apply, write, boot };
}
async function blocked(h: ReturnType<typeof createHarness>) {
  for (const origin of [undefined, "system"] as const) {
    h.send({ type: "user_message", requestId: origin ?? "owner", text: "message", ...(origin ? { origin } : {}) });
    await h.waitFor((m): m is Of<"user_message_unavailable"> => m.type === "user_message_unavailable" && m.requestId === (origin ?? "owner"));
  }
}
describe("durable orchestration restore", () => {
  it.each(["flag off", "capability mismatch"])("clears unavailable intent only after proof, admits chat and reopens without a loop: %s", async () => {
    const store = await savedStore();
    const first = reopen(store);
    try {
      expect(await first.boot()).toMatchObject({ orchestration: { enabled: false, posture: "off" } });
      expect(first.verify).toHaveBeenCalled(); expect(first.apply).not.toHaveBeenCalled();
      expect(first.write).toHaveBeenCalledTimes(1);
      expect(first.history.state().segments[0]!.applied.orchestration).toBeUndefined();
      first.h.send({ type: "user_message", requestId: "ordinary", text: "continue" });
      await first.h.waitFor((m): m is Of<"turn_started"> => m.type === "turn_started" && m.requestId === "ordinary");
      await first.h.waitUntil(() => first.h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      await first.h.session.shutdown(); first.h.close();
      expect(createRuntimeSessionHistory(store, "test-session", false)).toBeUndefined();
      const second = reopen(store);
      try {
        expect(await second.boot()).toMatchObject({ orchestration: { enabled: false, posture: "off" } });
        expect(second.verify).not.toHaveBeenCalled(); expect(second.write).not.toHaveBeenCalled();
      } finally { second.h.close(); }
    } finally { first.h.close(); await store.close(); }
  });
  it("keeps owner and report admission closed until OFF proof and checked clear finish", async () => {
    const store = await savedStore();
    let release!: () => void;
    const r = reopen(store, { hold: new Promise<void>(resolve => { release = resolve; }) });
    try {
      const ready = r.boot();
      const run = vi.spyOn(r.h.engine, "runTurn");
      r.h.send({ type: "user_message", requestId: "queued-owner", text: "work" });
      r.h.send({ type: "user_message", requestId: "queued-report", text: "report", origin: "system" });
      await r.h.flush();
      expect(run).not.toHaveBeenCalled();
      expect(r.write).not.toHaveBeenCalled();
      release();
      expect(await ready).toMatchObject({ orchestration: { posture: "off" } });
      expect(r.write).toHaveBeenCalledTimes(1);
      await r.h.waitUntil(() => run.mock.calls.length > 0);
    } finally { release(); await r.h.session.shutdown(); r.h.close(); await store.close(); }
  });
  it.each(["proof", "clear save", "ON save"])("preserves durable ON and quarantines a failed %s", async failure => {
    const store = await savedStore();
    const before = store.loadRuntimeSession("test-session");
    const r = reopen(store, { available: failure === "ON save", rollback: true, proof: failure !== "proof", failSave: failure !== "proof" });
    try {
      expect(await r.boot()).toMatchObject({ orchestration: { available: false, posture: "quarantined" } });
      expect(store.loadRuntimeSession("test-session")).toEqual(before);
      expect(r.write).toHaveBeenCalledTimes(failure === "proof" ? 0 : 1);
      await blocked(r.h);
      expect(r.h.received.some(m => m.type === "agent_event" && m.event.type === "engine_notice" && m.event.message.includes("You can continue"))).toBe(false);
    } finally { r.h.close(); await store.close(); }
  });
  it.each([false, true])("requires a verified rollback after partial apply, rollback=%s", async rollback => {
    const store = await savedStore();
    const r = reopen(store, { available: true, failApply: true, rollback });
    try {
      expect(await r.boot()).toMatchObject({ orchestration: { enabled: false, posture: rollback ? "off" : "quarantined" } });
      expect(r.apply.mock.calls.map(call => call[0])).toEqual([true, false]);
      expect(r.write).toHaveBeenCalledTimes(rollback ? 1 : 0);
      if (!rollback) await blocked(r.h);
    } finally { r.h.close(); await store.close(); }
  });
  it.each(["legacy", "unknown version", "wrong engine"])("clears %s metadata only through proved OFF, without attempting ON", async kind => {
    const store = await savedStore();
    const value = { ...saved, orchestration: { ...saved.orchestration!, nativeBase: kind === "legacy" ? undefined
      : { ...nativeBase, ...(kind === "wrong engine" ? { engine: "codex" } : { version: 99 }) } } };
    // Emulate an older/newer binary's JSON writer; the new checked writer rejects these payloads.
    const db = (store as unknown as { open(): DatabaseSync }).open();
    db.prepare("UPDATE runtime_segments SET selected_json=?,applied_json=?").run(JSON.stringify(value),JSON.stringify(value));
    const r = reopen(store, { available: true });
    try {
      expect(await r.boot()).toMatchObject({ orchestration: { enabled: false, posture: "off" } });
      expect(r.apply).not.toHaveBeenCalled();
      expect(r.verify).toHaveBeenCalled(); expect(r.write).toHaveBeenCalledTimes(1);
      expect(r.history.state().segments[0]!.applied.orchestration).toBeUndefined();
    } finally { r.h.close(); await store.close(); }
  });
  it("restores verified ON and commits nativeBase before reporting enabled", async () => {
    const store = await savedStore();
    const r = reopen(store, { available: true });
    try {
      expect(await r.boot()).toMatchObject({ orchestration: { enabled: true, posture: "on" } });
      expect(r.verify).toHaveBeenCalledTimes(1);
      expect(r.write).toHaveBeenCalledTimes(1);
      expect(r.history.state().segments[0]!.applied.orchestration).toEqual(saved.orchestration);
    } finally { r.h.close(); await store.close(); }
  });
});
