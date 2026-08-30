/**
 * Profile stats control-plane IPC (design slice-P7.22-cut.md §2-D5/D6/D2 W2).
 * Registers `ipcMain.handle` for the five channels in shared/profile-config.ts:
 * a read-only aggregated usage-stats view, the instant cache-only view and the
 * cache rebuild (both TASK.187 S3), a user-scope `telemetry.enabled` toggle,
 * and a reveal of the resolved sink directory. Mirrors main/skills-
 * ipc.ts exactly: the handler logic is exported pure functions over a deps
 * bag (unit-testable without ipcMain), zod validates the one payload-carrying

 * `{ok:true, ...}` or a typed refusal.
 *
 * Core runtime is imported ONLY through the `@anycode/core/telemetry-admin`
 * subpath (never the core barrel, which would drag the ai-SDK into the thin
 * main process — same rule as `@anycode/core/skills-admin` in skills-ipc.ts).
 *
 * PATH CUSTODY (design §2-D5/D6): the renderer NEVER supplies a filesystem
 * path — `profile-stats-get`/`profile-reveal-dir` carry no payload at all, and
 * `profile-telemetry-set` carries only a boolean. Every handler resolves the
 * scan/reveal directory itself from `deps.home()` + a config read; there is no
 * caller-supplied path to defend against here (unlike skills/subagents, which
 * accept a `name`/`ids` identity to re-resolve).
 *
 * INCREMENTAL SCAN (TASK.187 S3): the directory walk that used to live here —
 * readdir, lstat everything, sort newest-first, read every file under a byte
 * budget — moved to main/profile-stats-cache.ts and became incremental. A file
 * whose (size, mtime, inode, ctime) fingerprint has not moved is replayed from
 * a cached per-file partial and never opened; only the newest CONTIGUOUS
 * prefix of files that actually have a partial is shown, so a hole in the
 * scan can never be papered over with stale numbers.
 *
 * DIR RESOLUTION (design §2-D2): user-scope telemetry config only —
 * `loadTelemetryConfig(fs, home, home, env)` collapses `workspace===home` so a
 * project `.anycode/config.json` is NEVER consulted (Profile is an app-level
 * user page, not a per-tab one). When the resolution is enabled, the dir is
 * whatever the loader already resolved (default or a user-set absolute
 * `telemetry.dir`). When it is disabled (or unset, or the kill-switch is
 * active), `loadTelemetryConfig` intentionally returns `telemetry: null` with
 * no dir at all (`resolveSection` in core/telemetry/config.ts short-circuits
 * before computing one) — so historical stats can still be shown for a
 * currently-off user, `readUserTelemetryDirOverride` below does a SEPARATE,
 * permissive raw read of the same file's `telemetry.dir` (ignoring
 * `enabled`), falling back to the same default `<home>/.anycode/telemetry`
 * the loader would have used. This raw reader is a deliberate, narrow
 * duplication of core/telemetry/config.ts's absolute-path validation — the
 * `./telemetry-admin` subpath does not export the enabled-agnostic form.
 */

import { ipcMain } from "electron";
import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { loadTelemetryConfig, setUserTelemetryEnabled, type ProfileStats } from "@anycode/core/telemetry-admin";
import {
  PROFILE_REVEAL_DIR_CHANNEL,
  PROFILE_STATS_CACHED_CHANNEL,
  PROFILE_STATS_GET_CHANNEL,
  PROFILE_STATS_REBUILD_CHANNEL,
  PROFILE_TELEMETRY_SET_CHANNEL,
} from "../shared/profile-config.js";
import type {
  ProfileRevealDirResult,
  ProfileStatsCachedResult,
  ProfileStatsResult,
  ProfileStatsView,
  ProfileTelemetrySetResult,
} from "../shared/profile-config.js";
import {
  profileStatsCachePath,
  resolveScanBudgets,
  sharedProfileStatsCacheStore,
  type ProfileFileSnapshot,
  type ProfileScanBudgets,
  type ProfileStatsCacheStore,
} from "./profile-stats-cache.js";

// ── fs port (structural — matches core's FileSystemPort by shape, no core-barrel import) ──

