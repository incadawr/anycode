/**
 * TASKANA 4143 — newest-end SKIP semantics of the incremental cache scan,
 * driven through the REAL ProfileStatsCacheStore over an injected in-memory
 * ProfileFs (coherent snapshots, real size/mtime fingerprints, settable
 * failReadFor / failStatFor, counted directory reads).
 *
 * The contract under test: a contiguous NEWEST run positively identified
 * this pass as read-failed (not gone), stat-unavailable, or oversized is
 * SKIPPED — older readable history still contributes, `skippedNewestFiles`
 * reports the count, and backlog/truncated stay honest. Budget-deferred
 * files keep the contiguous-prefix behavior; a hole behind an aggregated
 * newer file keeps the cut behavior.
 */
import { describe, expect, it } from "vitest";
import {
  createProfileStatsCacheStore,
  resolveScanBudgets,
  type ProfileCacheFs,
  type ProfileCacheScanResult,
  type ProfileCacheStatsOutcome,
  type ProfileScanBudgets,
  type ProfileHandleStat,
  type ProfileFileSnapshot,
} from "./profile-stats-cache.js";
import type { ProfileFileStat, ProfileFs } from "./profile-ipc.js";

const DAY1 = Date.UTC(2020, 0, 1, 10, 0, 0);
const NOW = Date.UTC(2024, 0, 2);
/** Newest order is by mtime; these pins keep it exact. */
const MT_NEWEST = 4000;
const MT_MID = 3000;
const MT_OLD = 2000;
const MT_OLDEST = 1000;

