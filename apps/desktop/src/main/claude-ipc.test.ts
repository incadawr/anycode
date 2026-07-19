import { describe, expect, it, vi } from "vitest";
import { createClaudeOnboardingController, isClaudeSnapshotChangeMaterial, type ClaudeIpcDeps, type ClaudeOnboardingSnapshot, type DialogLike } from "./claude-ipc.js";
import type { ClaudeDoctorReport } from "../shared/claude-doctor.js";
import type { RunClaudeDoctorOptions } from "./claude-doctor.js";
import type { ClaudeLoginOutcome, RunClaudeLoginOptions } from "./claude-login.js";

function fakeDialog(result: { canceled: boolean; filePaths: string[] }): DialogLike {
  return { showOpenDialog: async () => result };
}

/** Typed so `.mock.calls[0][0]` is the real patch shape, not an inferred zero-arg signature. */
function fakeWriteClaudeSettings() {
  return vi.fn((_patch: Parameters<ClaudeIpcDeps["writeClaudeSettings"]>[0]) => Promise.resolve({ ok: true as const, snapshot: {} as never }));
}

/**
 * A fake fs that models a REAL one: `filePath` itself stats as an executable
 * file, every OTHER path (its ancestor directories) stats as a directory —
 * checkClaudeBinaryPathTrust walks the full ancestor chain, so a fake that
 * answers `isFile` for everything fails every ancestor's "is not a
 * directory" check and silently makes discovery resolve to nothing.
 */
function fakeExecutableFs(filePath: string, fileMode = 0o755) {
  return {
    stat: (path: string) =>
      path === filePath
        ? { isFile: () => true, isDirectory: () => false, mode: fileMode, uid: 0, gid: 0 }
        : { isFile: () => false, isDirectory: () => true, mode: 0o755, uid: 0, gid: 0 },
    realpath: (path: string) => path,
  };
}

function baseDeps(overrides: Partial<ClaudeIpcDeps> = {}): ClaudeIpcDeps {
  return {
    bootEnv: {},
    readBinaryPathSetting: async () => undefined,
    writeClaudeSettings: fakeWriteClaudeSettings(),
    dialog: fakeDialog({ canceled: true, filePaths: [] }),
    openPath: async () => "",
    onSnapshot: vi.fn(),
    fs: {
      stat: () => {
        throw new Error("ENOENT");
      },
      realpath: (p) => p,
    },
    ...overrides,
  };
}

