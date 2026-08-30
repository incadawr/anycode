/**
 * Unit tests for the Profile-stats IPC handler logic (design
 * slice-P7.22-cut.md §2-D2/D5/D6 W2 gate), exercised as the exported handle*
 * functions off a REAL node fs in scratch tmpdirs (no Electron ipcMain).
 * Covers: stats round-trip vs seeded fixture files, the disabled-but-has-data
 * case, the `ANYCODE_TELEMETRY` kill-switch flag, the toggle writing ONLY the
 * user-scope config (a sibling project config is untouched), reveal targeting
 * the resolved dir, a symlinked `.jsonl` entry being skipped by execution, and
 * a missing dir resolving to a zeroed (not failed) stats view.
 */

import { appendFile, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROFILE_STATS_CACHE_MAX_BYTES, PROFILE_STATS_MAX_SCAN_BYTES } from "@anycode/core/telemetry-admin";
import {
  handleProfileRevealDir,
  handleProfileStatsCached,
  handleProfileStatsGet,
  handleProfileStatsRebuild,
  handleProfileTelemetrySet,
  NodeProfileFs,
  type ProfileFileStat,
  type ProfileFs,
  type ProfileIpcDeps,
} from "./profile-ipc.js";
// TASK.187 S3 — the incremental cache under handleProfileStatsGet/Cached.
import {
  createProfileStatsCacheStore,
  profileStatsCachePath,
  type ProfileFileSnapshot,
  type ProfileScanBudgets,
  type ProfileStatsCacheStore,
} from "./profile-stats-cache.js";

const fs = new NodeProfileFs();
const dirs: string[] = [];

async function tmp(prefix = "pripc-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function seed(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf-8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

function makeDeps(
  home: string,
  opts?: { env?: NodeJS.ProcessEnv; reveal?: (path: string) => void },
): ProfileIpcDeps {
  return {
    home: () => home,
    fs,
    reveal: opts?.reveal ?? (() => {}),
    env: opts?.env ?? {},
  };
}

function jsonl(records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Fixed anchor far in the past so "current streak" math never depends on the
// real wall clock; `now` passed to aggregateProfileStats (via Date.now()
// inside the handler) is NOT overridable here, so tests assert fields that do
// not depend on "today" (lifetime/peak/session/tool/model counts), not the
// streak fields.
const DAY1 = Date.UTC(2020, 0, 1, 10, 0, 0);
const DAY2 = DAY1 + DAY_MS;

async function seedTelemetryDir(dir: string): Promise<void> {
  await seed(
    join(dir, "session-a.jsonl"),
    jsonl([
      { v: 1, ts: DAY1, session: "session-a", t: "session_start", model: "gpt-5", provider: "openai", mode: "agent" },
      { v: 1, ts: DAY1 + 1000, session: "session-a", t: "usage", inputTokens: 40, outputTokens: 60, totalTokens: 100 },
      { v: 1, ts: DAY1 + 2000, session: "session-a", t: "tool", tool: "bash", status: "ok", durationMs: 10 },
      { v: 1, ts: DAY1 + 3000, session: "session-a", t: "loop_end", turns: 1, reason: "done" },
    ]),
  );
  await seed(
    join(dir, "session-b.jsonl"),
    jsonl([
      { v: 1, ts: DAY2, session: "session-b", t: "session_start", model: "claude-opus", provider: "anthropic", mode: "agent" },
      { v: 1, ts: DAY2 + 1000, session: "session-b", t: "usage", totalTokens: 50 },
      { v: 1, ts: DAY2 + 2000, session: "session-b", t: "tool", tool: "bash", status: "ok", durationMs: 5 },
      { v: 1, ts: DAY2 + 3000, session: "session-b", t: "tool", tool: "read", status: "ok", durationMs: 5 },
      { v: 1, ts: DAY2 + 4000, session: "session-b", t: "subagent_start", agentType: "sonnet" },
      { v: 1, ts: DAY2 + 5000, session: "session-b", t: "loop_end", turns: 2, reason: "done" },
    ]),
  );
}

// ---------------------------------------------------------------------------

describe("handleProfileStatsGet", () => {
  it("aggregates seeded fixture files into an exact stats view (telemetry enabled)", async () => {
    const home = await tmp();
    const telemetryDir = join(home, ".anycode/telemetry");
    await seedTelemetryDir(telemetryDir);
    // Explicit `dir` (TASK.121's fail-closed VITEST gate in core/telemetry/
    // config.ts refuses to resolve an `enabled:true` section onto the DEFAULT
    // dir under a test runner — a test must always name its sink explicitly,
    // even though it happens to equal the default here).
    await seed(
      join(home, ".anycode/config.json"),
      JSON.stringify({ telemetry: { enabled: true, dir: telemetryDir } }),
    );

    const result = await handleProfileStatsGet(makeDeps(home));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.view.lifetimeTokens).toBe(150);
    expect(result.view.totalSessions).toBe(2);
    expect(result.view.totalRuns).toBe(2);
    expect(result.view.toolCalls).toBe(3);
    expect(result.view.subagentRuns).toBe(1);
    // Equivalent of the removed `topTools`/`topModels` top-N fields (S10):
    // the SAME per-tool/per-model totals are now only reachable via the full
    // `days`/`models` aggregates — sum tool calls across every day bucket.
    const toolTotals: Record<string, number> = {};
    for (const dayStats of Object.values(result.view.days)) {
      for (const [name, count] of Object.entries(dayStats.tools)) {
        toolTotals[name] = (toolTotals[name] ?? 0) + count;
      }
    }
    expect(toolTotals).toEqual({ bash: 2, read: 1 });
    expect(result.view.models).toEqual([
      { model: "gpt-5", tokens: 100, sessions: 1 },
      { model: "claude-opus", tokens: 50, sessions: 1 },
    ]);
    expect(result.view.peakDay?.tokens).toBe(100);
    expect(result.view.telemetryEnabled).toBe(true);
    expect(result.view.killSwitchActive).toBe(false);
    expect(result.view.dir).toBe(telemetryDir);
    expect(result.view.truncated).toBe(false);
    // No cut was ever made — there is no honest lower bound to report.
    expect(result.view.coverageStartTs).toBeNull();
  });

  it("shows historical stats when telemetry is disabled (data + disabled empty-state branch)", async () => {
    const home = await tmp();
    const telemetryDir = join(home, ".anycode/telemetry");
    await seedTelemetryDir(telemetryDir);
    await seed(join(home, ".anycode/config.json"), JSON.stringify({ telemetry: { enabled: false } }));

    const result = await handleProfileStatsGet(makeDeps(home));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.view.telemetryEnabled).toBe(false);
    expect(result.view.lifetimeTokens).toBe(150);
    expect(result.view.dir).toBe(telemetryDir);
  });

  it("uses a disabled-but-set telemetry.dir override, not the default", async () => {
    const home = await tmp();
    const customDir = join(home, "custom-sink");
    await seedTelemetryDir(customDir);
    await seed(
      join(home, ".anycode/config.json"),
      JSON.stringify({ telemetry: { enabled: false, dir: customDir } }),
    );

    const result = await handleProfileStatsGet(makeDeps(home));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.dir).toBe(customDir);
    expect(result.view.lifetimeTokens).toBe(150);
  });

  it("sets killSwitchActive when ANYCODE_TELEMETRY is a kill-switch value", async () => {
    const home = await tmp();
    await seed(join(home, ".anycode/config.json"), JSON.stringify({ telemetry: { enabled: true } }));

    const result = await handleProfileStatsGet(makeDeps(home, { env: { ANYCODE_TELEMETRY: "0" } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.killSwitchActive).toBe(true);
    // Kill-switch also forces the resolution to disabled, per loadTelemetryConfig.
    expect(result.view.telemetryEnabled).toBe(false);
  });

  it("resolves a missing telemetry dir to a zeroed stats view (ok:true, not io_error)", async () => {
    const home = await tmp();
    // No .anycode/config.json and no telemetry dir at all.

    const result = await handleProfileStatsGet(makeDeps(home));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.lifetimeTokens).toBe(0);
    expect(result.view.totalSessions).toBe(0);
    expect(result.view.peakDay).toBeNull();
    expect(result.view.dir).toBe(join(home, ".anycode/telemetry"));
  });

  it("skips a symlinked .jsonl entry (design §2-D1 symlink-skip)", async () => {
    const home = await tmp();
    const telemetryDir = join(home, ".anycode/telemetry");
    await seedTelemetryDir(telemetryDir);

    // A symlinked-in third file, pointing at a real jsonl fixture elsewhere,
    // whose records must NOT be counted.
    const outside = await tmp("pripc-outside-");
    const outsideFile = join(outside, "evil.jsonl");
    await seed(
      outsideFile,
      jsonl([{ v: 1, ts: DAY1, session: "evil", t: "usage", totalTokens: 999_999 }]),
    );
    await symlink(outsideFile, join(telemetryDir, "session-c.jsonl"));

    const result = await handleProfileStatsGet(makeDeps(home));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.lifetimeTokens).toBe(150);
    expect(result.view.totalSessions).toBe(2);
  });

  it(
    "stops the scan before reading a file whose REAL byte size exceeds PROFILE_STATS_MAX_SCAN_BYTES " +
      "(byte-accurate gate, W5-FIX finding 1 / codex R1 P2-A)",
    async () => {
      const home = await tmp();
      const telemetryDir = join(home, ".anycode/telemetry");
      await seedTelemetryDir(telemetryDir);

      const hugePath = join(telemetryDir, "zzz-huge.jsonl");
      await seed(
        hugePath,
        jsonl([{ v: 1, ts: DAY1, session: "huge", t: "usage", totalTokens: 999_999 }]),
      );
      await truncate(hugePath, PROFILE_STATS_MAX_SCAN_BYTES + 1);
      const hugeStat = await stat(hugePath);
      expect(hugeStat.size).toBeGreaterThan(PROFILE_STATS_MAX_SCAN_BYTES);

      // Oldest mtime of the three, despite its name sorting LAST — proves the
      // cut is decided by TIME, not by name (a bare name-sort would have put
      // "zzz-huge.jsonl" last in scan order and let both small files count
      // first, same as before TASK.158 slice 0).
      const base = Date.now() - 60_000;
      await utimes(hugePath, base / 1000, base / 1000);
      await utimes(join(telemetryDir, "session-a.jsonl"), (base + 1000) / 1000, (base + 1000) / 1000);
      await utimes(join(telemetryDir, "session-b.jsonl"), (base + 2000) / 1000, (base + 2000) / 1000);

      const result = await handleProfileStatsGet(makeDeps(home));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The oversized file's record must never be counted — it is never read.
      expect(result.view.lifetimeTokens).toBe(150);
      expect(result.view.totalSessions).toBe(2);
      expect(result.view.truncated).toBe(true);
    },
  );

  it(
    "keeps the newest files (by mtime, not by name) and drops the oldest when the total " +
      "exceeds PROFILE_STATS_MAX_SCAN_BYTES (TASK.158 slice 0 — the old scan order was " +
      "name-lexicographic, i.e. random relative to time, since filenames are UUIDs)",
    async () => {
      const home = await tmp();
      const telemetryDir = join(home, ".anycode/telemetry");
      await seedTelemetryDir(telemetryDir);

      // Named "aaa-huge" so it sorts FIRST alphabetically: under the OLD
      // (buggy) name-sorted order it would have been read FIRST too, breaking
      // the scan before session-a/session-b were ever reached and yielding
      // lifetimeTokens 0. Giving it the OLDEST mtime instead must produce the
      // opposite result: session-a/session-b (both newer) are tried first and
      // survive; this file is the one dropped.
      const hugePath = join(telemetryDir, "aaa-huge.jsonl");
      await seed(
        hugePath,
        jsonl([{ v: 1, ts: DAY1, session: "huge", t: "usage", totalTokens: 999_999 }]),
      );
      await truncate(hugePath, PROFILE_STATS_MAX_SCAN_BYTES + 1);

      const base = Date.now() - 60_000;
      await utimes(hugePath, base / 1000, base / 1000); // oldest
      await utimes(join(telemetryDir, "session-a.jsonl"), (base + 1000) / 1000, (base + 1000) / 1000); // middle
      await utimes(join(telemetryDir, "session-b.jsonl"), (base + 2000) / 1000, (base + 2000) / 1000); // newest

      const result = await handleProfileStatsGet(makeDeps(home));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.view.lifetimeTokens).toBe(150);
      expect(result.view.totalSessions).toBe(2);
      expect(result.view.truncated).toBe(true);
      // coverageStartTs (TASK.169) is the EARLIEST EVENT inside the oldest
      // INCLUDED file (session-a), not that file's mtime: session-a's mtime
      // is set to "now" above, but its first record (session_start) carries
      // ts=DAY1 (year 2020) — mtime is when the session's LAST record was
      // written (i.e. when it ENDED), so using it would understate coverage
      // by the session's own length. DAY1 is the honest lower bound here.
      expect(result.view.coverageStartTs).toBe(DAY1);
    },
  );

  it(
    "falls back to the oldest included file's mtimeMs when its first line has no usable ts " +
      "(TASK.169 fail-soft path — never throws, never reports null while truncated)",
    async () => {
      const home = await tmp();
      const telemetryDir = join(home, ".anycode/telemetry");
      await mkdir(telemetryDir, { recursive: true });

      const hugePath = join(telemetryDir, "aaa-huge.jsonl");
      await seed(hugePath, jsonl([{ v: 1, ts: DAY1, session: "huge", t: "usage", totalTokens: 999_999 }]));
      await truncate(hugePath, PROFILE_STATS_MAX_SCAN_BYTES + 1);

      // First line is not even JSON (a torn write / corrupt sink) — the rest
      // of the file is fine and still counts toward the aggregated stats.
      const oldPath = join(telemetryDir, "bbb-garbage-first-line.jsonl");
      await seed(oldPath, "not json at all\n" + jsonl([{ v: 1, ts: DAY1, session: "old", t: "usage", totalTokens: 5 }]));

      const base = Date.now() - 60_000;
      await utimes(hugePath, base / 1000, base / 1000); // oldest, dropped (alone exceeds the budget)
      await utimes(oldPath, (base + 1000) / 1000, (base + 1000) / 1000); // newer, kept — the only included file

      const result = await handleProfileStatsGet(makeDeps(home));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.view.truncated).toBe(true);
      expect(result.view.lifetimeTokens).toBe(5);
      const oldStat = await stat(oldPath);
      expect(result.view.coverageStartTs).toBe(oldStat.mtimeMs);
    },
  );

  it("tie-breaks equal mtimes deterministically by name, not by readdir order", async () => {
    const home = await tmp();
    const telemetryDir = join(home, ".anycode/telemetry");
    await mkdir(telemetryDir, { recursive: true });

    // Two files, individually under the byte budget but together over it —
    // an exact mtime tie must still pick a stable winner.
    const sizeEach = Math.floor(PROFILE_STATS_MAX_SCAN_BYTES / 2) + 1000;
    const pathA = join(telemetryDir, "aaa.jsonl");
    const pathB = join(telemetryDir, "bbb.jsonl");
    await seed(pathA, jsonl([{ v: 1, ts: DAY1, session: "a", t: "usage", totalTokens: 11 }]));
    await seed(pathB, jsonl([{ v: 1, ts: DAY1, session: "b", t: "usage", totalTokens: 22 }]));
    await truncate(pathA, sizeEach);
    await truncate(pathB, sizeEach);

    const sameMtime = Date.now() / 1000;
    await utimes(pathA, sameMtime, sameMtime);
    await utimes(pathB, sameMtime, sameMtime);

    const result = await handleProfileStatsGet(makeDeps(home));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // On an exact mtime tie, name-ascending order makes "aaa.jsonl" the one
    // tried (and kept) first; "bbb.jsonl" is the one that doesn't fit.
    expect(result.view.lifetimeTokens).toBe(11);
    expect(result.view.totalSessions).toBe(1);
    expect(result.view.truncated).toBe(true);
  });

  it("reports coverageStartTs as null when truncation cuts before any file could be included", async () => {
    const home = await tmp();
    const telemetryDir = join(home, ".anycode/telemetry");
    await mkdir(telemetryDir, { recursive: true });

    // A single file, alone larger than the whole budget: it is the newest
    // (only) candidate, doesn't fit, and nothing is ever included.
    const hugePath = join(telemetryDir, "only.jsonl");
    await seed(hugePath, jsonl([{ v: 1, ts: DAY1, session: "huge", t: "usage", totalTokens: 999_999 }]));
    await truncate(hugePath, PROFILE_STATS_MAX_SCAN_BYTES + 1);

    const result = await handleProfileStatsGet(makeDeps(home));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.truncated).toBe(true);
    expect(result.view.lifetimeTokens).toBe(0);
    expect(result.view.totalSessions).toBe(0);
    expect(result.view.coverageStartTs).toBeNull();
  });

  it(
    "closes the lstat->readFile TOCTOU: an O_NOFOLLOW read refuses to follow a symlink even when the " +
      "pre-check lstat lies that it is a regular file (W5-FIX finding 3 / codex R1 P3)",
    async () => {
      const home = await tmp();
      const telemetryDir = join(home, ".anycode/telemetry");
      await mkdir(telemetryDir, { recursive: true });

      // The real target lives OUTSIDE the scanned dir — only the symlink is
      // inside it, so the only way its content could leak in is by following
      // the symlink at read time.
      const outside = await tmp("pripc-outside-");
      const outsideFile = join(outside, "real.jsonl");
      await seed(
        outsideFile,
        jsonl([{ v: 1, ts: DAY1, session: "real", t: "usage", totalTokens: 999_999 }]),
      );
      const linkPath = join(telemetryDir, "link.jsonl");
      await symlink(outsideFile, linkPath);

      // Simulates the TOCTOU race codex describes: the pre-check lstat
      // reports a regular (non-symlink) file for every path, so only the
      // O_NOFOLLOW read itself (not the lstat pre-check) can still refuse to
      // follow the symlink.
      class RacyLiesLstatFs extends NodeProfileFs {
        override async lstat(path: string): Promise<ProfileFileStat> {
          const real = await super.lstat(path);
          return { ...real, isFile: true, isSymbolicLink: false };
        }
      }

      const result = await handleProfileStatsGet({
        home: () => home,
        fs: new RacyLiesLstatFs(),
        reveal: () => {},
        env: {},
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.view.lifetimeTokens).toBe(0);
      expect(result.view.totalSessions).toBe(0);
    },
  );
});

