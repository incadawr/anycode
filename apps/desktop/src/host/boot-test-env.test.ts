import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { bootHostInTempProfile, PROXY_ENV_KEYS } from "./boot-test-env.js";

/**
 * A stand-in for the host fork: it registers a message handler on
 * `process.parentPort` exactly like `./index.ts` does at module evaluation and
 * calls `process.exit` (mocked by the scaffolding) when asked to shut down.
 */
function fakeFork(options: {
  /** Extra work before the fork answers a shutdown — e.g. a slow teardown. */
  onShutdown?: () => Promise<void>;
  /** Set to make the fork ignore the shutdown request (a wedged boot). */
  neverStops?: boolean;
  /** Runs once the "module evaluated", i.e. while the fork is live. */
  onBooted?: () => void;
}): () => Promise<void> {
  return async () => {
    const parent = process.parentPort as unknown as EventEmitter;
    parent.on("message", (event: any) => {
      if (event?.data?.type !== "shutdown" || options.neverStops === true) return;
      void Promise.resolve(options.onShutdown?.()).then(() => process.exit(0));
    });
    options.onBooted?.();
  };
}

describe("hermetic host boot scaffolding", () => {
  it("restores the environment only after the fork has stopped", async () => {
    const ambientHome = process.env.HOME;
    const homesSeenByFork: Array<string | undefined> = [];
    const result = await bootHostInTempProfile(
      async ({ profile, requestShutdown, waitForStopped }) => {
        homesSeenByFork.push(process.env.HOME);
        expect(profile.dir).not.toBe(ambientHome);
        requestShutdown();
        expect(await waitForStopped(2_000)).toBe(true);
        // Still the throwaway profile at the LAST moment the fork can act.
        expect(process.env.HOME).toBe(profile.dir);
      },
      // Teardown takes a moment: the restore must wait for it, not race it.
      { boot: fakeFork({ onShutdown: () => new Promise((resolve) => setTimeout(resolve, 20)) }) },
    );

    expect(result.error).toBeNull();
    expect(result.stopped).toBe(true);
    expect(homesSeenByFork).toEqual([result.profile.dir]);
    expect(result.homeAtStop).toBe(result.profile.dir);
    expect(result.restored).toBe(true);
    expect(process.env.HOME).toBe(ambientHome);
    expect(existsSync(result.profile.dir)).toBe(false);
  });

  it("keeps the temp profile in place when the fork never stops", async () => {
    const ambientHome = process.env.HOME;
    const cwdBefore = process.cwd();
    let leaked = "";
    const result = await bootHostInTempProfile(
      async ({ profile }) => {
        leaked = profile.dir;
        // Exactly what a timed-out `vi.waitFor` does, with the boot still live.
        throw new Error("wait timed out while the fork was still booting");
      },
      { boot: fakeFork({ neverStops: true }), stopBudgetMs: 100, pollMs: 10 },
    );

    expect((result.error as Error).message).toContain("still booting");
    expect(result.stopped).toBe(false);
    expect(result.restored).toBe(false);
    // The environment was NOT restored underneath the still-running fork: a late
    // database open can only ever land in the throwaway profile.
    expect(process.env.HOME).toBe(leaked);
    expect(existsSync(leaked)).toBe(true);

    // Deliberate manual recovery, since the scaffolding refused to touch
    // anything: the assertions above need the untouched state.
    process.chdir(cwdBefore);
    vi.restoreAllMocks();
    Reflect.deleteProperty(process, "parentPort");
    vi.unstubAllEnvs();
    rmSync(leaked, { recursive: true, force: true });
    expect(process.env.HOME).toBe(ambientHome);
  });

  it("clears the proxy family for the fork and restores it afterwards", async () => {
    const sentinel = "http://anycode-test:fake-token@127.0.0.1:9";
    const ambient = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
    vi.stubEnv("HTTPS_PROXY", sentinel);
    vi.stubEnv("http_proxy", sentinel);
    const seenByFork: Array<string | undefined> = [];
    const result = await bootHostInTempProfile(
      async ({ requestShutdown, waitForStopped }) => {
        // Boot scans the family BEFORE the trust gate and binds a relay per
        // credentialed value, so nothing may reach it from the shell.
        seenByFork.push(process.env.HTTPS_PROXY, process.env.http_proxy);
        requestShutdown();
        expect(await waitForStopped(2_000)).toBe(true);
      },
      { boot: fakeFork({}) },
    );

    expect(result.stopped).toBe(true);
    expect(seenByFork).toEqual([undefined, undefined]);
    for (const key of PROXY_ENV_KEYS) expect(process.env[key]).toBe(ambient[key]);
  });

  it("removes the session pair the fork stamps into its own environment", async () => {
    const ambient = {
      id: process.env.ANYCODE_SESSION_ID,
      workspace: process.env.ANYCODE_SESSION_WORKSPACE,
    };
    // The leak this guards against only shows up when the pair starts absent (a
    // normal CI/dev shell), so the test makes that case unconditional.
    delete process.env.ANYCODE_SESSION_ID;
    delete process.env.ANYCODE_SESSION_WORKSPACE;
    try {
      const result = await bootHostInTempProfile(
        async ({ requestShutdown, waitForStopped }) => {
          // `applySessionToolEnv`: fills the pair only where it is absent, i.e. the
          // fork creates both keys on a bare boot like this one.
          process.env.ANYCODE_SESSION_ID ??= "session-created-by-boot";
          process.env.ANYCODE_SESSION_WORKSPACE ??= "/workspace/created-by-boot";
          expect(process.env.ANYCODE_SESSION_ID).toBeTruthy();
          requestShutdown();
          expect(await waitForStopped(2_000)).toBe(true);
        },
        { boot: fakeFork({}) },
      );

      expect(result.stopped).toBe(true);
      // The pair the boot created is gone again — an unstubbed absent key would
      // have survived cleanup and leaked a deleted session into later tests.
      expect(process.env.ANYCODE_SESSION_ID).toBeUndefined();
      expect(process.env.ANYCODE_SESSION_WORKSPACE).toBeUndefined();
    } finally {
      if (ambient.id !== undefined) process.env.ANYCODE_SESSION_ID = ambient.id;
      if (ambient.workspace !== undefined) process.env.ANYCODE_SESSION_WORKSPACE = ambient.workspace;
    }
  });
});
