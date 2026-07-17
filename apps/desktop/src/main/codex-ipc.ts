/**
 * Codex onboarding control plane (TASK.41, cut §2(g)/§3.8): the invoke-API
 * behind the Settings Codex card — recheck (discovery ladder + bounded
 * doctor), explicit file-picker override, and the native login flow
 * (start/cancel). Wires main/codex-binary.ts (discovery), main/codex-
 * doctor.ts (diagnosis), and main/codex-login.ts (sign-in) together, persists
 * ONLY path/status metadata into settings.codex (never a token — cut §2(g)),
 * and hands the caller a fresh snapshot on every successful step so the
 * renderer can re-render without a restart (TASK.41 п.5).
 *
 * CHANNEL NAMES ARE DUPLICATED LITERALS, not `shared/**` exports: every lane
 * in this track froze `shared/**` as read-only after block C0 (design cut §4
 * disjointness rules) specifically so no two parallel lanes fight over the
 * same file. This mirrors the codebase's existing precedent for a boundary
 * that can't reach a shared module (e.g. `ENV_WORKSPACE`/`ENV_DB_PATH` in
 * main/index.ts, `buildCodexChildEnv` duplicated in main/codex-doctor.ts) —
 * preload/index.ts and renderer/src/anycode-window.d.ts hold byte-identical
 * copies of these five constants, kept in sync by contract.
 */
import { ipcMain } from "electron";
import type { CodexDoctorReport } from "../shared/codex-doctor.js";
import type { SettingsMutationResult } from "../shared/settings.js";
import { ENV_CODEX_BIN } from "../shared/engines.js";
import { CODEX_ONBOARDING_SHUTDOWN_BUDGET_MS } from "../shared/codex-timeouts.js";
import { closeAllCodexChildren } from "./codex-children.js";
import {
  discoverCodexBinary,
  resolveCodexBinary,
  type CodexBinaryFs,
  type CodexBinarySource,
  type CodexIdentity,
} from "./codex-binary.js";
import { runCodexDoctor, type RunCodexDoctorOptions } from "./codex-doctor.js";
import { runCodexLogin, type CodexLoginOutcome, type RunCodexLoginOptions } from "./codex-login.js";
import {
  SYSTEM_CODEX_PROFILE,
  SYSTEM_PROFILE_ID,
  assertCodexProfileHome,
  createCodexProfilesRegistry,
  type CodexProfileCreateRequest,
  type CodexProfileCreateResult,
  type CodexProfileFs,
  type CodexProfileGuardResult,
  type CodexProfilesSettingsSlice,
  type ResolvedCodexProfile,
} from "./codex-profiles.js";
import type { CodexProfileRecord } from "../shared/settings.js";

// ── invoke/push channels (duplicated literals — see file header) ──

export const CODEX_RECHECK_CHANNEL = "anycode:codex-recheck";
export const CODEX_PICK_BINARY_CHANNEL = "anycode:codex-pick-binary";
export const CODEX_LOGIN_START_CHANNEL = "anycode:codex-login-start";
export const CODEX_LOGIN_CANCEL_CHANNEL = "anycode:codex-login-cancel";
// Profile control plane (TASK.50, cut §2/§4) — same duplicated-literal
// convention as the four above.
export const CODEX_PROFILE_LIST_CHANNEL = "anycode:codex-profile-list";
export const CODEX_PROFILE_CREATE_CHANNEL = "anycode:codex-profile-create";
export const CODEX_PROFILE_DELETE_CHANNEL = "anycode:codex-profile-delete";
export const CODEX_PROFILE_SET_ACTIVE_CHANNEL = "anycode:codex-profile-set-active";
/** The explicit "Re-link credential" action (amended §A1.2) — the ONLY path that repairs a wrong auth.json entry. */
export const CODEX_PROFILE_REPAIR_LINK_CHANNEL = "anycode:codex-profile-repair-link";
/** Push: main -> renderer, fired after every snapshot-changing step (TASK.41 п.5). No payload — listeners re-fetch (`listAvailableEngines`/`codex-recheck`), same shape as `updates.onUpdateStatus`/`window.onWindowState`. */
export const ENGINES_CHANGED_CHANNEL = "anycode:engines-changed";

// ── wire shapes (duplicated structurally in anycode-window.d.ts; CodexDoctorReport itself is the frozen shared/codex-doctor.ts type, imported read-only) ──