describe("handleProfileTelemetrySet", () => {
  it("patches only the user-scope telemetry.enabled flag, preserving a sibling project config", async () => {
    const home = await tmp();
    const project = await tmp();
    await seed(
      join(home, ".anycode/config.json"),
      JSON.stringify({ mcpServers: { foo: { command: "x" } }, telemetry: { enabled: false, dir: "/custom" } }),
    );
    const projectConfigContent = JSON.stringify({ telemetry: { enabled: true } });
    await seed(join(project, ".anycode/config.json"), projectConfigContent);

    const result = await handleProfileTelemetrySet(makeDeps(home), { enabled: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.telemetryEnabled).toBe(true);
    expect(result.view.dir).toBe("/custom");

    const userConfig = JSON.parse(await readFile(join(home, ".anycode/config.json"), "utf-8"));
    expect(userConfig).toEqual({ mcpServers: { foo: { command: "x" } }, telemetry: { enabled: true, dir: "/custom" } });

    // The project config is a completely separate file/scope — untouched byte-for-byte.
    const projectConfigAfter = await readFile(join(project, ".anycode/config.json"), "utf-8");
    expect(projectConfigAfter).toBe(projectConfigContent);
  });

  it("refuses an invalid payload", async () => {
    const home = await tmp();
    const result = await handleProfileTelemetrySet(makeDeps(home), { enabled: "yes" });
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(await exists(join(home, ".anycode/config.json"))).toBe(false);
  });

  it("creates the user config file when absent", async () => {
    const home = await tmp();
    const result = await handleProfileTelemetrySet(makeDeps(home), { enabled: true });
    expect(result.ok).toBe(true);
    const userConfig = JSON.parse(await readFile(join(home, ".anycode/config.json"), "utf-8"));
    expect(userConfig).toEqual({ telemetry: { enabled: true } });
  });
});

describe("handleProfileRevealDir", () => {
  it("reveals the resolved scan directory", async () => {
    const home = await tmp();
    const telemetryDir = join(home, ".anycode/telemetry");
    // Explicit `dir` (TASK.121's fail-closed VITEST gate in core/telemetry/
    // config.ts refuses to resolve an `enabled:true` section onto the DEFAULT
    // dir under a test runner — a test must always name its sink explicitly,
    // even though it happens to equal the default here). Same idiom as the
    // handleProfileStatsGet tests above.
    await seed(
      join(home, ".anycode/config.json"),
      JSON.stringify({ telemetry: { enabled: true, dir: telemetryDir } }),
    );

    let revealed: string | undefined;
    const result = await handleProfileRevealDir(makeDeps(home, { reveal: (p) => (revealed = p) }));
    expect(result).toEqual({ ok: true });
    expect(revealed).toBe(telemetryDir);
  });

  it("reveals the default dir when no config exists", async () => {
    const home = await tmp();
    let revealed: string | undefined;
    const result = await handleProfileRevealDir(makeDeps(home, { reveal: (p) => (revealed = p) }));
    expect(result).toEqual({ ok: true });
    expect(revealed).toBe(join(home, ".anycode/telemetry"));
  });
});

/** Reads the cache JSON, hands it to `mutate`, writes the result back. */
async function patchCacheJson(
  path: string,
  mutate: (cache: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const parsed = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
  await writeFile(path, JSON.stringify(mutate(parsed)), "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════════
// TASK.187 S3 — incremental per-file cache (plan §3 "S3", decisions D-1/D-2/D-6)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Counts exactly the two operations the cache exists to eliminate: per-file
 * coherent opens (`readFileSnapshot`) and directory listings. Counting by
 * path matters for `readdir` — the cache store lists its OWN directory to
 * sweep orphaned tmp files, and that listing must never be mistaken for a
 * telemetry scan.
 */
class CountingProfileFs extends NodeProfileFs {
  opens = 0;
  openedPaths: string[] = [];
  readdirPaths: string[] = [];
  override async readFileSnapshot(path: string): Promise<ProfileFileSnapshot> {
    this.opens += 1;
    this.openedPaths.push(path);
    return super.readFileSnapshot(path);
  }
  override async readdir(path: string): Promise<string[]> {
    this.readdirPaths.push(path);
    return super.readdir(path);
  }
  readdirCountFor(path: string): number {
    return this.readdirPaths.filter((p) => p === path).length;
  }
}

async function seedEnabledConfig(home: string, telemetryDir: string): Promise<void> {
  await seed(join(home, ".anycode/config.json"), JSON.stringify({ telemetry: { enabled: true, dir: telemetryDir } }));
}

/** Seeds one sink file and pins its mtime, so newest-first scan order is exact. */
async function seedAt(dir: string, name: string, records: Record<string, unknown>[], mtimeSec: number): Promise<string> {
  const path = join(dir, name);
  await seed(path, jsonl(records));
  await utimes(path, mtimeSec, mtimeSec);
  return path;
}

/** Same, but padded past the per-file ceiling. `truncate` bumps mtime, so the
 *  pin is re-applied after it — otherwise the file jumps to the front of the
 *  newest-first order and the fixture stops testing what it claims to. */
async function seedOversized(
  dir: string,
  name: string,
  records: Record<string, unknown>[],
  mtimeSec: number,
): Promise<string> {
  const path = join(dir, name);
  await seed(path, jsonl(records));
  await truncate(path, 4096);
  await utimes(path, mtimeSec, mtimeSec);
  return path;
}

function usage(session: string, ts: number, tokens: number): Record<string, unknown>[] {
  return [{ v: 1, ts, session, t: "usage", totalTokens: tokens }];
}

function cacheDeps(
  home: string,
  fsPort: ProfileFs,
  opts?: { budgets?: Partial<ProfileScanBudgets>; cache?: ProfileStatsCacheStore },
): ProfileIpcDeps {
  return {
    home: () => home,
    fs: fsPort,
    reveal: () => {},
    env: {},
    budgets: opts?.budgets,
    cache: opts?.cache,
  };
}

const MTIME_BASE = Math.floor(Date.UTC(2024, 0, 1) / 1000);

/** home + telemetry dir + enabled user config, the fixture every cache test starts from. */
async function cacheHome(): Promise<{ home: string; telemetryDir: string; cachePath: string }> {
  const home = await tmp("prcache-");
  const telemetryDir = join(home, ".anycode/telemetry");
  await mkdir(telemetryDir, { recursive: true });
  await seedEnabledConfig(home, telemetryDir);
  return { home, telemetryDir, cachePath: profileStatsCachePath(home) };
}

describe("profile stats cache — incremental scan (T-noopen family)", () => {
  it("T-noopen: a second scan of an unchanged directory opens ZERO files", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedTelemetryDir(telemetryDir);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort);

    const first = await handleProfileStatsGet(deps);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(fsPort.opens).toBe(2);

    const opensAfterCold = fsPort.opens;
    const second = await handleProfileStatsGet(deps);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // The whole point of the slice: a warm pass re-lstats but re-opens nothing.
    expect(fsPort.opens).toBe(opensAfterCold);
    expect(second.view).toEqual(first.view);
    expect(second.view.lifetimeTokens).toBe(150);
    expect(second.view.truncated).toBe(false);
    expect(second.view.backlogRemaining).toBe(0);
    expect(second.view.pendingExactSessions).toBe(0);
  });

  it("T-append: an appended file is re-read and its new records counted", async () => {
    const { home, telemetryDir } = await cacheHome();
    const path = await seedAt(telemetryDir, "a.jsonl", usage("a", DAY1, 10), MTIME_BASE);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort);

    const first = await handleProfileStatsGet(deps);
    expect(first.ok && first.view.lifetimeTokens).toBe(10);

    await writeFile(path, jsonl([...usage("a", DAY1, 10), ...usage("a", DAY1 + 1000, 7)]), "utf-8");
    await utimes(path, MTIME_BASE + 5, MTIME_BASE + 5);

    const opensBefore = fsPort.opens;
    const second = await handleProfileStatsGet(deps);
    expect(fsPort.opens).toBe(opensBefore + 1);
    expect(second.ok && second.view.lifetimeTokens).toBe(17);
  });

  it("T-delete: a vanished file's contribution disappears without re-reading survivors", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "a.jsonl", usage("a", DAY1, 10), MTIME_BASE);
    const gone = await seedAt(telemetryDir, "b.jsonl", usage("b", DAY1, 5), MTIME_BASE + 1);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort);

    await handleProfileStatsGet(deps);
    await rm(gone);

    const opensBefore = fsPort.opens;
    const after = await handleProfileStatsGet(deps);
    expect(fsPort.opens).toBe(opensBefore);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.view.lifetimeTokens).toBe(10);
    expect(after.view.totalSessions).toBe(1);
  });

  it("T-concurrent: two overlapping scans share one pass (a single readdir, one result)", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedTelemetryDir(telemetryDir);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort);

    const [a, b] = await Promise.all([handleProfileStatsGet(deps), handleProfileStatsGet(deps)]);
    expect(fsPort.readdirCountFor(telemetryDir)).toBe(1);
    expect(a).toEqual(b);
    expect(a.ok && a.view.lifetimeTokens).toBe(150);
  });
});

