import { describe, expect, it, vi } from "vitest";
import { coreOrchestrationPolicy, orchestrationAvailability, OrchestrationController, type OrchestrationPolicy } from "./orchestration-policy.js";

describe("orchestration policy", () => {
  it("treats an absent seam as unavailable", async () => {
    expect(orchestrationAvailability()).toEqual({ supported: false, reason: "unavailable" });
    const controller = new OrchestrationController();
    expect(await controller.apply(true, "build")).toBe(false);
    expect(controller.state.status).toBe("off");
  });

  it("restores the core base mode and notifies the existing callback", async () => {
    let mode: "build" | "plan" = "build";
    const changed = vi.fn();
    const policy = coreOrchestrationPolicy({ mode: () => mode, setMode: value => { mode = value as typeof mode; }, onChanged: changed });
    const controller = new OrchestrationController(policy);
    expect(await controller.apply(true, mode)).toBe(true);
    expect(mode).toBe("plan");
    expect(await controller.apply(false, "plan")).toBe(true);
    expect(mode).toBe("build");
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });

  it("quarantines failed or unconfirmed application", async () => {
    for (const apply of [async () => { throw new Error("failed"); }, async () => ({ enabled: false, baseAuthority: "build" })]) {
      const controller = new OrchestrationController({ availability: () => ({ supported: true }), apply });
      expect(await controller.apply(true, "build")).toBe(false);
      expect(controller.state.status).toBe("quarantined");
      expect(await controller.apply(true, "build")).toBe(false);
    }
  });

  it("does not publish a late result after invalidation", async () => {
    let resolve!: (value: { enabled: boolean; baseAuthority: unknown }) => void;
    const policy: OrchestrationPolicy = { availability: () => ({ supported: true }), apply: () => new Promise(r => { resolve = r; }) };
    const controller = new OrchestrationController(policy);
    const pending = controller.apply(true, "build");
    expect(controller.state.status).toBe("transitioning");
    controller.invalidate();
    resolve({ enabled: true, baseAuthority: "build" });
    expect(await pending).toBe(false);
    expect(controller.state.status).toBe("quarantined");
  });
});
