import { describe, expect, it, vi } from "vitest";
import { OrchestrationAdmission } from "./orchestration-admission.js";
import { OrchestrationController, type OrchestrationSnapshot } from "./orchestration-policy.js";

function setup() {
  let connection: string | null = "one";
  let busy = false;
  let finish!: (snapshot: OrchestrationSnapshot) => void;
  const apply = vi.fn(() => new Promise<OrchestrationSnapshot>(resolve => { finish = resolve; }));
  const controller = new OrchestrationController({ availability: () => ({ supported: true }), apply });
  const gate = new OrchestrationAdmission({ controller, connectionId: () => connection, busy: () => busy, baseAuthority: () => "build", timeoutMs: 20 });
  return { gate, controller, apply, finish: () => finish({ enabled: true, baseAuthority: "build" }), disconnect: () => { connection = null; }, setBusy: () => { busy = true; } };
}

describe("orchestration admission", () => {
  it("applies before admitting exactly once and deduplicates in flight and settled", async () => {
    const h = setup(); const admit = vi.fn();
    const first = h.gate.submit("id", "one", admit);
    const duplicate = h.gate.submit("id", "one", admit);
    expect(admit).not.toHaveBeenCalled();
    expect(await h.gate.submit("second", "one", admit)).toEqual({ outcome: "rejected", reason: "busy" });
    h.finish();
    expect(await first).toEqual({ outcome: "applied", enabled: true });
    expect(await duplicate).toEqual(await first);
    expect(await h.gate.submit("id", "one", admit)).toEqual(await first);
    expect(h.apply).toHaveBeenCalledTimes(1); expect(admit).toHaveBeenCalledTimes(1);
    expect(await h.gate.toggle("id", "one", false)).toEqual({ kind: "frame_diagnostic", reason: "conflict" });
  });
  it("diagnoses a conflicting frame while the original request is pending", async () => {
    const h = setup(); const admit = vi.fn();
    const original = h.gate.submit("id", "one", admit);
    expect(await h.gate.toggle("id", "one", false)).toEqual({ kind: "frame_diagnostic", reason: "conflict" });
    expect(admit).not.toHaveBeenCalled();
    h.finish();
    expect(await original).toEqual({ outcome: "applied", enabled: true });
    expect(await h.gate.submit("id", "one", admit)).toEqual(await original);
    expect(admit).toHaveBeenCalledTimes(1);
  });
  it("diagnoses a conflicting frame after the original turn started", async () => {
    const h = setup(); const admit = vi.fn();
    const original = h.gate.submit("id", "one", admit); h.finish();
    expect(await original).toEqual({ outcome: "applied", enabled: true });
    expect(await h.gate.toggle("id", "one", false)).toEqual({ kind: "frame_diagnostic", reason: "conflict" });
    expect(await h.gate.submit("id", "one", admit)).toEqual(await original);
    expect(admit).toHaveBeenCalledTimes(1);
  });
  it("diagnoses a conflicting frame without replacing an unknown outcome", async () => {
    const h = setup(); const admit = vi.fn();
    const original = h.gate.submit("id", "one", admit); h.disconnect(); h.finish();
    expect(await original).toEqual({ outcome: "unknown", reason: "disconnected" });
    expect(await h.gate.toggle("id", "one", false)).toEqual({ kind: "frame_diagnostic", reason: "conflict" });
    expect(await h.gate.submit("id", "one", admit)).toEqual(await original);
    expect(admit).not.toHaveBeenCalled();
  });
  it("refuses unavailable, busy, stale and bounded ledger without applying", async () => {
    const h = setup(); const admit = vi.fn();
    expect(await h.gate.submit("stale", "old", admit)).toMatchObject({ outcome: "rejected", reason: "stale" });
    h.setBusy();
    expect(await h.gate.submit("busy", "one", admit)).toMatchObject({ outcome: "rejected", reason: "busy" });
    expect(h.apply).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
  });
  it("refuses unavailable policy and stops at ledger capacity", async () => {
    const controller = new OrchestrationController();
    const gate = new OrchestrationAdmission({ controller, connectionId: () => "one", busy: () => false, baseAuthority: () => "build", timeoutMs: 20, maxRequests: 1 });
    expect(await gate.toggle("first", "one", true)).toEqual({ outcome: "rejected", reason: "unavailable" });
    expect(await gate.toggle("next", "one", true)).toEqual({ outcome: "rejected", reason: "capacity" });
  });
  it("reports an unconfirmed policy failure as unknown", async () => {
    const controller = new OrchestrationController({ availability: () => ({ supported: true }), apply: async () => { throw new Error("failed"); } });
    const gate = new OrchestrationAdmission({ controller, connectionId: () => "one", busy: () => false, baseAuthority: () => "build", timeoutMs: 20 });
    const admit = vi.fn();
    expect(await gate.submit("id", "one", admit)).toEqual({ outcome: "unknown", reason: "unconfirmed" });
    expect(controller.state.status).toBe("quarantined"); expect(admit).not.toHaveBeenCalled();
  });
  it("quarantines timeout and never admits on late completion", async () => {
    const h = setup(); const admit = vi.fn();
    const result = h.gate.submit("id", "one", admit);
    expect(await result).toEqual({ outcome: "unknown", reason: "timeout" });
    h.finish(); await Promise.resolve();
    expect(h.controller.state.status).toBe("quarantined"); expect(admit).not.toHaveBeenCalled();
  });
  it("returns unknown and does not admit after disconnect during apply", async () => {
    const h = setup(); const admit = vi.fn();
    const result = h.gate.submit("id", "one", admit); h.disconnect(); h.finish();
    expect(await result).toEqual({ outcome: "unknown", reason: "disconnected" });
    expect(admit).not.toHaveBeenCalled();
    expect(await h.gate.submit("id", "one", admit)).toEqual(await result);
  });
  it("does not claim rejection when admission may have started before disconnect", async () => {
    const h = setup();
    const result = h.gate.submit("id", "one", () => h.disconnect()); h.finish();
    expect(await result).toEqual({ outcome: "unknown", reason: "disconnected" });
  });
});
