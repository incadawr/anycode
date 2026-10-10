import { describe, expect, it, vi } from "vitest";
import { createChildConnectionPreparer } from "./child-connection-preparation.js";

/**
 * Taskana 4269 §3 item 11/12: the ACTUAL preparation composition extracted from
 * main/index.ts. These tests pin the ordering that the protocol depends on:
 * the pin reservation is synchronous and PRECEDES the awaited env build, a
 * missing id never reserves, and every failure path releases exactly once.
 */

function rig(overrides: Partial<Parameters<typeof createChildConnectionPreparer>[0]> = {}) {
  const reserve = vi.fn();
  const release = vi.fn();
  const deps = {
    connectionExists: vi.fn(() => true),
    reserve,
    release,
    ensurePinnedEnv: vi.fn(async () => {}),
    hostEnvAvailable: vi.fn(() => true),
    ...overrides,
  };
  return { deps, reserve, release, prepare: createChildConnectionPreparer(deps) };
}

describe("createChildConnectionPreparer — actual main composition (Taskana 4269)", () => {
  it("reserves SYNCHRONOUSLY, before the awaited env build", async () => {
    let releaseEnvBuild!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseEnvBuild = resolve;
    });
    const { prepare, reserve, release } = rig({ ensurePinnedEnv: vi.fn(() => gate) });

    const pending = prepare("conn-1");
    // The reservation is already visible while the env build is still pending.
    expect(reserve).toHaveBeenCalledWith("conn-1");
    expect(release).not.toHaveBeenCalled();

    releaseEnvBuild();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) result.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a missing id never reserves and fails closed", async () => {
    const { prepare, reserve, release, deps } = rig({ connectionExists: vi.fn(() => false) });

    const result = await prepare("conn-missing");

    expect(result).toEqual({ ok: false });
    expect(reserve).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(deps.ensurePinnedEnv).not.toHaveBeenCalled();
  });

  it("a successful preparation holds the pin until release(), and release is idempotent", async () => {
    const { prepare, release } = rig();

    const result = await prepare("conn-2");

    expect(result.ok).toBe(true);
    expect(release).not.toHaveBeenCalled(); // held, not released, on success
    if (result.ok) {
      result.release();
      result.release();
    }
    expect(release).toHaveBeenCalledTimes(1); // exactly once despite two calls
  });

  it("a rejected env build releases exactly once and fails closed", async () => {
    const { prepare, release } = rig({
      ensurePinnedEnv: vi.fn(async () => {
        throw new Error("env build failed");
      }),
    });

    const result = await prepare("conn-3");

    expect(result).toEqual({ ok: false });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a post-await missing id releases exactly once and fails closed", async () => {
    // Exists for the initial check, gone after the await.
    const connectionExists = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const { prepare, release } = rig({ connectionExists });

    const result = await prepare("conn-4");

    expect(result).toEqual({ ok: false });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("an unavailable env after a successful build releases exactly once and fails closed", async () => {
    const { prepare, release } = rig({ hostEnvAvailable: vi.fn(() => false) });

    const result = await prepare("conn-5");

    expect(result).toEqual({ ok: false });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