function jsonl(records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function usage(session: string, ts: number, tokens: number): Record<string, unknown>[] {
  return [{ v: 1, ts, session, t: "usage", totalTokens: tokens }];
}

/** In-memory file with the stat fields the fingerprint needs. */
interface MemFile {
  content: string;
  mtimeMs: number;
  ino: number;
  ctimeMs: number;
  failRead: boolean;
  failStat: boolean;
  oversized: boolean;
}

interface MemDir {
  files: Map<string, MemFile>;
}

export class MemoryProfileFs implements ProfileFs, ProfileCacheFs {
  root = new Map<string, MemDir>();
  dirReads = 0;
  /** readdirs of the TELEMETRY directory only (the tmp sweep legitimately
   *  lists the cache directory; it must not count as a telemetry scan). */
  telemetryDirReads = 0;
  private nextIno = 1;

  constructor(public readonly telemetryDir: string) {
    this.root.set(telemetryDir, { files: new Map() });
    // The cache file's directory (tmp + rename publish) — auto-created like
    // NodeProfileFs.writeFile's recursive mkdir does.
    const cacheDir = "/cache";
    if (!this.root.has(cacheDir)) this.root.set(cacheDir, { files: new Map() });
  }

  add(name: string, content: string, mtimeMs: number): this {
    this.dir.files.set(name, {
      content,
      mtimeMs,
      ino: this.nextIno++,
      ctimeMs: mtimeMs,
      failRead: false,
      failStat: false,
      oversized: false,
    });
    return this;
  }

  addUsage(name: string, session: string, ts: number, tokens: number, mtimeMs: number): this {
    return this.add(name, jsonl(usage(session, ts, tokens)), mtimeMs);
  }

  get dir(): MemDir {
    return this.root.get(this.telemetryDir)!;
  }

  get(name: string): MemFile | undefined {
    return this.dir.files.get(name);
  }

  failReadFor(name: string): void {
    this.dir.files.get(name)!.failRead = true;
  }

  failStatFor(name: string): void {
    this.dir.files.get(name)!.failStat = true;
  }

  markOversized(name: string): void {
    this.dir.files.get(name)!.oversized = true;
  }

  remove(name: string): void {
    this.dir.files.delete(name);
  }

  renameTo(name: string, to: string): void {
    const f = this.dir.files.get(name);
    if (f) {
      this.dir.files.delete(name);
      this.dir.files.set(to, f);
    }
  }

  clearFailures(): void {
    for (const f of this.dir.files.values()) {
      f.failRead = false;
      f.failStat = false;
    }
  }

  private resolve(path: string): { dir: MemDir; name: string } | null {
    const slash = path.lastIndexOf("/");
    const dirPath = slash > 0 ? path.slice(0, slash) : "";
    const name = path.slice(slash + 1);
    const dir = this.root.get(dirPath);
    return dir === undefined ? null : { dir, name };
  }

  private statOf(f: MemFile, size: number): ProfileFileStat {
    return {
      size,
      mtimeMs: f.mtimeMs,
      isFile: true,
      isDirectory: false,
      mode: 0o644,
      ino: f.ino,
      ctimeMs: f.ctimeMs,
    };
  }

  private handleStatOf(f: MemFile, size: number): ProfileHandleStat {
    return { size, mtimeMs: f.mtimeMs, ctimeMs: f.ctimeMs, ino: f.ino };
  }

  async readFile(path: string): Promise<string> {
    const r = this.resolve(path);
    const f = r?.dir.files.get(r.name);
    if (!f) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    return f.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const r = this.resolve(path);
    if (r === null) throw Object.assign(new Error("no such dir"), { code: "ENOENT" });
    r.dir.files.set(r.name, {
      content,
      mtimeMs: Date.now(),
      ino: this.nextIno++,
      ctimeMs: Date.now(),
      failRead: false,
      failStat: false,
      oversized: false,
    });
  }

  async exists(path: string): Promise<boolean> {
    const r = this.resolve(path);
    return r !== null && r.dir.files.has(r.name);
  }

  async stat(path: string): Promise<ProfileFileStat> {
    return this.lstat(path);
  }

  async mkdir(): Promise<void> {}

  async readdir(path: string): Promise<string[]> {
    const dir = this.root.get(path);
    if (dir === undefined) throw Object.assign(new Error("no such dir"), { code: "ENOENT" });
    this.dirReads += 1;
    if (path === this.telemetryDir) this.telemetryDirReads += 1;
    return [...dir.files.keys()];
  }

  async rename(from: string, to: string): Promise<void> {
    const rf = this.resolve(from)!;
    const f = rf.dir.files.get(rf.name);
    if (f) {
      rf.dir.files.delete(rf.name);
      const rt = this.resolve(to)!;
      rt.dir.files.set(rt.name, f);
    }
  }

  async rm(path: string): Promise<void> {
    const r = this.resolve(path);
    if (r !== null) r.dir.files.delete(r.name);
  }

  async lstat(path: string): Promise<ProfileFileStat> {
    const r = this.resolve(path);
    const f = r?.dir.files.get(r.name);
    if (!f) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    if (f.failStat) throw Object.assign(new Error("EACCES (simulated)"), { code: "EACCES" });
    const size = f.oversized ? 4096 : Buffer.byteLength(f.content, "utf-8");
    return this.statOf(f, size);
  }

  async readFileNoFollow(path: string): Promise<string> {
    return this.readFile(path);
  }

  snapshotOpens: string[] = [];

  async readFileSnapshot(path: string): Promise<ProfileFileSnapshot> {
    const r = this.resolve(path);
    const f = r?.dir.files.get(r.name);
    if (!f) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    if (f.failRead) throw Object.assign(new Error("EPERM (simulated)"), { code: "EPERM" });
    this.snapshotOpens.push(path);
    const size = Buffer.byteLength(f.content, "utf-8");
    return {
      content: f.content,
      bytesRead: size,
      before: this.handleStatOf(f, size),
      after: this.handleStatOf(f, size),
    };
  }
}

function setup(): { fs: MemoryProfileFs; scan: (budgets?: ProfileScanBudgets) => Promise<ProfileCacheScanResult> } {
  const fs = new MemoryProfileFs("/telemetry");
  const store = createProfileStatsCacheStore(fs, "/cache/profile-stats-cache.json", "UTC");
  const scan = (budgets?: ProfileScanBudgets) => store.scan(fs.telemetryDir, budgets ?? resolveScanBudgets(), NOW);
  return { fs, scan };
}

function okView(result: ProfileCacheScanResult): ProfileCacheStatsOutcome {
  expect(result.ok).toBe(true);
  return result as ProfileCacheStatsOutcome;
}

describe("ProfileStatsCacheStore scan — newest-end skips", () => {
  it("newest EPERM with readable older history: older aggregates, newest skipped", async () => {
    const { fs, scan } = setup();
    fs.addUsage("n1.jsonl", "s1", DAY1 + 2000, 5, MT_NEWEST);
    fs.addUsage("o1.jsonl", "s0", DAY1, 4, MT_OLD);
    fs.failReadFor("n1.jsonl");

    const r = okView(await scan());
    expect(r.stats.lifetimeTokens).toBe(4);
    expect(r.stats.totalSessions).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.backlogRemaining).toBe(1);
    expect(r.skippedNewestFiles).toBe(1);
    // Only the NEWEST tail is missing — no older-history boundary to report.
    expect(r.coverageStartTs).toBeNull();
  });

  it("newest-tail skip over a middle hole still reports the older coverage boundary", async () => {
    const { fs, scan } = setup();
    fs.addUsage("o1.jsonl", "s0", DAY1, 4, MT_OLDEST);
    fs.addUsage("x1.jsonl", "sx", DAY1 + 500, 6, 1500);
    fs.addUsage("m1.jsonl", "sm", DAY1 + 1000, 7, MT_MID);
    fs.addUsage("n1.jsonl", "s1", DAY1 + 2000, 5, MT_NEWEST);

    // The NEWEST file and a MIDDLE file both change and fail to read; the
    // readable run between them still contributes, so the newest failure is
    // a tail skip — while the middle hole leaves older history missing, so
    // the oldest included file's earliest event is the honest boundary.
    for (const name of ["n1.jsonl", "x1.jsonl"]) {
      const f = fs.get(name)!;
      f.content = jsonl(usage(name === "n1.jsonl" ? "s1" : "sx", DAY1, 99));
      f.mtimeMs += 500;
      f.ctimeMs += 500;
      fs.failReadFor(name);
    }

    const r = okView(await scan());
    expect(r.stats.lifetimeTokens).toBe(7); // m1 only
    expect(r.truncated).toBe(true);
    expect(r.skippedNewestFiles).toBe(1);
    expect(r.coverageStartTs).toBe(DAY1 + 1000); // m1's first event
  });

  it("newest oversized with readable older history: skip 1, backlog 0, never opened", async () => {
    const { fs, scan } = setup();
    fs.addUsage("o1.jsonl", "s0", DAY1, 4, MT_OLD);
    fs.addUsage("n1.jsonl", "s1", DAY1 + 2000, 5, MT_NEWEST);
    fs.markOversized("n1.jsonl"); // lstat size 4096 > maxFileBytes 1024

    const r = okView(await scan(resolveScanBudgets({ maxFileBytes: 1024 })));
    expect(r.stats.lifetimeTokens).toBe(4);
    expect(r.truncated).toBe(true);
    expect(r.backlogRemaining).toBe(0);
    expect(r.skippedNewestFiles).toBe(1);
    expect(fs.snapshotOpens).not.toContain("/telemetry/n1.jsonl");
  });

  it("newest stat-unavailable: same tail-skip, backlog 1", async () => {
    const { fs, scan } = setup();
    fs.addUsage("n1.jsonl", "s1", DAY1 + 2000, 5, MT_NEWEST);
    fs.addUsage("o1.jsonl", "s0", DAY1, 4, MT_OLD);
    fs.failStatFor("n1.jsonl");

    const r = okView(await scan());
    expect(r.stats.lifetimeTokens).toBe(4);
    expect(r.truncated).toBe(true);
    expect(r.backlogRemaining).toBe(1);
    expect(r.skippedNewestFiles).toBe(1);
  });

  it("contiguous multiple newest failures: correct skip count", async () => {
    const { fs, scan } = setup();
    fs.addUsage("n1.jsonl", "s1", DAY1 + 3000, 5, MT_NEWEST);
    fs.addUsage("n2.jsonl", "s2", DAY1 + 2000, 6, MT_MID);
    fs.addUsage("o1.jsonl", "s0", DAY1, 4, MT_OLD);
    fs.failReadFor("n1.jsonl");
    fs.failReadFor("n2.jsonl");

    const r = okView(await scan());
    expect(r.stats.lifetimeTokens).toBe(4);
    expect(r.truncated).toBe(true);
    expect(r.skippedNewestFiles).toBe(2);
  });

  it("budget deferral keeps contiguous-prefix behavior: no skip, empty aggregate", async () => {
    const { fs, scan } = setup();
    fs.addUsage("o1.jsonl", "s0", DAY1, 4, MT_OLD);
    const warm = okView(await scan());
    expect(warm.stats.lifetimeTokens).toBe(4);
    expect(warm.skippedNewestFiles).toBe(0);

    fs.addUsage("n2.jsonl", "s2", DAY1 + 2000, 6, MT_MID);
    fs.addUsage("n1.jsonl", "s1", DAY1 + 3000, 5, MT_NEWEST);
    fs.failReadFor("n1.jsonl");

    const deferred = okView(await scan(resolveScanBudgets({ maxNewReadsPerPass: 1 })));
    expect(deferred.stats.lifetimeTokens).toBe(0);
    expect(deferred.truncated).toBe(true);
    expect(deferred.skippedNewestFiles).toBe(0);
    expect(deferred.backlogRemaining).toBeGreaterThanOrEqual(2);

    fs.clearFailures();
    const full = okView(await scan());
    expect(full.stats.lifetimeTokens).toBe(15);
    expect(full.skippedNewestFiles).toBe(0);
    expect(full.backlogRemaining).toBe(0);
  });

  it("middle failed file behind aggregated newest, oldest cached: cut, skip 0", async () => {
    const { fs, scan } = setup();
    fs.addUsage("o1.jsonl", "s0", DAY1, 4, MT_OLDEST);
    fs.addUsage("m1.jsonl", "sm", DAY1 + 1000, 7, MT_MID);
    fs.addUsage("n1.jsonl", "s1", DAY1 + 2000, 5, MT_NEWEST);
    const warm = okView(await scan());
    expect(warm.stats.lifetimeTokens).toBe(16);

    // The middle file CHANGES and now fails to read: a hole behind an
    // aggregated newest file keeps the cut behavior — no newest-end skip.
    const m = fs.get("m1.jsonl")!;
    m.content = jsonl(usage("sm", DAY1 + 1000, 99));
    m.mtimeMs = MT_MID + 500;
    m.ctimeMs = MT_MID + 500;
    fs.failReadFor("m1.jsonl");

    const r = okView(await scan());
    expect(r.stats.lifetimeTokens).toBe(5);
    expect(r.truncated).toBe(true);
    expect(r.skippedNewestFiles).toBe(0);
    expect(r.backlogRemaining).toBe(1);
  });

  it("nothing readable: single failed file, empty aggregate, skip 0", async () => {
    const { fs, scan } = setup();
    fs.addUsage("n1.jsonl", "s1", DAY1, 5, MT_NEWEST);
    fs.failReadFor("n1.jsonl");

    const r = okView(await scan());
    expect(r.stats.lifetimeTokens).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.skippedNewestFiles).toBe(0);
  });
});

