import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CodexDoctorReport } from "../shared/codex-doctor.js";
import type { CodexBinaryFs } from "./codex-binary.js";
import { CODEX_DOCTOR_TTL_MS, createCodexOnboardingController, type CodexIpcDeps, type CodexOnboardingSnapshot } from "./codex-ipc.js";

const scratch = mkdtempSync(join(tmpdir(), "anycode-codex-ipc-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let homeCounter = 0;

/** One macrotask turn — drains the microtask queue so queued seam work advances. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

  // S3-2 red-proof: `runExclusive` must coalesce ONLY within the same profile
  // key. A held `recheck("a")` must not swallow a concurrent `recheck(undefined)`
  // (active = system) — the second call must run its OWN doctor and get its OWN
  // (system) verdict, sequentially, not adopt profile a's in-flight report.
  it("serializes a different-profile recheck instead of coalescing it onto the held profile's report (S3-2)", async () => {
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const invocations: string[] = [];
    let inFlightNow = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Echoes the profile it ran against (codexHome present ⇒ concrete profile;
    // absent ⇒ the system pseudo-profile). Blocks on a shared gate so the FIRST
    // run is provably still in flight when the concurrent second call arrives.
    const runDoctor = vi.fn(async (_path: string, options?: { profile?: { id: string; codexHome?: string } }): Promise<CodexDoctorReport> => {
      const id = options?.profile?.codexHome !== undefined ? options.profile.id : undefined;
      invocations.push(id ?? "system");
      inFlightNow++;
      maxConcurrent = Math.max(maxConcurrent, inFlightNow);
      await gate;
      inFlightNow--;
      const status: CodexDoctorReport["status"] = id === undefined ? "signed_out" : "ready";
      return {
        status,
        version: "0.144.3",
        ...(status === "ready" ? { account: { type: "chatgpt", plan: "plus" }, models: [] } : {}),
        ...(id !== undefined ? { profileId: id } : {}),
      };
    });
    const deps = makeDeps({ runDoctor });
    const controller = createCodexOnboardingController(deps);
    expect((await controller.createProfile({ label: "a" })).ok).toBe(true); // id "a"; active stays system

    const held = controller.recheck("a"); // doctor #1 (profile a), blocks on the gate
    while (runDoctor.mock.calls.length < 1) await tick();
    const concurrent = controller.recheck(undefined); // active = system, a DIFFERENT key
    await tick();
    await tick();
    // Serialized behind the held run: the active-profile recheck has NOT spawned
    // its own doctor yet (one child at a time).
    expect(runDoctor.mock.calls.length).toBe(1);

    release();
    const aSnap = await held;
    const sysSnap = await concurrent;

    expect(aSnap.report.profileId).toBe("a");
    // The discriminant: the active-profile recheck returns ITS OWN system verdict
    // (no profileId, signed_out), NOT profile a's — and a second doctor really ran.
    expect(sysSnap.report.profileId).toBeUndefined();
    expect(sysSnap.report.status).toBe("signed_out");
    expect(invocations).toEqual(["a", "system"]);
    expect(maxConcurrent).toBe(1); // never two doctor children at once
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

describe("serialization seam — login in-flight + key namespace (W4-F1 L10)", () => {
  /** A doctor that echoes the profile it ran against, tracking call order and peak concurrency. */
  function makeCountingDoctor(state: { calls: string[]; inFlight: number; maxConcurrent: number }, delayMs = 5) {
    return vi.fn(async (_path: string, options?: { profile?: { id: string; codexHome?: string } }): Promise<CodexDoctorReport> => {
      const id = options?.profile?.codexHome !== undefined ? options.profile.id : "system";
      state.calls.push(id);
      state.inFlight++;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      state.inFlight--;
      return { status: "ready", version: "0.144.3", account: { type: "chatgpt", email: null, plan: "plus" }, models: [], profileId: id };
    });
  }

  // F1-a red-proof: a login holds a real child (browser open, seconds-minutes).
  // A recheck of a DIFFERENT profile that lands during it must QUEUE behind the
  // login seam, not spawn a second doctor child in parallel. Rollback (login
  // outside inFlightByKey/inFlightTail) ⇒ the doctor starts immediately = RED.
  it("F1-a: a different-profile recheck does NOT spawn a doctor while a login is in flight — it queues behind the seam", async () => {
    let resolveLogin!: (outcome: { ok: true }) => void;
    const runLogin = vi.fn(() => new Promise<{ ok: true }>((resolve) => { resolveLogin = resolve; }));
    const state = { calls: [] as string[], inFlight: 0, maxConcurrent: 0 };
    const runDoctor = makeCountingDoctor(state);
    const deps = makeDeps({ runLogin: runLogin as never, runDoctor });
    const controller = createCodexOnboardingController(deps);
    expect((await controller.createProfile({ label: "acc" })).ok).toBe(true);
    expect((await controller.createProfile({ label: "other" })).ok).toBe(true);

    const loginPromise = controller.loginStart("acc");
    while (runLogin.mock.calls.length === 0) await tick();

    const recheckPromise = controller.recheck("other");
    await tick();
    await tick();
    // The discriminant: with the login child still alive, the different-profile
    // recheck has NOT spawned a doctor of its own (rollback ⇒ parallel doctor here).
    expect(runDoctor).not.toHaveBeenCalled();

    resolveLogin({ ok: true });
    const loginResult = await loginPromise;
    const recheckSnap = await recheckPromise;

    expect(loginResult.ok).toBe(true);
    // Login's own post-login doctor ran first (inside the held seam), THEN the
    // queued recheck — strictly sequential, never two children at once.
    expect(state.calls).toEqual(["acc", "other"]);
    expect(state.maxConcurrent).toBe(1);
    expect(recheckSnap.report.profileId).toBe("other");
  });

  // F1-b red-proof: a concurrent recheck of the SAME profile, still in flight
  // when the login finishes, must NOT be what the post-login re-diagnosis
  // returns. The post-login doctor must be a fresh POST-credential verdict.
  // Rollback (post-login `runExclusive(profile.id)` coalescing onto the
  // in-flight pre-credential recheck) ⇒ the stale "signed_out" is handed back
  // right after a successful sign-in = RED.
  it("F1-b: the post-login re-diagnosis is a POST-credential verdict, not a coalesced pre-credential recheck of the same profile", async () => {
    let credentialWritten = false;
    let resolveLogin!: () => void;
    const runLogin = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveLogin = () => {
            credentialWritten = true; // the login writes the credential into the profile home
            resolve({ ok: true });
          };
        }),
    );
    let releaseDoctorGate!: () => void;
    const doctorGate = new Promise<void>((resolve) => { releaseDoctorGate = resolve; });
    const runDoctor = vi.fn(async (_path: string, options?: { profile?: { id: string; codexHome?: string } }): Promise<CodexDoctorReport> => {
      const id = options?.profile?.codexHome !== undefined ? options.profile.id : "system";
      // Captured AT CALL TIME: a doctor spawned before the credential landed
      // reads "signed_out"; one spawned after reads "ready".
      const credAtCall = credentialWritten;
      if (!credAtCall) {
        // Hold a pre-credential doctor in flight so it is provably still
        // coalescible when the login reaches its post-login re-diagnosis.
        await doctorGate;
      }
      const status: CodexDoctorReport["status"] = credAtCall ? "ready" : "signed_out";
      return {
        status,
        version: "0.144.3",
        ...(status === "ready" ? { account: { type: "chatgpt", email: null, plan: "plus" }, models: [] } : {}),
        profileId: id,
      };
    });
    const deps = makeDeps({ runLogin: runLogin as never, runDoctor });
    const controller = createCodexOnboardingController(deps);
    expect((await controller.createProfile({ label: "acc" })).ok).toBe(true);

    const loginPromise = controller.loginStart("acc");
    while (runLogin.mock.calls.length === 0) await tick();

    // A recheck of the SAME profile arrives while the login child is alive.
    const recheckPromise = controller.recheck("acc");
    await tick();
    await tick();

    resolveLogin(); // credential written; login proceeds to its post-login doctor
    await tick();
    releaseDoctorGate(); // unblock any pre-credential doctor left in flight (rollback path)

    const loginResult = await loginPromise;
    await recheckPromise;

    expect(loginResult.ok).toBe(true);
    if (loginResult.ok) {
      // The discriminant: a POST-credential verdict, not the stale pre-credential
      // recheck's "signed_out" (rollback coalesces onto it here).
      expect(loginResult.snapshot.report.status).toBe("ready");
      expect(loginResult.snapshot.report.profileId).toBe("acc");
    }
  });

  // F2 red-proof: the reserved active-profile key must be unreachable from a
  // renderer-supplied id. `recheck()` (active) and `recheck("recheck:active")`
  // must occupy DISJOINT keys. Rollback (bare `profileId ?? ACTIVE_PROFILE_KEY`)
  // ⇒ the literal string collides with the reserved key and coalesces = RED.
  it("F2: recheck() and recheck(\"recheck:active\") occupy disjoint keys — the reserved key is not collidable from a renderer id", async () => {
    const deps = makeDeps();
    const controller = createCodexOnboardingController(deps);
    const [active, bogus] = await Promise.all([controller.recheck(), controller.recheck("recheck:active")]);
    // Disjoint keys ⇒ two independent runs, not one coalesced promise.
    expect(active).not.toBe(bogus);
    // The argless call diagnosed the ACTIVE (system) profile...
    expect(active.report.profileId).toBeUndefined();
    // ...while the literal-string id is an UNKNOWN profile (resolution error),
    // never silently adopted as the active recheck.
    expect(bogus.report.status).toBe("error");
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

  it("hasVerdictFor() splits never-diagnosed (unknown) from a landed verdict (TASK.64)", async () => {
    const runDoctor = profileAwareDoctor((id) => (id === "good" ? "ready" : "signed_out"));
    const deps = makeDeps({ runDoctor });
    const controller = createCodexOnboardingController(deps);
    expect((await controller.createProfile({ label: "good" })).ok).toBe(true);
    expect((await controller.createProfile({ label: "bad" })).ok).toBe(true);
    // Before ANY diagnosis every slot is unknown — readyFor's fail-closed false
    // must not be read as "configured but not ready".
    expect(controller.hasVerdictFor("good")).toBe(false);
    expect(controller.hasVerdictFor(undefined)).toBe(false);

    await controller.recheck("good");
    expect(controller.hasVerdictFor("good")).toBe(true);
    expect(controller.readyFor("good")).toBe(true);

    // A landed NOT-ready verdict is KNOWN too — the gate refuses fast, no re-doctor.
    await controller.recheck("bad");
    expect(controller.hasVerdictFor("bad")).toBe(true);
    expect(controller.readyFor("bad")).toBe(false);

    // A failed profile resolution caches nothing — still unknown.
    await controller.recheck("no-such");
    expect(controller.hasVerdictFor("no-such")).toBe(false);
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

describe("doctor TTL cache (TASK.65)", () => {
  /** A ready-verdict doctor whose spawn count makes a TTL reuse provable as "0 extra runs". */
  function countingReadyDoctor() {
    return vi.fn(async (): Promise<CodexDoctorReport> => ({
      status: "ready",
      version: "0.144.3",
      account: { type: "chatgpt", plan: "plus" },
      models: [],
    }));
  }

  it("reuses a verdict within the TTL — a second ensureChecked runs the doctor 0 extra times", async () => {
    let clock = 1_000_000;
    const runDoctor = countingReadyDoctor();
    const controller = createCodexOnboardingController(makeDeps({ runDoctor, now: () => clock }));
    await controller.ensureChecked();
    expect(runDoctor).toHaveBeenCalledTimes(1);
    clock += CODEX_DOCTOR_TTL_MS - 1; // still inside the freshness window
    const second = await controller.ensureChecked();
    expect(runDoctor).toHaveBeenCalledTimes(1); // no re-spawn
    expect(second.report.status).toBe("ready");
  });

  it("re-runs the doctor once the TTL has elapsed (strict < ⇒ the boundary is stale)", async () => {
    let clock = 1_000_000;
    const runDoctor = countingReadyDoctor();
    const controller = createCodexOnboardingController(makeDeps({ runDoctor, now: () => clock }));
    await controller.ensureChecked();
    clock += CODEX_DOCTOR_TTL_MS; // now() - checkedAt === TTL ⇒ not fresh
    await controller.ensureChecked();
    expect(runDoctor).toHaveBeenCalledTimes(2);
  });

  it("force:true bypasses a fresh cache (the Settings 'Recheck all' action)", async () => {
    let clock = 1_000_000;
    const runDoctor = countingReadyDoctor();
    const controller = createCodexOnboardingController(makeDeps({ runDoctor, now: () => clock }));
    await controller.ensureChecked();
    clock += 5_000; // well within the TTL
    await controller.ensureChecked(undefined, { force: true });
    expect(runDoctor).toHaveBeenCalledTimes(2);
  });

  it("recheck() delegates through the TTL — a plain recheck inside the window reuses the cache, force re-runs", async () => {
    let clock = 1_000_000;
    const runDoctor = countingReadyDoctor();
    const controller = createCodexOnboardingController(makeDeps({ runDoctor, now: () => clock }));
    await controller.recheck();
    clock += 10_000;
    await controller.recheck(); // TTL-guarded (no options) ⇒ cache hit
    expect(runDoctor).toHaveBeenCalledTimes(1);
    await controller.recheck(undefined, { force: true }); // explicit "Recheck all"
    expect(runDoctor).toHaveBeenCalledTimes(2);
  });

  it("coalesces two concurrent ensureChecked calls into ONE doctor run", async () => {
    const runDoctor = vi.fn(async (): Promise<CodexDoctorReport> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: "ready", version: "0.144.3", account: { type: "chatgpt", plan: "plus" }, models: [] };
    });
    const controller = createCodexOnboardingController(makeDeps({ runDoctor }));
    const [a, b] = await Promise.all([controller.ensureChecked(), controller.ensureChecked()]);
    expect(a).toBe(b);
    expect(runDoctor).toHaveBeenCalledTimes(1);
  });

  it("boot-prime path: ensureChecked warms a NON-active profile's verdict (readyFor/hasVerdictFor flip)", async () => {
    const runDoctor = vi.fn(async (_path: string, options?: { profile?: { id: string; codexHome?: string } }): Promise<CodexDoctorReport> => {
      const id = options?.profile?.codexHome !== undefined ? options.profile.id : undefined;
      return { status: "signed_out", version: "0.144.3", ...(id !== undefined ? { profileId: id } : {}) };
    });
    const controller = createCodexOnboardingController(makeDeps({ runDoctor }));
    expect((await controller.createProfile({ label: "other" })).ok).toBe(true);
    // "other" is never made active — the active profile stays `system`, so this
    // is exactly the non-active profile the boot loop primes.
    expect(controller.hasVerdictFor("other")).toBe(false); // UNKNOWN before the prime
    await controller.ensureChecked("other"); // the boot loop's per-id prime
    expect(controller.hasVerdictFor("other")).toBe(true); // now KNOWN
    expect(controller.readyFor("other")).toBe(false); // known signed_out, not UNKNOWN
  });

  it("regression: a landed signed_out verdict is KNOWN (UNKNOWN != signed_out) and is reused within the TTL", async () => {
    let clock = 1_000_000;
    const runDoctor = vi.fn(async (): Promise<CodexDoctorReport> => ({ status: "signed_out", version: "0.144.3" }));
    const controller = createCodexOnboardingController(makeDeps({ runDoctor, now: () => clock }));
    // Before any doctor pass the two are distinct: fail-closed false AND unknown.
    expect(controller.readyFor()).toBe(false);
    expect(controller.hasVerdictFor()).toBe(false);
    await controller.ensureChecked();
    expect(runDoctor).toHaveBeenCalledTimes(1);
    expect(controller.hasVerdictFor()).toBe(true); // a signed_out verdict IS a verdict
    expect(controller.readyFor()).toBe(false);
    clock += 10_000;
    await controller.ensureChecked(); // within TTL ⇒ reused, not re-spawned
    expect(runDoctor).toHaveBeenCalledTimes(1);
  });
});
