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

import { mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROFILE_STATS_MAX_SCAN_BYTES } from "@anycode/core/telemetry-admin";
import {
  handleProfileRevealDir,
  handleProfileStatsGet,
  handleProfileTelemetrySet,
  NodeProfileFs,
  type ProfileFileStat,
  type ProfileIpcDeps,
} from "./profile-ipc.js";

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
      // coverageStartTs is the oldest INCLUDED file's real mtime — session-a,
      // not the dropped (older still) aaa-huge.jsonl.
      const aStat = await stat(join(telemetryDir, "session-a.jsonl"));
      expect(result.view.coverageStartTs).toBe(aStat.mtimeMs);
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
    await seed(join(home, ".anycode/config.json"), JSON.stringify({ telemetry: { enabled: true } }));

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
