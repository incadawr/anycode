/**
 * Unit tests for the telemetry-directory retention module (Taskana 4109 /
 * TASK.122). Everything runs on the REAL NodeProfileFs over mkdtemp scratch
 * dirs — no real ~/.anycode is ever touched. Fixed `now` so age math never
 * depends on the wall clock.
 */

import { appendFile, mkdtemp, mkdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeProfileFs, type ProfileFs } from "./profile-ipc.js";
import { createProfileStatsCacheStore, profileStatsCachePath, resolveScanBudgets } from "./profile-stats-cache.js";
import {
  DEFAULT_TELEMETRY_RETENTION,
  RETENTION_INITIAL_DELAY_MS,
  RETENTION_INTERVAL_MS,
  readUserTelemetryRetention,
  startTelemetryRetention,
  sweepTelemetryDir,
} from "./telemetry-retention.js";

const fs = new NodeProfileFs();
const dirs: string[] = [];

async function tmp(prefix = "tret-"): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const NOW = Date.UTC(2026, 9, 24);
const DAY = 86_400_000;

function jsonl(records: Record<string, unknown>[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** Writes a telemetry file and pins its mtime to the given epoch-ms. */
async function seedFile(dir: string, name: string, mtimeMs: number, content = "x"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, "utf-8");
  await utimes(path, Math.floor(mtimeMs / 1000), Math.floor(mtimeMs / 1000));
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function defaults(over?: Partial<typeof DEFAULT_TELEMETRY_RETENTION>) {
  return { ...DEFAULT_TELEMETRY_RETENTION, ...over };
}

// ---------------------------------------------------------------------------

describe("sweepTelemetryDir", () => {
  it("1. missing dir: ok, nothing removed, dir NOT created", async () => {
    const dir = join(await tmp(), "telemetry");
    const result = await sweepTelemetryDir({ fs, dir, policy: defaults(), protectedSessionIds: new Set(), now: NOW });
    expect(result).toEqual({ ok: true, scanned: 0, removed: [], removedBytes: 0, protectedKept: 0 });
    expect(await exists(dir)).toBe(false);
  });

  it("2. age cap: removes the two oldest of 200d/190d/10d, keeps the 10d file", async () => {
    const dir = await tmp();
    await seedFile(dir, "a.jsonl", NOW - 200 * DAY);
    await seedFile(dir, "b.jsonl", NOW - 190 * DAY);
    await seedFile(dir, "c.jsonl", NOW - 10 * DAY);
    const result = await sweepTelemetryDir({ fs, dir, policy: defaults(), protectedSessionIds: new Set(), now: NOW });
    expect(result.ok && result.removed).toEqual(["a.jsonl", "b.jsonl"]);
    expect(await exists(join(dir, "c.jsonl"))).toBe(true);
  });

  it("3. mtime order, not name order: maxFiles 3 of 5 removes exactly the two OLDEST by mtime", async () => {
    const dir = await tmp();
    // z.jsonl is the OLDEST, a.jsonl the NEWEST — name order is the reverse.
    await seedFile(dir, "z.jsonl", NOW - 5 * DAY);
    await seedFile(dir, "y.jsonl", NOW - 4 * DAY);
    await seedFile(dir, "m.jsonl", NOW - 3 * DAY);
    await seedFile(dir, "b.jsonl", NOW - 2 * DAY);
    await seedFile(dir, "a.jsonl", NOW - 1 * DAY);
    const result = await sweepTelemetryDir({
      fs,
      dir,
      policy: defaults({ maxFiles: 3 }),
      protectedSessionIds: new Set(),
      now: NOW,
    });
    expect(result.ok && result.removed).toEqual(["z.jsonl", "y.jsonl"]);
    expect(result.ok && result.scanned).toBe(5);
  });

  it("4. byte cap: three 400 KB files under a 1 MiB cap remove only the oldest", async () => {
    const dir = await tmp();
    const blob = "y".repeat(400 * 1024);
    await seedFile(dir, "a.jsonl", NOW - 30 * DAY, blob);
    await seedFile(dir, "b.jsonl", NOW - 20 * DAY, blob);
    await seedFile(dir, "c.jsonl", NOW - 10 * DAY, blob);
    const result = await sweepTelemetryDir({
      fs,
      dir,
      policy: defaults({ maxTotalBytes: 1_048_576 }),
      protectedSessionIds: new Set(),
      now: NOW,
    });
    expect(result.ok && result.removed).toEqual(["a.jsonl"]);
    expect(await exists(join(dir, "b.jsonl"))).toBe(true);
    expect(await exists(join(dir, "c.jsonl"))).toBe(true);
  });

  it("5. open-session protection: s-open.jsonl kept + protectedKept 1; s-closed.jsonl removed", async () => {
    const dir = await tmp();
    await seedFile(dir, "s-open.jsonl", NOW - 300 * DAY);
    await seedFile(dir, "s-closed.jsonl", NOW - 300 * DAY);
    const result = await sweepTelemetryDir({
      fs,
      dir,
      policy: defaults(),
      protectedSessionIds: new Set(["s-open"]),
      now: NOW,
    });
    expect(result.ok && result.protectedKept).toBe(1);
    expect(result.ok && result.removed).toEqual(["s-closed.jsonl"]);
    expect(await exists(join(dir, "s-open.jsonl"))).toBe(true);
  });

  it("6. recent guard: 1h/2h/3h files survive a maxFiles 1 cap; only the 40d file goes", async () => {
    const dir = await tmp();
    await seedFile(dir, "h1.jsonl", NOW - 1 * 3_600_000);
    await seedFile(dir, "h2.jsonl", NOW - 2 * 3_600_000);
    await seedFile(dir, "h3.jsonl", NOW - 3 * 3_600_000);
    await seedFile(dir, "d40.jsonl", NOW - 40 * DAY);
    const result = await sweepTelemetryDir({
      fs,
      dir,
      policy: defaults({ maxFiles: 1 }),
      protectedSessionIds: new Set(),
      now: NOW,
    });
    expect(result.ok && result.removed).toEqual(["d40.jsonl"]);
    expect(result.ok && result.protectedKept).toBe(3);
    for (const n of ["h1.jsonl", "h2.jsonl", "h3.jsonl"]) {
      expect(await exists(join(dir, n))).toBe(true);
    }
  });

  it("7. future mtime: a file dated now+1d is never removed even under a tight cap", async () => {
    const dir = await tmp();
    await seedFile(dir, "fut.jsonl", NOW + DAY);
    await seedFile(dir, "old.jsonl", NOW - 300 * DAY);
    const result = await sweepTelemetryDir({
      fs,
      dir,
      policy: defaults({ maxFiles: 100 }),
      protectedSessionIds: new Set(),
      now: NOW,
    });
    expect(result.ok && result.removed).toEqual(["old.jsonl"]);
    expect(await exists(join(dir, "fut.jsonl"))).toBe(true);
  });

  it("8. non-targets untouched: other names, a directory, a symlink and its target all survive", async () => {
    const dir = await tmp();
    const outside = await tmp();
    const target = join(outside, "target.jsonl");
    await writeFile(target, "x", "utf-8");
    await utimes(target, Math.floor((NOW - 300 * DAY) / 1000), Math.floor((NOW - 300 * DAY) / 1000));
    await writeFile(join(dir, "notes.txt"), "x", "utf-8");
    await utimes(join(dir, "notes.txt"), Math.floor((NOW - 300 * DAY) / 1000), Math.floor((NOW - 300 * DAY) / 1000));
    await writeFile(join(dir, "cache.json"), "x", "utf-8");
    await mkdir(join(dir, "old.jsonl"));
    await symlink(target, join(dir, "link.jsonl"));

    const result = await sweepTelemetryDir({ fs, dir, policy: defaults(), protectedSessionIds: new Set(), now: NOW });
    expect(result.ok && result.removed).toEqual([]);
    expect(result.ok && result.scanned).toBe(0);
    for (const p of ["notes.txt", "cache.json", "old.jsonl", "link.jsonl"]) {
      expect(await exists(join(dir, p))).toBe(true);
    }
    expect(await exists(target)).toBe(true);
  });

  it("9. changed between scan and delete: a mid-run append keeps the file", async () => {
    const dir = await tmp();
    await seedFile(dir, "victim.jsonl", NOW - 300 * DAY);
    await seedFile(dir, "other.jsonl", NOW - 300 * DAY);

    let lstats = 0;
    const racing: ProfileFs = Object.create(fs);
    racing.lstat = async (path: string) => {
      if (path.endsWith("victim.jsonl")) {
        lstats++;
        if (lstats === 2) {
          // The sweep's re-stat arrives after a concurrent append.
          await appendFile(path, '{"v":1,"ts":1,"session":"victim","t":"usage"}\n', "utf-8");
        }
      }
      // Stat AFTER the possible append, so the re-stat observes the change.
      return fs.lstat(path);
    };

    const result = await sweepTelemetryDir({ fs: racing, dir, policy: defaults(), protectedSessionIds: new Set(), now: NOW });
    expect(result.ok && result.removed).toEqual(["other.jsonl"]);
    expect(await exists(join(dir, "victim.jsonl"))).toBe(true);
  });

  it("10. per-run bound: 7 expired files with maxDeletes 5 remove 5, then the remaining 2", async () => {
    const dir = await tmp();
    for (let i = 1; i <= 7; i++) {
      await seedFile(dir, `f${i}.jsonl`, NOW - (400 - i) * DAY);
    }
    const first = await sweepTelemetryDir({
      fs,
      dir,
      policy: defaults(),
      protectedSessionIds: new Set(),
      now: NOW,
      maxDeletes: 5,
    });
    expect(first.ok && first.removed).toEqual(["f1.jsonl", "f2.jsonl", "f3.jsonl", "f4.jsonl", "f5.jsonl"]);

    const second = await sweepTelemetryDir({
      fs,
      dir,
      policy: defaults(),
      protectedSessionIds: new Set(),
      now: NOW,
      maxDeletes: 5,
    });
    expect(second.ok && second.removed).toEqual(["f6.jsonl", "f7.jsonl"]);
  });
});

// ---------------------------------------------------------------------------

describe("cache interop", () => {
  it("11. retention keeps the Profile stats view contiguous, untruncated, with the cache intact", async () => {
    const home = await tmp();
    const dir = join(home, ".anycode", "telemetry");
    await mkdir(dir, { recursive: true });
    const cachePath = profileStatsCachePath(home);
    const store = createProfileStatsCacheStore(fs, cachePath, "UTC");

    const ts = Date.UTC(2026, 0, 1);
    const seedSession = async (name: string, mtime: number) => {
      await writeFile(
        join(dir, `${name}.jsonl`),
        jsonl([
          { v: 1, ts, session: name, t: "session_start", model: "m", provider: "p", mode: "agent" },
          { v: 1, ts: ts + 1000, session: name, t: "usage", inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          { v: 1, ts: ts + 2000, session: name, t: "session_end" },
        ]),
        "utf-8",
      );
      await utimes(join(dir, `${name}.jsonl`), Math.floor(mtime / 1000), Math.floor(mtime / 1000));
    };
    await seedSession("s300", NOW - 300 * DAY);
    await seedSession("s250", NOW - 250 * DAY);
    await seedSession("s5", NOW - 5 * DAY);
    await seedSession("s2", NOW - 2 * DAY);

    const before = await store.scan(dir, resolveScanBudgets(), NOW);
    expect(before.ok).toBe(true);

    const sweep = await sweepTelemetryDir({ fs, dir, policy: defaults(), protectedSessionIds: new Set(), now: NOW });
    expect(sweep.ok && [...sweep.removed].sort()).toEqual(["s250.jsonl", "s300.jsonl"]);

    const after = await store.scan(dir, resolveScanBudgets(), NOW);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.truncated).toBe(false);
    expect(after.coverageStartTs).toBeNull();
    expect(after.stats.totalSessions).toBe(2);
    expect(after.stats.lifetimeTokens).toBe(30);
    expect(after.backlogRemaining).toBe(0);
    // The cache FILE itself survives retention (it lives outside the dir).
    expect(await exists(cachePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("readUserTelemetryRetention", () => {
  it("12. no config file: defaults", async () => {
    const home = await tmp();
    expect(await readUserTelemetryRetention(fs, home)).toEqual(DEFAULT_TELEMETRY_RETENTION);
  });

  it("13. telemetry.enabled false + retention.maxAgeDays 30: defaults plus maxAgeDays 30", async () => {
    const home = await tmp();
    await mkdir(join(home, ".anycode"), { recursive: true });
    await writeFile(
      join(home, ".anycode", "config.json"),
      JSON.stringify({ telemetry: { enabled: false, retention: { maxAgeDays: 30 } } }),
      "utf-8",
    );
    expect(await readUserTelemetryRetention(fs, home)).toEqual({ ...DEFAULT_TELEMETRY_RETENTION, maxAgeDays: 30 });
  });

  it("14. invalid retention (maxAgeDays 0 / unknown key / non-object): defaults, no throw", async () => {
    const home = await tmp();
    await mkdir(join(home, ".anycode"), { recursive: true });
    const cases: unknown[] = [
      { telemetry: { retention: { maxAgeDays: 0 } } },
      { telemetry: { retention: { nope: 1 } } },
      { telemetry: { retention: "nope" } },
    ];
    for (const cfg of cases) {
      await writeFile(join(home, ".anycode", "config.json"), JSON.stringify(cfg), "utf-8");
      await expect(readUserTelemetryRetention(fs, home)).resolves.toEqual(DEFAULT_TELEMETRY_RETENTION);
    }
  });
});

// ---------------------------------------------------------------------------

/** Timer rig: records scheduled callbacks; firing them runs the retention pass. */
function fakeTimers() {
  interface Handle {
    cb: () => void;
    cleared: boolean;
    fire(): void;
    // Node timers have unref()/ref(); the fake rig makes them no-ops.
    unref(): void;
    ref(): void;
  }
  const timeouts: Handle[] = [];
  const intervals: Handle[] = [];
  const mkHandle = (cb: () => void): Handle => {
    const h: Handle = {
      cb,
      cleared: false,
      fire() {
        if (!h.cleared) cb();
      },
      // Node timers have unref(); the fake rig makes it a no-op.
      unref() {},
      ref() {},
    };
    return h;
  };
  const timers = {
    setTimeout: ((cb: () => void) => {
      const h = mkHandle(cb);
      timeouts.push(h);
      return h as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    setInterval: ((cb: () => void) => {
      const h = mkHandle(cb);
      intervals.push(h);
      return h as unknown as NodeJS.Timeout;
    }) as typeof setInterval,
    clearTimeout: ((h: unknown) => {
      const t = timeouts.find((x) => x === h);
      if (t) t.cleared = true;
    }) as typeof clearTimeout,
    clearInterval: ((h: unknown) => {
      const t = intervals.find((x) => x === h);
      if (t) t.cleared = true;
    }) as typeof clearInterval,
  };
  // A fired callback starts an async chain (runNow -> kill switch -> policy
  // read -> dir resolve -> readdir -> per-file lstat -> rm); the rm lands many
  // macrotasks later, so poll until the chain quiesces.
  const settle = async (pred?: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (pred && (await pred())) return;
      await new Promise<void>((r) => setImmediate(r));
    }
  };
  return {
    timers,
    fireInitial: () => timeouts.forEach((h) => h.fire()),
    timeouts,
    intervals,
    initialCleared: () => timeouts.every((h) => h.cleared),
    intervalCleared: () => intervals.every((h) => h.cleared),
    settle,
  };
}

async function retentionHome(): Promise<{ home: string; dir: string }> {
  const home = await tmp("tret-home-");
  const dir = join(home, ".anycode", "telemetry");
  await mkdir(dir, { recursive: true });
  return { home, dir };
}

describe("startTelemetryRetention", () => {
  it("15. nothing runs before the initial timer fires; firing it removes an expired file", async () => {
    const { home, dir } = await retentionHome();
    await seedFile(dir, "expired.jsonl", NOW - 300 * DAY);
    await seedFile(dir, "fresh.jsonl", NOW - 1 * DAY);
    const rig = fakeTimers();

    const handle = startTelemetryRetention({
      home: () => home,
      fs,
      env: {},
      protectedSessionIds: () => [],
      now: () => NOW,
      timers: rig.timers,
    });

    // Nothing has run yet: the initial delay has not elapsed.
    expect(await exists(join(dir, "expired.jsonl"))).toBe(true);

    rig.fireInitial();
    await rig.settle(async () => !(await exists(join(dir, "expired.jsonl"))));
    expect(await exists(join(dir, "expired.jsonl"))).toBe(false);
    expect(await exists(join(dir, "fresh.jsonl"))).toBe(true);
    handle.stop();
  });

  it("16. kill switch (ANYCODE_TELEMETRY=off): nothing removed", async () => {
    const { home, dir } = await retentionHome();
    const victim = await seedFile(dir, "expired.jsonl", NOW - 300 * DAY);
    const rig = fakeTimers();
    const handle = startTelemetryRetention({
      home: () => home,
      fs,
      env: { ANYCODE_TELEMETRY: "off" },
      protectedSessionIds: () => [],
      now: () => NOW,
      timers: rig.timers,
    });
    rig.fireInitial();
    await rig.settle();
    expect(await exists(victim)).toBe(true);
    handle.stop();
  });

  it("17. retention.enabled false: nothing removed", async () => {
    const { home, dir } = await retentionHome();
    const victim = await seedFile(dir, "expired.jsonl", NOW - 300 * DAY);
    await writeFile(
      join(home, ".anycode", "config.json"),
      JSON.stringify({ telemetry: { retention: { enabled: false } } }),
      "utf-8",
    );
    const rig = fakeTimers();
    const handle = startTelemetryRetention({
      home: () => home,
      fs,
      env: {},
      protectedSessionIds: () => [],
      now: () => NOW,
      timers: rig.timers,
    });
    rig.fireInitial();
    await rig.settle();
    expect(await exists(victim)).toBe(true);
    handle.stop();
  });

  it("18. two concurrent runNow() calls return the same promise", async () => {
    const { home, dir } = await retentionHome();
    await seedFile(dir, "expired.jsonl", NOW - 300 * DAY);
    const rig = fakeTimers();
    const handle = startTelemetryRetention({
      home: () => home,
      fs,
      env: {},
      protectedSessionIds: () => [],
      now: () => NOW,
      timers: rig.timers,
    });
    const a = handle.runNow();
    const b = handle.runNow();
    expect(b).toBe(a);
    await a;
    const c = handle.runNow();
    expect(c).not.toBe(a); // single-flight resets after completion
    await c;
    handle.stop();
  });

  it("19. stop() clears both timers", async () => {
    const { home } = await retentionHome();
    const rig = fakeTimers();
    const handle = startTelemetryRetention({
      home: () => home,
      fs,
      env: {},
      protectedSessionIds: () => [],
      now: () => NOW,
      timers: rig.timers,
    });
    expect(rig.timeouts).toHaveLength(1);
    expect(rig.intervals).toHaveLength(1);
    handle.stop();
    expect(rig.initialCleared()).toBe(true);
    expect(rig.intervalCleared()).toBe(true);
    // A cleared initial timer firing must not run the sweep again.
    const expired = join(home, ".anycode", "telemetry", "x.jsonl");
    rig.fireInitial();
    await rig.settle();
    expect(await exists(expired)).toBe(false);
  });
});

it("constants stay at the documented defaults", () => {
  expect(RETENTION_INITIAL_DELAY_MS).toBe(2 * 60 * 1000);
  expect(RETENTION_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
});