/**
 * The file-system surface the telemetry-admin functions + this module's own
 * directory scan need, typed structurally rather than importing core's
 * `FileSystemPort` (no subpath exports it) — same "duplicated on purpose, not
 * value-imported" rule skills-ipc.ts documents for `SkillsFs`. `lstat` is
 * required (unlike `FileSystemPort`'s optional declaration) because the
 * symlink-skip scan (design §2-D1) is not optional here — a port that cannot
 * lstat must fail closed, so this module never even constructs against one.
 */
export interface ProfileFileStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  mode?: number;
  isSymbolicLink?: boolean;
  /** TASK.187 S3 (D-6): inode + ctime complete the cache fingerprint. Without
   *  the inode a rotation that reuses a name is invisible; without ctime a
   *  same-size rewrite with a restored mtime is. REQUIRED, not optional: the
   *  cache compares an `lstat` fingerprint against one taken from an open
   *  handle, where both fields always exist, so a port that omitted them here
   *  would mismatch on every single file forever — the cache would never warm
   *  up and the whole feature would be dead while every test stayed green. */
  ino: number;
  ctimeMs: number;
}

export interface ProfileFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<ProfileFileStat>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  /** REQUIRED since TASK.187 S3 (D-6): the stats cache publishes itself by
   *  tmp+rename only — there is no direct-write fallback, so a port without
   *  rename could never persist a cache atomically. */
  rename(from: string, to: string): Promise<void>;
  /** REQUIRED since TASK.187 S3: sweeping tmp files orphaned by a crash
   *  between the write and the rename. */
  rm(path: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<ProfileFileStat>;
  /** O_NOFOLLOW read — reading a scanned telemetry file must never follow a
   *  symlink swapped in after the lstat pre-check (closes the lstat->read
   *  TOCTOU on the read path, mirror of subagents-ipc.ts's SubagentsFs). */
  readFileNoFollow(path: string): Promise<string>;
  /**
   * TASK.187 S3 (D-6) coherent snapshot read: open O_NOFOLLOW, `fstat` the
   * HANDLE, read exactly that many bytes, `fstat` the same handle again. The
   * caller compares the two stats to tell a legitimate append (grew) from a
   * rewrite that may have straddled the read (shrank, or same size with a
   * moved ctime, or a new inode). Statting the path instead of the handle
   * would leave the lstat->read TOCTOU wide open.
   */
  readFileSnapshot(path: string): Promise<ProfileFileSnapshot>;
}

/** Thin node:fs/promises implementation of ProfileFs (main-process-local, no core import). */
export class NodeProfileFs implements ProfileFs {
  async readFile(path: string): Promise<string> {
    return fsp.readFile(path, "utf-8");
  }
  async writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    if (opts?.mode !== undefined) {
      await fsp.writeFile(path, content, { encoding: "utf-8", mode: opts.mode });
      return;
    }
    await fsp.writeFile(path, content, "utf-8");
  }
  /** NOTE: an `access` failure is indistinguishable from absence in a boolean.
   *  Anything that must tell "not there" from "there but unreadable" (the
   *  telemetry scan does) has to call the real operation and read its error
   *  code instead of probing with this. */
  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(path);
      return true;
    } catch {
      return false;
    }
  }
  async stat(path: string): Promise<ProfileFileStat> {
    const s = await fsp.stat(path);
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      mode: s.mode,
      ino: s.ino,
      ctimeMs: s.ctimeMs,
    };
  }
  async mkdir(path: string): Promise<void> {
    await fsp.mkdir(path, { recursive: true });
  }
  async readdir(path: string): Promise<string[]> {
    return fsp.readdir(path);
  }
  async rename(from: string, to: string): Promise<void> {
    await fsp.mkdir(dirname(to), { recursive: true });
    await fsp.rename(from, to);
  }
  async rm(path: string): Promise<void> {
    await fsp.rm(path, { force: true });
  }
  async chmod(path: string, mode: number): Promise<void> {
    await fsp.chmod(path, mode);
  }
  async lstat(path: string): Promise<ProfileFileStat> {
    const s = await fsp.lstat(path);
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      mode: s.mode,
      isSymbolicLink: s.isSymbolicLink(),
      ino: s.ino,
      ctimeMs: s.ctimeMs,
    };
  }
  async readFileNoFollow(path: string): Promise<string> {
    // O_NOFOLLOW fails the open() with ELOOP if the final component is a symlink.
    const handle = await fsp.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      return await handle.readFile("utf-8");
    } finally {
      await handle.close();
    }
  }
  async readFileSnapshot(path: string): Promise<ProfileFileSnapshot> {
    const handle = await fsp.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      const size = before.size;
      const buffer = Buffer.allocUnsafe(size);
      let bytesRead = 0;
      while (bytesRead < size) {
        const chunk = await handle.read(buffer, bytesRead, size - bytesRead, bytesRead);
        // A zero-length read before `size` bytes means the file shrank under
        // us; reporting the short count lets the caller treat it as such.
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      const after = await handle.stat();
      return {
        content: buffer.subarray(0, bytesRead).toString("utf-8"),
        bytesRead,
        before: { size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, ino: before.ino },
        after: { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino },
      };
    } finally {
      await handle.close();
    }
  }
}