describe("createClaudeOnboardingController — recheck", () => {
  it("not_installed when the discovery ladder resolves to nothing, and never spawns a doctor", async () => {
    const runDoctor = vi.fn();
    const controller = createClaudeOnboardingController(baseDeps({ runDoctor }));
    const snapshot = await controller.recheck();
    expect(snapshot.report).toEqual({ status: "not_installed" });
    expect(snapshot.binaryPath).toBeNull();
    expect(runDoctor).not.toHaveBeenCalled();
  });

  it("runs the doctor with no CLAUDE_CONFIG_DIR override when a binary IS discovered, and reports ready (owner pivot: ambient default)", async () => {
    const report: ClaudeDoctorReport = { status: "ready", version: "2.1.212" };
    const runDoctor = vi.fn(async (_binaryPath: string, _options: RunClaudeDoctorOptions) => report);
    const onSnapshot = vi.fn();
    const controller = createClaudeOnboardingController(
      baseDeps({
        readBinaryPathSetting: async () => "/opt/claude",
        fs: fakeExecutableFs("/opt/claude"),
        runDoctor,
        onSnapshot,
        platform: "linux",
      }),
    );
    const snapshot = await controller.recheck();
    expect(snapshot.report).toEqual(report);
    expect(snapshot.binaryPath).toBe("/opt/claude");
    expect(snapshot.source).toBe("settings");
    expect(runDoctor.mock.calls[0]![1]).not.toHaveProperty("profileDir");
    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(controller.readyFor()).toBe(true);
    expect(controller.hasVerdictFor()).toBe(true);
  });

  it("persists only status/version/at — never an account fact (custody)", async () => {
    const writeClaudeSettings = fakeWriteClaudeSettings();
    const controller = createClaudeOnboardingController(
      baseDeps({
        readBinaryPathSetting: async () => "/opt/claude",
        fs: fakeExecutableFs("/opt/claude"),
        runDoctor: async () => ({ status: "ready", version: "2.1.212" }),
        writeClaudeSettings,
      }),
    );
    await controller.recheck();
    expect(writeClaudeSettings).toHaveBeenCalledTimes(1);
    const patch = writeClaudeSettings.mock.calls[0]![0];
    expect(Object.keys(patch.lastCheck!).sort()).toEqual(["at", "status", "version"]);
    expect(patch.binaryPath).toBe("/opt/claude");
  });

  it("never persists an env-override path", async () => {
    const writeClaudeSettings = fakeWriteClaudeSettings();
    const controller = createClaudeOnboardingController(
      baseDeps({
        bootEnv: { ANYCODE_CLAUDE_BIN: "/env/claude" },
        fs: fakeExecutableFs("/env/claude"),
        runDoctor: async () => ({ status: "ready", version: "2.1.212" }),
        writeClaudeSettings,
      }),
    );
    await controller.recheck();
    const patch = writeClaudeSettings.mock.calls[0]![0];
    expect(patch.binaryPath).toBeUndefined();
  });

  it("coalesces overlapping recheck calls onto a single doctor run", async () => {
    let calls = 0;
    const runDoctor = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { status: "ready", version: "2.1.212" } as ClaudeDoctorReport;
    });
    const controller = createClaudeOnboardingController(
      baseDeps({
        readBinaryPathSetting: async () => "/opt/claude",
        fs: fakeExecutableFs("/opt/claude"),
        runDoctor,
      }),
    );
    const [a, b] = await Promise.all([controller.recheck(), controller.recheck()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("hasVerdictFor is false until the first recheck ever lands", () => {
    const controller = createClaudeOnboardingController(baseDeps());
    expect(controller.hasVerdictFor()).toBe(false);
    expect(controller.readyFor()).toBe(false);
  });
});

describe("createClaudeOnboardingController — pickBinary", () => {
  it("cancelled when the dialog is cancelled", async () => {
    const controller = createClaudeOnboardingController(baseDeps({ dialog: fakeDialog({ canceled: true, filePaths: [] }) }));
    expect(await controller.pickBinary()).toEqual({ ok: false, reason: "cancelled" });
  });

  it("invalid when the picked path fails validation", async () => {
    const controller = createClaudeOnboardingController(
      baseDeps({
        dialog: fakeDialog({ canceled: false, filePaths: ["/not/executable"] }),
        fs: fakeExecutableFs("/not/executable", 0o644),
      }),
    );
    expect(await controller.pickBinary()).toEqual({ ok: false, reason: "invalid" });
  });

  it("ok, with source=picker, when the picked path validates and the doctor runs", async () => {
    const runDoctor = vi.fn(async () => ({ status: "ready", version: "2.1.212" }) as ClaudeDoctorReport);
    const controller = createClaudeOnboardingController(
      baseDeps({
        dialog: fakeDialog({ canceled: false, filePaths: ["/opt/custom/claude"] }),
        fs: fakeExecutableFs("/opt/custom/claude"),
        runDoctor,
      }),
    );
    const result = await controller.pickBinary();
    expect(result).toMatchObject({ ok: true, snapshot: { binaryPath: "/opt/custom/claude", source: "picker" } });
  });
});

// SLICE-CC-LOGIN (TASK.66, cut §7 W2 DoD tests).
describe("createClaudeOnboardingController — loginStart/loginCancel", () => {
  it("unsupported when no binary is discovered — never calls runLogin", async () => {
    const runLogin = vi.fn();
    const controller = createClaudeOnboardingController(baseDeps({ runLogin }));
    const result = await controller.loginStart();
    expect(result).toEqual({ ok: false, reason: "unsupported" });
    expect(runLogin).not.toHaveBeenCalled();
  });

  it("refuses busy while a recheck's doctor call is already in flight", async () => {
    let resolveDoctor: (report: ClaudeDoctorReport) => void = () => {};
    const doctorPromise = new Promise<ClaudeDoctorReport>((resolve) => {
      resolveDoctor = resolve;
    });
    const runDoctor = vi.fn(() => doctorPromise);
    const controller = createClaudeOnboardingController(
      baseDeps({ readBinaryPathSetting: async () => "/opt/claude", fs: fakeExecutableFs("/opt/claude"), runDoctor }),
    );
    const recheckPromise = controller.recheck();
    const loginResult = await controller.loginStart();
    expect(loginResult).toEqual({ ok: false, reason: "busy" });
    resolveDoctor({ status: "ready", version: "2.1.212" });
    await recheckPromise;
  });

  it("a recheck landing while login's own poll doctor call is active COALESCES onto it — the fake doctor's spawn count never grows", async () => {
    let resolveDoctor: (report: ClaudeDoctorReport) => void = () => {};
    const doctorPromise = new Promise<ClaudeDoctorReport>((resolve) => {
      resolveDoctor = resolve;
    });
    const runDoctor = vi.fn(() => doctorPromise);
    const runLogin = vi.fn(async (_binaryPath: string, options: RunClaudeLoginOptions): Promise<ClaudeLoginOutcome> => {
      const ready = await options.probe();
      return ready ? { ok: true } : { ok: false, reason: "timeout" };
    });
    const controller = createClaudeOnboardingController(
      baseDeps({ readBinaryPathSetting: async () => "/opt/claude", fs: fakeExecutableFs("/opt/claude"), runDoctor, runLogin }),
    );
    const loginPromise = controller.loginStart();
    // Flush every pending microtask so performLogin's chain (readBinaryPathSetting
    // -> runLogin -> probe -> runExclusive(discoverAndCheck) -> runDoctor) has
    // actually reached the doctor spawn before the concurrent recheck below.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runDoctor).toHaveBeenCalledTimes(1);
    const recheckPromise = controller.recheck();
    expect(runDoctor).toHaveBeenCalledTimes(1); // still 1 — coalesced, not a second spawn.
    resolveDoctor({ status: "ready", version: "2.1.212" });
    const [loginResult, recheckSnapshot] = await Promise.all([loginPromise, recheckPromise]);
    expect(loginResult).toEqual({ ok: true, snapshot: recheckSnapshot });
    expect(runDoctor).toHaveBeenCalledTimes(1);
  });

  it("a second loginStart while one is already running refuses busy", async () => {
    let resolveOutcome: (outcome: ClaudeLoginOutcome) => void = () => {};
    const runLogin = vi.fn(() => new Promise<ClaudeLoginOutcome>((resolve) => {
      resolveOutcome = resolve;
    }));
    const controller = createClaudeOnboardingController(
      baseDeps({ readBinaryPathSetting: async () => "/opt/claude", fs: fakeExecutableFs("/opt/claude"), runLogin }),
    );
    const first = controller.loginStart();
    const second = await controller.loginStart();
    expect(second).toEqual({ ok: false, reason: "busy" });
    resolveOutcome({ ok: false, reason: "cancelled" });
    await first;
  });

  it("success persists the final snapshot and fires onSnapshot exactly once, with no CLAUDE_CONFIG_DIR override (owner pivot: ambient default)", async () => {
    const writeClaudeSettings = fakeWriteClaudeSettings();
    const onSnapshot = vi.fn();
    const runDoctor = vi.fn(async () => ({ status: "ready", version: "2.1.212" }) as ClaudeDoctorReport);
    const runLogin = vi.fn(async (_binaryPath: string, options: RunClaudeLoginOptions): Promise<ClaudeLoginOutcome> => {
      const ready = await options.probe();
      return ready ? { ok: true } : { ok: false, reason: "timeout" };
    });
    const controller = createClaudeOnboardingController(
      baseDeps({
        readBinaryPathSetting: async () => "/opt/claude",
        fs: fakeExecutableFs("/opt/claude"),
        runDoctor,
        runLogin,
        writeClaudeSettings,
        onSnapshot,
        platform: "linux",
      }),
    );
    const result = await controller.loginStart();
    expect(result).toMatchObject({ ok: true, snapshot: { report: { status: "ready" }, binaryPath: "/opt/claude" } });
    expect(writeClaudeSettings).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(runLogin.mock.calls[0]![1]).not.toHaveProperty("profileDir");
  });

  it("custody: loginStart's resolved value is a closed field set, even against an adversarial runLogin/runDoctor", async () => {
    const runDoctor = vi.fn(
      async () => ({ status: "ready", version: "2.1.212", account: { email: "leak@evil.example" } }) as unknown as ClaudeDoctorReport,
    );
    const runLogin = vi.fn(async (_binaryPath: string, options: RunClaudeLoginOptions) => {
      await options.probe();
      return { ok: true, token: "fake-not-a-token", authUrl: "https://evil.example" } as unknown as ClaudeLoginOutcome;
    });
    const controller = createClaudeOnboardingController(
      baseDeps({ readBinaryPathSetting: async () => "/opt/claude", fs: fakeExecutableFs("/opt/claude"), runDoctor, runLogin }),
    );
    const result = await controller.loginStart();
    expect(Object.keys(result).sort()).toEqual(["ok", "snapshot"]);
    if (result.ok) {
      expect(Object.keys(result.snapshot).sort()).toEqual(["binaryPath", "checkedAt", "report", "source"]);
    }
  });

  it("shutdown mid-login aborts it (cancelled) and settles the pending promise", async () => {
    const runLogin = vi.fn((_binaryPath: string, options: RunClaudeLoginOptions): Promise<ClaudeLoginOutcome> => {
      if (options.signal?.aborted === true) {
        return Promise.resolve({ ok: false, reason: "cancelled" });
      }
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "cancelled" }), { once: true });
      });
    });
    const controller = createClaudeOnboardingController(
      baseDeps({ readBinaryPathSetting: async () => "/opt/claude", fs: fakeExecutableFs("/opt/claude"), runLogin }),
    );
    const loginPromise = controller.loginStart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.shutdown();
    await expect(loginPromise).resolves.toEqual({ ok: false, reason: "cancelled" });
  });

  it("loginCancel aborts the active login", async () => {
    const runLogin = vi.fn((_binaryPath: string, options: RunClaudeLoginOptions): Promise<ClaudeLoginOutcome> => {
      if (options.signal?.aborted === true) {
        return Promise.resolve({ ok: false, reason: "cancelled" });
      }
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "cancelled" }), { once: true });
      });
    });
    const controller = createClaudeOnboardingController(
      baseDeps({ readBinaryPathSetting: async () => "/opt/claude", fs: fakeExecutableFs("/opt/claude"), runLogin }),
    );
    const loginPromise = controller.loginStart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.loginCancel();
    await expect(loginPromise).resolves.toEqual({ ok: false, reason: "cancelled" });
  });

  it("loginCancel with no active login is a harmless no-op", () => {
    const controller = createClaudeOnboardingController(baseDeps());
    expect(() => controller.loginCancel()).not.toThrow();
  });
});

