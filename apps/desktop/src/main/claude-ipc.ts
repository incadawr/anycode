/**
 * Claude engine onboarding control plane (SLICE-CC A3 + SLICE-CC-LOGIN
 * TASK.66, cut §1.2/§4, minimal subset of main/codex-ipc.ts): the invoke-API
 * behind the Settings Claude card — recheck (discovery ladder + bounded
 * doctor), an explicit file-picker override, and the native subscription
 * login flow (start/cancel). Wires main/claude-binary.ts (discovery),
 * main/claude-doctor.ts (diagnosis), and main/claude-login.ts (sign-in)
 * together, persists ONLY path/status metadata into `settings.claude` (never
 * a token/account fact — cut §0.2 invariant 2), and hands the caller a fresh
 * snapshot on every successful step so the renderer can re-render without a
 * restart.
 *
 * OUT OF SCOPE (cut §1.2 "НЕ делаем" / SLICE-CC-LOGIN cut §5): multi-profile
 * CRUD (CC-E) — this controller diagnoses/signs into exactly ONE profile,
 * ambient `~/.claude` by default (owner pivot: `resolveClaudeConfigDir`,
 * shared/claude-config-dir.ts — every `runDoctor`/`runLogin` call below
 * passes no override).
 *
 * CHANNEL NAMES ARE DUPLICATED LITERALS, not `shared/**` exports — mirrors
 * main/codex-ipc.ts's own header: every lane in this codebase's history froze
 * `shared/**` as read-only after a prior integration block specifically so no
 * two parallel lanes fight over the same file. preload/index.ts and
 * renderer/src/anycode-window.d.ts hold byte-identical copies of these
 * constants, kept in sync by contract.
 */
import { ipcMain } from "electron";
import type { ClaudeDoctorReport } from "../shared/claude-doctor.js";
import type { SettingsMutationResult } from "../shared/settings.js";
import { ENV_CLAUDE_BIN } from "../shared/engines.js";
import {
  discoverClaudeBinary,
  resolveClaudeBinary,
  type ClaudeBinaryFs,
  type ClaudeBinarySource,
  type ClaudeIdentity,
} from "./claude-binary.js";
import { runClaudeDoctor, type RunClaudeDoctorOptions } from "./claude-doctor.js";
import { runClaudeLogin, type ClaudeLoginOutcome, type RunClaudeLoginOptions } from "./claude-login.js";

// ── invoke channels (duplicated literals — see file header) ──

export const CLAUDE_RECHECK_CHANNEL = "anycode:claude-recheck";
export const CLAUDE_PICK_BINARY_CHANNEL = "anycode:claude-pick-binary";
// SLICE-CC-LOGIN (TASK.66, cut §4): the native login channels — same
// duplicated-literal convention as the two channels above.
export const CLAUDE_LOGIN_START_CHANNEL = "anycode:claude-login-start";
export const CLAUDE_LOGIN_CANCEL_CHANNEL = "anycode:claude-login-cancel";
// Doctor-spawn-loop fix: a dedicated push carrying the fresh
// `ClaudeOnboardingSnapshot` payload itself, so ClaudeEnginePane can apply a
// new snapshot directly (zero IPC round-trip, zero doctor spawn) instead of
// answering the shared `engines-changed` push with a full recheck — the
// recheck-on-push loop this replaces (each recheck's own `onSnapshot` fired
// another `engines-changed` push, which triggered another recheck, forever).
export const CLAUDE_SNAPSHOT_CHANGED_CHANNEL = "anycode:claude-snapshot-changed";

// ── wire shapes (duplicated structurally in preload/index.ts + anycode-window.d.ts) ──

export interface ClaudeOnboardingSnapshot {
  report: ClaudeDoctorReport;
  /** The winning candidate path, or null when nothing on the ladder resolved. */
  binaryPath: string | null;
  source: ClaudeBinarySource;
  /** ISO timestamp of this check. */
  checkedAt: string;
}

export type ClaudePickBinaryResult =
  | { ok: true; snapshot: ClaudeOnboardingSnapshot }
  | { ok: false; reason: "cancelled" | "invalid" };

// SLICE-CC-LOGIN (TASK.66, cut §4): mirrors main/codex-ipc.ts's own
// `CodexLoginStartResult` — same reason set, `main/claude-login.ts`'s own
// `ClaudeLoginOutcome` plus the busy-gate's `"busy"` refusal.
export type ClaudeLoginStartResult =
  | { ok: true; snapshot: ClaudeOnboardingSnapshot }
  | { ok: false; reason: "busy" | "unsupported" | "cancelled" | "timeout" | "failed" };