describe("profile stats cache — budgets, holes and oversized files (D-2)", () => {
  it("T-catchup: a one-open budget eats the backlog newest-first across three passes", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "n1.jsonl", usage("n1", DAY1 + 3000, 1), MTIME_BASE + 30);
    await seedAt(telemetryDir, "n2.jsonl", usage("n2", DAY1 + 2000, 2), MTIME_BASE + 20);
    await seedAt(telemetryDir, "n3.jsonl", usage("n3", DAY1 + 1000, 4), MTIME_BASE + 10);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort, { budgets: { maxNewReadsPerPass: 1 } });

    const p1 = await handleProfileStatsGet(deps);
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    expect(p1.view.lifetimeTokens).toBe(1);
    expect(p1.view.truncated).toBe(true);
    expect(p1.view.backlogRemaining).toBe(2);
    expect(p1.view.coverageStartTs).toBe(DAY1 + 3000);

    const p2 = await handleProfileStatsGet(deps);
    expect(p2.ok && p2.view.lifetimeTokens).toBe(3);
    expect(p2.ok && p2.view.backlogRemaining).toBe(1);
    expect(p2.ok && p2.view.truncated).toBe(true);

    const p3 = await handleProfileStatsGet(deps);
    expect(p3.ok).toBe(true);
    if (!p3.ok) return;
    expect(p3.view.lifetimeTokens).toBe(7);
    expect(p3.view.truncated).toBe(false);
    expect(p3.view.backlogRemaining).toBe(0);
    expect(p3.view.coverageStartTs).toBeNull();
    expect(fsPort.opens).toBe(3);
  });

  it("T-hole: cached partials older than an unread gap are excluded, then return when it closes", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "o1.jsonl", usage("o1", DAY1, 4), MTIME_BASE);
    await seedAt(telemetryDir, "o2.jsonl", usage("o2", DAY1 + 100, 8), MTIME_BASE + 1);
    const fsPort = new CountingProfileFs();
    const warm = cacheDeps(home, fsPort);
    expect((await handleProfileStatsGet(warm)).ok).toBe(true);

    // Three newer files arrive; the pass budget admits only the newest, so
    // n2/n1 form an unread GAP between it and the warm cache behind them.
    await seedAt(telemetryDir, "n1.jsonl", usage("n1", DAY1 + 1000, 1), MTIME_BASE + 10);
    await seedAt(telemetryDir, "n2.jsonl", usage("n2", DAY1 + 2000, 2), MTIME_BASE + 11);
    await seedAt(telemetryDir, "n3.jsonl", usage("n3", DAY1 + 3000, 16), MTIME_BASE + 12);
    const tight = cacheDeps(home, fsPort, { budgets: { maxNewReadsPerPass: 1 } });

    const holed = await handleProfileStatsGet(tight);
    expect(holed.ok).toBe(true);
    if (!holed.ok) return;
    expect(holed.view.lifetimeTokens).toBe(16);
    expect(holed.view.truncated).toBe(true);
    expect(holed.view.backlogRemaining).toBe(2);
    expect(holed.view.coverageStartTs).toBe(DAY1 + 3000);

    expect((await handleProfileStatsGet(tight)).ok).toBe(true); // n2 read
    const closed = await handleProfileStatsGet(tight); // n1 read — gap gone
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.view.lifetimeTokens).toBe(31);
    expect(closed.view.truncated).toBe(false);
    expect(closed.view.backlogRemaining).toBe(0);
  });

  it("T-hole-restart: a fresh store answers from disk with the SAME cut, without scanning", async () => {
    const { home, telemetryDir, cachePath } = await cacheHome();
    await seedAt(telemetryDir, "o1.jsonl", usage("o1", DAY1, 4), MTIME_BASE);
    const fsPort = new CountingProfileFs();
    expect((await handleProfileStatsGet(cacheDeps(home, fsPort))).ok).toBe(true);
    await seedAt(telemetryDir, "n1.jsonl", usage("n1", DAY1 + 1000, 1), MTIME_BASE + 10);
    await seedAt(telemetryDir, "n2.jsonl", usage("n2", DAY1 + 2000, 16), MTIME_BASE + 11);
    const holed = await handleProfileStatsGet(cacheDeps(home, fsPort, { budgets: { maxNewReadsPerPass: 1 } }));
    expect(holed.ok && holed.view.lifetimeTokens).toBe(16);

    // Application restart: brand-new store over the same cache file.
    const restarted = new CountingProfileFs();
    const store = createProfileStatsCacheStore(restarted, cachePath);
    const cached = await handleProfileStatsCached(cacheDeps(home, restarted, { cache: store }));
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    // The sleeping partial behind the gap must NOT resurface just because the
    // scan is gone — that is what the persisted `active` stamp is for.
    expect(cached.view.lifetimeTokens).toBe(16);
    expect(cached.view.truncated).toBe(true);
    expect(cached.view.backlogRemaining).toBe(1);
    expect(restarted.readdirCountFor(telemetryDir)).toBe(0);
    expect(restarted.opens).toBe(0);
  });

  it("T-oversized: a file over the per-file ceiling is never opened and cuts the history", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "n1.jsonl", usage("n1", DAY1 + 2000, 1), MTIME_BASE + 20);
    await seedAt(telemetryDir, "n2.jsonl", usage("n2", DAY1 + 1000, 2), MTIME_BASE + 10);
    const big = await seedOversized(telemetryDir, "big.jsonl", usage("big", DAY1, 999), MTIME_BASE);
    const fsPort = new CountingProfileFs();

    const result = await handleProfileStatsGet(cacheDeps(home, fsPort, { budgets: { maxFileBytes: 1024 } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.lifetimeTokens).toBe(3);
    expect(result.view.truncated).toBe(true);
    // The oversized file is a PERMANENT cut, not a backlog item: promising
    // "Refresh continues" here would be a forever-lie.
    expect(result.view.backlogRemaining).toBe(0);
    expect(fsPort.openedPaths).not.toContain(big);
  });

  it("T-oversized-suffix: the scan stops at the oversized file and resumes once it is gone", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "new.jsonl", usage("new", DAY1 + 2000, 1), MTIME_BASE + 20);
    const big = await seedOversized(telemetryDir, "big.jsonl", usage("big", DAY1 + 1000, 999), MTIME_BASE + 10);
    const old = await seedAt(telemetryDir, "old.jsonl", usage("old", DAY1, 4), MTIME_BASE);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort, { budgets: { maxFileBytes: 1024 } });

    const cut = await handleProfileStatsGet(deps);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.view.lifetimeTokens).toBe(1);
    expect(cut.view.truncated).toBe(true);
    expect(cut.view.backlogRemaining).toBe(0);
    expect(fsPort.openedPaths).not.toContain(old);
    expect(fsPort.openedPaths).not.toContain(big);

    await rm(big);
    const healed = await handleProfileStatsGet(deps);
    expect(healed.ok).toBe(true);
    if (!healed.ok) return;
    expect(healed.view.lifetimeTokens).toBe(5);
    expect(healed.view.truncated).toBe(false);
    expect(healed.view.backlogRemaining).toBe(0);
    expect(fsPort.openedPaths).toContain(old);
  });
});