export interface ProfileIpcDeps {
  /** `os.homedir()` in production; overridable at the main/index.ts wiring site (dev/automation only, mirrors ANYCODE_SUBAGENTS_HOME). */
  home(): string;
  fs: ProfileFs;
  /** Reveals a path in the OS file manager — injected so this module stays Electron-free in tests (production wiring: `shell.showItemInFolder`). */
  reveal(path: string): void | Promise<void>;
  /** Boot env — carries the `ANYCODE_TELEMETRY` kill-switch (also read internally by `loadTelemetryConfig`). */
  env: NodeJS.ProcessEnv;
  /** TASK.187 S3: per-pass scan budgets (D-2). Omitted fields fall back to the
   *  production constants; tests inject tiny ones to exercise the backlog. */
  budgets?: Partial<ProfileScanBudgets>;
  /** TASK.187 S3: the cache store. Omitted, the process-wide store for this
   *  home's cache path is used — two IPC calls MUST share one store or nothing
   *  is cached between them. */
  cache?: ProfileStatsCacheStore;
}

// ── dir / config resolution helpers (§2-D2) ──

function stripTrailingSep(base: string): string {
  return base.replace(/[/\\]+$/, "");
}

/** `<home>/.anycode/telemetry` — byte-identical to core/telemetry/config.ts's default. */
function defaultTelemetryDir(home: string): string {
  return `${stripTrailingSep(home)}/.anycode/telemetry`;
}

/** `<home>/.anycode/config.json` — byte-identical to core/telemetry/settings.ts's `userTelemetryConfigPath`. */
function userConfigPath(home: string): string {
  return `${stripTrailingSep(home)}/.anycode/config.json`;
}

