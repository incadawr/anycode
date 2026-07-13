import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CodexRpcClient, buildDoctorChildEnv, runCodexDoctor } from "./codex-doctor.js";

const fixturePath = fileURLToPath(new URL("./codex-doctor-fixtures/fake-codex.mjs", import.meta.url));

/**
 * These tests drive a FAKE spawner against a synthetic path, so the real
 * filesystem trust gate (main/codex-binary.ts, W2-review Medium) has nothing to
 * stat. It is stubbed to "trusted" here and asserted on its own terms in
 * codex-binary.test.ts (policy) and below (a real world-writable binary IS
 * refused, end to end).
 */
const TRUSTED = (): null => null;
const scratchDir = mkdtempSync(join(tmpdir(), "anycode-codex-doctor-test-"));

afterAll(() => rmSync(scratchDir, { recursive: true, force: true }));

/** Redirects every spawn to `node fixturePath <realArgs> <extraFlags>` — the same DI shape host's AppServerClient tests use (binaryArgs prefix), generalized to extra trailing flags the fixture's `flag()`/`value()` helpers read anywhere in argv. */
function fakeSpawn(extraFlags: string[] = []) {
  return (_command: string, args: readonly string[], options: SpawnOptions): ChildProcess =>
    spawn(process.execPath, [fixturePath, ...args, ...extraFlags], options);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls up to `timeoutMs` for a pid to disappear — a settle window, not an instant check (test hazard: an immediate check can race the OS reaping the process). */
async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !alive(pid);
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

describe("buildDoctorChildEnv", () => {
  it("allowlists only known POSIX keys — no ambient ANYCODE_* secret ever reaches the child", () => {
    const env = buildDoctorChildEnv(
      { HOME: "/home/dev", PATH: "/usr/bin", ANYCODE_API_KEY: "sk-should-not-leak", RANDOM_VAR: "nope" },
      "darwin",
    );
    expect(env.HOME).toBe("/home/dev");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANYCODE_API_KEY).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
  });

  it("allowlists Windows-shaped keys (APPDATA/USERPROFILE/...) on win32, still scrubbing secrets", () => {
    const env = buildDoctorChildEnv(
      {
        USERPROFILE: "C:\\Users\\dev",
        APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
        PATH: "C:\\tools",
        HOME: "/should/not/appear/on/windows",
        ANYCODE_API_KEY: "sk-should-not-leak",
      },
      "win32",
    );
    expect(env.USERPROFILE).toBe("C:\\Users\\dev");
    expect(env.APPDATA).toBe("C:\\Users\\dev\\AppData\\Roaming");
    expect(env.PATH).toBe("C:\\tools");
    expect(env.HOME).toBeUndefined();
    expect(env.ANYCODE_API_KEY).toBeUndefined();
  });
});

