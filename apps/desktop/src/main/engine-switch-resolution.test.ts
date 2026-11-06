import { describe, expect, it, vi } from "vitest";
import { resolveEngineSwitchTarget } from "./engine-switch-resolution.js";

describe("engine switch target resolution", () => {
  it("rejects renderer-supplied configuration before calling privileged resolvers", async () => {
    const deps = { ready: vi.fn(), resolve: vi.fn() };
    expect(await resolveEngineSwitchTarget({ engine: "core", model: "m", connectionId: "c", config: {} }, deps)).toEqual({ ok: false, reason: "invalid_target" });
    expect(deps.ready).not.toHaveBeenCalled();
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it("uses the resolved configuration only after readiness succeeds", async () => {
    const target = { engine: "codex", model: "m", codexProfileId: "p" };
    const deps = { ready: vi.fn().mockResolvedValue(true), resolve: vi.fn().mockResolvedValue({ profile: "resolved" }) };
    expect(await resolveEngineSwitchTarget(target, deps)).toEqual({ ok: true, target, config: { profile: "resolved" } });
    expect(deps.resolve).toHaveBeenCalledWith(target);
  });

  it("fails closed on unready, missing or failing configuration", async () => {
    const target = { engine: "claude", model: "m" };
    const resolve = vi.fn().mockResolvedValue(undefined);
    expect(await resolveEngineSwitchTarget(target, { ready: async () => false, resolve })).toEqual({ ok: false, reason: "not_ready" });
    expect(resolve).not.toHaveBeenCalled();
    expect(await resolveEngineSwitchTarget(target, { ready: async () => true, resolve })).toEqual({ ok: false, reason: "not_ready" });
    expect(await resolveEngineSwitchTarget(target, { ready: async () => { throw new Error("unavailable"); }, resolve })).toEqual({ ok: false, reason: "not_ready" });
  });
});
