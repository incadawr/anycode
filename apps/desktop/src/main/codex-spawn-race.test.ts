/**
 * "No `codex` process is spawned once shutdown has begun" (W3.5 review,
 * Critical) — and "the binary is re-validated AT each spawn, not once per run"
 * (Medium).
 *
 * WHAT THESE ASSERT, AND WHY IT IS NOT "IT DIED IN THE END": the buggy code
 * already satisfied "no survivors" — the runners' `finally` and the POSIX
 * exit-guard reaped the late child in most orderings. What it violated is the
 * INVARIANT: a detached child created behind a completed teardown, an
 * `openExternal` browser window opening mid-quit, and on win32 nothing that can
 * reap it at all (main/codex-children.ts's header). So every assertion here is
 * that the process WAS NEVER CREATED, via two independent witnesses:
 *
 *   1. the OS: the binary under test is a REAL executable that appends a line to
 *      a log the first thing it does, before `exec`ing the fixture;
 *   2. the spawn boundary: a recording `spawnImpl` that counts the call and then
 *      performs the REAL spawn. It catches what witness (1) cannot — a child
 *      forked and then SIGKILLed by the group reaper before it ever reached its
 *      first line. That ordering really happens, and it is still a spawn.
 *
 * Nothing else is stubbed: the real trust gate stats the real binary, the real
 * runners drive the real teardown.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeAllCodexChildren, liveCodexChildCount } from "./codex-children.js";
import { runCodexDoctor } from "./codex-doctor.js";
import { runCodexLogin } from "./codex-login.js";
import { createCodexOnboardingController, type CodexIpcDeps } from "./codex-ipc.js";

const fixture = fileURLToPath(new URL("./codex-doctor-fixtures/fake-codex.mjs", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "anycode-codex-spawn-race-"));

afterAll(() => rmSync(workDir, { recursive: true, force: true }));
afterEach(async () => {
  // Never let one test's survivor become the next test's mystery.
  await closeAllCodexChildren();
});

interface CodexShim {
  path: string;
  /** Spawn calls that reached the child_process boundary — a fork counts even if it is killed before it can execute anything. */
  spawnCalls: readonly string[][];
  /** Executions the OS actually performed, counted from the log the binary appends to on start. */
  execCount: () => number;
  /** The recording seam: counts, then really spawns. */
  spawnImpl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

/**
 * A REAL executable at a REAL path — `mkdtemp` gives a 0700 directory we own, so
 * the production trust gate passes on its own terms and the production spawn
 * path runs exactly as it would against a user's `codex`.
 *
 * `poisonOnVersion` makes the binary world-writable from INSIDE its own
 * `--version` run: a genuine TOCTOU against the real filesystem, not a stubbed
 * trust seam. Everything the doctor validated before the preflight is stale by
 * the time the app-server spawn comes around, and only a check AT that spawn
 * catches it.
 */
function writeCodexShim(name: string, options: { poisonOnVersion?: boolean } = {}): CodexShim {
  const path = join(workDir, name);
  const log = join(workDir, `${name}.execs`);
  const poison = options.poisonOnVersion === true ? `if [ "$1" = "--version" ]; then chmod 0777 "$0"; fi\n` : "";
  writeFileSync(path, `#!/bin/sh\necho "$$" >> ${log}\n${poison}exec ${process.execPath} ${fixture} "$@"\n`);
  chmodSync(path, 0o755);
  const spawnCalls: string[][] = [];
  return {
    path,
    spawnCalls,
    execCount: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "").length
        : 0,
    spawnImpl: (command, args, spawnOptions) => {
      spawnCalls.push([command, ...args]);
      return spawn(command, args, spawnOptions);
    },
  };
}

/**
 * Never created, held for a whole settle window: a process that WAS created
 * needs a moment to reach its first line, so an instantaneous check on the OS
 * witness alone would hand the buggy code a false green.
 */
