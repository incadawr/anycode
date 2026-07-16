import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CodexDoctorReport } from "../shared/codex-doctor.js";
import type { CodexBinaryFs } from "./codex-binary.js";
import { createCodexOnboardingController, type CodexIpcDeps, type CodexOnboardingSnapshot } from "./codex-ipc.js";

const scratch = mkdtempSync(join(tmpdir(), "anycode-codex-ipc-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let homeCounter = 0;

/** Rejects every path — no rung of the discovery ladder resolves. */
const noBinaryFs: CodexBinaryFs = {
  realpath: (path) => path,
  stat() {
    throw new Error("ENOENT");
  },
};

/** uid/gids the fake fs below is owned by; pinned so the suite does not depend on the real uid of whoever runs it. */
const ME = { uid: 501, gids: [20] };

function makeDeps(
  overrides: Partial<CodexIpcDeps> = {},
): CodexIpcDeps & { writtenPatches: unknown[]; snapshots: CodexOnboardingSnapshot[]; home: string } {
  const writtenPatches: unknown[] = [];
  const snapshots: CodexOnboardingSnapshot[] = [];
  // The in-memory settings.codex block the registry round-trips through — the
  // same read-what-you-wrote shape settings-ipc's handleSet provides in prod.
  let codexBlock: Record<string, unknown> = {};
  const home = join(scratch, `home-${homeCounter++}`);
  mkdirSync(home, { recursive: true });
  return {
    bootEnv: { PATH: "/usr/local/bin", HOME: "/home/dev" },
    readBinaryPathSetting: async () => undefined,
    readCodexSettings: async () => codexBlock as never,
    home,
    writeCodexSettings: async (patch) => {
      writtenPatches.push(patch);
      codexBlock = { ...codexBlock, ...(patch as object) };
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
    // The first call claims the lock synchronously but only reaches runLogin
    // after its pre-spawn awaits (profile resolution, settings read) settle.
    while (runLogin.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
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

describe("codex profiles control plane (TASK.50, cut §2/§4)", () => {
  /** A doctor fake that answers per-profile, echoing the profile it was run against — the shape the real runner produces. */
  function profileAwareDoctor(statusFor: (profileId: string) => CodexDoctorReport["status"] = () => "ready") {
    return vi.fn(async (_path: string, options?: { profile?: { id: string; codexHome?: string } }): Promise<CodexDoctorReport> => {
      const id = options?.profile?.codexHome !== undefined ? options.profile.id : undefined;
      const status = statusFor(id ?? "system");
      return {
        status,
        version: "0.144.3",
        ...(status === "ready" ? { account: { type: "chatgpt", email: "sentinel-custody@example.com", plan: "plus" }, models: [] } : {}),
        ...(id !== undefined ? { profileId: id } : {}),
      };
    });
  }

  it("lists an empty registry as system-active", async () => {
    const controller = createCodexOnboardingController(makeDeps());
    expect(await controller.listProfiles()).toEqual({ profiles: [], activeProfileId: "system" });
  });

  it("creates a profile (persisted record + real 0700 home) and lists it back", async () => {
    const deps = makeDeps();
    const controller = createCodexOnboardingController(deps);
    const created = await controller.createProfile({ label: "Personal" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.profile.id).toBe("personal");
    const listed = await controller.listProfiles();
    expect(listed.profiles).toHaveLength(1);
    expect(listed.profiles[0]?.profile.label).toBe("Personal");
  });

  it("recheck(profileId) hands the RESOLVED profile to the doctor and persists the per-profile lastCheck — never the top-level one", async () => {
    const runDoctor = profileAwareDoctor();
    const deps = makeDeps({ runDoctor });
    const controller = createCodexOnboardingController(deps);
    const created = await controller.createProfile({ label: "acc" });
    expect(created.ok).toBe(true);

    const snapshot = await controller.recheck("acc");
    expect(snapshot.report.status).toBe("ready");
    expect(snapshot.report.profileId).toBe("acc");
    expect(runDoctor).toHaveBeenCalledWith(
      "/usr/local/bin/codex",
      expect.objectContaining({
        profile: expect.objectContaining({ id: "acc", codexHome: join(deps.home, ".anycode", "codex", "profile-acc") }),
      }),
    );
    // Per-profile lastCheck landed in the record...
    const listed = await controller.listProfiles();
    expect(listed.profiles[0]?.profile.lastCheck?.status).toBe("ready");
    // ...while the TOP-LEVEL lastCheck (the ACTIVE profile's slot, cut §2.3)
    // was NOT written for a non-active profile's check.
    const topLevel = (deps.writtenPatches as Array<Record<string, unknown>>).filter((patch) => "lastCheck" in patch);
    expect(topLevel).toEqual([]);
  });

  it("recheck() with no argument checks the ACTIVE profile and writes the top-level lastCheck", async () => {
    const runDoctor = profileAwareDoctor();
    const deps = makeDeps({ runDoctor });
    const controller = createCodexOnboardingController(deps);
    const created = await controller.createProfile({ label: "acc" });
    expect(created.ok).toBe(true);
    expect(await controller.setActiveProfile("acc")).toEqual({ ok: true });

    const snapshot = await controller.recheck();
    expect(snapshot.report.profileId).toBe("acc");
    const topLevel = (deps.writtenPatches as Array<Record<string, unknown>>).filter((patch) => "lastCheck" in patch);
    expect(topLevel).toHaveLength(1);
  });

  it("readyFor() answers per profile, not per binary (cut §4.2: readiness = f(binary, profile))", async () => {
    const runDoctor = profileAwareDoctor((id) => (id === "good" ? "ready" : "signed_out"));
    const deps = makeDeps({ runDoctor });
    const controller = createCodexOnboardingController(deps);
    expect((await controller.createProfile({ label: "good" })).ok).toBe(true);
    expect((await controller.createProfile({ label: "bad" })).ok).toBe(true);
    await controller.recheck("good");
    await controller.recheck("bad");
    expect(controller.readyFor("good")).toBe(true);
    expect(controller.readyFor("bad")).toBe(false);
    // The default (active = system) has not been checked ready in this test.
    expect(controller.readyFor(undefined)).toBe(false);
  });

  it("recheck of an UNKNOWN profile is an error snapshot with no doctor spawn", async () => {
    const runDoctor = vi.fn();
    const deps = makeDeps({ runDoctor });
    const controller = createCodexOnboardingController(deps);
    const snapshot = await controller.recheck("no-such");
    expect(snapshot.report.status).toBe("error");
    expect(runDoctor).not.toHaveBeenCalled();
  });

  it("loginStart into an authLink profile is refused as unsupported, without running the login flow (amended §A1)", async () => {
    const runLogin = vi.fn(async () => ({ ok: true as const }));
    const deps = makeDeps({ runLogin });
    const controller = createCodexOnboardingController(deps);
    const target = join(deps.home, "fake-auth-target.json");
    writeFileSync(target, "{}");
    const created = await controller.createProfile({ label: "main", authLink: target });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await controller.loginStart(created.profile.id);
    expect(result).toEqual({ ok: false, reason: "unsupported" });
    expect(runLogin).not.toHaveBeenCalled();
  });

  it("loginStart(profileId) passes the resolved profile into the login runner and re-diagnoses against it", async () => {
    const runLogin = vi.fn(async (_path: string, opts: { profile?: { id: string } }) => {
      expect(opts.profile?.id).toBe("acc");
      return { ok: true as const };
    });
    const runDoctor = profileAwareDoctor();
    const deps = makeDeps({ runLogin, runDoctor });
    const controller = createCodexOnboardingController(deps);
    expect((await controller.createProfile({ label: "acc" })).ok).toBe(true);

    const result = await controller.loginStart("acc");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.report.profileId).toBe("acc");
    }
    expect(runLogin).toHaveBeenCalledOnce();
  });

  it("deleteProfile drops the record AND the profile's cached readiness", async () => {
    const runDoctor = profileAwareDoctor();
    const deps = makeDeps({ runDoctor });
    const controller = createCodexOnboardingController(deps);
    expect((await controller.createProfile({ label: "gone" })).ok).toBe(true);
    await controller.recheck("gone");
    expect(controller.readyFor("gone")).toBe(true);

    expect(await controller.deleteProfile("gone")).toEqual({ ok: true });
    expect(controller.readyFor("gone")).toBe(false);
    expect((await controller.listProfiles()).profiles).toEqual([]);
  });

  it("repairProfileLink refuses an unknown id and a profile without an authLink", async () => {
    const deps = makeDeps();
    const controller = createCodexOnboardingController(deps);
    expect((await controller.repairProfileLink("no-such")).ok).toBe(false);
    expect((await controller.createProfile({ label: "plain" })).ok).toBe(true);
    expect((await controller.repairProfileLink("plain")).ok).toBe(false);
  });

  it("custody §4.4: the sentinel e-mail from the doctor report never reaches ANY persisted settings patch", async () => {
    const runDoctor = profileAwareDoctor();
    const deps = makeDeps({ runDoctor });
    const controller = createCodexOnboardingController(deps);
    expect((await controller.createProfile({ label: "acc" })).ok).toBe(true);
    await controller.setActiveProfile("acc");
    await controller.recheck("acc");
    await controller.recheck();
    expect(JSON.stringify(deps.writtenPatches)).not.toContain("sentinel-custody@example.com");
  });
});