describe("profile stats cache — fingerprint and coherent reads (D-6)", () => {
  it("T-fingerprint: a same-size rewrite with a restored mtime is still re-read (ctime catches it)", async () => {
    const { home, telemetryDir } = await cacheHome();
    const path = await seedAt(telemetryDir, "a.jsonl", usage("a", DAY1, 100), MTIME_BASE);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort);
    expect((await handleProfileStatsGet(deps)).ok).toBe(true);

    const rewritten = jsonl(usage("a", DAY1, 111));
    expect(rewritten.length).toBe((await readFile(path, "utf-8")).length);
    await writeFile(path, rewritten, "utf-8");
    await utimes(path, MTIME_BASE, MTIME_BASE); // size AND mtime identical again

    const opensBefore = fsPort.opens;
    const after = await handleProfileStatsGet(deps);
    expect(fsPort.opens).toBe(opensBefore + 1);
    expect(after.ok && after.view.lifetimeTokens).toBe(111);
  });

  it("T-fingerprint: a rotation that swaps the inode behind an identical name is re-read", async () => {
    const { home, telemetryDir } = await cacheHome();
    const path = await seedAt(telemetryDir, "a.jsonl", usage("a", DAY1, 100), MTIME_BASE);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort);
    expect((await handleProfileStatsGet(deps)).ok).toBe(true);
    const inoBefore = (await stat(path)).ino;

    const replacement = join(telemetryDir, "..", "replacement.jsonl");
    await writeFile(replacement, jsonl(usage("a", DAY1, 100)), "utf-8");
    await rename(replacement, path);
    await utimes(path, MTIME_BASE, MTIME_BASE);
    expect((await stat(path)).ino).not.toBe(inoBefore);

    const opensBefore = fsPort.opens;
    await handleProfileStatsGet(deps);
    expect(fsPort.opens).toBe(opensBefore + 1);
  });

  it("T-fingerprint: a file that GROWS during the read is cached against the pre-read snapshot", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "a.jsonl", usage("a", DAY1, 10), MTIME_BASE);
    // Simulates a legitimate append landing between fstat1 and fstat2: same
    // inode, same ctime rules, only bigger — no re-read, no retry.
    class GrowingFs extends CountingProfileFs {
      override async readFileSnapshot(path: string): Promise<ProfileFileSnapshot> {
        const snap = await super.readFileSnapshot(path);
        return { ...snap, after: { ...snap.after, size: snap.after.size + 10 } };
      }
    }
    const fsPort = new GrowingFs();
    const deps = cacheDeps(home, fsPort);

    const result = await handleProfileStatsGet(deps);
    expect(result.ok && result.view.lifetimeTokens).toBe(10);
    expect(fsPort.opens).toBe(1); // exactly one attempt — growth is not a mismatch
    const opensBefore = fsPort.opens;
    expect((await handleProfileStatsGet(deps)).ok).toBe(true);
    expect(fsPort.opens).toBe(opensBefore); // cached under fstat1, so it is a hit
  });

  it("T-reread-mismatch: a same-size ctime change retries, and an unstable file is skipped", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "a.jsonl", usage("a", DAY1, 10), MTIME_BASE);
    class UnstableFs extends CountingProfileFs {
      failuresLeft = Number.POSITIVE_INFINITY;
      override async readFileSnapshot(path: string): Promise<ProfileFileSnapshot> {
        const snap = await super.readFileSnapshot(path);
        if (this.failuresLeft <= 0) return snap;
        this.failuresLeft -= 1;
        return { ...snap, after: { ...snap.after, ctimeMs: snap.after.ctimeMs + 1 } };
      }
    }

    const never = new UnstableFs();
    const skipped = await handleProfileStatsGet(cacheDeps(home, never));
    expect(skipped.ok).toBe(true);
    if (!skipped.ok) return;
    expect(never.opens).toBe(3); // one attempt + two retries, then give up
    expect(skipped.view.lifetimeTokens).toBe(0);
    expect(skipped.view.truncated).toBe(true);
    expect(skipped.view.backlogRemaining).toBe(1);

    const flaky = new UnstableFs();
    flaky.failuresLeft = 1;
    const recovered = await handleProfileStatsGet(cacheDeps(home, flaky, { cache: createProfileStatsCacheStore(flaky, profileStatsCachePath(home)) }));
    expect(flaky.opens).toBe(2);
    expect(recovered.ok && recovered.view.lifetimeTokens).toBe(10);
  });

  it("T-readfail-cached: a changed file that fails to read drops its stale partial and cuts coverage", async () => {
    const { home, telemetryDir } = await cacheHome();
    const bad = await seedAt(telemetryDir, "bad.jsonl", usage("bad", DAY1 + 1000, 10), MTIME_BASE + 10);
    await seedAt(telemetryDir, "old.jsonl", usage("old", DAY1, 4), MTIME_BASE);
    class FailingFs extends CountingProfileFs {
      failFor: string | null = null;
      override async readFileSnapshot(path: string): Promise<ProfileFileSnapshot> {
        if (path === this.failFor) {
          this.opens += 1;
          throw new Error("EPERM (simulated)");
        }
        return super.readFileSnapshot(path);
      }
    }
    const fsPort = new FailingFs();
    const deps = cacheDeps(home, fsPort);
    const warm = await handleProfileStatsGet(deps);
    expect(warm.ok && warm.view.lifetimeTokens).toBe(14);

    await writeFile(bad, jsonl(usage("bad", DAY1 + 1000, 99)), "utf-8");
    await utimes(bad, MTIME_BASE + 20, MTIME_BASE + 20);
    fsPort.failFor = bad;

    const after = await handleProfileStatsGet(deps);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // Neither the stale 10 nor the unread 99 may be shown, and everything
    // older than the hole is cut too — truthfulness over completeness.
    expect(after.view.lifetimeTokens).toBe(0);
    expect(after.view.truncated).toBe(true);
    expect(after.view.backlogRemaining).toBe(1);
    expect(after.view.coverageStartTs).toBeNull();
  });
});

