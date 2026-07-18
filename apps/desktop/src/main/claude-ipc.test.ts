import { describe, expect, it, vi } from "vitest";
import { createClaudeOnboardingController, type ClaudeIpcDeps, type DialogLike } from "./claude-ipc.js";
import type { ClaudeDoctorReport } from "../shared/claude-doctor.js";

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

  it("runs the doctor with a defaultClaudeProfileDir path when a binary IS discovered, and reports ready", async () => {
    const report: ClaudeDoctorReport = { status: "ready", version: "2.1.212" };
    const runDoctor = vi.fn(async () => report);
    const onSnapshot = vi.fn();
    const controller = createClaudeOnboardingController(
      baseDeps({
        readBinaryPathSetting: async () => "/opt/claude",
        fs: fakeExecutableFs("/opt/claude"),
        runDoctor,
        onSnapshot,
        home: "/tmp/fake-home",
        platform: "linux",
      }),
    );
    const snapshot = await controller.recheck();
    expect(snapshot.report).toEqual(report);
    expect(snapshot.binaryPath).toBe("/opt/claude");
    expect(snapshot.source).toBe("settings");
    expect(runDoctor).toHaveBeenCalledWith("/opt/claude", expect.objectContaining({ profileDir: "/tmp/fake-home/.anycode/claude/profile-default" }));
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
