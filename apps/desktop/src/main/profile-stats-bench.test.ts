/**
 * TASK.187 S3 before/after benchmark on a REAL telemetry directory.
 *
 * Opt-in only — without `ANYCODE_BENCH_DIR` the single case is skipped, so
 * the normal gate never touches a 60 000-file directory:
 *
 *   cd apps/desktop && ANYCODE_BENCH_DIR="$HOME/.anycode/telemetry" \
 *     npx vitest run src/main/profile-stats-bench.test.ts
 *
 * PROCEDURE (all of it matters for the numbers to mean anything):
 *  - the app must be CLOSED; a live telemetry sink makes the run
 *    non-deterministic;
 *  - the benchmark directory is READ-ONLY here: the cache file and every tmp
 *    file it writes go to a scratch tmpdir, never next to the owner's data;
 *  - the file list is SNAPSHOTTED once at the start and every step works off
 *    that snapshot.
 *
 * It prints, per the plan's §3 "S3 bench" checklist:
 *  (a) baseline — the pre-S3 path (list + read everything + aggregate);
 *  (b) cold incremental build to full coverage; the NUMBER OF PASSES is
 *      printed, never predicted;
 *  (c) warm pass — the repeat cost the slice exists to remove;
 *  (d) cached channel — merge only, no directory scan at all;
 *  (e) DIFFERENTIAL: on every pass, the merged prefix must equal
 *      `aggregateProfileStats(exactly those files, byteBudget: Infinity)`;
 *  (f) cache file size, its `JSON.parse` time, and peak heap.
 */

import { appendFileSync } from "node:fs";
import { lstat, mkdir, readdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateProfileStats,
  PROFILE_STATS_MAX_SCAN_BYTES,
  type ProfileStatsFile,
} from "@anycode/core/telemetry-admin";
import { NodeProfileFs } from "./profile-ipc.js";
import { createProfileStatsCacheStore, resolveScanBudgets } from "./profile-stats-cache.js";

const BENCH_DIR = process.env.ANYCODE_BENCH_DIR ?? "";
/** Optional transcript file — some reporters swallow console output, and a
 *  benchmark whose numbers cannot be read is not a benchmark. */
const BENCH_LOG = process.env.ANYCODE_BENCH_LOG ?? "";
const MAX_PASSES = 40;

function say(line: string): void {
  console.log(line);
  if (BENCH_LOG.length > 0) appendFileSync(BENCH_LOG, `${line}\n`);
}

interface Snapshot {
  name: string;
  fullPath: string;
  size: number;
  mtimeMs: number;
}

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

