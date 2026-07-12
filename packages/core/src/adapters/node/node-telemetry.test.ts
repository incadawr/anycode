/**
 * node-telemetry.test.ts (slice 6.6 B7): JsonlTelemetrySink over a real
 * tmpdir filesystem — happy-path JSONL, lazy mkdir, bounded queue/oversize
 * drops, fail-soft behavior against an unwritable sink, dispose bounded
 * flush + idempotency, and post-dispose drops.
 */

import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTelemetrySink } from "./node-telemetry.js";
import type { TelemetryRecord } from "../../ports/telemetry.js";
import { TELEMETRY_MAX_PENDING, TELEMETRY_MAX_RECORD_BYTES } from "../../types/config.js";

function usageRecord(session: string, overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return { v: 1, ts: Date.now(), session, t: "usage", inputTokens: 10, ...overrides } as TelemetryRecord;
}

describe("JsonlTelemetrySink", () => {
  let tmpDir: string;
  let lockedDir: string | undefined;

  afterEach(async () => {
    if (lockedDir) {
      await chmod(lockedDir, 0o755).catch(() => {});
      lockedDir = undefined;
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("appends records and produces a valid line-delimited JSONL file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-telemetry-"));
    const sink = new JsonlTelemetrySink({ dir: tmpDir, fileName: "s1.jsonl" });

    sink.record(usageRecord("s1"));
    sink.record({ v: 1, ts: Date.now(), session: "s1", t: "turn_end", turn: 1, finishReason: "stop" });
    sink.record({ v: 1, ts: Date.now(), session: "s1", t: "session_end" });
    await sink.dispose();

    const raw = await readFile(join(tmpDir, "s1.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].t).toBe("usage");
    expect(parsed[1].t).toBe("turn_end");
    expect(parsed[2].t).toBe("session_end");

    const status = sink.status();
    expect(status.written).toBe(3);
    expect(status.dropped).toBe(0);
    expect(status.filePath).toBe(join(tmpDir, "s1.jsonl"));
  });

  it("creates the sink directory lazily on first write, not at construction", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-telemetry-"));
    const sinkDir = join(tmpDir, "nested", "telemetry");
    const sink = new JsonlTelemetrySink({ dir: sinkDir, fileName: "s2.jsonl" });

    // No record() call yet -> directory must not exist.
    await expect(readFile(join(sinkDir, "s2.jsonl"), "utf8")).rejects.toThrow();

    sink.record(usageRecord("s2"));
    await sink.dispose();

    const raw = await readFile(join(sinkDir, "s2.jsonl"), "utf8");
    expect(raw.trim().length).toBeGreaterThan(0);
  });

  it("bounds the pending queue: flooding drops records once the cap is hit", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-telemetry-"));
    const sink = new JsonlTelemetrySink({ dir: tmpDir, fileName: "flood.jsonl" });

    const total = TELEMETRY_MAX_PENDING + 500;
    for (let i = 0; i < total; i++) {
      sink.record(usageRecord("flood", { ts: i } as Partial<TelemetryRecord>));
    }
    await sink.dispose();

    const status = sink.status();
    expect(status.dropped).toBeGreaterThan(0);
    expect(status.written + status.dropped).toBe(total);
    expect(status.written).toBeLessThanOrEqual(TELEMETRY_MAX_PENDING);
  });

  it("drops an oversized record without writing it or growing the file", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-telemetry-"));
    const sink = new JsonlTelemetrySink({ dir: tmpDir, fileName: "oversize.jsonl" });

    const huge = {
      v: 1,
      ts: Date.now(),
      session: "x".repeat(TELEMETRY_MAX_RECORD_BYTES + 1000),
      t: "error",
    } as unknown as TelemetryRecord;
    sink.record(huge);
    sink.record(usageRecord("small"));
    await sink.dispose();

    const status = sink.status();
    expect(status.dropped).toBe(1);
    expect(status.written).toBe(1);

    const raw = await readFile(join(tmpDir, "oversize.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).session).toBe("small");
  });

  it("stays fail-soft when the sink path is a file, not a directory", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-telemetry-"));
    const fakeDirPath = join(tmpDir, "not-a-dir");
    await writeFile(fakeDirPath, "i am a file");

    const sink = new JsonlTelemetrySink({ dir: fakeDirPath, fileName: "s.jsonl" });
    expect(() => sink.record(usageRecord("s"))).not.toThrow();

    await expect(sink.dispose()).resolves.toBeUndefined();

    const status = sink.status();
    expect(status.dropped).toBe(1);
    expect(status.lastWriteError).toBeDefined();
  });

  it("stays fail-soft against an unwritable directory (chmod 0o000)", async () => {
    if (process.getuid && process.getuid() === 0) {
      // root bypasses filesystem permission bits; the scenario cannot be
      // reproduced under a root test-runner (e.g. some CI containers).
      return;
    }
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-telemetry-"));
    lockedDir = join(tmpDir, "locked");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(lockedDir);
    await chmod(lockedDir, 0o000);

    const sink = new JsonlTelemetrySink({ dir: lockedDir, fileName: "s.jsonl" });
    expect(() => sink.record(usageRecord("s"))).not.toThrow();

    const start = Date.now();
    await expect(sink.dispose()).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(3000);

    const status = sink.status();
    expect(status.written).toBe(0);
    expect(status.dropped).toBe(1);
    expect(status.lastWriteError).toBeDefined();
  });

  it("dispose is idempotent — a second call resolves without error and does not reopen the chain", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-telemetry-"));
    const sink = new JsonlTelemetrySink({ dir: tmpDir, fileName: "idempotent.jsonl" });

    sink.record(usageRecord("s"));
    await sink.dispose();
    const statusAfterFirst = sink.status();

    await expect(sink.dispose()).resolves.toBeUndefined();
    const statusAfterSecond = sink.status();
    expect(statusAfterSecond).toEqual(statusAfterFirst);
  });

  it("flush() waits for in-flight appends and leaves the sink open for further record()s", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-telemetry-"));
    const sink = new JsonlTelemetrySink({ dir: tmpDir, fileName: "flush.jsonl" });

    sink.record(usageRecord("s"));
    sink.record(usageRecord("s"));
    // No await between record() and flush(): the appends are still in-flight
    // on the tail chain when flush() is called, mirroring the teardown-push
    // race this test guards against (session.ts calling flushTelemetry()
    // right after runTurn() settles, before the append promise resolves).
    await sink.flush();

    const flushedStatus = sink.status();
    expect(flushedStatus.written).toBe(2);
    expect(flushedStatus.dropped).toBe(0);

    // flush() must not close the sink (unlike dispose()) — record() still works.
    sink.record(usageRecord("s"));
    await sink.flush();
    expect(sink.status().written).toBe(3);

    await sink.dispose();
  });

  it("drops records recorded after dispose()", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-telemetry-"));
    const sink = new JsonlTelemetrySink({ dir: tmpDir, fileName: "post-dispose.jsonl" });

    sink.record(usageRecord("s"));
    await sink.dispose();

    const before = sink.status();
    sink.record(usageRecord("s"));
    const after = sink.status();

    expect(after.dropped).toBe(before.dropped + 1);
    expect(after.written).toBe(before.written);
  });
});
