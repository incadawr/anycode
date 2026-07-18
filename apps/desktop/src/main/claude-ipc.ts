/**
 * Claude engine onboarding control plane (SLICE-CC A3, cut §1.2, minimal
 * subset of main/codex-ipc.ts): the invoke-API behind the Settings Claude
 * card — recheck (discovery ladder + bounded doctor) and an explicit
 * file-picker override. Wires main/claude-binary.ts (discovery) and
 * main/claude-doctor.ts (diagnosis) together, persists ONLY path/status
 * metadata into `settings.claude` (never a token/account fact — cut §0.2
 * invariant 2), and hands the caller a fresh snapshot on every successful
 * step so the renderer can re-render without a restart.
 *
 * OUT OF SCOPE FOR CC-A (cut §1.2 "НЕ делаем"): native login orchestration
 * (`loginStart`/`loginCancel` — onboarding is a manual terminal step, see
 * ClaudeEnginePane.tsx's copy), multi-profile CRUD (CC-E) — this controller
 * diagnoses exactly ONE profile, `main/claude-binary.ts`'s
 * `defaultClaudeProfileDir()`.
 *
 * CHANNEL NAMES ARE DUPLICATED LITERALS, not `shared/**` exports — mirrors
 * main/codex-ipc.ts's own header: every lane in this codebase's history froze
 * `shared/**` as read-only after a prior integration block specifically so no
 * two parallel lanes fight over the same file. preload/index.ts and
 * renderer/src/anycode-window.d.ts hold byte-identical copies of these two
 * constants, kept in sync by contract.
 */
import { homedir } from "node:os";
import { ipcMain } from "electron";
import type { ClaudeDoctorReport } from "../shared/claude-doctor.js";
import type { SettingsMutationResult } from "../shared/settings.js";
import { ENV_CLAUDE_BIN } from "../shared/engines.js";
import {
  defaultClaudeProfileDir,
  discoverClaudeBinary,
  resolveClaudeBinary,
  type ClaudeBinaryFs,
  type ClaudeBinarySource,
  type ClaudeIdentity,
} from "./claude-binary.js";
import { runClaudeDoctor, type RunClaudeDoctorOptions } from "./claude-doctor.js";

// ── invoke channels (duplicated literals — see file header) ──

export const CLAUDE_RECHECK_CHANNEL = "anycode:claude-recheck";
export const CLAUDE_PICK_BINARY_CHANNEL = "anycode:claude-pick-binary";

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
  /** User home the AnyCode profile dir (`~/.anycode/claude/profile-default`) lives under; tests point this at a tmp dir. */
  home?: string;
  dialog: DialogLike;
  /** Fired after every successful recheck/pick with the fresh snapshot — main/index.ts updates its `claudeBinaryPath` and pushes the engines-changed push. */
  onSnapshot: (snapshot: ClaudeOnboardingSnapshot) => void;
  platform?: NodeJS.Platform;
  fs?: ClaudeBinaryFs;
  /** Test seam for the trust gate's ownership rules; production reads the live process identity. */
  identity?: ClaudeIdentity;
  /** DI seam for tests; production defaults to the real doctor runner. */
  runDoctor?: (binaryPath: string, options: RunClaudeDoctorOptions) => Promise<ClaudeDoctorReport>;
}

export interface ClaudeOnboardingController {
  /** Diagnoses the ONE AnyCode default profile against the discovered binary. */
  recheck(): Promise<ClaudeOnboardingSnapshot>;
  pickBinary(): Promise<ClaudePickBinaryResult>;
  /** Synchronous, off the in-memory last-report cache. `undefined` until the first snapshot lands. */
  readyFor(): boolean;
  /** Has a doctor verdict EVER landed (regardless of its status)? Splits a fail-closed `false` from `readyFor` into KNOWN-not-ready vs UNKNOWN (boot recheck still in flight). */
  hasVerdictFor(): boolean;
  /** App-lifecycle teardown hook (no-op placeholder in CC-A — the doctor's own bounded teardown already tears every spawned child down before its promise settles; CC-B/CC-C introduce the long-lived engine child this will eventually drain). */
  shutdown(): Promise<void>;
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
  let lastReport: ClaudeDoctorReport | undefined;
  let inFlight: Promise<ClaudeOnboardingSnapshot> | null = null;

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
    const home = deps.home ?? homedir();
    const report: ClaudeDoctorReport =
      binaryPath === null
        ? { status: "not_installed" }
        : await runDoctor(binaryPath, {
            env: deps.bootEnv,
            profileDir: defaultClaudeProfileDir(home, deps.platform ?? process.platform),
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
      await (inFlight ?? Promise.resolve()).catch(() => {});
    },
  };
}

/** Wires the two invoke channels onto ipcMain. Returns the controller so main/index.ts can also drive `recheck()` directly for the fire-and-forget boot-time check, and read `readyFor()`/`hasVerdictFor()` as the tab gate's engineReady/engineReadyKnown source. */
export function registerClaudeIpc(deps: ClaudeIpcDeps): ClaudeOnboardingController {
  const controller = createClaudeOnboardingController(deps);
  ipcMain.handle(CLAUDE_RECHECK_CHANNEL, () => controller.recheck());
  ipcMain.handle(CLAUDE_PICK_BINARY_CHANNEL, () => controller.pickBinary());
  return controller;
}