// Doctor-spawn-loop fix (belt half): main only re-fires the shared
// `engines-changed` push when a snapshot MATERIALLY differs from the last one.
describe("isClaudeSnapshotChangeMaterial", () => {
  function fakeSnapshot(overrides: Partial<ClaudeOnboardingSnapshot> = {}): ClaudeOnboardingSnapshot {
    return { report: { status: "ready", version: "2.1.212" }, binaryPath: "/opt/claude", source: "path", checkedAt: "2026-07-19T00:00:00.000Z", ...overrides };
  }

  it("first-ever snapshot (no previous) is always material", () => {
    expect(isClaudeSnapshotChangeMaterial(undefined, fakeSnapshot())).toBe(true);
  });

  it("identical report differing only in checkedAt is NOT material", () => {
    const previous = fakeSnapshot({ checkedAt: "2026-07-19T00:00:00.000Z" });
    const next = fakeSnapshot({ checkedAt: "2026-07-19T00:00:05.000Z" });
    expect(isClaudeSnapshotChangeMaterial(previous, next)).toBe(false);
  });

  it("a status flip is material", () => {
    const previous = fakeSnapshot({ report: { status: "ready", version: "2.1.212" } });
    const next = fakeSnapshot({ report: { status: "signed_out", version: "2.1.212" } });
    expect(isClaudeSnapshotChangeMaterial(previous, next)).toBe(true);
  });

  it("a binaryPath change is material", () => {
    const previous = fakeSnapshot({ binaryPath: "/opt/claude" });
    const next = fakeSnapshot({ binaryPath: "/usr/local/bin/claude" });
    expect(isClaudeSnapshotChangeMaterial(previous, next)).toBe(true);
  });

  it("a source change is material", () => {
    const previous = fakeSnapshot({ source: "path" });
    const next = fakeSnapshot({ source: "settings" });
    expect(isClaudeSnapshotChangeMaterial(previous, next)).toBe(true);
  });

  it("a version change is material", () => {
    const previous = fakeSnapshot({ report: { status: "ready", version: "2.1.212" } });
    const next = fakeSnapshot({ report: { status: "ready", version: "2.2.0" } });
    expect(isClaudeSnapshotChangeMaterial(previous, next)).toBe(true);
  });

  it("only the volatile error string differing is NOT material", () => {
    const previous = fakeSnapshot({ report: { status: "error", error: "timed out" } });
    const next = fakeSnapshot({ report: { status: "error", error: "connection refused" } });
    expect(isClaudeSnapshotChangeMaterial(previous, next)).toBe(false);
  });
});