export interface CodexOnboardingSnapshot {
  report: CodexDoctorReport;
  /** The winning candidate path, or null when nothing on the ladder resolved. */
  binaryPath: string | null;
  source: CodexBinarySource;
  /** ISO timestamp of this check. */
  checkedAt: string;
}

export type CodexPickBinaryResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "cancelled" | "invalid" };

export type CodexLoginStartResult =
  | { ok: true; snapshot: CodexOnboardingSnapshot }
  | { ok: false; reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed" };

/** One registry row projected for the renderer: the persisted record + the last in-memory doctor report (cut §4.3 — reports are cached in main memory, never on disk). */
export interface CodexProfilesSnapshot {
  profiles: Array<{ profile: CodexProfileRecord; report?: CodexDoctorReport }>;
  activeProfileId: string;
}

export interface DialogLike {
  showOpenDialog(options: { properties: Array<"openFile">; defaultPath?: string }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface CodexIpcDeps {
  /** Immutable boot-env snapshot (main/index.ts's `bootEnv`) — read for `ANYCODE_CODEX_BIN`/`PATH`/`HOME`/`APPDATA`, and passed through as the doctor/login child's SOURCE env (buildDoctorChildEnv still allowlists it). */
  bootEnv: NodeJS.ProcessEnv;
  /** Reads the currently-persisted `settings.codex.binaryPath`, fresh, every call (main is the sole writer; this module never caches it). */
  readBinaryPathSetting: () => Promise<string | undefined>;
  /** Reads the persisted `settings.codex` profile slice fresh every call — the registry never caches settings state. */
  readCodexSettings: () => Promise<CodexProfilesSettingsSlice | undefined>;
  /**
   * Persists a `settings.codex` patch (cut §3.5 + §2.3: `binaryPath`/
   * `lastCheck` as before, plus the additive `profiles`/`activeProfileId`
   * registry fields — arrays replace wholesale, per the settings-set merge
   * contract). Expected to route through the SAME `settings-set`
   * validation/merge/save pipeline settings-ipc.ts's `handleSet` already owns
   * (main/index.ts wires this as a thin closure over it) — one write path,
   * not two. Best-effort from this module's point of view: a `read_only`
   * refusal must not block the LIVE snapshot this session already computed
   * from reaching the caller. NEVER carries account material: only
   * status/version/at cross into a lastCheck (custody §4.4).
   */
  writeCodexSettings: (patch: {
    binaryPath?: string;
    lastCheck?: { status: CodexDoctorReport["status"]; version?: string; at: string };
    profiles?: CodexProfileRecord[];
    activeProfileId?: string;
  }) => Promise<SettingsMutationResult>;
  /** User home the profile tree (`~/.anycode/codex/…`) lives under; tests point this at a tmp dir. */
  home?: string;
  /** Filesystem seam of the profile registry/guard; production uses real node:fs. */
  profileFs?: CodexProfileFs;
  /** Fired after a profile CRUD mutation (create/delete/set-active/repair) so main can push `ENGINES_CHANGED_CHANNEL`. */
  onProfilesChanged?: () => void;
  dialog: DialogLike;
  openExternal: (url: string) => Promise<void> | void;
  /** Fired after every successful recheck/pick/login with the fresh snapshot — main/index.ts updates its `codexBinaryPath` and pushes `ENGINES_CHANGED_CHANNEL` (readiness itself is read back via `readyFor`). */
  onSnapshot: (snapshot: CodexOnboardingSnapshot) => void;
  platform?: NodeJS.Platform;
  fs?: CodexBinaryFs;
  /** Test seam for the trust gate's ownership rules; production reads the live process identity. */
  identity?: CodexIdentity;
  /** DI seams for tests; production defaults to the real doctor/login runners. */
  runDoctor?: (binaryPath: string, options?: RunCodexDoctorOptions) => Promise<CodexDoctorReport>;
  runLogin?: (binaryPath: string, options: RunCodexLoginOptions) => Promise<CodexLoginOutcome>;
}

export interface CodexOnboardingController {
  /** Diagnoses ONE profile (the active one when `profileId` is absent) against the discovered binary (cut §4.2: readiness = f(binary, profile)). */
  recheck(profileId?: string): Promise<CodexOnboardingSnapshot>;
  pickBinary(): Promise<CodexPickBinaryResult>;
  /** Runs the native login INTO a profile's home (TASK.50 п.2); an authLink profile refuses `unsupported` (amended §A1). */
  loginStart(profileId?: string): Promise<CodexLoginStartResult>;
  loginCancel(): void;
  // ── profile control plane (TASK.50) ──
  listProfiles(): Promise<CodexProfilesSnapshot>;
  createProfile(request: CodexProfileCreateRequest): Promise<CodexProfileCreateResult>;
  deleteProfile(id: string): Promise<CodexProfileGuardResult>;
  setActiveProfile(id: string): Promise<CodexProfileGuardResult>;
  repairProfileLink(id: string): Promise<CodexProfileGuardResult>;
  /**
   * The per-profile readiness gate `engineReady("codex")` reads (cut §4.2:
   * `codexReady` stops being one global boolean). Synchronous, off main's
   * in-memory report cache; `undefined` asks about the ACTIVE profile.
   */
  readyFor(profileId?: string): boolean;
  /**
   * App-lifecycle teardown (W2-review Critical). Every child this controller
   * opened — doctor, login, version preflight — is spawned `detached` (its own
   * POSIX process group), so it does NOT die with main: an Electron exit that
   * only stopped the tab hosts left the whole group alive, for up to the login's
   * five-minute window. Quit MUST call this and MUST await it, exactly as it
   * awaits `shutdownAllTabHosts()`.
   *
   * Aborts every in-flight run, awaits its bounded teardown, and then reaps
   * whatever is somehow still registered. Idempotent, never rejects, and after
   * it is called the controller refuses to start new work — a late IPC during
   * quit must not spawn a fresh orphan behind the teardown's back.
   *
   * INVARIANT (W3.5-review Critical): NO `codex` process is spawned by this
   * controller once `shutdown()` has begun — not "spawned and later reaped".
   * That holds only because the refusal is re-read on the far side of EVERY
   * pre-spawn `await` (the settings read, the file picker), not merely at a
   * method's entrance: a run parked on one of those awaits when quit lands is
   * not yet in the registry this drains, so an entrance-only check would let it
   * resume and spawn after the drain has already finished. The runners hold the
   * same line from the other side — an already-aborted signal makes
   * `runCodexDoctor`/`runCodexLogin` return before their first spawn.
   */
  shutdown(): Promise<void>;
}

/** Only a freshly CONFIRMED, non-dev-override path is worth remembering — an env override never persists (cut §3.5: "не env-override"), and "nothing found" must not clobber a path that may just be transiently unreachable (e.g. an unmounted volume). */
function shouldPersistPath(source: CodexBinarySource, binaryPath: string | null): binaryPath is string {
  return binaryPath !== null && source !== "env" && source !== "none";
}

/** The credential-free lastCheck projection — the ONLY report facts that ever reach settings.json (custody §4.4). */
function lastCheckOf(snapshot: CodexOnboardingSnapshot): { status: CodexDoctorReport["status"]; version?: string; at: string } {
  return {
    status: snapshot.report.status,
    ...(snapshot.report.version !== undefined ? { version: snapshot.report.version } : {}),
    at: snapshot.checkedAt,
  };
}

/**
 * The coalescence key for a `recheck()` aimed at the ACTIVE profile (no
 * `profileId`). A reserved token OUTSIDE the profile-id charset (`:` is not a
 * legal id char) and never equal to `system`, so an active-profile recheck
 * coalesces ONLY with another active-profile recheck — never with a recheck,
 * pick, or login keyed by a concrete profile id (the S3-2 misattribution:
 * `recheck(undefined)` adopting an in-flight `recheck("A")`'s report).
 */
const ACTIVE_PROFILE_KEY = "recheck:active";

/**
 * The coalescence key a login-in-progress occupies in `inFlightByKey` (F1). A
 * reserved token that neither a concrete-profile key (`id:<profileId>`) nor the
 * active-profile key (`recheck:active`) can ever equal, so NOTHING coalesces
 * onto a login — a concurrent recheck/pick sees a different key and QUEUES
 * behind the login gate (via `inFlightTail`) instead of spawning a second
 * doctor child alongside the live login child.
 */
const LOGIN_KEY = "login:active";

/**
 * Builds the exclusive controller: `recheck`/`pickBinary`/`loginStart` funnel
 * through `runExclusive`, which COALESCES work sharing one profile key and
 * SERIALIZES work across different keys behind a single tail promise — so the
 * module never spawns two doctor/login children at once from itself, and never
 * hands a caller a snapshot diagnosed against a DIFFERENT profile than it asked
 * for (each child already owns its bounded, zero-orphan teardown; the single-
 * child rule avoids needless concurrent work, the per-key coalescence is the
 * S3-2 correctness fix). Exported (not just `registerCodexIpc`) so
 * main/codex-ipc.test.ts can drive the handlers directly, off a fake deps bag,
 * the same shape as every other `main/*-ipc.ts` sibling in this codebase.
 */
export function createCodexOnboardingController(deps: CodexIpcDeps): CodexOnboardingController {
  const runDoctor = deps.runDoctor ?? runCodexDoctor;
  const runLogin = deps.runLogin ?? runCodexLogin;
  const registry = createCodexProfilesRegistry({
    readCodex: deps.readCodexSettings,
    writeCodex: async (patch) => {
      await deps.writeCodexSettings(patch);
    },
    ...(deps.home !== undefined ? { home: deps.home } : {}),
    ...(deps.profileFs !== undefined ? { fs: deps.profileFs } : {}),
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
  });
  /**
   * Per-profile report cache (cut §4.3): main memory only, never disk —
   * e-mail/plan/quotas live here and in the renderer projection, nowhere
   * else. Keyed by profile id; `system` is the pseudo-profile's slot.
   */
  const reports = new Map<string, CodexDoctorReport>();
  /** Last-read `activeProfileId` — refreshed on every registry read so the sync `readyFor()` gate can answer for "the active profile". */
  let cachedActiveProfileId: string = SYSTEM_PROFILE_ID;
  /** Keeps the runners' pre-spawn home guard on the SAME filesystem seam as the registry — absent, they default to the real fs. */
  const profileGuard =
    deps.profileFs !== undefined
      ? (profile: ResolvedCodexProfile): CodexProfileGuardResult =>
          assertCodexProfileHome(profile, {
            fs: deps.profileFs,
            ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
          })
      : undefined;
  /**
   * Per-profile-key coalescence map (S3-2): a key already present shares its
   * one in-flight/queued run; a NEW key does not — so an argless active-profile
   * recheck never adopts a concrete profile's report. Entry lives from the
   * moment a run is queued until it settles.
   */
  const inFlightByKey = new Map<string, Promise<CodexOnboardingSnapshot>>();
  /**
   * Serialization tail: a different key queues its run BEHIND this promise, so
   * the module still spawns at most one doctor/login child at a time (the
   * single-child invariant from runExclusive's header) — different keys run one
   * after another, never in parallel.
   */
  let inFlightTail: Promise<unknown> = Promise.resolve();
  let activeLoginAbort: AbortController | null = null;
  /** Aborted once, at quit: every doctor run started by this controller carries this signal. */
  const lifetime = new AbortController();
  let shuttingDown = false;
  /**
   * Every run currently unwinding. Awaiting these IS awaiting the teardown of
   * the children they own: each runner closes its child in a `finally` before
   * its promise settles.
   */
  const activeRuns = new Set<Promise<unknown>>();

  function track<T>(promise: Promise<T>): Promise<T> {
    activeRuns.add(promise);
    const forget = (): void => {
      activeRuns.delete(promise);
    };
    // `then(forget, forget)` (not `finally`) — it marks a rejection handled here
    // without deriving a NEW rejected promise that nobody would ever observe.
    promise.then(forget, forget);
    return promise;
  }

  function runExclusive(key: string, fn: () => Promise<CodexOnboardingSnapshot>): Promise<CodexOnboardingSnapshot> {
    const coalesced = inFlightByKey.get(key);
    if (coalesced !== undefined) {
      return coalesced;
    }
    // Different key ⇒ chain behind the tail (one child at a time). `then(fn, fn)`
    // runs regardless of how the prior run settled, so a rejection never stalls
    // the queue; the returned promise still reflects THIS run's own outcome.
    const promise = inFlightTail.then(fn, fn).finally(() => {
      inFlightByKey.delete(key);
    });
    inFlightByKey.set(key, promise);
    inFlightTail = promise;
    return track(promise);
  }

  /**
   * Enters a login into the same serialization seam recheck/pickBinary funnel
   * through (F1). A login body is not a single `fn`: it spans several awaits and
   * its OWN inline post-login doctor spawn, so instead of runExclusive it holds
   * a gate under LOGIN_KEY and advances `inFlightTail` up front — the caller
   * invokes this before its first `await`. While the gate is unresolved, every
   * other-key run chains behind it (one child at a time) and pickBinary's
   * `inFlightByKey.size` check waits it out. The returned release settles the
   * gate and frees the slot; the caller MUST call it in a `finally`. The gate's
   * resolved VALUE is inert — LOGIN_KEY never coalesces and every awaiter reads
   * settlement only, never the value.
   */
  function enterLoginSeam(): () => void {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const held: Promise<CodexOnboardingSnapshot> = inFlightTail.then(
      () => gate.then(shutdownSnapshot),
      () => gate.then(shutdownSnapshot),
    );
    inFlightByKey.set(LOGIN_KEY, held);
    inFlightTail = held;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      inFlightByKey.delete(LOGIN_KEY);
      releaseGate();
    };
  }

  /** No child, no spawn: quit is in progress and the ladder is closed for business. */
  function shutdownSnapshot(): CodexOnboardingSnapshot {
    return {
      report: { status: "error", error: "AnyCode is shutting down" },
      binaryPath: null,
      source: "none",
      checkedAt: new Date().toISOString(),
    };
  }

  function discover(): { path: string | null; source: CodexBinarySource } {
    return discoverCodexBinary({
      envOverride: deps.bootEnv[ENV_CODEX_BIN],
      env: deps.bootEnv,
      ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      ...(deps.identity !== undefined ? { identity: deps.identity } : {}),
    });
  }

  /**
   * Resolves a profile id (undefined = the active one) to spawn-time facts,
   * refreshing the cached active id along the way. A failing resolution is a
   * refusal, not a fallback — an unknown/broken profile must never silently
   * run as `system` and diagnose the WRONG account.
   */
  async function resolveProfile(profileId: string | undefined): Promise<{ ok: true; profile: ResolvedCodexProfile } | { ok: false; reason: string }> {
    const listed = await registry.list();
    cachedActiveProfileId = listed.activeProfileId;
    return registry.resolve(profileId);
  }

  /** Best-effort persistence of one check's outcome — see writeCodexSettings's own doc comment. */
  async function persist(snapshot: CodexOnboardingSnapshot): Promise<void> {
    const checkedId = snapshot.report.profileId ?? SYSTEM_PROFILE_ID;
    try {
      // The top-level lastCheck slot is "the ACTIVE profile's last check"
      // (cut §2.3) — a background check of a NON-active profile must not
      // clobber it. binaryPath is profile-independent and persists as before.
      const pathToPersist = shouldPersistPath(snapshot.source, snapshot.binaryPath) ? snapshot.binaryPath : undefined;
      const persistTopLevel = checkedId === cachedActiveProfileId;
      if (pathToPersist !== undefined || persistTopLevel) {
        await deps.writeCodexSettings({
          ...(pathToPersist !== undefined ? { binaryPath: pathToPersist } : {}),
          ...(persistTopLevel ? { lastCheck: lastCheckOf(snapshot) } : {}),
        });
      }
      if (checkedId !== SYSTEM_PROFILE_ID) {
        await registry.setLastCheck(checkedId, lastCheckOf(snapshot));
      }
    } catch {
      // Best-effort persistence — the live snapshot still reaches the caller.
    }
  }

  /** Runs the doctor against ONE explicit path+source+profile, persists, notifies, and returns the fresh snapshot. */
  async function checkPath(binaryPath: string | null, source: CodexBinarySource, profile: ResolvedCodexProfile): Promise<CodexOnboardingSnapshot> {
    // The choke point every doctor spawn in this module funnels through, and
    // therefore where the shutdown gate has to be re-read — an entrance check is
    // worth nothing across an `await`. `shutdown()` snapshots `activeRuns` and
    // then drains the child registry; a caller that was parked on a pre-spawn
    // `await` while that happened would otherwise resume afterwards and spawn a
    // detached child BEHIND the completed teardown — an orphan by construction.
    if (shuttingDown) {
      return shutdownSnapshot();
    }
    const report: CodexDoctorReport =
      binaryPath === null
        ? { status: "not_installed" }
        : await runDoctor(binaryPath, {
            env: deps.bootEnv,
            // Quit aborts the doctor and awaits its bounded teardown; without
            // this signal the child outlives the app (W2-review Critical).
            signal: lifetime.signal,
            profile,
            ...(profileGuard !== undefined ? { profileGuard } : {}),
            ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
          });
    const snapshot: CodexOnboardingSnapshot = { report, binaryPath, source, checkedAt: new Date().toISOString() };
    reports.set(report.profileId ?? SYSTEM_PROFILE_ID, report);
    await persist(snapshot);
    deps.onSnapshot(snapshot);
    return snapshot;
  }

  /** A resolution refusal projected as an error snapshot — no spawn happened, nothing is persisted or cached. */
  function resolutionErrorSnapshot(reason: string): CodexOnboardingSnapshot {
    return {
      report: { status: "error", error: reason },
      binaryPath: null,
      source: "none",
      checkedAt: new Date().toISOString(),
    };
  }

  /** Full ladder: settings rung reads fresh (discovery needs it as an input, unlike the env/PATH/common rungs which read directly off `deps.bootEnv`). */
  async function discoverAndCheck(profileId: string | undefined): Promise<CodexOnboardingSnapshot> {
    const resolution = await resolveProfile(profileId);
    if (!resolution.ok) {
      return resolutionErrorSnapshot(resolution.reason);
    }
    const settingsPath = await deps.readBinaryPathSetting();
    const discovery = discoverCodexBinary({
      envOverride: deps.bootEnv[ENV_CODEX_BIN],
      ...(settingsPath !== undefined ? { settingsPath } : {}),
      env: deps.bootEnv,
      ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      ...(deps.identity !== undefined ? { identity: deps.identity } : {}),
    });
    return checkPath(discovery.path, discovery.source, resolution.profile);
  }

  return {
    recheck: (profileId?: string): Promise<CodexOnboardingSnapshot> =>
      shuttingDown
        ? Promise.resolve(shutdownSnapshot())
        : // Namespace the concrete-profile key (F2): a renderer-supplied
          // `profileId` lives in `id:<profileId>`, never bare, so it cannot
          // collide with the reserved ACTIVE_PROFILE_KEY string even if a
          // caller passes the literal "recheck:active". (A bogus id still
          // fails resolution downstream — this only keeps the key domains
          // disjoint, it does NOT drop an invalid id to the active recheck.)
          runExclusive(profileId !== undefined ? `id:${profileId}` : ACTIVE_PROFILE_KEY, () => discoverAndCheck(profileId)),

    async pickBinary(): Promise<CodexPickBinaryResult> {
      if (shuttingDown) {
        return { ok: false, reason: "cancelled" };
      }
      if (inFlightByKey.size > 0) {
        // Let any concurrent recheck/login (across every profile key) settle
        // before opening a picker on top of it — its rejection is not ours.
        await inFlightTail.catch(() => {});
      }
      const picked = await deps.dialog.showOpenDialog({ properties: ["openFile"] });
      // A picker can sit open across the whole quit: re-read the gate on the far
      // side of it, before the confirmed path is handed to a doctor run.
      if (shuttingDown) {
        return { ok: false, reason: "cancelled" };
      }
      const filePath = picked.filePaths[0];
      if (picked.canceled || filePath === undefined) {
        return { ok: false, reason: "cancelled" };
      }
      const resolved = resolveCodexBinary(filePath, deps.fs, deps.platform ?? process.platform, deps.identity);
      if (resolved.path === null) {
        return { ok: false, reason: "invalid" };
      }
      const confirmedPath = resolved.path;
      // A picked binary is diagnosed against the ACTIVE profile; a broken
      // active-profile record must not block validating the binary itself,
      // so resolution failure falls back to the system pseudo-profile here
      // (the binary verdict is profile-independent — cut §4.2 rows 1-3).
      const resolution = await resolveProfile(undefined);
      const profile = resolution.ok ? resolution.profile : SYSTEM_CODEX_PROFILE;
      // Same `id:<id>` namespace as recheck (F2) so a pick and a recheck of the
      // same profile still share one key (coalesce), never split across domains.
      const snapshot = await runExclusive(`id:${profile.id}`, () => checkPath(confirmedPath, "picker", profile));
      return { ok: true, snapshot };
    },

    async loginStart(profileId?: string): Promise<CodexLoginStartResult> {
      if (shuttingDown || inFlightByKey.size > 0 || activeLoginAbort !== null) {
        return { ok: false, reason: "busy" };
      }
      // The lock is claimed HERE, synchronously, before the function's first
      // `await` — two back-to-back (same-tick) calls must serialize on this
      // check with no interleaving microtask, or a second call could slip
      // through while the first is still awaiting `readBinaryPathSetting()`.
      const controller = new AbortController();
      activeLoginAbort = controller;
      // Enter the SAME serialization seam recheck/pickBinary funnel through, up
      // front, before the first `await` (F1). Without it the login child ran
      // OUTSIDE inFlightByKey/inFlightTail: a concurrent recheck/pick spawned a
      // doctor child in PARALLEL with the live login (breaking runExclusive's
      // one-child invariant, and letting a mid-login doctor read a half-written
      // profile home whose wrong verdict then persists), and the post-login
      // re-diagnosis below could COALESCE onto an in-flight PRE-credential
      // recheck of this same profile and hand the caller a stale "not ready"
      // right after a successful sign-in. Holding the seam makes every other-key
      // run QUEUE behind login instead. Released in the `finally`.
      const releaseSeam = enterLoginSeam();
      try {
        const resolution = await resolveProfile(profileId);
        if (!resolution.ok) {
          return { ok: false, reason: "failed" };
        }
        const profile = resolution.profile;
        // An authLink profile mirrors an external credential — its login flow
        // does not exist (amended §A1): a broken link is repaired by the
        // explicit "Re-link credential" action, never by re-login.
        if (profile.authLink !== undefined) {
          return { ok: false, reason: "unsupported" };
        }
        const settingsPath = await deps.readBinaryPathSetting();
        // THE window this gate exists for: a login is not in `activeRuns` until
        // the spawn below registers it, so a `shutdown()` that lands while this
        // `await` is parked drains a registry the login is not in, finishes, and
        // the continuation then spawns a detached child — and opens a browser
        // window in the user's face — into an app that has already quit. Same
        // refusal as the entrance check: one shutdown answer per method.
        if (shuttingDown) {
          return { ok: false, reason: "busy" };
        }
        const discovery = discoverCodexBinary({
          envOverride: deps.bootEnv[ENV_CODEX_BIN],
          ...(settingsPath !== undefined ? { settingsPath } : {}),
          env: deps.bootEnv,
          ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
          ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
          ...(deps.identity !== undefined ? { identity: deps.identity } : {}),
        });
        if (discovery.path === null) {
          return { ok: false, reason: "unsupported" };
        }
        const binaryPath = discovery.path;
        // Quit aborts the login too: `shutdown()` fires this same controller,
        // and the runner's own `finally` closes the child before the promise
        // `shutdown()` is awaiting can settle.
        const outcome = await track(
          runLogin(binaryPath, {
            openExternal: deps.openExternal,
            signal: controller.signal,
            env: deps.bootEnv,
            // The login signs INTO the profile's home (TASK.50 п.2): the
            // runner overwrites any ambient CODEX_HOME with it, so codex
            // writes the credential into the profile tree, never ~/.codex.
            profile,
            ...(profileGuard !== undefined ? { profileGuard } : {}),
            ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
          }),
        );
        if (!outcome.ok) {
          return { ok: false, reason: outcome.reason };
        }
        // Re-diagnose via the doctor (never trust the login handshake's own
        // success flag for account/version state) — one source of truth for
        // "is Codex ready", the same doctor every other path uses. Runs INLINE
        // (not via runExclusive) INSIDE the still-held login seam: a fresh
        // POST-credential verdict that cannot coalesce onto a queued
        // pre-credential recheck of this profile (F1). `track` keeps it in
        // activeRuns so shutdown awaits its bounded teardown as before. Same
        // profile as the login, so the fresh verdict lands in ITS cache slot.
        const snapshot = await track(checkPath(binaryPath, discovery.source, profile));
        return { ok: true, snapshot };
      } finally {
        releaseSeam();
        activeLoginAbort = null;
      }
    },

    loginCancel(): void {
      activeLoginAbort?.abort();
    },

    // ── profile control plane (TASK.50) — settings/fs mutations only, no spawns ──

    async listProfiles(): Promise<CodexProfilesSnapshot> {
      const listed = await registry.list();
      cachedActiveProfileId = listed.activeProfileId;
      return {
        profiles: listed.profiles.map((profile) => {
          const report = reports.get(profile.id);
          return { profile, ...(report !== undefined ? { report } : {}) };
        }),
        activeProfileId: listed.activeProfileId,
      };
    },

    async createProfile(request: CodexProfileCreateRequest): Promise<CodexProfileCreateResult> {
      if (shuttingDown) {
        return { ok: false, reason: "failed", message: "AnyCode is shutting down" };
      }
      const created = await registry.create(request);
      if (created.ok) {
        deps.onProfilesChanged?.();
      }
      return created;
    },

    async deleteProfile(id: string): Promise<CodexProfileGuardResult> {
      if (shuttingDown) {
        return { ok: false, reason: "AnyCode is shutting down" };
      }
      const removed = await registry.remove(id);
      if (removed.ok) {
        reports.delete(id);
        if (cachedActiveProfileId === id) {
          cachedActiveProfileId = SYSTEM_PROFILE_ID;
        }
        deps.onProfilesChanged?.();
      }
      return removed;
    },

    async setActiveProfile(id: string): Promise<CodexProfileGuardResult> {
      if (shuttingDown) {
        return { ok: false, reason: "AnyCode is shutting down" };
      }
      const set = await registry.setActive(id);
      if (set.ok) {
        cachedActiveProfileId = id;
        deps.onProfilesChanged?.();
      }
      return set;
    },

    async repairProfileLink(id: string): Promise<CodexProfileGuardResult> {
      if (shuttingDown) {
        return { ok: false, reason: "AnyCode is shutting down" };
      }
      const repaired = await registry.repairLink(id);
      if (repaired.ok) {
        deps.onProfilesChanged?.();
      }
      return repaired;
    },

    readyFor(profileId?: string): boolean {
      return reports.get(profileId ?? cachedActiveProfileId)?.status === "ready";
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      lifetime.abort();
      activeLoginAbort?.abort();
      // Each aborted run tears its own child down (bounded) before its promise
      // settles, so awaiting the runs IS awaiting the teardown.
      await Promise.race([
        Promise.allSettled([...activeRuns]),
        new Promise<void>((resolve) => setTimeout(resolve, CODEX_ONBOARDING_SHUTDOWN_BUDGET_MS)),
      ]);
      // Backstop, and the reason this is a guarantee rather than a hope: any
      // child still registered (a run that never unwound, a preflight mid-flight)
      // gets its process GROUP reaped directly. Zero survivors either way.
      await closeAllCodexChildren();
    },
  };
}

/** Narrow IPC-boundary arg readers — invoke payloads are renderer-supplied and never trusted structurally. */
function profileIdArg(args: unknown): string | undefined {
  const profileId = (args as { profileId?: unknown } | undefined)?.profileId;
  return typeof profileId === "string" ? profileId : undefined;
}

function idArg(args: unknown): string {
  const id = (args as { id?: unknown } | undefined)?.id;
  return typeof id === "string" ? id : "";
}

/** Wires the invoke channels onto ipcMain. Returns the controller so main/index.ts can also drive `recheck()` directly for the fire-and-forget boot-time check (TASK.41 п.1: discovery must run without the user visiting Settings first) and read `readyFor()` as the per-profile tab gate. */
export function registerCodexIpc(deps: CodexIpcDeps): CodexOnboardingController {
  const controller = createCodexOnboardingController(deps);
  ipcMain.handle(CODEX_RECHECK_CHANNEL, (_event, args?: unknown) => controller.recheck(profileIdArg(args)));
  ipcMain.handle(CODEX_PICK_BINARY_CHANNEL, () => controller.pickBinary());
  ipcMain.handle(CODEX_LOGIN_START_CHANNEL, (_event, args?: unknown) => controller.loginStart(profileIdArg(args)));
  ipcMain.handle(CODEX_LOGIN_CANCEL_CHANNEL, () => controller.loginCancel());
  ipcMain.handle(CODEX_PROFILE_LIST_CHANNEL, () => controller.listProfiles());
  ipcMain.handle(CODEX_PROFILE_CREATE_CHANNEL, (_event, request: unknown) => {
    const label = (request as { label?: unknown } | undefined)?.label;
    const authLink = (request as { authLink?: unknown } | undefined)?.authLink;
    const linkedHome = (request as { linkedHome?: unknown } | undefined)?.linkedHome;
    if (typeof label !== "string" || label.trim() === "") {
      return { ok: false, reason: "invalid", message: "a profile label is required" };
    }
    return controller.createProfile({
      label,
      ...(typeof authLink === "string" ? { authLink } : {}),
      ...(typeof linkedHome === "string" ? { linkedHome } : {}),
    });
  });
  ipcMain.handle(CODEX_PROFILE_DELETE_CHANNEL, (_event, args: unknown) => controller.deleteProfile(idArg(args)));
  ipcMain.handle(CODEX_PROFILE_SET_ACTIVE_CHANNEL, (_event, args: unknown) => controller.setActiveProfile(idArg(args)));
  ipcMain.handle(CODEX_PROFILE_REPAIR_LINK_CHANNEL, (_event, args: unknown) => controller.repairProfileLink(idArg(args)));
  return controller;
}
