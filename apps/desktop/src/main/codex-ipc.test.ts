import { describe, expect, it, vi } from "vitest";
import type { CodexDoctorReport } from "../shared/codex-doctor.js";
import type { CodexBinaryFs } from "./codex-binary.js";
import { createCodexOnboardingController, type CodexIpcDeps, type CodexOnboardingSnapshot } from "./codex-ipc.js";

/** Rejects every path — no rung of the discovery ladder resolves. */
const noBinaryFs: CodexBinaryFs = {
  realpath: (path) => path,
  stat() {
    throw new Error("ENOENT");
  },
};

/** uid/gids the fake fs below is owned by; pinned so the suite does not depend on the real uid of whoever runs it. */
const ME = { uid: 501, gids: [20] };

function makeDeps(overrides: Partial<CodexIpcDeps> = {}): CodexIpcDeps & { writtenPatches: unknown[]; snapshots: CodexOnboardingSnapshot[] } {
  const writtenPatches: unknown[] = [];
  const snapshots: CodexOnboardingSnapshot[] = [];
  return {
    bootEnv: { PATH: "/usr/local/bin", HOME: "/home/dev" },
    readBinaryPathSetting: async () => undefined,
    writeCodexSettings: async (patch) => {
      writtenPatches.push(patch);
      return { ok: true, snapshot: {} as never };
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    openExternal: async () => {},
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot);
    },
    // Models a real filesystem: a trusted, user-owned binary in a user-owned
    // directory (the trust gate stats both — see codex-binary.test.ts).
    fs: {
      realpath: (path) => path,
      stat: (path) => ({
        isFile: () => path.endsWith("codex"),
        isDirectory: () => !path.endsWith("codex"),
        mode: 0o755,
        uid: ME.uid,
        gid: 20,
      }),
    },
    identity: ME,
    platform: "darwin",
    runDoctor: async () => ({ status: "ready", version: "0.144.3", account: { type: "chatgpt", plan: "plus" }, models: [] }),
    runLogin: async () => ({ ok: true }),
    writtenPatches,
    snapshots,
    ...overrides,
  };
}

describe("createCodexOnboardingController.recheck", () => {
  it("discovers, diagnoses, persists, and notifies on a happy path", async () => {
    const deps = makeDeps();
    const controller = createCodexOnboardingController(deps);
    const snapshot = await controller.recheck();
    expect(snapshot.report.status).toBe("ready");
    expect(snapshot.binaryPath).toBe("/usr/local/bin/codex");
    expect(snapshot.source).toBe("path");
    expect(deps.snapshots).toHaveLength(1);
    expect(deps.writtenPatches).toEqual([
      { binaryPath: "/usr/local/bin/codex", lastCheck: { status: "ready", version: "0.144.3", at: snapshot.checkedAt } },
    ]);
  });

  it("does not persist binaryPath for an env-override result, but still persists lastCheck", async () => {
    const deps = makeDeps({ bootEnv: { PATH: "", HOME: "", ANYCODE_CODEX_BIN: "/dev/codex" } });
    const controller = createCodexOnboardingController(deps);
    const snapshot = await controller.recheck();
    expect(snapshot.source).toBe("env");
    expect(deps.writtenPatches).toEqual([{ lastCheck: { status: "ready", version: "0.144.3", at: snapshot.checkedAt } }]);
  });

  it("reports not_installed without spawning a doctor when nothing on the ladder resolves", async () => {
    const runDoctor = vi.fn();
    const deps = makeDeps({ bootEnv: { PATH: "", HOME: "" }, fs: noBinaryFs, runDoctor });
    const controller = createCodexOnboardingController(deps);
    const snapshot = await controller.recheck();
    expect(snapshot.report).toEqual({ status: "not_installed" });
    expect(snapshot.binaryPath).toBeNull();
    expect(runDoctor).not.toHaveBeenCalled();
  });

  it("dedups concurrent recheck calls into a single doctor run", async () => {
    let calls = 0;
    const runDoctor = vi.fn(async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: "ready" as const, version: "0.144.3", account: { type: "chatgpt", plan: "plus" }, models: [] };
    });
    const deps = makeDeps({ runDoctor });
    const controller = createCodexOnboardingController(deps);
    const [a, b] = await Promise.all([controller.recheck(), controller.recheck()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("a settings write failure never blocks the live snapshot from reaching the caller", async () => {
    const deps = makeDeps({ writeCodexSettings: async () => { throw new Error("read_only"); } });
    const controller = createCodexOnboardingController(deps);
    const snapshot = await controller.recheck();
    expect(snapshot.report.status).toBe("ready");
  });
});

describe("createCodexOnboardingController.pickBinary", () => {
  it("returns cancelled when the dialog is dismissed", async () => {
    const deps = makeDeps();
    const controller = createCodexOnboardingController(deps);
    const result = await controller.pickBinary();
    expect(result).toEqual({ ok: false, reason: "cancelled" });
  });

  it("returns invalid for a relative or non-executable pick", async () => {
    const deps = makeDeps({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["relative/codex"] }) },
    });
    const controller = createCodexOnboardingController(deps);
    const result = await controller.pickBinary();
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("diagnoses and persists an explicitly picked path with source 'picker'", async () => {
    const deps = makeDeps({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["/custom/codex"] }) },
    });
    const controller = createCodexOnboardingController(deps);
    const result = await controller.pickBinary();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.binaryPath).toBe("/custom/codex");
      expect(result.snapshot.source).toBe("picker");
    }
    expect(deps.writtenPatches).toEqual([
      { binaryPath: "/custom/codex", lastCheck: { status: "ready", version: "0.144.3", at: expect.any(String) } },
    ]);
  });
});

