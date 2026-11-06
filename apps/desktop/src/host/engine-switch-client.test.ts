import { describe, expect, it } from "vitest";
import { createEngineSwitchClient } from "./engine-switch-client.js";
import { ENGINE_SWITCH_RESPONSE } from "../shared/engine-switch-control.js";

describe("authenticated engine switch client", () => {
  it("correlates phase, request id and host generation and rejects duplicate RPCs", async () => {
    const client = createEngineSwitchClient(4, () => {});
    const result = client.request({ phase: "abort", requestId: "r" });
    await expect(client.request({ phase: "abort", requestId: "r" })).rejects.toThrow("duplicate");
    let settled = false;
    void result.then(() => { settled = true; });
    client.handle({ type: ENGINE_SWITCH_RESPONSE, phase: "abort", requestId: "r", generation: 3, ok: true });
    client.handle({ type: ENGINE_SWITCH_RESPONSE, phase: "retire", requestId: "r", generation: 4, ok: true });
    await Promise.resolve();
    expect(settled).toBe(false);
    client.handle({ type: ENGINE_SWITCH_RESPONSE, phase: "abort", requestId: "r", generation: 4, ok: true });
    expect(await result).toMatchObject({ ok: true });
    client.close();
  });
});