export interface DialogLike {
  showOpenDialog(options: { properties: Array<"openFile">; defaultPath?: string }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface ClaudeIpcDeps {
  /** Immutable boot-env snapshot (main/index.ts's `bootEnv`) — read for `ANYCODE_CLAUDE_BIN`/`PATH`/`HOME`/`APPDATA`, and passed through as the doctor child's SOURCE env. */
  bootEnv: NodeJS.ProcessEnv;
  /** Reads the currently-persisted `settings.claude.binaryPath`, fresh, every call (main is the sole writer; this module never caches it). */
  readBinaryPathSetting: () => Promise<string | undefined>;
  /** Persists a `settings.claude` patch (best-effort: a `read_only` refusal must not block the LIVE snapshot this session already computed from reaching the caller). NEVER carries account material — only status/version/at (custody). */
  writeClaudeSettings: (patch: {
    binaryPath?: string;
    lastCheck?: { status: ClaudeDoctorReport["status"]; version?: string; at: string };
  }) => Promise<SettingsMutationResult>;
  dialog: DialogLike;
  /** Opens the login script in a real terminal (main injects `shell.openPath`; SLICE-CC-LOGIN cut §4 — same pattern `openExternal` already uses elsewhere in this codebase). */
  openPath: (path: string) => Promise<string> | string;
  /** Fired after every successful recheck/pick/login with the fresh snapshot — main/index.ts updates its `claudeBinaryPath` and pushes the engines-changed push. */
  onSnapshot: (snapshot: ClaudeOnboardingSnapshot) => void;
  platform?: NodeJS.Platform;
  fs?: ClaudeBinaryFs;
  /** Test seam for the trust gate's ownership rules; production reads the live process identity. */
  identity?: ClaudeIdentity;
  /** DI seam for tests; production defaults to the real doctor runner. */
  runDoctor?: (binaryPath: string, options: RunClaudeDoctorOptions) => Promise<ClaudeDoctorReport>;
  /** DI seam for tests; production defaults to the real login runner (SLICE-CC-LOGIN cut §4). */
  runLogin?: (binaryPath: string, options: RunClaudeLoginOptions) => Promise<ClaudeLoginOutcome>;
}

export interface ClaudeOnboardingController {
  /** Diagnoses the discovered binary against the user's ambient Claude profile. */
  recheck(): Promise<ClaudeOnboardingSnapshot>;
  pickBinary(): Promise<ClaudePickBinaryResult>;
  /**
   * Runs the native subscription login (SLICE-CC-LOGIN, cut §4): opens a real
   * terminal running a throwaway sign-in script, then polls the SAME
   * exclusive recheck path `recheck()` uses until the profile reads ready,
   * cancels, or times out. Refuses `"busy"` synchronously (before its first
   * `await`) if a recheck/pick/login is already in flight — mirrors
   * main/codex-ipc.ts's F1 lesson.
   */
  loginStart(): Promise<ClaudeLoginStartResult>;
  /** Aborts an in-flight `loginStart()`; a no-op when none is running. */
  loginCancel(): void;
  /** Synchronous, off the in-memory last-report cache. `undefined` until the first snapshot lands. */
  readyFor(): boolean;
  /** Has a doctor verdict EVER landed (regardless of its status)? Splits a fail-closed `false` from `readyFor` into KNOWN-not-ready vs UNKNOWN (boot recheck still in flight). */
  hasVerdictFor(): boolean;
  /** App-lifecycle teardown hook (no-op placeholder in CC-A — the doctor's own bounded teardown already tears every spawned child down before its promise settles; CC-B/CC-C introduce the long-lived engine child this will eventually drain). */
  shutdown(): Promise<void>;
}

/**
 * Whether `next` materially differs from `previous` — the belt half of the
 * doctor-spawn-loop fix (the dedicated snapshot push above is the root-cause
 * fix): main only re-fires the shared `engines-changed` push when something a
 * listener would actually act on has changed, not on every routine recheck.
 * `checkedAt` and the raw `report.error` string are deliberately excluded —
 * both can differ between two otherwise-identical checks. A first-ever
 * snapshot (`previous === undefined`) always counts as changed.
 */
export function isClaudeSnapshotChangeMaterial(previous: ClaudeOnboardingSnapshot | undefined, next: ClaudeOnboardingSnapshot): boolean {
  if (previous === undefined) {
    return true;
  }
  return (
    previous.report.status !== next.report.status ||
    previous.report.version !== next.report.version ||
    previous.binaryPath !== next.binaryPath ||
    previous.source !== next.source
  );
}

/** Only a freshly CONFIRMED, non-dev-override path is worth remembering — an env override never persists, and "nothing found" must not clobber a path that may just be transiently unreachable. */
function shouldPersistPath(source: ClaudeBinarySource, binaryPath: string | null): binaryPath is string {
  return binaryPath !== null && source !== "env" && source !== "none";
}

/** The credential-free lastCheck projection — the ONLY report facts that ever reach settings.json (custody). */
function lastCheckOf(snapshot: ClaudeOnboardingSnapshot): { status: ClaudeDoctorReport["status"]; version?: string; at: string } {
  return {
    status: snapshot.report.status,
    ...(snapshot.report.version !== undefined ? { version: snapshot.report.version } : {}),
    at: snapshot.checkedAt,
  };
}

/**
 * Builds the exclusive controller: `recheck`/`pickBinary` funnel through a
 * single in-flight slot, so a rapid double-click never spawns two overlapping
 * doctor children (there is exactly one profile to diagnose in CC-A, so no
 * per-profile coalescence map is needed — mirrors main/codex-ipc.ts's
 * `runExclusive`, collapsed to one key since profiles are CC-E).
 */
export function createClaudeOnboardingController(deps: ClaudeIpcDeps): ClaudeOnboardingController {
  const runDoctor = deps.runDoctor ?? runClaudeDoctor;
  const runLogin = deps.runLogin ?? runClaudeLogin;
  let lastReport: ClaudeDoctorReport | undefined;
  let inFlight: Promise<ClaudeOnboardingSnapshot> | null = null;
  // SLICE-CC-LOGIN (cut §4): claimed synchronously, before loginStart's first
  // `await`, so two back-to-back same-tick calls serialize on this check with
  // no interleaving microtask (mirrors main/codex-ipc.ts's F1 lesson).
  let activeLoginAbort: AbortController | null = null;
  let activeLoginPromise: Promise<ClaudeLoginStartResult> | null = null;

  function runExclusive(fn: () => Promise<ClaudeOnboardingSnapshot>): Promise<ClaudeOnboardingSnapshot> {
    if (inFlight !== null) {
      return inFlight;
    }
    const promise = fn().finally(() => {
      inFlight = null;
    });
    inFlight = promise;
    return promise;
  }

  function discover(settingsPath: string | undefined): { path: string | null; source: ClaudeBinarySource } {
    return discoverClaudeBinary({
      envOverride: deps.bootEnv[ENV_CLAUDE_BIN],
      ...(settingsPath !== undefined ? { settingsPath } : {}),
      env: deps.bootEnv,
      ...(deps.fs !== undefined ? { fs: deps.fs } : {}),
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      ...(deps.identity !== undefined ? { identity: deps.identity } : {}),
    });
  }

  /** Best-effort persistence of one check's outcome. */
  async function persist(snapshot: ClaudeOnboardingSnapshot): Promise<void> {
    try {
      const pathToPersist = shouldPersistPath(snapshot.source, snapshot.binaryPath) ? snapshot.binaryPath : undefined;
      await deps.writeClaudeSettings({
        ...(pathToPersist !== undefined ? { binaryPath: pathToPersist } : {}),
        lastCheck: lastCheckOf(snapshot),
      });
    } catch {
      // Best-effort persistence — the live snapshot still reaches the caller.
    }
  }

  /** Runs the doctor against ONE explicit path+source, persists, notifies, and returns the fresh snapshot. */
  async function checkPath(binaryPath: string | null, source: ClaudeBinarySource): Promise<ClaudeOnboardingSnapshot> {
    const report: ClaudeDoctorReport =
      binaryPath === null
        ? { status: "not_installed" }
        : await runDoctor(binaryPath, {
            env: deps.bootEnv,
            // Ambient by default (owner pivot): no profileDir override, so the
            // doctor diagnoses the SAME `~/.claude` the user's own terminal is
            // signed into.
            ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
          });
    const snapshot: ClaudeOnboardingSnapshot = { report, binaryPath, source, checkedAt: new Date().toISOString() };
    lastReport = report;
    await persist(snapshot);
    deps.onSnapshot(snapshot);
    return snapshot;
  }

  async function discoverAndCheck(): Promise<ClaudeOnboardingSnapshot> {
    const settingsPath = await deps.readBinaryPathSetting();
    const discovery = discover(settingsPath);
    return checkPath(discovery.path, discovery.source);
  }

  /**
   * The login body (SLICE-CC-LOGIN cut §4): resolves the binary the same way
   * `recheck()` does, then runs `runClaudeLogin` with `probe` routed through
   * the SAME `runExclusive`/`discoverAndCheck` a manual "Recheck" click uses
   * — a concurrent recheck landing while a poll's own doctor call is active
   * COALESCES onto it (single-slot invariant preserved, cut §4's own
   * requirement), and the final `ready` poll's snapshot (already persisted +
   * pushed via `deps.onSnapshot` inside `checkPath`) is what `loginStart`
   * hands back on success — never a second, redundant diagnosis.
   */
  async function performLogin(controller: AbortController): Promise<ClaudeLoginStartResult> {
    const settingsPath = await deps.readBinaryPathSetting();
    const discovery = discover(settingsPath);
    if (discovery.path === null) {
      return { ok: false, reason: "unsupported" };
    }
    const binaryPath = discovery.path;
    let lastSnapshot: ClaudeOnboardingSnapshot | undefined;
    const outcome = await runLogin(binaryPath, {
      // Ambient by default (owner pivot): no profileDir override, so the
      // opened terminal's `claude auth login` signs into the user's own
      // `~/.claude` — the same one the doctor above diagnoses.
      openPath: deps.openPath,
      signal: controller.signal,
      ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
      probe: async () => {
        const snapshot = await runExclusive(discoverAndCheck);
        lastSnapshot = snapshot;
        return snapshot.report.status === "ready";
      },
    });
    if (!outcome.ok) {
      return { ok: false, reason: outcome.reason };
    }
    // `outcome.ok` is only ever true right after `probe` returned true, which
    // always assigns `lastSnapshot` first — the fallback recheck below is an
    // unreachable-in-practice belt for a `runLogin` DI fake that reports `ok`
    // without ever having polled.
    const snapshot = lastSnapshot ?? (await runExclusive(discoverAndCheck));
    return { ok: true, snapshot };
  }

  return {
    recheck: (): Promise<ClaudeOnboardingSnapshot> => runExclusive(discoverAndCheck),

    async pickBinary(): Promise<ClaudePickBinaryResult> {
      if (inFlight !== null) {
        await inFlight.catch(() => {});
      }
      const picked = await deps.dialog.showOpenDialog({ properties: ["openFile"] });
      const filePath = picked.filePaths[0];
      if (picked.canceled || filePath === undefined) {
        return { ok: false, reason: "cancelled" };
      }
      const resolved = resolveClaudeBinary(filePath, deps.fs, deps.platform ?? process.platform, deps.identity);
      if (resolved.path === null) {
        return { ok: false, reason: "invalid" };
      }
      const confirmedPath = resolved.path;
      const snapshot = await runExclusive(() => checkPath(confirmedPath, "picker"));
      return { ok: true, snapshot };
    },

    async loginStart(): Promise<ClaudeLoginStartResult> {
      // Busy-gate BEFORE the first `await` (F1 lesson): a recheck/pick
      // currently spawning a doctor, or a login already running, both refuse
      // a new login rather than queueing behind it.
      if (inFlight !== null || activeLoginAbort !== null) {
        return { ok: false, reason: "busy" };
      }
      const controller = new AbortController();
      activeLoginAbort = controller;
      const promise = performLogin(controller);
      activeLoginPromise = promise;
      try {
        return await promise;
      } finally {
        activeLoginAbort = null;
        activeLoginPromise = null;
      }
    },

    loginCancel(): void {
      activeLoginAbort?.abort();
    },

    readyFor(): boolean {
      return lastReport?.status === "ready";
    },

    hasVerdictFor(): boolean {
      return lastReport !== undefined;
    },

    async shutdown(): Promise<void> {
      // The doctor's own bounded teardown (main/claude-doctor.ts) already
      // closes every child it spawns before its promise settles — there is no
      // additional detached-process registry to drain in CC-A (no long-lived
      // engine child exists yet; CC-C introduces one and this hook becomes
      // load-bearing then). Await any in-flight check so a quit landing
      // mid-recheck does not race a concurrent settings write.
      //
      // SLICE-CC-LOGIN (cut §4): abort any in-flight login too, then await
      // its settlement — `runClaudeLogin` (main/claude-login.ts) resolves
      // `{ok:false, reason:"cancelled"}` once its signal trips, on every path
      // (pre-spawn, mid-poll), so this never races a detached process: the
      // terminal window itself is not ours to reap (cut §9 — it outlives
      // quit, documented, zero process cost on our side).
      activeLoginAbort?.abort();
      await Promise.allSettled([inFlight ?? Promise.resolve(), activeLoginPromise ?? Promise.resolve()]);
    },
  };
}

/** Wires the four invoke channels onto ipcMain. Returns the controller so main/index.ts can also drive `recheck()` directly for the fire-and-forget boot-time check, and read `readyFor()`/`hasVerdictFor()` as the tab gate's engineReady/engineReadyKnown source. */
export function registerClaudeIpc(deps: ClaudeIpcDeps): ClaudeOnboardingController {
  const controller = createClaudeOnboardingController(deps);
  ipcMain.handle(CLAUDE_RECHECK_CHANNEL, () => controller.recheck());
  ipcMain.handle(CLAUDE_PICK_BINARY_CHANNEL, () => controller.pickBinary());
  ipcMain.handle(CLAUDE_LOGIN_START_CHANNEL, () => controller.loginStart());
  ipcMain.handle(CLAUDE_LOGIN_CANCEL_CHANNEL, () => controller.loginCancel());
  return controller;
}
