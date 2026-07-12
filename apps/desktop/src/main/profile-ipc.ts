/**
 * Profile stats control-plane IPC (design slice-P7.22-cut.md §2-D5/D6/D2 W2).
 * Registers `ipcMain.handle` for the three channels in shared/profile-config.ts:
 * a read-only aggregated usage-stats view, a user-scope `telemetry.enabled`
 * toggle, and a reveal of the resolved sink directory. Mirrors main/skills-
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
import {
  aggregateProfileStats,
  loadTelemetryConfig,
  setUserTelemetryEnabled,
  PROFILE_STATS_MAX_SCAN_BYTES,
  type ProfileStats,
  type ProfileStatsFile,
} from "@anycode/core/telemetry-admin";
import {
  PROFILE_REVEAL_DIR_CHANNEL,
  PROFILE_STATS_GET_CHANNEL,
  PROFILE_TELEMETRY_SET_CHANNEL,
} from "../shared/profile-config.js";
import type {
  ProfileRevealDirResult,
  ProfileStatsResult,
  ProfileStatsView,
  ProfileTelemetrySetResult,
} from "../shared/profile-config.js";

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
}

export interface ProfileFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, opts?: { mode?: number }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<ProfileFileStat>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rename?(from: string, to: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<ProfileFileStat>;
  /** O_NOFOLLOW read — reading a scanned telemetry file must never follow a
   *  symlink swapped in after the lstat pre-check (closes the lstat->read
   *  TOCTOU on the read path, mirror of subagents-ipc.ts's SubagentsFs). */
  readFileNoFollow(path: string): Promise<string>;
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
    return { size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDirectory: s.isDirectory(), mode: s.mode };
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
}

export interface ProfileIpcDeps {
  /** `os.homedir()` in production; overridable at the main/index.ts wiring site (dev/automation only, mirrors ANYCODE_SUBAGENTS_HOME). */
  home(): string;
  fs: ProfileFs;
  /** Reveals a path in the OS file manager — injected so this module stays Electron-free in tests (production wiring: `shell.showItemInFolder`). */
  reveal(path: string): void | Promise<void>;
  /** Boot env — carries the `ANYCODE_TELEMETRY` kill-switch (also read internally by `loadTelemetryConfig`). */
  env: NodeJS.ProcessEnv;
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

// ── directory scan (§2-D1: flat *.jsonl regular files only, lstat-skip symlinks, no recursion) ──

interface ScanResult {
  ok: true;
  files: ProfileStatsFile[];
  /** True when the byte-accurate budget (real `lstat` sizes, PROFILE_STATS_MAX_SCAN_BYTES)
   *  stopped the scan before every *.jsonl entry was read (W5-FIX finding 1). */
  truncated: boolean;
}

/**
 * Lists `dir`'s `*.jsonl` entries, lstat-skipping symlinks and anything not a
 * regular file (no recursion — design §2-D1). A MISSING dir is treated as
 * empty (`{ok:true, files:[]}`, not a failure — §2-D2 empty-state matrix); a
 * genuine `readdir` failure on an existing-but-unreadable dir is `{ok:false}`.
 * A single entry's `lstat`/`readFile` failure (vanished mid-scan, permission
 * on one file) is skipped rather than failing the whole scan.
 *
 * BYTE-ACCURATE CAP (W5-FIX finding 1): entries are processed in a
 * deterministic (name-sorted) order, and each REAL file size (`lstat().size`,
 * bytes, not UTF-16 code units) is checked against the running budget BEFORE
 * that file is read — so a single oversized file is never loaded into memory
 * at all, unlike the aggregator's own post-read char-based cap (which stays
 * as a secondary in-memory guard, not the primary defense).
 */
async function listJsonlFiles(fs: ProfileFs, dir: string): Promise<ScanResult | { ok: false }> {
  let names: string[];
  try {
    if (!(await fs.exists(dir))) {
      return { ok: true, files: [], truncated: false };
    }
    names = await fs.readdir(dir);
  } catch (error) {
    console.warn(`[profile-ipc] readdir failed for ${dir}`, error);
    return { ok: false };
  }

  const jsonlNames = names.filter((name) => name.endsWith(".jsonl")).sort();

  const files: ProfileStatsFile[] = [];
  let accumulatedBytes = 0;
  let truncated = false;
  for (const name of jsonlNames) {
    const fullPath = `${stripTrailingSep(dir)}/${name}`;
    let st: ProfileFileStat;
    try {
      st = await fs.lstat(fullPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink === true) continue;
    if (!st.isFile) continue;

    if (accumulatedBytes + st.size > PROFILE_STATS_MAX_SCAN_BYTES) {
      truncated = true;
      break;
    }

    let raw: string;
    try {
      raw = await fs.readFileNoFollow(fullPath);
    } catch {
      // A symlink swapped in after the lstat pre-check (TOCTOU) fails ELOOP
      // here and is skipped, same fail-soft ethic as any other read error.
      continue;
    }
    accumulatedBytes += st.size;
    files.push({ name, lines: raw.split("\n") });
  }
  return { ok: true, files, truncated };
}



const telemetrySetSchema = z.object({ enabled: z.boolean() });

// ── handlers (exported for unit tests) ──

function toView(stats: ProfileStats, status: ResolvedProfileDir): ProfileStatsView {
  return {
    ...stats,
    telemetryEnabled: status.telemetryEnabled,
    killSwitchActive: status.killSwitchActive,
    dir: status.dir,
  };
}

/**
 * profile-stats-get: resolves the user-scope dir (§2-D2), scans it (§2-D1),
 * and aggregates. A missing dir yields a zeroed stats view (ok:true) — only a
 * genuine readdir/aggregation failure is `io_error`.
 */
export async function handleProfileStatsGet(deps: ProfileIpcDeps): Promise<ProfileStatsResult> {
  let status: ResolvedProfileDir;
  try {
    status = await resolveProfileDir(deps);
  } catch (error) {
    console.warn("[profile-ipc] telemetry config resolution failed", error);
    return { ok: false, reason: "io_error" };
  }

  const scanned = await listJsonlFiles(deps.fs, status.dir);
  if (!scanned.ok) {
    return { ok: false, reason: "io_error" };
  }

  let stats: ProfileStats;
  try {
    stats = aggregateProfileStats(scanned.files, { now: Date.now() });
  } catch (error) {
    console.warn("[profile-ipc] aggregation failed", error);
    return { ok: false, reason: "io_error" };
  }

  const view = toView(stats, status);
  // Byte-accurate scan-level truncation (real file sizes) OR the aggregator's
  // own char-based in-memory cap — either signal means the view is partial.
  view.truncated = stats.truncated || scanned.truncated;
  return { ok: true, view };
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

/** Wires the three channels onto ipcMain. A payload the handler cannot validate is answered with a safe negative. */
export function registerProfileIpc(deps: ProfileIpcDeps): void {
  ipcMain.handle(PROFILE_STATS_GET_CHANNEL, () => handleProfileStatsGet(deps));
  ipcMain.handle(PROFILE_TELEMETRY_SET_CHANNEL, (_event, raw: unknown) => handleProfileTelemetrySet(deps, raw));
  ipcMain.handle(PROFILE_REVEAL_DIR_CHANNEL, () => handleProfileRevealDir(deps));
}