describe("profile stats cache — cumulative exact cross-file activity (S2 blocker 1)", () => {
  // Session "s" split across files with OVERLAPPING segments: the merge's
  // first-pass bridge formula and the union-sort truth disagree, and only the
  // exact second pass can tell them apart.
  const OVERLAP_A = [
    { v: 1, ts: DAY1, session: "s", t: "usage", totalTokens: 1 },
    { v: 1, ts: DAY1 + 10, session: "s", t: "usage", totalTokens: 1 },
  ];
  const OVERLAP_B = [
    { v: 1, ts: DAY1 + 5, session: "s", t: "usage", totalTokens: 1 },
    { v: 1, ts: DAY1 + 15, session: "s", t: "usage", totalTokens: 1 },
  ];

  it("T-exact-cache: exact on the cold pass, cached (zero opens) on the warm one", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "a.jsonl", OVERLAP_A, MTIME_BASE + 1);
    const bPath = await seedAt(telemetryDir, "b.jsonl", OVERLAP_B, MTIME_BASE + 2);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort);

    // Union-sort of 0,5,10,15 is 15; the bridge formula would say 20.
    const cold = await handleProfileStatsGet(deps);
    expect(cold.ok).toBe(true);
    if (!cold.ok) return;
    expect(cold.view.longestSessionMs).toBe(15);
    expect(cold.view.pendingExactSessions).toBe(0);

    const opensAfterCold = fsPort.opens;
    const warmed = await handleProfileStatsGet(deps);
    expect(fsPort.opens).toBe(opensAfterCold);
    expect(warmed.ok && warmed.view.longestSessionMs).toBe(15);

    // Touching one participant invalidates only ITS folded contribution.
    await writeFile(bPath, jsonl([...OVERLAP_B, { v: 1, ts: DAY1 + 20, session: "s", t: "usage", totalTokens: 1 }]), "utf-8");
    await utimes(bPath, MTIME_BASE + 9, MTIME_BASE + 9);
    const changed = await handleProfileStatsGet(deps);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.view.longestSessionMs).toBe(20); // union 0,5,10,15,20
    expect(changed.view.pendingExactSessions).toBe(0);
    // TWO opens, not one: b is re-read as a partial, and because cluster
    // merging is irreversible, a participant that CHANGED after being folded
    // in resets the session's clusters — so a is folded in again too.
    expect(fsPort.opens).toBe(opensAfterCold + 2);
  });

  it(
    "T-exact-cumulative: a session with more participants than ONE pass can open still converges, " +
      "because every pass persists the participants it managed to fold in",
    async () => {
      const { home, telemetryDir } = await cacheHome();
      // Four overlapping segments of one session, newest file last-written.
      await seedAt(telemetryDir, "a.jsonl", [
        { v: 1, ts: DAY1, session: "s", t: "usage", totalTokens: 1 },
        { v: 1, ts: DAY1 + 10, session: "s", t: "usage", totalTokens: 1 },
      ], MTIME_BASE + 1);
      await seedAt(telemetryDir, "b.jsonl", [
        { v: 1, ts: DAY1 + 5, session: "s", t: "usage", totalTokens: 1 },
        { v: 1, ts: DAY1 + 15, session: "s", t: "usage", totalTokens: 1 },
      ], MTIME_BASE + 2);
      await seedAt(telemetryDir, "c.jsonl", [
        { v: 1, ts: DAY1 + 12, session: "s", t: "usage", totalTokens: 1 },
        { v: 1, ts: DAY1 + 25, session: "s", t: "usage", totalTokens: 1 },
      ], MTIME_BASE + 3);
      await seedAt(telemetryDir, "d.jsonl", [
        { v: 1, ts: DAY1 + 20, session: "s", t: "usage", totalTokens: 1 },
        { v: 1, ts: DAY1 + 30, session: "s", t: "usage", totalTokens: 1 },
      ], MTIME_BASE + 4);

      const fsPort = new CountingProfileFs();
      const deps = cacheDeps(home, fsPort, { budgets: { maxNewReadsPerPass: 1 } });

      // Passes 1-4 spend their single open on the file partials themselves;
      // the exact pass can only fold in what is already in memory.
      const p1 = await handleProfileStatsGet(deps);
      expect(p1.ok && p1.view.longestSessionMs).toBe(10); // d alone
      const p2 = await handleProfileStatsGet(deps);
      expect(p2.ok && p2.view.pendingExactSessions).toBe(1);
      const p3 = await handleProfileStatsGet(deps);
      expect(p3.ok && p3.view.pendingExactSessions).toBe(1);
      const p4 = await handleProfileStatsGet(deps);
      expect(p4.ok).toBe(true);
      if (!p4.ok) return;
      expect(p4.view.truncated).toBe(false);
      expect(p4.view.totalSessions).toBe(4); // totalSessions counts FILES
      expect(p4.view.pendingExactSessions).toBe(1);
      expect(p4.view.longestSessionMs).toBe(43); // provisional bridge formula

      // Pass 5 has no partial to read, so its one open goes to the LAST
      // missing participant — and the three folded in earlier are still
      // there. A restart-from-scratch exact pass would need four opens in
      // this pass alone and could never finish under this budget.
      const p5 = await handleProfileStatsGet(deps);
      expect(p5.ok).toBe(true);
      if (!p5.ok) return;
      expect(p5.view.longestSessionMs).toBe(30); // union-sort truth
      expect(p5.view.pendingExactSessions).toBe(0);
      expect(fsPort.opens).toBe(5); // 4 partial reads + exactly 1 exact-pass read
    },
  );
});

describe("profile stats cache — a live sink must not blank the view (S5 regression)", () => {
  it(
    "T-livesink-blank: a file that GROWS between the directory lstat and its own read stays INCLUDED, " +
      "so a successful pass cannot zero a view the previous pass filled",
    async () => {
      const { home, telemetryDir } = await cacheHome();
      await seedAt(telemetryDir, "old.jsonl", usage("old", DAY1, 4), MTIME_BASE);
      const live = join(telemetryDir, "live.jsonl");
      await seedAt(telemetryDir, "live.jsonl", usage("live", DAY1 + 1000, 10), MTIME_BASE + 10);

      /**
       * Reproduces the production timing exactly: a pass lstats every entry
       * first (~1 s over the owner's 60 787 files) and only then opens them,
       * so the session file the running app is appending to grows in between.
       * The append here lands after this pass's own lstat of that file and
       * before its open, which is what makes the pre-read `fstat` report a
       * bigger size than the directory listing did.
       */
      class GrowsBetweenListAndReadFs extends CountingProfileFs {
        armFor: string | null = null;
        override async readFileSnapshot(path: string): Promise<ProfileFileSnapshot> {
          if (path === this.armFor) {
            this.armFor = null;
            await appendFile(path, jsonl(usage("live", DAY1 + 2000, 7)), "utf-8");
          }
          return super.readFileSnapshot(path);
        }
      }
      const fsPort = new GrowsBetweenListAndReadFs();
      const deps = cacheDeps(home, fsPort);

      const first = await handleProfileStatsGet(deps);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.view.lifetimeTokens).toBe(14);

      // The sink also wrote between the two passes, so the file is due for a
      // re-read anyway — and grows once more while that read is in flight.
      await appendFile(live, jsonl(usage("live", DAY1 + 1500, 5)), "utf-8");
      fsPort.armFor = live;

      const second = await handleProfileStatsGet(deps);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      // The pass holds a complete, coherent snapshot of every file. A
      // snapshot one append newer than the pass's own lstat is not a hole,
      // and treating it as one cuts EVERY older file out of the view — a
      // successful, fully empty answer landing on top of a filled screen.
      expect(second.view.lifetimeTokens).toBe(26);
      expect(second.view.truncated).toBe(false);
      expect(second.view.backlogRemaining).toBe(0);

      // The same verdict is what gets persisted, so the cached channel cannot
      // serve the blank after a restart either.
      const cached = await handleProfileStatsCached(deps);
      expect(cached.ok && cached.view.lifetimeTokens).toBe(26);
    },
  );

  it(
    "T-vanished-newest: the newest file disappearing between the listing and its read removes ONE file " +
      "from the view, it does not blank the ones behind it",
    async () => {
      const { home, telemetryDir } = await cacheHome();
      await seedAt(telemetryDir, "keep.jsonl", usage("keep", DAY1, 4), MTIME_BASE);
      const doomed = join(telemetryDir, "doomed.jsonl");
      await seedAt(telemetryDir, "doomed.jsonl", usage("doomed", DAY1 + 1000, 10), MTIME_BASE + 10);

      class VanishesBeforeReadFs extends CountingProfileFs {
        armFor: string | null = null;
        override async readFileSnapshot(path: string): Promise<ProfileFileSnapshot> {
          if (path === this.armFor) {
            this.armFor = null;
            await rm(path);
          }
          return super.readFileSnapshot(path);
        }
      }
      const fsPort = new VanishesBeforeReadFs();
      fsPort.armFor = doomed;

      const result = await handleProfileStatsGet(cacheDeps(home, fsPort));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // A file that no longer exists is one file fewer, not a gap waiting to
      // be filled — so the older file behind it stays on screen and nothing
      // claims to be catching up.
      expect(result.view.lifetimeTokens).toBe(4);
      expect(result.view.truncated).toBe(false);
      expect(result.view.backlogRemaining).toBe(0);
      expect(result.view.coverageStartTs).toBeNull();
    },
  );

  it(
    "T-livesink-cached-subset: a mid-list file that grows during its own read cannot evict its " +
      "siblings from the cached view",
    async () => {
      const { home, telemetryDir, cachePath } = await cacheHome();
      // x is the NEWEST by the directory listing; g is older and therefore
      // the last file of the prefix — the one a boundary-key scheme would
      // have used as its cutoff.
      await seedAt(telemetryDir, "x.jsonl", usage("x", DAY1 + 2000, 4), MTIME_BASE + 20);
      const g = join(telemetryDir, "g.jsonl");
      await seedAt(telemetryDir, "g.jsonl", usage("g", DAY1 + 1000, 10), MTIME_BASE + 10);

      class GrowsDuringReadFs extends CountingProfileFs {
        armFor: string | null = null;
        override async readFileSnapshot(path: string): Promise<ProfileFileSnapshot> {
          if (path === this.armFor) {
            this.armFor = null;
            await appendFile(path, jsonl(usage("g", DAY1 + 1500, 7)), "utf-8");
          }
          return super.readFileSnapshot(path);
        }
      }
      const fsPort = new GrowsDuringReadFs();
      fsPort.armFor = g;
      const deps = cacheDeps(home, fsPort);

      const scanned = await handleProfileStatsGet(deps);
      expect(scanned.ok).toBe(true);
      if (!scanned.ok) return;
      expect(scanned.view.lifetimeTokens).toBe(21);
      expect(scanned.view.truncated).toBe(false);

      // g's stored mtime now runs AHEAD of x's even though the scan ordered x
      // first, so any membership rule that compares one file's recorded mtime
      // against another's would drop x here.
      const cached = await handleProfileStatsCached(deps);
      expect(cached.ok).toBe(true);
      if (!cached.ok) return;
      expect(cached.view.lifetimeTokens).toBe(21);

      const restarted = new CountingProfileFs();
      const afterRestart = await handleProfileStatsCached(
        cacheDeps(home, restarted, { cache: createProfileStatsCacheStore(restarted, cachePath) }),
      );
      expect(afterRestart.ok && afterRestart.view.lifetimeTokens).toBe(21);
      expect(restarted.readdirCountFor(telemetryDir)).toBe(0);
    },
  );
});

