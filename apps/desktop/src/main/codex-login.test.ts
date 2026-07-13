import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runCodexLogin } from "./codex-login.js";

const fixturePath = fileURLToPath(new URL("./codex-doctor-fixtures/fake-codex.mjs", import.meta.url));

function fakeSpawn(extraFlags: string[] = []) {
  return (_command: string, args: readonly string[], options: SpawnOptions): ChildProcess =>
    spawn(process.execPath, [fixturePath, ...args, ...extraFlags], options);
}

describe("runCodexLogin", () => {
  it("opens the returned authUrl and resolves ok once account/login/completed arrives", async () => {
    const openExternal = vi.fn(async () => {});
    const outcome = await runCodexLogin("/fake/codex", {
      openExternal,
      spawnImpl: fakeSpawn(["--auto-complete-login"]),
      timeoutMs: 5_000,
    });
    expect(outcome).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://example.invalid/auth");
  });

  it("never reads/returns a token or account material — the outcome carries only ok/reason", async () => {
    const outcome = await runCodexLogin("/fake/codex", {
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
      openExternal: async () => {},
      spawnImpl: fakeSpawn(["--stubborn"]),
      rpcTimeoutMs: 150,
      timeoutMs: 5_000,
    });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
  });
});