describe("runCodexDoctor", () => {
  it("reports ready with account + paginated models on a compatible, signed-in CLI", async () => {
    const report = await runCodexDoctor("/fake/codex", { trust: TRUSTED, spawnImpl: fakeSpawn() });
    expect(report.status).toBe("ready");
    expect(report.version).toBe("0.144.3");
    expect(report.account).toEqual({ type: "chatgpt", plan: "plus" });
    expect(report.models).toEqual([
      { id: "gpt-fake-1", label: "Fake One", efforts: ["low", "high"] },
      { id: "gpt-fake-2", label: "Fake Two" },
    ]);
  });

  it("never carries the account email — only type/plan cross the doctor boundary (custody)", async () => {
    const report = await runCodexDoctor("/fake/codex", { trust: TRUSTED, spawnImpl: fakeSpawn() });
    expect(report.account).toBeDefined();
    expect(Object.keys(report.account ?? {})).toEqual(["type", "plan"]);
    expect(JSON.stringify(report)).not.toContain("@example.com");
  });

  it("reports signed_out when account/read returns a null account", async () => {
    const report = await runCodexDoctor("/fake/codex", { trust: TRUSTED, spawnImpl: fakeSpawn(["--signed-out"]) });
    expect(report).toEqual({ status: "signed_out", version: "0.144.3" });
  });

  it("reports update_required for a version outside the supported range, without spawning app-server at all", async () => {
    const report = await runCodexDoctor("/fake/codex", { trust: TRUSTED, spawnImpl: fakeSpawn(["--bad-version"]) });
    expect(report).toEqual({ status: "update_required", version: "0.99.0" });
  });

  it("reports error for unparseable version output", async () => {
    const report = await runCodexDoctor("/fake/codex", { trust: TRUSTED, spawnImpl: fakeSpawn(["--malformed-version"]) });
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/version/i);
  });

  it("bounds a hung version preflight with its own timeout, never the overall watchdog", async () => {
    const report = await runCodexDoctor("/fake/codex", { trust: TRUSTED, spawnImpl: fakeSpawn(["--hang-version"]),
      versionTimeoutMs: 150 });
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/timed out/i);
  });

  it("caps model/list pagination at the configured page limit against a server that never stops paginating", async () => {
    const report = await runCodexDoctor("/fake/codex", { trust: TRUSTED, spawnImpl: fakeSpawn(["--many-pages"]),
      maxModelPages: 3 });
    expect(report.status).toBe("ready");
    expect(report.models).toHaveLength(3);
    expect(report.models?.map((m) => m.id)).toEqual(["model-1", "model-2", "model-3"]);
  });

  // W2-review High: this client runs INSIDE THE MAIN PROCESS. A live Codex that
  // closes fd 0 makes the NEXT write raise an asynchronous EPIPE on the stdin
  // socket, and an `error` event with no listener is escalated by Node into an
  // unhandled exception — i.e. it takes the whole app down. The write must
  // happen AFTER the child's read end is provably gone (hence the marker), or
  // the data simply sits in the pipe buffer and the defect never fires.
  // Pre-fix: uncaught `write EPIPE`. Post-fix: a bounded rejection.
  it("survives a child that closes stdin while a request is in flight (an EPIPE must not kill the main process)", async () => {
    const client = new CodexRpcClient(fakeSpawn(["--close-stdin"]));
    const stdinClosed = new Promise<void>((resolve) => {
      client.onNotification((notification) => {
        if (notification.method === "test/stdin-closed") resolve();
      });
    });
    try {
      client.spawn("/fake/codex", {});
      await stdinClosed;
      await expect(client.request("initialize", {}, { timeoutMs: 2_000 })).rejects.toThrow(/stdin/i);
    } finally {
      await client.close();
    }
  }, 20_000);

  it("proves zero orphans: a stubborn app-server that ignores stdin+SIGTERM and forks a grandchild is fully reaped, including on the watchdog-timeout path", async () => {
    const pidFile = join(scratchDir, `stubborn-${Date.now()}.pid`);
    const promise = runCodexDoctor("/fake/codex", {
      trust: TRUSTED,
      spawnImpl: fakeSpawn(["--stubborn", `--pid-file=${pidFile}`]),
      // Small watchdog: `initialize` never gets a response from a stubborn
      // server, so the watchdog (not a per-RPC timeout) is what fires here.
      timeoutMs: 400,
      rpcTimeoutMs: 5_000,
    });

    await waitForFile(pidFile);
    const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    expect(alive(grandchildPid)).toBe(true);

    const report = await promise;
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/watchdog/i);

    // close() runs in runCodexDoctor's `finally`, AFTER the watchdog settles
    // — by the time the promise above resolves, teardown has already reaped
    // the process group (app-server child + grandchild), not merely sent a
    // termination signal it doesn't wait to confirm.
    expect(await waitUntilDead(grandchildPid)).toBe(true);
  }, 15_000);
});

describe("CodexRpcClient", () => {
  it("close() is a safe no-op before spawn() and idempotent across repeated calls", async () => {
    const client = new CodexRpcClient(fakeSpawn());
    await client.close();
    await client.close();
    expect(client.pid).toBeNull();
  });

  // W3.5-review Low: the previous shape of this test — `Promise.all([close(),
  // close()])` — was green on the very bug it claimed to cover. `Promise.all`
  // awaits BOTH promises, so the first close's real teardown was awaited anyway
  // and a second close that resolved early on a still-live group was invisible.
  // Here the first close is deliberately left floating and ONLY the second is
  // awaited: quit awaits the close it happens to call, and that call must carry
  // the real teardown, not somebody else's promise. The liveness assertion is
  // instantaneous on purpose — a settle-window poll would just wait for the
  // floating first close to finish the job and then report success.
  it("a concurrent second close() awaits the SAME real teardown — it must not resolve early while the group is still alive", async () => {
    const client = new CodexRpcClient(fakeSpawn());
    client.spawn("/fake/codex", buildDoctorChildEnv(process.env));
    const pid = client.pid;
    expect(pid).toEqual(expect.any(Number));

    const first = client.close();
    first.catch(() => {});
    await client.close();
    expect(alive(pid!)).toBe(false);

    await first; // no double signal storm, no throw on the concurrent path either.
  });
});
