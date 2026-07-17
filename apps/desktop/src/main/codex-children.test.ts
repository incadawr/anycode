/**
 * Orphan tests for main's OWN Codex children (W2 review: Critical + High).
 *
 * These deliberately spawn REAL processes through the REAL runners — a fake
 * spawnImpl proves nothing about a process group. Every assertion is a
 * surviving-process COUNT read from the OS (`kill(pid, 0)`), never a mocked
 * call. Each check polls to the end of a settle window (cut §2(l)): an
 * instantaneous check catches a grandchild mid-reap and flakes.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { makeTrustedScratchDir } from "../shared/test-scratch.js";
import { checkCodexBinaryPathTrust } from "./codex-binary.js";
import { closeAllCodexChildren, liveCodexChildCount } from "./codex-children.js";
import { createCodexOnboardingController, type CodexIpcDeps } from "./codex-ipc.js";
import { runCodexDoctor } from "./codex-doctor.js";

const fixture = fileURLToPath(new URL("./codex-doctor-fixtures/fake-codex.mjs", import.meta.url));
// NOT os.tmpdir(): the production trust gate refuses a binary under a
// world-writable ancestor, which on Linux is `/tmp` itself. See test-scratch.ts.
const workDir = makeTrustedScratchDir("codex-children");

afterAll(() => rmSync(workDir, { recursive: true, force: true }));
afterEach(async () => {
  // Never let one test's survivor become the next test's mystery.
  await closeAllCodexChildren();
});

/**
 * A REAL executable at a REAL path, so the production trust gate and the
 * production spawn path both run exactly as they would against a user's
 * `codex`. The gate is asked, right here, whether the path we just wrote is one
 * it would execute: a scratch location it refuses would otherwise surface as
 * every test in this file timing out waiting for a child that was never spawned
 * — the CI failure this guard exists to name in one line.
 */
function writeCodexShim(name: string, extraArgs: readonly string[]): string {
  const shim = join(workDir, name);
  writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${fixture} "$@" ${extraArgs.join(" ")}\n`);
  chmodSync(shim, 0o755);
  const untrusted = checkCodexBinaryPathTrust(shim, undefined, process.platform);
  if (untrusted !== null) throw new Error(`test scratch is not an executable location the trust gate accepts: ${untrusted}`);
  return shim;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

/** Survivors at the END of the settle window — the only honest way to count a process tree that is being reaped. */
async function survivorsAfterSettle(pids: readonly number[], settleMs = 5_000): Promise<number[]> {
  const end = Date.now() + settleMs;
  for (;;) {
    const survivors = pids.filter(alive);
    if (survivors.length === 0) return [];
    if (Date.now() >= end) return survivors;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function makeDeps(binaryPath: string, overrides: Partial<CodexIpcDeps> = {}): CodexIpcDeps {
  return {
    bootEnv: { ANYCODE_CODEX_BIN: binaryPath, PATH: "", HOME: workDir },
    readBinaryPathSetting: async () => undefined,
    readCodexSettings: async () => undefined,
    writeCodexSettings: async () => ({ ok: true as const, snapshot: {} as never }),
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    openExternal: vi.fn(),
    onSnapshot: () => {},
    ...overrides,
  };
}

describe.skipIf(process.platform === "win32")("codex child ownership at app quit", () => {
  // THE CRITICAL. A login holds its child for up to five minutes; the child is
  // detached, so an Electron exit that does not tear it down leaves the whole
  // group running. `shutdown()` is what `before-quit` awaits.
  it("quit aborts an in-flight login and reaps its child AND grandchild", async () => {
    const childPidFile = join(workDir, "login-child.pid");
    const grandchildPidFile = join(workDir, "login-grandchild.pid");
    // Serves RPC (so the login really parks on its 5-minute wait) and forks a
    // stubborn grandchild that ignores SIGTERM: only a GROUP kill ends it.
    const shim = writeCodexShim("codex-login", [
      "--fork-helper",
      `--pid-file=${grandchildPidFile}`,
      `--self-pid-file=${childPidFile}`,
    ]);
    const controller = createCodexOnboardingController(makeDeps(shim));

    const login = controller.loginStart();
    await waitForFile(childPidFile);
    await waitForFile(grandchildPidFile);
    const childPid = Number(readFileSync(childPidFile, "utf8"));
    const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
    expect(alive(childPid)).toBe(true);
    expect(alive(grandchildPid)).toBe(true);

    await controller.shutdown();

    expect(await survivorsAfterSettle([childPid, grandchildPid])).toEqual([]);
    expect(liveCodexChildCount()).toBe(0);
    await expect(login).resolves.toEqual({ ok: false, reason: "cancelled" });
  }, 30_000);

  it("quit aborts an in-flight doctor and reaps its child AND grandchild", async () => {
    const grandchildPidFile = join(workDir, "doctor-grandchild.pid");
    // `--stubborn` never answers stdin AND ignores SIGTERM, so the doctor is
    // still mid-RPC when quit lands — the window in which the Critical bites.
    const shim = writeCodexShim("codex-doctor", ["--stubborn", `--pid-file=${grandchildPidFile}`]);
    const controller = createCodexOnboardingController(makeDeps(shim));

    const recheck = controller.recheck();
    await waitForFile(grandchildPidFile);
    const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
    expect(alive(grandchildPid)).toBe(true);

    await controller.shutdown();

    expect(await survivorsAfterSettle([grandchildPid])).toEqual([]);
    expect(liveCodexChildCount()).toBe(0);
    await expect(recheck).resolves.toMatchObject({ report: { status: "error" } });
  }, 30_000);

  it("refuses to start new work once shutdown has begun", async () => {
    const shim = writeCodexShim("codex-refuse", []);
    const controller = createCodexOnboardingController(makeDeps(shim));

    await controller.shutdown();

    // A late IPC during quit must not spawn a fresh child behind the
    // teardown's back — that child would be born already orphaned.
    await expect(controller.recheck()).resolves.toMatchObject({ report: { status: "error" } });
    await expect(controller.loginStart()).resolves.toEqual({ ok: false, reason: "busy" });
    await expect(controller.pickBinary()).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(liveCodexChildCount()).toBe(0);
  }, 20_000);

  // W2-review Medium, end to end: the REAL trust gate against a REAL binary.
  // A world-writable `codex` is refused BEFORE anything is executed — a swap
  // between discovery and spawn is the attack this closes off.
  it("refuses to execute a world-writable binary, and spawns nothing", async () => {
    const shim = writeCodexShim("codex-untrusted", []);
    chmodSync(shim, 0o777);

    const report = await runCodexDoctor(shim);

    expect(report.status).toBe("error");
    expect(report.error).toMatch(/world-writable/);
    expect(liveCodexChildCount()).toBe(0);
  }, 20_000);

  // THE PREFLIGHT HIGH. This spawn precedes every long-lived client, so a
  // grandchild it strands can never be reaped by any later group teardown.
  it("version preflight group-kills a wrapper's grandchild on timeout", async () => {
    const grandchildPidFile = join(workDir, "preflight-grandchild.pid");
    const shim = writeCodexShim("codex-preflight", ["--version-grandchild", `--pid-file=${grandchildPidFile}`]);

    const report = await runCodexDoctor(shim, { versionTimeoutMs: 700 });
    expect(report.status).toBe("error");

    await waitForFile(grandchildPidFile);
    const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
    expect(await survivorsAfterSettle([grandchildPid])).toEqual([]);
    expect(liveCodexChildCount()).toBe(0);
  }, 30_000);
});