describe("profile stats cache — byte budget (D-2 secondary guard)", () => {
  it("a byte budget smaller than a single file still advances one file per pass", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "n1.jsonl", usage("n1", DAY1 + 3000, 1), MTIME_BASE + 30);
    await seedAt(telemetryDir, "n2.jsonl", usage("n2", DAY1 + 2000, 2), MTIME_BASE + 20);
    await seedAt(telemetryDir, "n3.jsonl", usage("n3", DAY1 + 1000, 4), MTIME_BASE + 10);
    const fsPort = new CountingProfileFs();
    // One byte of budget: the first file of every pass is admitted anyway, so
    // the backlog drains instead of wedging forever.
    const deps = cacheDeps(home, fsPort, { budgets: { maxScanBytes: 1 } });

    const p1 = await handleProfileStatsGet(deps);
    expect(p1.ok && p1.view.backlogRemaining).toBe(2);
    const p2 = await handleProfileStatsGet(deps);
    expect(p2.ok && p2.view.backlogRemaining).toBe(1);
    const p3 = await handleProfileStatsGet(deps);
    expect(p3.ok).toBe(true);
    if (!p3.ok) return;
    expect(p3.view.backlogRemaining).toBe(0);
    expect(p3.view.lifetimeTokens).toBe(7);
    expect(fsPort.opens).toBe(3);
  });

  it("the exact pass spends the BYTE budget too, and finishes on the next pass", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "a.jsonl", [
      { v: 1, ts: DAY1, session: "s", t: "usage", totalTokens: 1 },
      { v: 1, ts: DAY1 + 10, session: "s", t: "usage", totalTokens: 1 },
    ], MTIME_BASE + 1);
    const bPath = await seedAt(telemetryDir, "b.jsonl", [
      { v: 1, ts: DAY1 + 5, session: "s", t: "usage", totalTokens: 1 },
      { v: 1, ts: DAY1 + 15, session: "s", t: "usage", totalTokens: 1 },
    ], MTIME_BASE + 2);
    const fsPort = new CountingProfileFs();
    expect((await handleProfileStatsGet(cacheDeps(home, fsPort))).ok).toBe(true);

    // Touch b: its partial must be re-read, and because it had already been
    // folded into the session's clusters, the exact work restarts for BOTH.
    await utimes(bPath, MTIME_BASE + 7, MTIME_BASE + 7);
    const bSize = (await stat(bPath)).size;
    // Exactly enough bytes for b's own re-read and not one more, so the exact
    // pass's read of a is refused on BYTES (the open budget is untouched).
    const tight = cacheDeps(home, fsPort, { budgets: { maxScanBytes: bSize } });

    const deferred = await handleProfileStatsGet(tight);
    expect(deferred.ok).toBe(true);
    if (!deferred.ok) return;
    expect(deferred.view.pendingExactSessions).toBe(1);
    expect(deferred.view.longestSessionMs).toBe(20); // provisional bridge formula

    const finished = await handleProfileStatsGet(tight);
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(finished.view.pendingExactSessions).toBe(0);
    expect(finished.view.longestSessionMs).toBe(15);
  });
});

describe("profile stats cache — cache-file custody (D-1/D-6)", () => {
  it("T-no-cache: the cached channel refuses honestly before any scan has run", async () => {
    const { home } = await cacheHome();
    const fsPort = new CountingProfileFs();
    const result = await handleProfileStatsCached(cacheDeps(home, fsPort));
    expect(result).toEqual({ ok: false, reason: "no_cache" });
  });

  it("T-restart: a fresh store answers the cached channel from disk without scanning", async () => {
    const { home, telemetryDir, cachePath } = await cacheHome();
    await seedTelemetryDir(telemetryDir);
    const warmFs = new CountingProfileFs();
    const fresh = await handleProfileStatsGet(cacheDeps(home, warmFs));
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;

    const restarted = new CountingProfileFs();
    const cached = await handleProfileStatsCached(
      cacheDeps(home, restarted, { cache: createProfileStatsCacheStore(restarted, cachePath) }),
    );
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    expect(cached.view).toEqual(fresh.view);
    expect(restarted.readdirCountFor(telemetryDir)).toBe(0);
    expect(restarted.opens).toBe(0);
  });

  it("T-cache-delete: deleting the cache file is a real reset even with a live in-memory store", async () => {
    const { home, telemetryDir, cachePath } = await cacheHome();
    await seedTelemetryDir(telemetryDir);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort);
    expect((await handleProfileStatsGet(deps)).ok).toBe(true);
    expect(fsPort.opens).toBe(2);

    await rm(cachePath);

    expect(await handleProfileStatsCached(deps)).toEqual({ ok: false, reason: "no_cache" });
    const rebuilt = await handleProfileStatsGet(deps);
    expect(rebuilt.ok && rebuilt.view.lifetimeTokens).toBe(150);
    expect(fsPort.opens).toBe(4); // every file re-read: the reset was real
  });

  it("T-cache-external: a foreign valid revision on disk is adopted and continued incrementally", async () => {
    const { home, telemetryDir, cachePath } = await cacheHome();
    await seedAt(telemetryDir, "a.jsonl", usage("a", DAY1, 10), MTIME_BASE);
    await seedAt(telemetryDir, "b.jsonl", usage("b", DAY1 + 100, 5), MTIME_BASE + 1);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort);
    expect((await handleProfileStatsGet(deps)).ok).toBe(true);
    expect(fsPort.opens).toBe(2);

    // Another process wrote its own version: same schema, different revision,
    // one file it had not yet aggregated.
    const disk = JSON.parse(await readFile(cachePath, "utf-8")) as Record<string, unknown>;
    disk.rev = "foreign-revision";
    delete (disk.files as Record<string, unknown>)["b.jsonl"];
    await writeFile(cachePath, JSON.stringify(disk), "utf-8");

    const after = await handleProfileStatsGet(deps);
    expect(after.ok && after.view.lifetimeTokens).toBe(15);
    // Exactly ONE new open: the store adopted the disk version (which lacked
    // b) instead of trusting its own memory, and re-read only what was missing.
    expect(fsPort.opens).toBe(3);
  });

  it("T-rebuild: a rebuild is a budget-cut pass from empty, not a whole-directory stall", async () => {
    const { home, telemetryDir, cachePath } = await cacheHome();
    await seedAt(telemetryDir, "n1.jsonl", usage("n1", DAY1 + 3000, 1), MTIME_BASE + 30);
    await seedAt(telemetryDir, "n2.jsonl", usage("n2", DAY1 + 2000, 2), MTIME_BASE + 20);
    await seedAt(telemetryDir, "n3.jsonl", usage("n3", DAY1 + 1000, 4), MTIME_BASE + 10);
    const fsPort = new CountingProfileFs();
    const warm = cacheDeps(home, fsPort);
    const before = await handleProfileStatsGet(warm);
    expect(before.ok && before.view.lifetimeTokens).toBe(7);
    expect(fsPort.opens).toBe(3);

    const tight = cacheDeps(home, fsPort, { budgets: { maxNewReadsPerPass: 1 } });
    const rebuilt = await handleProfileStatsRebuild(tight);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    // From empty, under the same one-open budget: the newest file only, an
    // honest backlog, and NOT a 3-file stall.
    expect(fsPort.opens).toBe(4);
    expect(rebuilt.view.lifetimeTokens).toBe(1);
    expect(rebuilt.view.truncated).toBe(true);
    expect(rebuilt.view.backlogRemaining).toBe(2);
    expect(await exists(cachePath)).toBe(true);

    await handleProfileStatsGet(tight);
    const caughtUp = await handleProfileStatsGet(tight);
    expect(caughtUp.ok).toBe(true);
    if (!caughtUp.ok) return;
    expect(caughtUp.view.lifetimeTokens).toBe(7);
    expect(caughtUp.view.backlogRemaining).toBe(0);
    expect(caughtUp.view.truncated).toBe(false);
  });

  it("T-rebuild: the cached channel refuses between the reset and the next pass", async () => {
    const { home, telemetryDir, cachePath } = await cacheHome();
    await seedAt(telemetryDir, "a.jsonl", usage("a", DAY1, 10), MTIME_BASE);
    const fsPort = new CountingProfileFs();
    const deps = cacheDeps(home, fsPort);
    expect((await handleProfileStatsGet(deps)).ok).toBe(true);
    expect((await handleProfileStatsCached(deps)).ok).toBe(true);

    const store = createProfileStatsCacheStore(fsPort, cachePath);
    await store.reset();
    expect(await exists(cachePath)).toBe(false);
    expect(await handleProfileStatsCached(cacheDeps(home, fsPort, { cache: store }))).toEqual({
      ok: false,
      reason: "no_cache",
    });
  });

  it("T-tmp-cleanup: orphaned tmp files older than an hour are swept, fresh ones are left alone", async () => {
    const { home, telemetryDir, cachePath } = await cacheHome();
    await seedAt(telemetryDir, "a.jsonl", usage("a", DAY1, 10), MTIME_BASE);
    const staleTmp = `${cachePath}.4242.deadbeef.tmp`;
    const freshTmp = `${cachePath}.4243.cafebabe.tmp`;
    await seed(staleTmp, "{}");
    await seed(freshTmp, "{}");
    const twoHoursAgo = Date.now() / 1000 - 7200;
    await utimes(staleTmp, twoHoursAgo, twoHoursAgo);

    const fsPort = new CountingProfileFs();
    expect((await handleProfileStatsGet(cacheDeps(home, fsPort))).ok).toBe(true);
    expect(await exists(staleTmp)).toBe(false);
    expect(await exists(freshTmp)).toBe(true);
  });

  it("T-atomic: a crash between the tmp write and the rename leaves the previous cache intact", async () => {
    const { home, telemetryDir, cachePath } = await cacheHome();
    await seedAt(telemetryDir, "a.jsonl", usage("a", DAY1, 10), MTIME_BASE);
    const fsPort = new CountingProfileFs();
    expect((await handleProfileStatsGet(cacheDeps(home, fsPort))).ok).toBe(true);
    const good = await readFile(cachePath, "utf-8");

    class CrashingRenameFs extends CountingProfileFs {
      override async rename(): Promise<void> {
        throw new Error("killed before rename (simulated)");
      }
    }
    await seedAt(telemetryDir, "b.jsonl", usage("b", DAY1 + 100, 5), MTIME_BASE + 1);
    const crashing = new CrashingRenameFs();
    const stillOk = await handleProfileStatsGet(
      cacheDeps(home, crashing, { cache: createProfileStatsCacheStore(crashing, cachePath) }),
    );
    expect(stillOk.ok && stillOk.view.lifetimeTokens).toBe(15); // the pass itself still answers
    expect(await readFile(cachePath, "utf-8")).toBe(good); // ...and the old version is untouched

    // The surviving file is still a valid cache: a new store reads it and
    // only has to re-read the one file that never made it in.
    const recovered = new CountingProfileFs();
    const after = await handleProfileStatsGet(
      cacheDeps(home, recovered, { cache: createProfileStatsCacheStore(recovered, cachePath) }),
    );
    expect(after.ok && after.view.lifetimeTokens).toBe(15);
    expect(recovered.opens).toBe(1);
  });
});