async function expectNeverSpawned(shim: CodexShim, settleMs = 1_000): Promise<void> {
  const end = Date.now() + settleMs;
  for (;;) {
    expect(shim.spawnCalls).toEqual([]);
    expect(shim.execCount()).toBe(0);
    if (Date.now() >= end) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Yields the queue, so a call parked on its first `await` is provably parked. */
function settleTicks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The controller under test, with the REAL runners — the only injection is the
 * recording spawn seam, so what runs is production discovery, production trust,
 * production spawn, production teardown.
 */
function makeDeps(shim: CodexShim, overrides: Partial<CodexIpcDeps> = {}): CodexIpcDeps {
  return {
    // No `ANYCODE_CODEX_BIN`, no PATH: discovery must come down the SETTINGS
    // rung, i.e. through `readBinaryPathSetting()` — the pre-spawn `await` that
    // opens the window these tests drive quit into.
    bootEnv: { PATH: "", HOME: workDir },
    readBinaryPathSetting: async () => shim.path,
    writeCodexSettings: async () => ({ ok: true as const, snapshot: {} as never }),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    openExternal: vi.fn(),
    onSnapshot: () => {},
    runDoctor: (binaryPath, options) => runCodexDoctor(binaryPath, { ...options, spawnImpl: shim.spawnImpl }),
    runLogin: (binaryPath, options) => runCodexLogin(binaryPath, { ...options, spawnImpl: shim.spawnImpl, timeoutMs: 5_000 }),
    ...overrides,
  };
}

describe.skipIf(process.platform === "win32")("no codex child is spawned once shutdown has begun", () => {
  // THE CRITICAL. The login claims its lock, then awaits the settings read — it
  // is not in `activeRuns` yet, so quit snapshots an empty set, drains the child
  // registry and finishes. Pre-fix the continuation then ran to completion: a
  // detached app-server child spawned behind the teardown, AND `openExternal`
  // popping a browser window in the user's face mid-quit.
  it("quit landing while a login is parked on its pre-spawn await spawns NOTHING and opens no browser", async () => {
    const shim = writeCodexShim("codex-login-race");
    let releaseSettings!: () => void;
    const settingsRead = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const openExternal = vi.fn(async () => {});
    const controller = createCodexOnboardingController(
      makeDeps(shim, {
        readBinaryPathSetting: async () => {
          await settingsRead;
          return shim.path;
        },
        openExternal,
      }),
    );

    const login = controller.loginStart();
    await settleTicks();

    // A COMPLETE quit — abort, bounded drain, group reap — all of it happening
    // while the login sits behind an await that quit cannot see.
    await controller.shutdown();
    releaseSettings();
    await login;

    await expectNeverSpawned(shim);
    expect(openExternal).not.toHaveBeenCalled();
    await expect(login).resolves.toEqual({ ok: false, reason: "busy" });
    expect(liveCodexChildCount()).toBe(0);
  }, 30_000);

  // The same window, one rung up the ladder: the recheck's own settings read.
  // The ordering here is the harsher one — the recheck IS in `activeRuns`, so
  // quit is still mid-drain when the parked run resumes; the gate has to hold at
  // the moment of resumption, not merely once quit has finished.
  it("a recheck parked on its pre-spawn await spawns no doctor once quit has begun", async () => {
    const shim = writeCodexShim("codex-recheck-race");
    let releaseSettings!: () => void;
    const settingsRead = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const controller = createCodexOnboardingController(
      makeDeps(shim, {
        readBinaryPathSetting: async () => {
          await settingsRead;
          return shim.path;
        },
      }),
    );

    const recheck = controller.recheck();
    await settleTicks();

    const quit = controller.shutdown();
    releaseSettings();
    await quit;
    await recheck;

    await expectNeverSpawned(shim);
    await expect(recheck).resolves.toMatchObject({ report: { status: "error" } });
    expect(liveCodexChildCount()).toBe(0);
  }, 30_000);

  // A native file picker can sit open across the entire quit sequence.
  it("quit landing while the binary picker is open spawns no doctor for the picked path", async () => {
    const shim = writeCodexShim("codex-picker-race");
    let releasePicker!: () => void;
    const pickerOpen = new Promise<void>((resolve) => {
      releasePicker = resolve;
    });
    const controller = createCodexOnboardingController(
      makeDeps(shim, {
        dialog: {
          showOpenDialog: async () => {
            await pickerOpen;
            return { canceled: false, filePaths: [shim.path] };
          },
        },
      }),
    );

    const picked = controller.pickBinary();
    await settleTicks();

    await controller.shutdown();
    releasePicker();
    await picked;

    await expectNeverSpawned(shim);
    await expect(picked).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(liveCodexChildCount()).toBe(0);
  }, 30_000);

  // The runners' own half of the invariant: even when handed a path, a runner
  // whose signal is ALREADY aborted must not spawn. Pre-fix `runCodexLogin`
  // observed its signal only after spawn + initialize + `account/login/start` +
  // `openExternal` — it did all of the damage first and cancelled afterwards.
  it("runCodexLogin entered with an already-aborted signal spawns nothing and opens no browser", async () => {
    const shim = writeCodexShim("codex-login-aborted");
    const abort = new AbortController();
    abort.abort();
    const openExternal = vi.fn(async () => {});

    const outcome = await runCodexLogin(shim.path, {
      openExternal,
      signal: abort.signal,
      spawnImpl: shim.spawnImpl,
      timeoutMs: 5_000,
    });

    await expectNeverSpawned(shim);
    expect(openExternal).not.toHaveBeenCalled();
    expect(outcome).toEqual({ ok: false, reason: "cancelled" });
    expect(liveCodexChildCount()).toBe(0);
  }, 20_000);

  // The doctor had NO abort gate at all before its preflight: its first child is
  // the `--version` probe, which ran before the only abort check in the run.
  it("runCodexDoctor entered with an already-aborted signal spawns nothing — not even the version preflight", async () => {
    const shim = writeCodexShim("codex-doctor-aborted");
    const abort = new AbortController();
    abort.abort();

    const report = await runCodexDoctor(shim.path, { signal: abort.signal, spawnImpl: shim.spawnImpl });

    await expectNeverSpawned(shim);
    expect(report.status).toBe("error");
    expect(liveCodexChildCount()).toBe(0);
  }, 20_000);
});

describe.skipIf(process.platform === "win32")("the doctor re-validates the binary AT the spawn", () => {
  // W3.5-review Medium, end to end and un-mocked: the binary makes ITSELF
  // world-writable while it is running `--version`. The trust check that
  // preceded the preflight is stale the moment that child exits, and the
  // app-server spawn is a fresh execution of a binary any local user can now
  // overwrite. Exactly ONE execution may appear: the preflight. A second means
  // the doctor executed an untrusted binary as a long-lived app-server.
  it("refuses to spawn the app-server when the binary turns world-writable during the version preflight", async () => {
    const shim = writeCodexShim("codex-swapped-under-us", { poisonOnVersion: true });

    const report = await runCodexDoctor(shim.path, { spawnImpl: shim.spawnImpl });

    expect(shim.spawnCalls).toEqual([[shim.path, "--version"]]);
    expect(shim.execCount()).toBe(1);
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/writable/i);
    expect(liveCodexChildCount()).toBe(0);
  }, 20_000);
});
