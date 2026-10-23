/**
 * Telemetry-directory retention (Taskana 4109 / TASK.122).
 *
 * The telemetry sink directory (`<home>/.anycode/telemetry`, or the user's
 * `telemetry.dir` / `ANYCODE_TELEMETRY_DIR` override) is a single FLAT
 * directory of `<sessionId>.jsonl` files appended to by the core host, codex,
 * claude, the CLI and the recognizer probe — and it was never cleaned up.
 *
 * What this module does — desktop-main sweeps EXACTLY the directory Profile
 * reads (`resolveProfileDir`, so `telemetry.dir` overrides and the kill switch
 * apply identically), 2 minutes after startup and then every 24 hours, off
 * the hot path:
 *
 * - candidates are flat `*.jsonl` REGULAR files only (no symlinks, no
 *   directories, no other names);
 * - removal is oldest-by-mtime first (tie-break by name) while ANY of
 *   `maxAgeDays` / `maxFiles` / `maxTotalBytes` is exceeded — deleting only
 *   the oldest keeps the newest contiguous prefix intact;
 * - NEVER removed, whatever the caps say: files of sessions open in a tab
 *   (`protectedSessionIds` from `manager.listTabs()`), files touched within
 *   the last 24 h (a live CLI/host session main cannot see may own them;
 *   deleting an open session's file would make the next append silently
 *   recreate it, leaving partial data), files with a future mtime
 *   (untrusted), and files whose inode/size/mtime changed between the scan
 *   and the delete (they are being written);
 * - at most `RETENTION_MAX_DELETES_PER_RUN` deletions per run; the next run
 *   continues.
 *
 * Why the Profile stats cache stays correct: it already prunes cached
 * partials for names no longer listed and their accumulators, treats
 * vanished files as `gone` mid-pass, and removed files are not "known", so
 * the view never becomes `truncated` and `coverageStartTs` stays `null` —
 * after retention the view simply covers the retained window, with no false
 * "history before X missing" note. (profile-stats-cache.ts is NOT modified
 * by this task; this property is asserted by the cache-interop test.)
 *
 * Config: `telemetry.retention` in the user-scope config
 * (`<home>/.anycode/config.json`) — `{ enabled?, maxAgeDays?, maxFiles?,
 * maxTotalBytes? }`. Core's `telemetryConfigSchema` is a non-strict
 * `z.object`, so the CLI/host strip the unknown `retention` key and ignore
 * it. `ANYCODE_TELEMETRY=off` (the kill switch) and `retention.enabled:
 * false` both disable sweeping.
 */

import { z } from "zod";
import { isKillSwitchActive, resolveProfileDir, userConfigPath, type ProfileFs } from "./profile-ipc.js";

export interface TelemetryRetentionPolicy {
  enabled: boolean;
  maxAgeDays: number;
  maxFiles: number;
  maxTotalBytes: number;
}

export const DEFAULT_TELEMETRY_RETENTION: TelemetryRetentionPolicy = {
  enabled: true,
  maxAgeDays: 180,
  maxFiles: 20_000,
  // Equals PROFILE_STATS_MAX_SCAN_BYTES (types/config.ts:789-800): a Rebuild
  // pass can cover everything retained in one go.
  maxTotalBytes: 64 * 1024 * 1024,
};

/** Never deleted, whatever the caps say: anything touched this recently may belong to a live CLI/host session main cannot see. */
export const RETENTION_PROTECT_RECENT_MS = 24 * 60 * 60 * 1000;

/** Bounds one run's work; the next run continues. */
export const RETENTION_MAX_DELETES_PER_RUN = 5_000;

export const RETENTION_INITIAL_DELAY_MS = 2 * 60 * 1000;
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_DAYS_CEILING = 3650;

/** Just enough of ProfileFs for a sweep; narrower than the cache's needs. */
export type RetentionFs = Pick<ProfileFs, "readdir" | "lstat" | "rm" | "exists" | "readFile">;

const retentionSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxAgeDays: z.number().int().min(1).max(3650).optional(),
    maxFiles: z.number().int().min(100).max(1_000_000).optional(),
    maxTotalBytes: z.number().int().min(1_048_576).optional(),
  })
  .strict();