describe("TASK.187 S3 — Profile stats benchmark (opt-in)", () => {
  it.runIf(BENCH_DIR.length > 0)(
    "measures the pre-S3 path against the incremental cache on a real directory",
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), "profile-bench-"));
      const cachePath = join(scratch, "profile-stats-cache.json");
      const fs = new NodeProfileFs();
      let peakHeap = 0;
      const notePeak = (): void => {
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      };

      try {
        // ── snapshot ───────────────────────────────────────────────────────
        const names = (await readdir(BENCH_DIR)).filter((name) => name.endsWith(".jsonl"));
        const snapshot: Snapshot[] = [];
        let logicalBytes = 0;
        for (const name of names) {
          const fullPath = join(BENCH_DIR, name);
          const st = await lstat(fullPath);
          if (st.isSymbolicLink() || !st.isFile()) continue;
          snapshot.push({ name, fullPath, size: st.size, mtimeMs: st.mtimeMs });
          logicalBytes += st.size;
        }
        snapshot.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        say(
          `[bench] dir=${BENCH_DIR} files=${snapshot.length} logical=${mib(logicalBytes)} ` +
            `(the owner's real sink — read-only here; cache in ${scratch})`,
        );

        /** Reads the named files off the snapshot, for the oracle. */
        const readFiles = async (wanted: Iterable<string>): Promise<ProfileStatsFile[]> => {
          const byName = new Map(snapshot.map((entry) => [entry.name, entry] as const));
          const files: ProfileStatsFile[] = [];
          for (const name of wanted) {
            const entry = byName.get(name);
            if (entry === undefined) continue;
            try {
              files.push({ name, lines: (await fs.readFileNoFollow(entry.fullPath)).split("\n") });
            } catch {
              // Vanished/unreadable since the snapshot: the scan skips it too.
            }
          }
          return files;
        };

        /** Included files whose size/mtime no longer match the snapshot. */
        const changedSinceSnapshot = async (wanted: Iterable<string>): Promise<string[]> => {
          const byName = new Map(snapshot.map((entry) => [entry.name, entry] as const));
          const moved: string[] = [];
          for (const name of wanted) {
            const entry = byName.get(name);
            if (entry === undefined) continue;
            try {
              const st = await lstat(entry.fullPath);
              if (st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) moved.push(name);
            } catch {
              moved.push(name);
            }
          }
          return moved;
        };

        // ── (a) baseline: the pre-S3 path, byte-budget cut, newest-first ───
        const baselineStart = process.hrtime.bigint();
        const baselineFiles: ProfileStatsFile[] = [];
        let baselineBytes = 0;
        let baselineTruncated = false;
        for (const entry of snapshot) {
          if (baselineBytes + entry.size > PROFILE_STATS_MAX_SCAN_BYTES) {
            baselineTruncated = true;
            break;
          }
          try {
            baselineFiles.push({ name: entry.name, lines: (await fs.readFileNoFollow(entry.fullPath)).split("\n") });
          } catch {
            continue;
          }
          baselineBytes += entry.size;
        }
        const baselineStats = aggregateProfileStats(baselineFiles, { now: Date.now() });
        const baselineMs = ms(baselineStart);
        const baselineRead = baselineFiles.length;
        notePeak();
        // Released before the cache phases so the heap figures below are
        // attributable to the cache, not to the baseline's line arrays.
        baselineFiles.length = 0;
        say(
          `[bench] (a) baseline (read-everything): ${baselineMs.toFixed(0)} ms, ` +
            `${baselineRead} files read, truncated=${baselineTruncated || baselineStats.truncated}, ` +
            `lifetimeTokens=${baselineStats.lifetimeTokens}`,
        );

        // ── (b) cold incremental build + (e) per-pass differential ─────────
        const budgets = resolveScanBudgets();
        const store = createProfileStatsCacheStore(fs, cachePath);
        let passes = 0;
        let lastBacklog = Number.POSITIVE_INFINITY;
        // Only the passes themselves — the per-pass differential below is a
        // bench instrument, not part of what the product pays.
        let coldScanMs = 0;
        for (;;) {
          passes += 1;
          const passStart = process.hrtime.bigint();
          const result = await store.scan(BENCH_DIR, budgets, Date.now());
          expect(result.ok).toBe(true);
          if (!result.ok) break;
          const passMs = ms(passStart);
          coldScanMs += passMs;
          notePeak();
          say(
            `[bench] (b) pass ${passes}: ${passMs.toFixed(0)} ms, truncated=${result.truncated}, ` +
              `backlog=${result.backlogRemaining}, pendingExact=${result.pendingExactSessions}, ` +
              `lifetimeTokens=${result.stats.lifetimeTokens}`,
          );

          // (e) the merged prefix must equal the uncapped oracle over EXACTLY
          // the files this pass claims to have aggregated. A LIVE sink (the
          // app running while the bench runs) would give the oracle records
          // the cached partial never saw, so the comparison is declared
          // inconclusive rather than failed when an included file moved.
          const included = store.includedFileNames();
          const moved = await changedSinceSnapshot(included);
          if (moved.length > 0) {
            say(
              `[bench] (e) pass ${passes} differential INCONCLUSIVE — ${moved.length} included file(s) ` +
                `changed under a live sink (e.g. ${moved.slice(0, 3).join(", ")}); close the app for a clean run`,
            );
          } else {
            const oracle = aggregateProfileStats(await readFiles(included), {
              now: Date.now(),
              byteBudget: Number.POSITIVE_INFINITY,
            });
            // `currentStreakDays` is anchored on `now`, which differs by the
            // seconds the pass itself took — never a semantic difference.
            expect({ ...result.stats, currentStreakDays: 0 }).toEqual({ ...oracle, currentStreakDays: 0 });
            say(`[bench] (e) pass ${passes} differential over ${included.length} files: identical`);
          }
          notePeak();

          if (result.backlogRemaining === 0) break;
          if (result.backlogRemaining >= lastBacklog) {
            throw new Error(`no progress: backlog stuck at ${result.backlogRemaining}`);
          }
          lastBacklog = result.backlogRemaining;
          if (passes >= MAX_PASSES) throw new Error(`backlog did not drain in ${MAX_PASSES} passes`);
        }
        say(`[bench] (b) cold build total (scan time only): ${coldScanMs.toFixed(0)} ms over ${passes} pass(es)`);

        // ── (c) warm pass ──────────────────────────────────────────────────
        const warmStart = process.hrtime.bigint();
        const warm = await store.scan(BENCH_DIR, budgets, Date.now());
        const warmMs = ms(warmStart);
        notePeak();
        expect(warm.ok).toBe(true);
        say(`[bench] (c) warm pass: ${warmMs.toFixed(0)} ms (target < 3000 ms)`);

        // ── (d) cached channel, from a FRESH store (a restart) ─────────────
        const restarted = createProfileStatsCacheStore(fs, cachePath);
        const cachedStart = process.hrtime.bigint();
        const cached = await restarted.cachedStats(BENCH_DIR, Date.now());
        const cachedMs = ms(cachedStart);
        notePeak();
        expect(cached.ok).toBe(true);
        if (cached.ok && warm.ok) {
          expect(cached.stats.lifetimeTokens).toBe(warm.stats.lifetimeTokens);
        }
        say(
          `[bench] (d) cached channel (no scan, cold store): ${cachedMs.toFixed(0)} ms (target < 500 ms); ` +
            `heapUsed with the full decoded cache resident: ${mib(process.memoryUsage().heapUsed)}`,
        );

        // ── (e2) EXACT differential on a stable copy of real data ─────────
        // The live-directory differential above goes inconclusive whenever
        // the running app appends to its own session file, which is exactly
        // when the bench is most likely to be run. A copy of the newest
        // SAMPLE_FILES files cannot move under us, so the comparison there is
        // an assertion, not a warning — and it is still real telemetry, not a
        // fixture.
        const sampleSize = Math.min(Number(process.env.ANYCODE_BENCH_SAMPLE ?? 8000), snapshot.length);
        const sampleDir = join(scratch, "sample");
        await mkdir(sampleDir, { recursive: true });
        const sampleNames: string[] = [];
        for (const entry of snapshot.slice(0, sampleSize)) {
          try {
            await writeFile(join(sampleDir, entry.name), await fs.readFileNoFollow(entry.fullPath), "utf-8");
            sampleNames.push(entry.name);
          } catch {
            continue;
          }
        }
        const sampleStore = createProfileStatsCacheStore(fs, join(scratch, "sample-cache.json"));
        // A budget deliberately smaller than the sample forces several passes,
        // so the differential covers PARTIAL coverage too, not just the end.
        const sampleBudgets = resolveScanBudgets({ maxNewReadsPerPass: Math.max(1, Math.ceil(sampleNames.length / 3)) });
        let samplePasses = 0;
        for (;;) {
          samplePasses += 1;
          const result = await sampleStore.scan(sampleDir, sampleBudgets, Date.now());
          expect(result.ok).toBe(true);
          if (!result.ok) break;
          const included = sampleStore.includedFileNames();
          const files: ProfileStatsFile[] = [];
          for (const name of included) {
            files.push({ name, lines: (await fs.readFileNoFollow(join(sampleDir, name))).split("\n") });
          }
          const oracle = aggregateProfileStats(files, { now: Date.now(), byteBudget: Number.POSITIVE_INFINITY });
          expect({ ...result.stats, currentStreakDays: 0 }, `sample pass ${samplePasses}`).toEqual({
            ...oracle,
            currentStreakDays: 0,
          });
          say(
            `[bench] (e2) sample pass ${samplePasses}: ${included.length}/${sampleNames.length} files included, ` +
              `backlog=${result.backlogRemaining}, differential IDENTICAL to the uncapped oracle`,
          );
          if (result.backlogRemaining === 0) break;
          if (samplePasses >= MAX_PASSES) throw new Error("sample backlog did not drain");
        }

        // ── (f) cache file size / parse cost / peak heap ───────────────────
        const cacheStat = await stat(cachePath);
        const raw = await fs.readFileNoFollow(cachePath);
        const parseStart = process.hrtime.bigint();
        JSON.parse(raw);
        const parseMs = ms(parseStart);
        notePeak();
        say(
          `[bench] (f) cache file ${mib(cacheStat.size)}, JSON.parse ${parseMs.toFixed(0)} ms, ` +
            `peak heapUsed ${mib(peakHeap)}`,
        );
        say(
          `[bench] speedup: baseline ${baselineMs.toFixed(0)} ms -> warm ${warmMs.toFixed(0)} ms ` +
            `(${(baselineMs / Math.max(warmMs, 1)).toFixed(1)}x), cached ${cachedMs.toFixed(0)} ms ` +
            `(${(baselineMs / Math.max(cachedMs, 1)).toFixed(1)}x)`,
        );
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    900_000,
  );
});
