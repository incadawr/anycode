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
    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
    // Taskana 4884: a timeout now says WHICH bound expired and for how long.
    expect(outcome.ok === false && outcome.detail).toContain("login did not complete");
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
    expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    // Taskana 4884: the transport error is no longer swallowed — it is the
    // breadcrumb that says WHY the handshake died.
    expect(outcome.ok === false && outcome.detail).toContain("timed out");
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
    expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    // The guard's own words reach the user, not a bare "failed".
    expect(outcome.ok === false && outcome.detail).toContain("profile home is world-writable");
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
    expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    expect(outcome.ok === false && outcome.detail).toContain("authLink");
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});


describe("Codex device-code login", () => {
  it("publishes the code and verification URL and waits for completion", async () => {
    const onDeviceCode = vi.fn();
    const openExternal = vi.fn();
    expect(await runCodexLogin("/fake/codex", {
      mode: "device", trust: TRUSTED, onDeviceCode, openExternal,
      spawnImpl: fakeSpawn(["--auto-complete-login"]), timeoutMs: 1000,
    })).toEqual({ ok: true });
    expect(onDeviceCode).toHaveBeenCalledExactlyOnceWith({ userCode: "ABCD-1234", verificationUrl: "https://example.invalid/device" });
    expect(openExternal).not.toHaveBeenCalled();
  });
  it.each(["--unsafe-login-url", "--invalid-device-code"])("rejects malformed device progress %s before exposing it", async (flag) => {
    const onDeviceCode = vi.fn();
    const openExternal = vi.fn();
    const outcome = await runCodexLogin("/fake/codex", {
      mode: "device", trust: TRUSTED, onDeviceCode, openExternal,
      spawnImpl: fakeSpawn([flag]), timeoutMs: 1000,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    // CUSTODY: the rejection explains the SHAPE of what was wrong, never the
    // offending value itself (the fixture's payload is "secret\npoison").
    expect(JSON.stringify(outcome)).not.toContain("secret");
    expect(onDeviceCode).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });
  /**
   * Taskana 4884 — the live defect, reproduced at the unit level.
   *
   * `account/login/start` is the ONE login RPC that is a real NETWORK round
   * trip: the server mints loginId/userCode/authUrl before answering. Measured
   * against two real binaries (0.144.3 and 0.164.0) on this machine, that mint
   * took 0.3s-4.7s — i.e. the doctor's 3s interactive per-RPC bound
   * (CODEX_DOCTOR_RPC_TIMEOUT_MS, which the login flow reused) sat INSIDE the
   * real distribution. Every mint slower than 3s rejected the request, the
   * catch collapsed the whole sign-in into `{ok:false, reason:"failed"}`, and
   * the pane showed "Sign-in failed. Try again." with no code ever published.
   *
   * The device code appears 3.5s late here; the flow must survive it.
   */
  it("waits past the doctor's 3s RPC bound for a slow device-code mint (Taskana 4884)", async () => {
    const controller = new AbortController();
    const onDeviceCode = vi.fn(() => controller.abort());
    const startedAt = Date.now();
    const outcome = await runCodexLogin("/fake/codex", {
      mode: "device",
      trust: TRUSTED,
      onDeviceCode,
      openExternal: vi.fn(),
      signal: controller.signal,
      spawnImpl: fakeSpawn(["--login-start-delay=3500"]),
      timeoutMs: 30_000,
    });
    // The code DID reach the user (pre-fix: never, the RPC had already failed).
    expect(onDeviceCode).toHaveBeenCalledExactlyOnceWith({ userCode: "ABCD-1234", verificationUrl: "https://example.invalid/device" });
    expect(Date.now() - startedAt).toBeGreaterThan(3_000);
    // Aborted from the callback — proof the flow got past the mint, not that it
    // merely avoided a failure.
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
  }, 20_000);

  it("carries the server's own rejection reason into the failure detail (Taskana 4884)", async () => {
    const outcome = await runCodexLogin("/fake/codex", {
      mode: "device",
      trust: TRUSTED,
      onDeviceCode: vi.fn(),
      openExternal: vi.fn(),
      spawnImpl: fakeSpawn(["--login-rejected"]),
      timeoutMs: 10_000,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "failed" });
    expect(outcome.ok === false && outcome.detail).toContain("device authorization expired");
  });

  it("cancels the device flow without leaving a five-minute timer", async () => {
    const controller = new AbortController();
    expect(await runCodexLogin("/fake/codex", {
      mode: "device", trust: TRUSTED, signal: controller.signal,
      onDeviceCode: () => controller.abort(), openExternal: vi.fn(), spawnImpl: fakeSpawn(),
    })).toEqual({ ok: false, reason: "cancelled" });
  });
});