describe("profile stats cache — untrusted cache input rebuilds instead of lying", () => {
  const mutations: Array<[string, (cachePath: string) => Promise<void>]> = [
    ["corrupt JSON", async (p) => writeFile(p, "{not json", "utf-8")],
    ["foreign schema", async (p) => patchCacheJson(p, (c) => ({ ...c, schema: 99 }))],
    ["foreign algo", async (p) => patchCacheJson(p, (c) => ({ ...c, algo: 99 }))],
    ["foreign timezone", async (p) => patchCacheJson(p, (c) => ({ ...c, tz: "Antarctica/Troll" }))],
    ["foreign dir", async (p) => patchCacheJson(p, (c) => ({ ...c, dir: "/somewhere/else" }))],
    ["oversized cache file", async (p) => truncate(p, PROFILE_STATS_CACHE_MAX_BYTES + 1)],
    ["bad shape (files is an array)", async (p) => patchCacheJson(p, (c) => ({ ...c, files: [] }))],
    [
      "bad shape (a partial's sessions map is not an array)",
      async (p) =>
        patchCacheJson(p, (c) => {
          const files = c.files as Record<string, Record<string, unknown>>;
          const first = Object.values(files)[0]!;
          (first.p as Record<string, unknown>).s = { nope: true };
          return c;
        }),
    ],
  ];

  for (const [label, mutate] of mutations) {
    it(`rebuilds from scratch on ${label}`, async () => {
      const { home, telemetryDir, cachePath } = await cacheHome();
      await seedTelemetryDir(telemetryDir);
      const fsPort = new CountingProfileFs();
      const deps = cacheDeps(home, fsPort);
      expect((await handleProfileStatsGet(deps)).ok).toBe(true);
      expect(fsPort.opens).toBe(2);

      await mutate(cachePath);

      // A fresh store, so the poisoned file is what the pass actually reads.
      const rebuildFs = new CountingProfileFs();
      const rebuilt = await handleProfileStatsGet(
        cacheDeps(home, rebuildFs, { cache: createProfileStatsCacheStore(rebuildFs, cachePath) }),
      );
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;
      expect(rebuilt.view.lifetimeTokens).toBe(150);
      expect(rebuildFs.opens).toBe(2); // full rebuild, never a partial trust
      expect(await handleProfileStatsCached(cacheDeps(home, rebuildFs))).toBeTruthy();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK.187 S5 — fail-closed cache validator, pinned on the CACHED channel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The family above proves a poisoned cache file does not survive into a FRESH
 * pass. It leaves two things unpinned, and both are where a weakened
 * validator would do its damage silently:
 *
 * 1. THE CACHED CHANNEL. `handleProfileStatsCached` is the instant-first-paint
 *    read — it never scans, so whatever `deserializeState` hands back is
 *    painted verbatim. A validator that accepted a half-decoded record would
 *    put wrong numbers on screen with no pass to correct them. The assertion
 *    is therefore the refusal itself (`no_cache`), taken with a FRESH store so
 *    the file on disk is the only thing it can believe, and with zero
 *    telemetry opens so the refusal is proven to come from the file rather
 *    than from a quiet re-scan.
 * 2. THE WHOLE VIEW. The family above checks `lifetimeTokens` only. Every
 *    number a partially-trusted cache could skew — days, models, tools,
 *    streaks, coverage, backlog — is checked here against an oracle computed
 *    from the same directory with no cache at all.
 *
 * The poisons are chosen for the decode branches nothing else reaches: a
 * `files` record missing a required stat field and a non-numeric one
 * (`decodeFileEntry`'s four-way guard), a malformed `exact` record
 * (`decodeExactEntry`), and a real payload truncated mid-write (the crash
 * shape, as opposed to the never-was-JSON `{not json`).
 */
describe("profile stats cache — a poisoned cache file refuses the cached channel and rebuilds to the oracle (TASK.187 S5)", () => {
  const poisons: Array<[string, (cachePath: string) => Promise<void>]> = [
    [
      "a real payload truncated mid-write",
      async (p) => {
        const raw = await readFile(p, "utf-8");
        await writeFile(p, raw.slice(0, Math.floor(raw.length * 0.6)), "utf-8");
      },
    ],
    [
      "a files record missing its mtime",
      async (p) =>
        patchCacheJson(p, (c) => {
          const first = Object.values(c.files as Record<string, Record<string, unknown>>)[0]!;
          delete first.m;
          return c;
        }),
    ],
    [
      "a files record whose size is not a number",
      async (p) =>
        patchCacheJson(p, (c) => {
          const first = Object.values(c.files as Record<string, Record<string, unknown>>)[0]!;
          first.s = "12";
          return c;
        }),
    ],
    [
      "an exact record whose participant list is not an array",
      async (p) => patchCacheJson(p, (c) => ({ ...c, exact: { "session-a": { p: "nope", k: [], a: null } } })),
    ],
    ["a foreign algo", async (p) => patchCacheJson(p, (c) => ({ ...c, algo: 99 }))],
  ];

  for (const [label, poison] of poisons) {
    it(`refuses no_cache and re-aggregates to the oracle on ${label}`, async () => {
      const { home, telemetryDir, cachePath } = await cacheHome();
      await seedTelemetryDir(telemetryDir);

      // The oracle: the same directory aggregated with no cache in play.
      const oracleFs = new CountingProfileFs();
      const oracle = await handleProfileStatsGet(
        cacheDeps(home, oracleFs, { cache: createProfileStatsCacheStore(oracleFs, join(home, "oracle-cache.json")) }),
      );
      expect(oracle.ok).toBe(true);
      if (!oracle.ok) return;
      expect(oracleFs.opens).toBe(2);

      const warmFs = new CountingProfileFs();
      expect((await handleProfileStatsGet(cacheDeps(home, warmFs))).ok).toBe(true);
      await poison(cachePath);

      const poisonedFs = new CountingProfileFs();
      const deps = cacheDeps(home, poisonedFs, { cache: createProfileStatsCacheStore(poisonedFs, cachePath) });
      expect(await handleProfileStatsCached(deps)).toEqual({ ok: false, reason: "no_cache" });
      // Nothing was read from the telemetry directory to reach that verdict:
      // the refusal is the validator's, not a scan's.
      expect(poisonedFs.opens).toBe(0);

      const rebuilt = await handleProfileStatsGet(deps);
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;
      expect(poisonedFs.opens).toBe(2); // every file re-read, never a partial trust
      expect(rebuilt.view).toEqual(oracle.view);

      // And the repaired file serves the cached channel again — the refusal
      // was the poison's, not a permanent broken state.
      const healed = await handleProfileStatsCached(deps);
      expect(healed).toEqual({ ok: true, view: oracle.view });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK.187 S3 closing review — metadata errors, prototype-named keys, cache
// range validation, and rebuild guarantees
// ═══════════════════════════════════════════════════════════════════════════

describe("profile stats cache — a metadata error is not an absent file", () => {
  it("T-dir-unreadable: a directory that exists but cannot be listed is io_error, not 'no telemetry yet'", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedTelemetryDir(telemetryDir);
    class UnreadableDirFs extends CountingProfileFs {
      // Exactly what a real EACCES looks like through this port: `exists`
      // is an `access()` probe, and an access error is indistinguishable
      // from absence in its boolean answer.
      override async exists(path: string): Promise<boolean> {
        return path === telemetryDir ? false : super.exists(path);
      }
      override async readdir(path: string): Promise<string[]> {
        if (path === telemetryDir) {
          const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
          error.code = "EACCES";
          throw error;
        }
        return super.readdir(path);
      }
    }
    // A directory the user cannot read holds unknown data, not zero data:
    // answering `ok:true` with an empty aggregate would paint zeros over real
    // history and nothing would ever correct them.
    const result = await handleProfileStatsGet(cacheDeps(home, new UnreadableDirFs()));
    expect(result).toEqual({ ok: false, reason: "io_error" });
  });

  it(
    "T-stat-unavailable: a transient lstat failure keeps the file's cached partial and cuts coverage " +
      "honestly instead of silently dropping its numbers",
    async () => {
      const { home, telemetryDir } = await cacheHome();
      await seedAt(telemetryDir, "new.jsonl", usage("new", DAY1 + 1000, 10), MTIME_BASE + 10);
      const old = await seedAt(telemetryDir, "old.jsonl", usage("old", DAY1, 4), MTIME_BASE);
      class FlakyLstatFs extends CountingProfileFs {
        failLstatFor: string | null = null;
        override async lstat(path: string): Promise<ProfileFileStat> {
          if (path === this.failLstatFor) {
            const error: NodeJS.ErrnoException = new Error("EIO: i/o error");
            error.code = "EIO";
            throw error;
          }
          return super.lstat(path);
        }
      }
      const fsPort = new FlakyLstatFs();
      const deps = cacheDeps(home, fsPort);

      const warm = await handleProfileStatsGet(deps);
      expect(warm.ok && warm.view.lifetimeTokens).toBe(14);
      const opensAfterWarm = fsPort.opens;

      fsPort.failLstatFor = old;
      const degraded = await handleProfileStatsGet(deps);
      expect(degraded.ok).toBe(true);
      if (!degraded.ok) return;
      // The file still exists — we just cannot judge it right now. Dropping
      // its 4 tokens while reporting full coverage would be a silent lie.
      expect(degraded.view.lifetimeTokens).toBe(10);
      expect(degraded.view.truncated).toBe(true);
      expect(degraded.view.backlogRemaining).toBe(1);
      expect(fsPort.opens).toBe(opensAfterWarm);

      fsPort.failLstatFor = null;
      const healed = await handleProfileStatsGet(deps);
      expect(healed.ok).toBe(true);
      if (!healed.ok) return;
      expect(healed.view.lifetimeTokens).toBe(14);
      expect(healed.view.truncated).toBe(false);
      // Zero re-reads: the partial was PRESERVED across the outage, not
      // discarded the way a genuinely vanished file's partial is.
      expect(fsPort.opens).toBe(opensAfterWarm);
    },
  );

  it(
    "T-stat-unavailable-unknown: a file we have never cached and cannot stat is assumed newest, " +
      "so it cuts coverage instead of hiding behind data it may postdate",
    async () => {
      const { home, telemetryDir } = await cacheHome();
      await seedAt(telemetryDir, "old.jsonl", usage("old", DAY1, 4), MTIME_BASE);
      const fresh = join(telemetryDir, "fresh.jsonl");
      class FlakyLstatFs extends CountingProfileFs {
        failLstatFor: string | null = null;
        override async lstat(path: string): Promise<ProfileFileStat> {
          if (path === this.failLstatFor) {
            const error: NodeJS.ErrnoException = new Error("EIO: i/o error");
            error.code = "EIO";
            throw error;
          }
          return super.lstat(path);
        }
      }
      const fsPort = new FlakyLstatFs();
      const deps = cacheDeps(home, fsPort);
      expect((await handleProfileStatsGet(deps)).ok).toBe(true);

      await seedAt(telemetryDir, "fresh.jsonl", usage("fresh", DAY1 + 1000, 10), MTIME_BASE + 10);
      fsPort.failLstatFor = fresh;

      const result = await handleProfileStatsGet(deps);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Nothing is known about where this file sits in time, so the honest
      // answer is "coverage is incomplete", not a number that quietly omits it.
      expect(result.view.lifetimeTokens).toBe(0);
      expect(result.view.truncated).toBe(true);
      expect(result.view.backlogRemaining).toBe(1);
    },
  );
});

describe("profile stats cache — prototype-named keys survive", () => {
  it('T-proto-session: a session called "__proto__" still gets its exact activity', async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "a.jsonl", [
      { v: 1, ts: DAY1, session: "__proto__", t: "usage", totalTokens: 1 },
      { v: 1, ts: DAY1 + 10, session: "__proto__", t: "usage", totalTokens: 1 },
    ], MTIME_BASE + 1);
    await seedAt(telemetryDir, "b.jsonl", [
      { v: 1, ts: DAY1 + 5, session: "__proto__", t: "usage", totalTokens: 1 },
      { v: 1, ts: DAY1 + 15, session: "__proto__", t: "usage", totalTokens: 1 },
    ], MTIME_BASE + 2);

    const result = await handleProfileStatsGet(cacheDeps(home, new CountingProfileFs()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 15 is the union-sort truth; 20 is the provisional bridge formula. An
    // exact value that cannot be written into its own result table would be
    // reported as final while carrying the provisional number.
    expect(result.view.longestSessionMs).toBe(15);
    expect(result.view.pendingExactSessions).toBe(0);
  });

  it('T-proto-tool: a tool called "__proto__" survives the cache round trip', async () => {
    const { home, telemetryDir, cachePath } = await cacheHome();
    await seedAt(
      telemetryDir,
      "a.jsonl",
      [{ v: 1, ts: DAY1, session: "a", t: "tool", tool: "__proto__", status: "ok", durationMs: 3 }],
      MTIME_BASE,
    );
    const fsPort = new CountingProfileFs();
    const fresh = await handleProfileStatsGet(cacheDeps(home, fsPort));
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    const freshTools = Object.values(fresh.view.days).flatMap((day) => Object.entries(day.tools));
    expect(freshTools).toEqual([["__proto__", 1]]);

    // Reading the cache back is where a plain-object accumulator eats the key
    // — and the file's fingerprint still matches, so nothing ever re-reads it.
    const restarted = new CountingProfileFs();
    const cached = await handleProfileStatsCached(
      cacheDeps(home, restarted, { cache: createProfileStatsCacheStore(restarted, cachePath) }),
    );
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    const cachedTools = Object.values(cached.view.days).flatMap((day) => Object.entries(day.tools));
    expect(cachedTools).toEqual([["__proto__", 1]]);
  });
});

describe("profile stats cache — an out-of-range cache file is refused, not believed", () => {
  const poisons: Array<[string, (cachePath: string) => Promise<void>]> = [
    [
      "negative day tokens",
      async (p) => patchCacheJson(p, (c) => withFirstDay(c, (day) => ({ ...day, t: -5 }))),
    ],
    [
      "a fractional call counter",
      async (p) => patchCacheJson(p, (c) => withFirstDay(c, (day) => ({ ...day, c: 1.5 }))),
    ],
    [
      "a negative tool counter",
      async (p) => patchCacheJson(p, (c) => withFirstDay(c, (day) => ({ ...day, l: { bash: -1 } }))),
    ],
    [
      "a session whose firstTs is one millisecond after its lastTs",
      // Deliberately inverted by ONE ms and with no recorded activity, so the
      // activity-versus-span rule below still passes and only the ordering
      // rule can catch it. A session whose span runs backwards lands on the
      // wrong day in `days[].sessions` and orders wrongly against every other
      // segment of the same session.
      async (p) => patchCacheJson(p, (c) => withFirstSession(c, (s) => ({ ...s, f: Number(s.l) + 1, a: 0 }))),
    ],
    [
      "a session claiming more activity than its own span",
      async (p) =>
        patchCacheJson(p, (c) => withFirstSession(c, (s) => ({ ...s, a: Number(s.l) - Number(s.f) + 60_000 }))),
    ],
    [
      "a session with negative tokens",
      async (p) => patchCacheJson(p, (c) => withFirstSession(c, (s) => ({ ...s, k: -1 }))),
    ],
  ];

  for (const [label, poison] of poisons) {
    it(`rebuilds from scratch on ${label}`, async () => {
      const { home, telemetryDir, cachePath } = await cacheHome();
      await seedTelemetryDir(telemetryDir);
      const warmFs = new CountingProfileFs();
      expect((await handleProfileStatsGet(cacheDeps(home, warmFs))).ok).toBe(true);
      await poison(cachePath);

      // A cache that survived JSON parsing but carries an impossible number
      // pins wrong statistics forever: every file fingerprint still matches,
      // so no pass would ever recompute it.
      const poisonedFs = new CountingProfileFs();
      const deps = cacheDeps(home, poisonedFs, { cache: createProfileStatsCacheStore(poisonedFs, cachePath) });
      expect(await handleProfileStatsCached(deps)).toEqual({ ok: false, reason: "no_cache" });

      const rebuilt = await handleProfileStatsGet(deps);
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;
      expect(rebuilt.view.lifetimeTokens).toBe(150);
      expect(poisonedFs.opens).toBe(2);
    });
  }
});

describe("profile stats cache — a successful rebuild means the rebuild happened", () => {
  it("T-rebuild-rm-fails: a cache file that cannot be removed refuses the channel", async () => {
    const { home, telemetryDir, cachePath } = await cacheHome();
    await seedTelemetryDir(telemetryDir);
    class UnremovableCacheFs extends CountingProfileFs {
      override async rm(path: string): Promise<void> {
        if (path === cachePath) throw new Error("EPERM: operation not permitted");
        return super.rm(path);
      }
    }
    const fsPort = new UnremovableCacheFs();
    const deps = cacheDeps(home, fsPort, { cache: createProfileStatsCacheStore(fsPort, cachePath) });
    expect((await handleProfileStatsGet(deps)).ok).toBe(true);

    // Answering ok here would claim a rebuild that never started, and the
    // next sync would quietly adopt the very file the user asked to discard.
    expect(await handleProfileStatsRebuild(deps)).toEqual({ ok: false, reason: "io_error" });
    expect(await exists(cachePath)).toBe(true);
  });

  it("T-rebuild-inflight: a pass that began before the reset neither serves nor publishes over it", async () => {
    const { home, telemetryDir } = await cacheHome();
    await seedAt(telemetryDir, "a.jsonl", usage("a", DAY1 + 100, 10), MTIME_BASE + 10);
    await seedAt(telemetryDir, "b.jsonl", usage("b", DAY1, 5), MTIME_BASE);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const enteredRead = new Promise<void>((resolve) => (entered = resolve));
    class GatedFs extends CountingProfileFs {
      gated = false;
      override async readFileSnapshot(path: string): Promise<ProfileFileSnapshot> {
        if (this.gated) {
          entered();
          await gate;
        }
        return super.readFileSnapshot(path);
      }
    }
    const fsPort = new GatedFs();
    const deps = cacheDeps(home, fsPort);
    expect((await handleProfileStatsGet(deps)).ok).toBe(true);
    const opensAfterWarm = fsPort.opens;

    // A pass starts and is provably inside its first read before anything else
    // happens; its world is {a, b}.
    await utimes(join(telemetryDir, "a.jsonl"), MTIME_BASE + 20, MTIME_BASE + 20);
    fsPort.gated = true;
    const inFlight = handleProfileStatsGet(deps);
    await enteredRead;

    // The world moves on, then the cache is discarded and rebuilt from empty.
    fsPort.gated = false;
    await seedAt(telemetryDir, "c.jsonl", usage("c", DAY1 + 200, 100), MTIME_BASE + 30);
    const rebuilt = await handleProfileStatsRebuild(deps);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    // Not the in-flight pass's answer: that one never saw c.
    expect(rebuilt.view.lifetimeTokens).toBe(115);

    release();
    const stale = await inFlight;
    expect(stale.ok && stale.view.lifetimeTokens).toBe(15);

    // ...and finishing last does not let it write its pre-reset world back.
    const after = await handleProfileStatsCached(deps);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.view.lifetimeTokens).toBe(115);
    // warm 2 + the in-flight pass re-reading a + the rebuild reading all three.
    expect(fsPort.opens).toBe(opensAfterWarm + 4);
  });
});

/** Rewrites the first day bucket of the first cached file entry. */
function withFirstDay(
  cache: Record<string, unknown>,
  mutate: (day: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const files = cache.files as Record<string, { p: { d: Record<string, Record<string, unknown>> } }>;
  const partial = Object.values(files)[0]!.p;
  const dayKey = Object.keys(partial.d)[0]!;
  partial.d[dayKey] = mutate(partial.d[dayKey]!);
  return cache;
}

/** Rewrites the first session of the first cached file entry. */
function withFirstSession(
  cache: Record<string, unknown>,
  mutate: (session: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const files = cache.files as Record<string, { p: { s: Record<string, unknown>[] } }>;
  const partial = Object.values(files)[0]!.p;
  partial.s[0] = mutate(partial.s[0]!);
  return cache;
}
