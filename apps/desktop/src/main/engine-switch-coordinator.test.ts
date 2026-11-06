import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlitePersistenceAdapter } from "@anycode/core";
import { EngineSwitchCoordinator } from "./engine-switch-coordinator.js";
import { ENGINE_SWITCH_CONTROL, type EngineSwitchResponse } from "../shared/engine-switch-control.js";

const target = { engine: "codex" as const, model: "chosen", codexProfileId: "account" };
const identity = { model: "chosen", mode: "read-only", externalSessionRef: "new-thread" };
const message = (phase: "prepare" | "commit" | "abort" | "retire" | "status", requestId = "r", generation = 3) => ({ type: ENGINE_SWITCH_CONTROL, requestId, generation, phase, ...(phase === "prepare" ? { target } : phase === "commit" ? { identity } : {}) });
function harness() {
  const responses: EngineSwitchResponse[] = [];
  const release = vi.fn();
  const deps = { generation: 3, current: () => true, admissible: () => true, prepare: vi.fn(async () => ({ launch: { target, env: { HOME: "/isolated" } }, release })), commit: vi.fn(), abort: vi.fn(), retire: vi.fn(), send: (response: EngineSwitchResponse) => responses.push(response) };
  return { deps, release, responses, coordinator: new EngineSwitchCoordinator(deps) };
}

describe("main-owned engine switch transaction", () => {
  it("holds admission through commit and retirement, committing once", async () => {
    const h = harness();
    await h.coordinator.handle(message("prepare"));
    expect(h.coordinator.acceptsCandidate("r")).toBe(true);
    await h.coordinator.handle(message("prepare"));
    expect(h.responses.at(-1)).toMatchObject({ ok: false, reason: "duplicate request" });
    await h.coordinator.handle(message("status"));
    expect(h.responses.at(-1)).toMatchObject({ phase: "status", ok: false });
    await h.coordinator.handle(message("commit"));
    await h.coordinator.handle(message("status"));
    expect(h.responses.at(-1)).toMatchObject({ phase: "status", ok: true });
    await h.coordinator.handle(message("commit"));
    expect(h.deps.commit).toHaveBeenCalledExactlyOnceWith(target, identity, "r");
    expect(h.coordinator.pending).toBe(true);
    expect(h.coordinator.acceptsCandidate("r")).toBe(false);
    await h.coordinator.handle(message("abort"));
    expect(h.deps.abort).not.toHaveBeenCalled();
    await h.coordinator.handle(message("retire"));
    expect(h.deps.retire).toHaveBeenCalledWith("r");
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.coordinator.pending).toBe(false);
  });

  it("rejects stale generations, unrelated commit ids and raw renderer configuration", async () => {
    const h = harness();
    await h.coordinator.handle(message("prepare", "stale", 2));
    await h.coordinator.handle({ ...message("prepare"), env: { SECRET: "untrusted" } });
    expect(h.deps.prepare).not.toHaveBeenCalled();
    await h.coordinator.handle(message("prepare"));
    await h.coordinator.handle(message("commit", "other"));
    expect(h.deps.commit).not.toHaveBeenCalled();
    await h.coordinator.handle(message("abort"));
    await h.coordinator.handle(message("commit"));
    expect(h.deps.commit).not.toHaveBeenCalled();
  });

  it("releases a late resolution after abort or host death", async () => {
    const h = harness();
    let resolve!: (value: Awaited<ReturnType<typeof h.deps.prepare>>) => void;
    h.deps.prepare.mockImplementation(() => new Promise(r => { resolve = r; }));
    const preparing = h.coordinator.handle(message("prepare"));
    await h.coordinator.handle(message("abort"));
    resolve({ launch: { target, env: { HOME: "/isolated" } }, release: h.release });
    await preparing;
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.coordinator.pending).toBe(false);
    expect(h.deps.commit).not.toHaveBeenCalled();
  });

  it("does not publish success when the durable commit fails", async () => {
    const h = harness();
    h.deps.commit.mockImplementation(() => { throw new Error("disk full"); });
    await h.coordinator.handle(message("prepare"));
    await h.coordinator.handle(message("commit"));
    expect(h.responses.at(-1)).toMatchObject({ phase: "commit", ok: false });
    expect(h.deps.abort).toHaveBeenCalledWith("r");
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("retains the committed outcome when posting its acknowledgement throws", async () => {
    const h = harness();
    h.deps.send = response => {
      if (response.phase === "commit") throw new Error("host transport closed");
      return h.responses.push(response);
    };
    await h.coordinator.handle(message("prepare"));
    await h.coordinator.handle(message("commit"));
    await h.coordinator.handle(message("status"));
    expect(h.responses.at(-1)).toMatchObject({ phase: "status", ok: true });
    expect(h.deps.commit).toHaveBeenCalledTimes(1);
    expect(h.deps.abort).not.toHaveBeenCalled();
    await h.coordinator.handle(message("retire"));
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("rechecks child admission after target resolution", async () => {
    const h = harness();
    let checks = 0;
    h.deps.admissible = () => ++checks === 1;
    await h.coordinator.handle(message("prepare"));
    expect(h.responses.at(-1)).toMatchObject({ ok: false });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.coordinator.pending).toBe(false);
  });
});

describe("durable engine identity mirror", () => {
  it("atomically replaces engine, model, native ref and pin while preserving the session", async () => {
    const root = mkdtempSync(join(tmpdir(), "engine-identity-"));
    const store = new SqlitePersistenceAdapter(join(root, "session.sqlite"));
    try {
      await store.createSession({ id: "session", workspace: "/workspace", title: "Keep me", model: "old", mode: "build", connectionId: "old-pin" });
      store.commitEngineIdentity("session", "core", { engine: "codex", ...identity, codexProfileId: "account" });
      expect(await store.getRootSession("session")).toMatchObject({ title: "Keep me", workspace: "/workspace", model: "chosen", engineId: "codex", externalSessionRef: "new-thread", codexProfileId: "account" });
      expect((await store.getRootSession("session"))?.connectionId).toBeUndefined();
      expect(() => store.commitEngineIdentity("session", "core", { engine: "claude", ...identity })).toThrow("Source session identity changed");
      store.commitEngineIdentity("session", "codex", { engine: "core", model: "next", mode: "plan", connectionId: "new-pin" });
      const row = await store.getRootSession("session");
      expect(row).toMatchObject({ model: "next", engineId: "core", connectionId: "new-pin" });
      expect(row?.externalSessionRef).toBeUndefined();
      expect(row?.codexProfileId).toBeUndefined();
    } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