/** Rejects a relative path (POSIX `/...` or Windows `C:\...` / `C:/...` only) — mirror of core/telemetry/config.ts's local check. */
function isAbsolutePath(path: string): boolean {
  return /^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

const TELEMETRY_KILL_SWITCH_VALUES = new Set(["0", "false", "off"]);

/** Mirror of core/telemetry/config.ts's (unexported) kill-switch check. */
function isKillSwitchActive(env: NodeJS.ProcessEnv): boolean {
  const raw = env.ANYCODE_TELEMETRY;
  return raw !== undefined && TELEMETRY_KILL_SWITCH_VALUES.has(raw.toLowerCase());
}

/**
 * Reads the user-scope config's raw `telemetry.dir`, if present and a valid
 * absolute path, REGARDLESS of `telemetry.enabled` (see module doc DIR
 * RESOLUTION). Fail-soft: any missing-file/parse/shape problem returns
 * `undefined` (falls through to the default dir) — this NEVER throws, mirroring
 * `loadTelemetryConfig`'s own fail-soft ethic.
 */
async function readUserTelemetryDirOverride(fs: ProfileFs, home: string): Promise<string | undefined> {
  const path = userConfigPath(home);
  try {
    if (!(await fs.exists(path))) {
      return undefined;
    }
    const raw = await fs.readFile(path);
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const telemetry = (parsed as { telemetry?: unknown }).telemetry;
    if (telemetry === null || typeof telemetry !== "object" || Array.isArray(telemetry)) {
      return undefined;
    }
    const dir = (telemetry as { dir?: unknown }).dir;
    if (typeof dir !== "string" || dir.length === 0 || !isAbsolutePath(dir)) {
      return undefined;
    }
    return dir;
  } catch {
    return undefined;
  }
}

interface ResolvedProfileDir {
  dir: string;
  telemetryEnabled: boolean;
  killSwitchActive: boolean;
}

/** Resolves the scan/reveal directory + status flags per §2-D2. Never throws (loadTelemetryConfig + readUserTelemetryDirOverride are both fail-soft). */
async function resolveProfileDir(deps: ProfileIpcDeps): Promise<ResolvedProfileDir> {
  const home = deps.home();
  const killSwitchActive = isKillSwitchActive(deps.env);
  const loaded = await loadTelemetryConfig(deps.fs, home, home, deps.env);
  if (loaded.telemetry !== null) {
    return { dir: loaded.telemetry.dir, telemetryEnabled: true, killSwitchActive };
  }
  const override = await readUserTelemetryDirOverride(deps.fs, home);
  return { dir: override ?? defaultTelemetryDir(home), telemetryEnabled: false, killSwitchActive };
}

// ── cache-backed scan (TASK.187 S3; the old read-everything-every-time scan
//     lived here and is now main/profile-stats-cache.ts) ──

/** The store this deps bag scans with: injected, else the process-wide one
 *  for `<home>/.anycode/profile-stats-cache.json`. */
function storeFor(deps: ProfileIpcDeps): ProfileStatsCacheStore {
  return deps.cache ?? sharedProfileStatsCacheStore(deps.fs, profileStatsCachePath(deps.home()));
}

const telemetrySetSchema = z.object({ enabled: z.boolean() });

// ── handlers (exported for unit tests) ──

interface ProfileCoverage {
  truncated: boolean;
  coverageStartTs: number | null;
  backlogRemaining: number;
  pendingExactSessions: number;
}

function toView(stats: ProfileStats, status: ResolvedProfileDir, coverage: ProfileCoverage): ProfileStatsView {
  return {
    ...stats,
    // Truncation is a property of the SCAN, never of the merged partials
    // (which carry no byte cap at all) — the scanning layer is the only
    // honest source for it.
    truncated: coverage.truncated,
    telemetryEnabled: status.telemetryEnabled,
    killSwitchActive: status.killSwitchActive,
    dir: status.dir,
    coverageStartTs: coverage.coverageStartTs,
    backlogRemaining: coverage.backlogRemaining,
    pendingExactSessions: coverage.pendingExactSessions,
  };
}

/**
 * profile-stats-get: resolves the user-scope dir (§2-D2) and runs ONE
 * incremental pass over it (TASK.187 S3) — unchanged files are replayed from
 * the cache and never opened. A missing dir yields a zeroed stats view
 * (ok:true); only a genuine readdir/aggregation failure is `io_error`.
 */
export async function handleProfileStatsGet(deps: ProfileIpcDeps): Promise<ProfileStatsResult> {
  let status: ResolvedProfileDir;
  try {
    status = await resolveProfileDir(deps);
  } catch (error) {
    console.warn("[profile-ipc] telemetry config resolution failed", error);
    return { ok: false, reason: "io_error" };
  }

  let scanned: Awaited<ReturnType<ProfileStatsCacheStore["scan"]>>;
  try {
    scanned = await storeFor(deps).scan(status.dir, resolveScanBudgets(deps.budgets), Date.now());
  } catch (error) {
    console.warn("[profile-ipc] aggregation failed", error);
    return { ok: false, reason: "io_error" };
  }
  if (!scanned.ok) {
    return { ok: false, reason: "io_error" };
  }
  return { ok: true, view: toView(scanned.stats, status, scanned) };
}

/**
 * profile-stats-cached: the instant answer. Merges what the cache already
 * holds — exactly the files the last completed pass stamped as active — and
 * NEVER lists the telemetry directory, so a warm start renders before the
 * verifying `profile-stats-get` has even finished its lstat sweep. The
 * coverage numbers come from the cache header (the last pass's own verdict);
 * only the toggle/dir status is resolved fresh.
 */
export async function handleProfileStatsCached(deps: ProfileIpcDeps): Promise<ProfileStatsCachedResult> {
  let status: ResolvedProfileDir;
  try {
    status = await resolveProfileDir(deps);
  } catch (error) {
    console.warn("[profile-ipc] telemetry config resolution failed", error);
    return { ok: false, reason: "io_error" };
  }

  let cached: Awaited<ReturnType<ProfileStatsCacheStore["cachedStats"]>>;
  try {
    cached = await storeFor(deps).cachedStats(status.dir, Date.now());
  } catch (error) {
    console.warn("[profile-ipc] cached view failed", error);
    return { ok: false, reason: "io_error" };
  }
  if (!cached.ok) {
    return { ok: false, reason: cached.reason };
  }
  return { ok: true, view: toView(cached.stats, status, cached) };
}

/**
 * profile-stats-rebuild: throws the cache away (file AND the in-memory copy)
 * and runs ONE ordinary incremental pass from empty. Deliberately NOT a
 * whole-directory rebuild: it is cut by the same per-pass budgets as every
 * other pass, so the answer comes back promptly with an honest
 * `backlogRemaining` and the remaining history arrives over the next few
 * refreshes.
 */
export async function handleProfileStatsRebuild(deps: ProfileIpcDeps): Promise<ProfileStatsResult> {
  try {
    await storeFor(deps).reset();
  } catch (error) {
    console.warn("[profile-ipc] cache reset failed", error);
    return { ok: false, reason: "io_error" };
  }
  return handleProfileStatsGet(deps);
}

/**
 * profile-telemetry-set: patches ONLY the user-scope `telemetry.enabled` flag
 * (setUserTelemetryEnabled preserves every sibling key, incl. a user-set
 * `telemetry.dir`) and returns a fresh stats view — same shape/refusal
 * convention as profile-stats-get.
 */
export async function handleProfileTelemetrySet(deps: ProfileIpcDeps, raw: unknown): Promise<ProfileTelemetrySetResult> {
  const parsed = telemetrySetSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  try {
    await setUserTelemetryEnabled(deps.fs, deps.home(), parsed.data.enabled);
  } catch (error) {
    console.warn("[profile-ipc] setUserTelemetryEnabled failed", error);
    return { ok: false, reason: "io_error" };
  }
  return handleProfileStatsGet(deps);
}

/** profile-reveal-dir: resolves the same scan dir and hands it to `deps.reveal` (prod: `shell.showItemInFolder`). No path ever comes from the renderer. */
export async function handleProfileRevealDir(deps: ProfileIpcDeps): Promise<ProfileRevealDirResult> {
  let status: ResolvedProfileDir;
  try {
    status = await resolveProfileDir(deps);
  } catch (error) {
    console.warn("[profile-ipc] telemetry config resolution failed", error);
    return { ok: false, reason: "io_error" };
  }
  try {
    await deps.reveal(status.dir);
  } catch (error) {
    console.warn("[profile-ipc] reveal failed", error);
    return { ok: false, reason: "io_error" };
  }
  return { ok: true };
}

/** Wires the five channels onto ipcMain. A payload the handler cannot validate is answered with a safe negative. */
export function registerProfileIpc(deps: ProfileIpcDeps): void {
  ipcMain.handle(PROFILE_STATS_GET_CHANNEL, () => handleProfileStatsGet(deps));
  ipcMain.handle(PROFILE_STATS_CACHED_CHANNEL, () => handleProfileStatsCached(deps));
  ipcMain.handle(PROFILE_STATS_REBUILD_CHANNEL, () => handleProfileStatsRebuild(deps));
  ipcMain.handle(PROFILE_TELEMETRY_SET_CHANNEL, (_event, raw: unknown) => handleProfileTelemetrySet(deps, raw));
  ipcMain.handle(PROFILE_REVEAL_DIR_CHANNEL, () => handleProfileRevealDir(deps));
}
