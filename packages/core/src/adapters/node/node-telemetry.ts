/**
 * JsonlTelemetrySink (slice 6.6, design slice-6.6-cut.md §2-B5): append-only,
 * per-session JSONL sink. record() is synchronous and NEVER throws — every
 * serialized line runs through a single promise chain (`tail`) so writes stay
 * ordered, and the chain itself never remains rejected (each link swallows
 * its own failure into lastWriteError/dropped, so no unhandled rejection is
 * possible by construction). Bounded everywhere: a full pending queue or an
 * oversized line drops before the chain is even touched; dispose() races the
 * chain against TELEMETRY_DISPOSE_DEADLINE_MS and is idempotent (memoized).

 * direct node:fs/promises is legal at the adapter layer, the same way
 * node-git/node-http reach for their own native APIs.
 */

import * as fsp from "node:fs/promises";
import type { TelemetryPort, TelemetryRecord, TelemetryStatus } from "../../ports/telemetry.js";
import {
  TELEMETRY_DISPOSE_DEADLINE_MS,
  TELEMETRY_MAX_PENDING,
  TELEMETRY_MAX_RECORD_BYTES,
} from "../../types/config.js";
import { raceWithTimeout } from "../../util/abort.js";

export interface JsonlTelemetrySinkOptions {
  /** Sink directory; created lazily (recursive mkdir) on the first write. */
  dir: string;
  /** File name within `dir`; wiring passes `<sessionId>.jsonl`. */
  fileName: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class JsonlTelemetrySink implements TelemetryPort {
  private readonly dir: string;
  private readonly filePath: string;

  private mkdirPromise: Promise<void> | null = null;
  private tail: Promise<void> = Promise.resolve();

  private pending = 0;
  private written = 0;
  private dropped = 0;
  private lastWriteError: string | undefined;

  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(opts: JsonlTelemetrySinkOptions) {
    this.dir = opts.dir;
    this.filePath = `${opts.dir.replace(/[/\\]+$/, "")}/${opts.fileName}`;
  }

  record(record: TelemetryRecord): void {
    if (this.disposed) {
      this.dropped++;
      return;
    }

    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      // JSON.stringify cannot throw for the whitelist-typed TelemetryRecord

      this.dropped++;
      return;
    }

    if (Buffer.byteLength(line, "utf8") > TELEMETRY_MAX_RECORD_BYTES) {
      this.dropped++;
      return;
    }
    if (this.pending >= TELEMETRY_MAX_PENDING) {
      this.dropped++;
      return;
    }

    this.pending++;
    this.tail = this.tail.then(() => this.append(line)).then(
      () => {
        this.written++;
        this.pending--;
      },
      (error: unknown) => {
        this.lastWriteError = describeError(error);
        this.dropped++;
        this.pending--;
      },
    );
  }

  status(): TelemetryStatus {
    return {
      filePath: this.filePath,
      written: this.written,
      dropped: this.dropped,
      ...(this.lastWriteError !== undefined ? { lastWriteError: this.lastWriteError } : {}),
    };
  }

  /** Waits for the in-flight append chain to settle without disposing the
   *  sink — record() keeps enqueueing after this resolves. Races the same
   *  TELEMETRY_DISPOSE_DEADLINE_MS deadline as dispose(); never rejects
   *  (the snapshotted `tail` promise being raced never itself rejects). */
  flush(): Promise<void> {
    const controller = new AbortController();
    return raceWithTimeout(this.tail, TELEMETRY_DISPOSE_DEADLINE_MS, controller).then(() => undefined);
  }

  /** Bounded flush-and-close (TELEMETRY_DISPOSE_DEADLINE_MS race); idempotent;
   *  never rejects — `tail` (the promise being raced) never itself rejects. */
  dispose(): Promise<void> {
    if (this.disposePromise !== null) {
      return this.disposePromise;
    }
    this.disposed = true;
    const controller = new AbortController();
    this.disposePromise = raceWithTimeout(this.tail, TELEMETRY_DISPOSE_DEADLINE_MS, controller).then(
      () => undefined,
    );
    return this.disposePromise;
  }

  private async ensureDir(): Promise<void> {
    if (this.mkdirPromise === null) {
      this.mkdirPromise = fsp.mkdir(this.dir, { recursive: true }).then(() => undefined);
    }
    await this.mkdirPromise;
  }

  private async append(line: string): Promise<void> {
    await this.ensureDir();
    await fsp.appendFile(this.filePath, line, "utf8");
  }
}