describe("ProfileStatsCacheStore scan — newest-end skips across a restart", () => {
  it("a NEW store over the persisted cache replays the skipped tail without reading the telemetry directory", async () => {
    const fs = new MemoryProfileFs("/telemetry");
    const cachePath = "/cache/profile-stats-cache.json";
    const store = createProfileStatsCacheStore(fs, cachePath, "UTC");
    fs.addUsage("n1.jsonl", "s1", DAY1 + 2000, 5, MT_NEWEST);
    fs.addUsage("o1.jsonl", "s0", DAY1, 4, MT_OLD);
    fs.failReadFor("n1.jsonl");

    const scanned = okView(await store.scan(fs.telemetryDir, resolveScanBudgets(), NOW));
    expect(scanned.stats.lifetimeTokens).toBe(4);
    expect(scanned.skippedNewestFiles).toBe(1);

    // A restart: a fresh store instance over the SAME filesystem and cache
    // file — nothing but the persisted state can answer.
    const restarted = createProfileStatsCacheStore(fs, cachePath, "UTC");
    const readsBefore = fs.telemetryDirReads;
    const cached = await restarted.cachedStats(fs.telemetryDir, NOW);
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    expect(cached.stats.lifetimeTokens).toBe(4);
    expect(cached.skippedNewestFiles).toBe(1);
    expect(cached.truncated).toBe(true);
    expect(fs.telemetryDirReads).toBe(readsBefore); // no telemetry directory read
  });
});
