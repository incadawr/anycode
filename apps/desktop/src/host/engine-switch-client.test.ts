import { describe, expect, it, vi } from "vitest";
import { commitEngineSwitch, createEngineSwitchClient } from "./engine-switch-client.js";
import { ENGINE_SWITCH_RESPONSE } from "../shared/engine-switch-control.js";
import { EngineSwitchCoordinator } from "../main/engine-switch-coordinator.js";

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

  it("recovers a lost commit reply by querying the same durable transaction", async () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    const unknown = vi.fn((): never => { throw new Error("unknown outcome"); });
    let main!: EngineSwitchCoordinator;
    const client = createEngineSwitchClient(4, message => { void main.handle(message); }, 10);
    main = new EngineSwitchCoordinator({ generation: 4, current: () => true, admissible: () => true,
      prepare: async target => ({ launch: { target, env: {} } }), commit,
      abort: () => {}, retire: () => {}, send: response => { if (response.phase !== "commit") client.handle(response); },
    });
    try {
      await client.request({ phase: "prepare", requestId: "lost-reply", target: { engine: "codex", model: "chosen" } });
      const result = commitEngineSwitch(client, "lost-reply", { model: "chosen", mode: "plan", externalSessionRef: "native" }, unknown);
      await vi.advanceTimersByTimeAsync(10);
      await result;
      expect(commit).toHaveBeenCalledTimes(1);
      expect(unknown).not.toHaveBeenCalled();
    } finally { main.close(); client.close(); vi.useRealTimers(); }
  });

  it("terminates the host when both commit and reconciliation replies are lost", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const unknown = vi.fn((): never => { throw new Error("unknown outcome"); });
    const client = createEngineSwitchClient(4, message => { sent.push(message.phase); }, 10);
    try {
      const result = commitEngineSwitch(client, "unknown", { model: "chosen", mode: "plan" }, unknown);
      const rejected = expect(result).rejects.toThrow("unknown outcome");
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(sent).toEqual(["commit", "status"]);
      expect(unknown).toHaveBeenCalledTimes(1);
    } finally { client.close(); vi.useRealTimers(); }
  });

  it("honors a correlated commit refusal without querying status or terminating", async () => {
    const sent: string[] = [];
    const unknown = vi.fn((): never => { throw new Error("unknown outcome"); });
    const client = createEngineSwitchClient(4, message => {
      sent.push(message.phase);
      client.handle({ ...message, type: ENGINE_SWITCH_RESPONSE, ok: false, reason: "stale candidate" });
    });
    try {
      await expect(commitEngineSwitch(client, "refused", { model: "chosen", mode: "plan" }, unknown)).rejects.toThrow("stale candidate");
      expect(sent).toEqual(["commit"]);
      expect(unknown).not.toHaveBeenCalled();
    } finally { client.close(); }
  });
});