/**
 * Reads `telemetry.retention` from the user-scope config — raw and
 * enabled-agnostic, the same way `readUserTelemetryDirOverride` reads
 * `telemetry.dir`. Absent section -> defaults; valid -> defaults with the
 * given fields overridden; invalid/unreadable -> defaults + warning.
 * NEVER throws.
 */
export async function readUserTelemetryRetention(fs: RetentionFs, home: string): Promise<TelemetryRetentionPolicy> {
  const path = userConfigPath(home);
  try {
    if (!(await fs.exists(path))) {
      return { ...DEFAULT_TELEMETRY_RETENTION };
    }
    const raw = await fs.readFile(path);
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_TELEMETRY_RETENTION };
    }
    const telemetry = (parsed as { telemetry?: unknown }).telemetry;
    if (telemetry === null || typeof telemetry !== "object" || Array.isArray(telemetry)) {
      return { ...DEFAULT_TELEMETRY_RETENTION };
    }
    const section = (telemetry as { retention?: unknown }).retention;
    if (section === undefined) {
      return { ...DEFAULT_TELEMETRY_RETENTION };
    }
    const result = retentionSchema.safeParse(section);
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      console.warn(`[telemetry-retention] ignoring invalid telemetry.retention in ${path}: ${detail}`);
      return { ...DEFAULT_TELEMETRY_RETENTION };
    }
    return { ...DEFAULT_TELEMETRY_RETENTION, ...result.data };
  } catch (err) {
    console.warn(`[telemetry-retention] ignoring unreadable config ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return { ...DEFAULT_TELEMETRY_RETENTION };
  }
}

interface RetentionCandidate {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
}

export interface SweepTelemetryDirOptions {
  fs: RetentionFs;
  dir: string;
  policy: TelemetryRetentionPolicy;
  protectedSessionIds: Set<string>;
  now: number;
  /** Injectable for tests; defaults to RETENTION_MAX_DELETES_PER_RUN. */
  maxDeletes?: number;
}

export type SweepTelemetryDirResult =
  | { ok: true; scanned: number; removed: string[]; removedBytes: number; protectedKept: number }
  | { ok: false };

function isErrnoException(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}

/**
 * One retention pass over a telemetry directory. See the module doc for the
 * protection rules. Never throws; any unexpected readdir failure returns
 * `{ ok: false }` (the next scheduled run retries).
 */
export async function sweepTelemetryDir(opts: SweepTelemetryDirOptions): Promise<SweepTelemetryDirResult> {
  const { fs, dir, policy, protectedSessionIds, now } = opts;
  const maxDeletes = opts.maxDeletes ?? RETENTION_MAX_DELETES_PER_RUN;

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (isErrnoException(err, "ENOENT")) {
      // No directory, nothing to sweep — and we must NOT create it (the sink
      // itself only lazily mkdirs on first write).
      return { ok: true, scanned: 0, removed: [], removedBytes: 0, protectedKept: 0 };
    }
    console.warn(`[telemetry-retention] cannot read directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }

  const candidates: RetentionCandidate[] = [];
  for (const name of names) {
    // Flat <sessionId>.jsonl files only: no separators, .jsonl suffix.
    if (!/^[^/\\]+\.jsonl$/.test(name)) continue;
    const path = `${dir}/${name}`;
    let stat;
    try {
      stat = await fs.lstat(path);
    } catch (err) {
      if (isErrnoException(err, "ENOENT")) continue;
      // Unknown state: never delete, never count.
      continue;
    }
    if (stat.isSymbolicLink === true || !stat.isFile) continue;
    candidates.push({ name, path, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
  }

  const scanned = candidates.length;

  // Oldest by mtime first, tie-break by name — deterministic and matching
  // the cache's newest-contiguous-prefix expectations.
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let remainingCount = candidates.length;
  let remainingBytes = candidates.reduce((sum, c) => sum + c.size, 0);
  const removed: string[] = [];
  let removedBytes = 0;
  let protectedKept = 0;

  for (const entry of candidates) {
    // Protected entries stay counted in the totals but are never removed.
    if (
      protectedSessionIds.has(entry.name.slice(0, -6)) ||
      now - entry.mtimeMs < RETENTION_PROTECT_RECENT_MS ||
      entry.mtimeMs > now
    ) {
      protectedKept++;
      continue;
    }

    const expired = now - entry.mtimeMs > policy.maxAgeDays * DAY_MS;
    if (!expired && remainingCount <= policy.maxFiles && remainingBytes <= policy.maxTotalBytes) {
      // Everything after this entry is newer and the caps are met.
      break;
    }

    // Re-stat: if the file changed in any observable way since the scan, it
    // is being written — keep it.
    let current;
    try {
      current = await fs.lstat(entry.path);
    } catch {
      current = undefined;
    }
    if (
      current === undefined ||
      current.ino !== entry.ino ||
      current.size !== entry.size ||
      current.mtimeMs !== entry.mtimeMs ||
      current.isSymbolicLink === true ||
      !current.isFile
    ) {
      continue;
    }

    try {
      await fs.rm(entry.path);
      // Success or ENOENT: either way it is gone from the next view.
    } catch (err) {
      if (isErrnoException(err, "ENOENT")) {
        // fall through: treat as removed
      } else {
        console.warn(`[telemetry-retention] cannot remove ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    removed.push(entry.name);
    removedBytes += entry.size;
    remainingCount--;
    remainingBytes -= entry.size;
    if (removed.length >= maxDeletes) break;
  }

  if (removed.length > 0) {
    console.log(`[telemetry-retention] removed ${removed.length} files (${removedBytes} bytes) from ${dir}`);
  }
  return { ok: true, scanned, removed, removedBytes, protectedKept };
}

/** Timer surface the retention loop needs — injectable for tests. */
export interface TelemetryRetentionTimers {
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
  clearTimeout: typeof clearTimeout;
  clearInterval: typeof clearInterval;
}

export interface TelemetryRetentionDeps {
  home(): string;
  fs: ProfileFs;
  env: NodeJS.ProcessEnv;
  protectedSessionIds(): Iterable<string>;
  now?(): number;
  timers?: TelemetryRetentionTimers;
}

export interface TelemetryRetentionHandle {
  runNow(): Promise<void>;
  stop(): void;
}

/**
 * Starts the retention loop: first run RETENTION_INITIAL_DELAY_MS after
 * start, then every RETENTION_INTERVAL_MS (both timers unref'd, so they never
 * hold the process open). `runNow` is single-flight and never rejects.
 * Every run checks the kill switch and `retention.enabled` first, so config
 * changes apply without a restart.
 */
export function startTelemetryRetention(deps: TelemetryRetentionDeps): TelemetryRetentionHandle {
  const timers = deps.timers ?? { setTimeout, setInterval, clearTimeout, clearInterval };
  const now = deps.now ?? Date.now;
  let inFlight: Promise<void> | null = null;

  const runOnce = async (): Promise<void> => {
    // 1. Kill switch: nothing at all when telemetry is hard-off.
    if (isKillSwitchActive(deps.env)) return;
    // 2. Policy (fail-soft: unreadable config means "defaults", never a throw).
    const policy = await readUserTelemetryRetention(deps.fs, deps.home());
    if (!policy.enabled) return;
    // 3. Sweep EXACTLY the directory Profile reads.
    const resolved = await resolveProfileDir({ home: deps.home, fs: deps.fs, env: deps.env, reveal: () => {} });
    await sweepTelemetryDir({
      fs: deps.fs,
      dir: resolved.dir,
      policy,
      protectedSessionIds: new Set(deps.protectedSessionIds()),
      now: now(),
    });
  };

  const runNow = (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    const run = (async () => {
      try {
        await runOnce();
      } catch (err) {
        console.warn(`[telemetry-retention] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        inFlight = null;
      }
    })();
    inFlight = run;
    return run;
  };

  const timeoutHandle = timers.setTimeout(() => {
    void runNow();
  }, RETENTION_INITIAL_DELAY_MS);
  // unref so the timer never holds the process open (fake test rigs have no unref).
  timeoutHandle.unref?.();

  const intervalHandle = timers.setInterval(() => {
    void runNow();
  }, RETENTION_INTERVAL_MS);
  intervalHandle.unref?.();

  return {
    runNow,
    stop() {
      timers.clearTimeout(timeoutHandle);
      timers.clearInterval(intervalHandle);
    },
  };
}
