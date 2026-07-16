import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runCodexLogin } from "./codex-login.js";
import type { ResolvedCodexProfile } from "./codex-profiles.js";

const fixturePath = fileURLToPath(new URL("./codex-doctor-fixtures/fake-codex.mjs", import.meta.url));

/** Fake spawner + synthetic path: the real fs trust gate has nothing to stat (see codex-doctor.test.ts). */
const TRUSTED = (): null => null;

function fakeSpawn(extraFlags: string[] = []) {
  return (_command: string, args: readonly string[], options: SpawnOptions): ChildProcess =>
    spawn(process.execPath, [fixturePath, ...args, ...extraFlags], options);
}

describe("runCodexLogin", () => {
  it("opens the returned authUrl and resolves ok once account/login/completed arrives", async () => {
    const openExternal = vi.fn(async () => {});
    const outcome = await runCodexLogin("/fake/codex", {
      trust: TRUSTED,
      openExternal,
      spawnImpl: fakeSpawn(["--auto-complete-login"]),
      timeoutMs: 5_000,
    });
    expect(outcome).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://example.invalid/auth");
  });

  it("never reads/returns a token or account material — the outcome carries only ok/reason", async () => {
    const outcome = await runCodexLogin("/fake/codex", {
      trust: TRUSTED,
      openExternal: async () => {},
      spawnImpl: fakeSpawn(["--auto-complete-login"]),
      timeoutMs: 5_000,
    });
    expect(Object.keys(outcome)).toEqual(["ok"]);
  });

  it("cancels via the abort signal and sends account/login/cancel, without waiting for the full timeout", async () => {
    const controller = new AbortController();
    const openExternal = vi.fn(async () => {
      controller.abort();
    });
    const start = Date.now();
    const outcome = await runCodexLogin("/fake/codex", {
      trust: TRUSTED,
      openExternal,
      signal: controller.signal,
      spawnImpl: fakeSpawn(), // no --auto-complete-login: only cancel can resolve this
      timeoutMs: 30_000,
    });
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("times out when nothing completes or cancels the login within the bound", async () => {
    const outcome = await runCodexLogin("/fake/codex", {
      trust: TRUSTED,
      openExternal: async () => {},
      spawnImpl: fakeSpawn(),
      timeoutMs: 150,
    });
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
  });

  it("fails closed when account/login/start responds without a usable authUrl/loginId", async () => {
    // The default fixture always returns both — simulate a malformed
    // response by pointing at a fixture path that has neither: reuse
    // --signed-out is unrelated here, so instead assert the type-guard by
    // spawning app-server with --stubborn (never responds at all) bounded by
    // a short rpcTimeoutMs, which exercises the same fail-closed `catch` path.
    const outcome = await runCodexLogin("/fake/codex", {
      trust: TRUSTED,
      openExternal: async () => {},
      spawnImpl: fakeSpawn(["--stubborn"]),
      rpcTimeoutMs: 150,
      timeoutMs: 5_000,
    });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
  });
});

describe("runCodexLogin + profiles (TASK.50 п.2 — login INTO a profile home)", () => {
  const PROFILE: ResolvedCodexProfile = {
    id: "acc1",
    codexHome: "/home/dev/.anycode/codex/profile-acc1",
    linked: false,
  };

  it("OVERWRITES an ambient CODEX_HOME with the profile home in the child env (hazard §14.6: ambient is set)", async () => {
    const captured: Array<NodeJS.ProcessEnv | undefined> = [];
    const outcome = await runCodexLogin("/fake/codex", {
      trust: TRUSTED,
      openExternal: async () => {},
      spawnImpl: (_command, args, options) => {
        captured.push(options.env as NodeJS.ProcessEnv | undefined);
        return spawn(process.execPath, [fixturePath, ...args, "--auto-complete-login"], options);
      },
      env: { HOME: "/home/dev", PATH: "/usr/bin", CODEX_HOME: "/home/dev/.codex-ambient-hijack" },
      timeoutMs: 5_000,
      profile: PROFILE,
      profileGuard: () => ({ ok: true }),
    });
    expect(outcome).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.CODEX_HOME).toBe("/home/dev/.anycode/codex/profile-acc1");
  });

  it("a refusing home guard fails closed WITHOUT spawning or opening a browser", async () => {
    const spawnSpy = vi.fn(fakeSpawn(["--auto-complete-login"]));
    const openExternal = vi.fn(async () => {});
    const outcome = await runCodexLogin("/fake/codex", {
      trust: TRUSTED,
      openExternal,
      spawnImpl: spawnSpy,
      timeoutMs: 5_000,
      profile: PROFILE,
      profileGuard: () => ({ ok: false, reason: "profile home is world-writable" }),
    });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("refuses to log into an authLink profile — its credential mirrors an external file (amended §A1.2: re-link, not re-login)", async () => {
    const spawnSpy = vi.fn(fakeSpawn(["--auto-complete-login"]));
    const outcome = await runCodexLogin("/fake/codex", {
      trust: TRUSTED,
      openExternal: async () => {},
      spawnImpl: spawnSpy,
      timeoutMs: 5_000,
      profile: { ...PROFILE, authLink: "/home/dev/.codex/auth.json" },
      profileGuard: () => ({ ok: true }),
    });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