describe("createCodexOnboardingController.loginStart / loginCancel", () => {
  it("refuses unsupported when no binary is discoverable", async () => {
    const deps = makeDeps({ bootEnv: { PATH: "", HOME: "" }, fs: noBinaryFs });
    const controller = createCodexOnboardingController(deps);
    const result = await controller.loginStart();
    expect(result).toEqual({ ok: false, reason: "unsupported" });
  });

  it("re-diagnoses via the doctor after a successful login handshake", async () => {
    const runLogin = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps({ runLogin });
    const controller = createCodexOnboardingController(deps);
    const result = await controller.loginStart();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.report.status).toBe("ready");
    }
    expect(runLogin).toHaveBeenCalledOnce();
  });

  it("passes the login outcome's own failure reason straight through", async () => {
    const deps = makeDeps({ runLogin: async () => ({ ok: false, reason: "timeout" }) });
    const controller = createCodexOnboardingController(deps);
    const result = await controller.loginStart();
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });

  it("refuses a second concurrent loginStart with busy", async () => {
    let resolveLogin!: (outcome: { ok: true }) => void;
    const runLogin = vi.fn(() => new Promise<{ ok: true }>((resolve) => { resolveLogin = resolve; }));
    const deps = makeDeps({ runLogin: runLogin as never });
    const controller = createCodexOnboardingController(deps);
    const first = controller.loginStart();
    const second = await controller.loginStart();
    expect(second).toEqual({ ok: false, reason: "busy" });
    resolveLogin({ ok: true });
    await first;
  });

  it("loginCancel aborts the signal passed into runLogin", async () => {
    let observedSignal: AbortSignal | undefined;
    const runLogin = vi.fn(async (_path: string, opts: { signal?: AbortSignal }) => {
      observedSignal = opts.signal;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: false as const, reason: "cancelled" as const };
    });
    const deps = makeDeps({ runLogin });
    const controller = createCodexOnboardingController(deps);
    const pending = controller.loginStart();
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.loginCancel();
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: "cancelled" });
    expect(observedSignal?.aborted).toBe(true);
  });
});

describe("custody", () => {
  it("the persisted lastCheck patch never carries an account/token field", async () => {
    const report: CodexDoctorReport = { status: "ready", version: "0.144.3", account: { type: "chatgpt", plan: "plus" }, models: [] };
    const deps = makeDeps({ runDoctor: async () => report });
    const controller = createCodexOnboardingController(deps);
    await controller.recheck();
    const [patch] = deps.writtenPatches as Array<{ lastCheck: Record<string, unknown> }>;
    expect(Object.keys(patch!.lastCheck)).toEqual(["status", "version", "at"]);
  });
});
