/**
 * Native-first session-row writer for a Claude session (cut §1.5 hazard (а)).
 *
 * The ordering rule it enforces: NO row exists until the native session
 * provably does. `--session-id <uuid>` rides the spawn argv, so the id is known
 * at connect time — but Claude Code materializes nothing for that id until a
 * turn actually runs (a handshake-only process emits no `system` frame and
 * writes no session file, probe #13). A row created at connect time for a tab
 * the user opens and closes without asking anything therefore names a native
 * session that never existed, and every later `--resume` of it fails against a
 * dead reference. The first turn-scoped `system/init` is the earliest moment
 * that reference is real, so that is when the row appears.
 *
 * The row id is nonetheless allocated UP FRONT, in memory: Session, the shadow
 * mirror and the tab wiring all need a stable session id from boot. Patches
 * that arrive before the row exists (a title is derived from the first user
 * message, which precedes that message's `system/init`) are buffered rather
 * than dropped — and rather than being allowed to conjure the row early.
 *
 * Every write is serialized behind the CREATE so a patch can never race ahead
 * of the INSERT it depends on.
 */

export interface ClaudeSessionRowPatch {
  title?: string;
  model?: string;
  /** The Claude preset id, stored verbatim in the shared `mode` TEXT column (cut §2(k).4). */
  mode?: string;
}

export interface ClaudeSessionRowPort {
  create(id: string, row: Record<string, unknown>): Promise<unknown>;
  touch(id: string, patch: ClaudeSessionRowPatch): Promise<unknown>;
}

/**
 * Taskana 4123 follow-up: the persistence tail behind the claude boot's
 * `attachEngineChildReportDurability` save seam. Deliberately its OWN method
 * (never a `touch` patch): the pending-child-reports snapshot writes the same
 * `sessions.pending_child_reports_json` column the core/codex boots use
 * (migration v20), with the same contract that a durability bookkeeping write
 * is NOT activity — `touch`'s port path funnels into `touchSession`, which
 * unconditionally stamps `updated_at` (the sidebar's last-activity order).
 * This method instead runs on the row's own serialized write chain, so a
 * snapshot saved before the row exists lands strictly after the CREATE —
 * never dropped, never conjuring the row early (the same posture `touch`
 * holds for buffered title patches).
 */
export interface ClaudePendingChildReportsPort {
  savePendingChildReports(id: string, json: string | null): Promise<unknown>;
}

export interface ClaudeSessionRowWriterOptions {
  rowId: string;
  /** Identity facts (workspace/engineId/externalSessionRef) — never the posture. */
  identity: Record<string, unknown>;
  /** True for a resume: the row is already on disk, so writes go straight through. */
  rowExists: boolean;
  port: ClaudeSessionRowPort;
  /** Taskana 4123 follow-up: the pending-child-reports column writer; absent -> those saves are buffered until the row exists, then dropped-safe. */
  pendingChildReportsPort?: ClaudePendingChildReportsPort;
  onError(error: unknown, stage: "create" | "touch" | "pending_reports"): void;
}

/**
 * A patch parked until the row exists. `settle` reports the real outcome: a
 * plain `touch` resolves whenever its write was attempted (its promise is only
 * "the enqueue landed", matching the fire-and-forget turn paths), while a
 * `commitTitle` write — `strict` — REJECTS when the row was never created or
 * the UPDATE failed.
 */
interface BufferedWrite {
  patch: ClaudeSessionRowPatch;
  /** True when the caller must learn the failure (a title the RPC acknowledges). */
  strict: boolean;
  /** Settles this write; `error` is the failure, absent on success. */
  settle(error?: unknown): void;
}

export class ClaudeSessionRowWriter {
  /** Serializes writes behind the CREATE; null exactly while no row exists. */
  private chain: Promise<void> | null;
  private readonly buffered: BufferedWrite[] = [];
  /**
   * Taskana 4123 follow-up: the pending-child-reports snapshot saved before
   * the row exists. At most one entry is ever live (each save overwrites the
   * whole snapshot — `null` once the queue drains), so the buffer keeps only
   * the newest json; it flushes through the serialized chain right after the
   * CREATE, mirroring `buffered`'s own flush below.
   */
  private bufferedReportJson: string | null | undefined;
  /**
   * Taskana 4123 review N1: how many live (non-buffered) report saves have
   * REGISTERED on the chain since materialize() captured the buffer. The flush
   * appended by materialize() runs after those registrations, so any count > 0
   * at flush time means the buffered snapshot is STALE — a live save already
   * carried newer state past it — and the flush must drop the buffer rather
   * than let an older snapshot land last (order NEW, OLD) and clobber it.
   */
  private liveReportSaves = 0;

  constructor(private readonly options: ClaudeSessionRowWriterOptions) {
    this.chain = options.rowExists ? Promise.resolve() : null;
  }

  /** True once a row exists (or is being created) — i.e. once patches stop buffering. */
  get materialized(): boolean {
    return this.chain !== null;
  }

  /**
   * Patch, never dropped: buffered while no row exists yet. The returned
   * promise settles once THIS patch has been written (never rejects — a
   * failure is reported through `onError`), so a caller that only waits for
   * the attempt can follow it.
   */
  touch(patch: ClaudeSessionRowPatch): Promise<void> {
    return this.write(patch, false);
  }

  /**
   * Write a title whose caller must be able to CONFIRM it (the Sessions API
   * `set_agent_title` ack). Unlike `touch`, the returned promise REJECTS when
   * the row could not be created or the UPDATE failed: a swallowed failure
   * would tell main the title is durable and drop the only copy of the handle.
   * The writer's own serialized chain stays fail-soft either way — an ordinary
   * turn patch queued behind a rejected title write still runs.
   */
  commitTitle(title: string): Promise<void> {
    return this.write({ title }, true);
  }

  private write(patch: ClaudeSessionRowPatch, strict: boolean): Promise<void> {
    if (this.chain === null) {
      return new Promise<void>((resolve, reject) => {
        this.buffered.push({
          patch,
          strict,
          settle: (error) => {
            if (!strict || error === undefined) resolve();
            else reject(error);
          },
        });
      });
    }
    const write = this.chain.then(() => this.options.port.touch(this.options.rowId, patch));
    // The chain keeps the fail-soft posture (a rejected write is reported, and
    // the next queued write still runs); only a strict caller is told.
    this.chain = write.then(() => undefined, (error: unknown) => this.options.onError(error, "touch"));
    return strict ? write.then(() => undefined) : write.then(() => undefined, () => undefined);
  }

  /**
   * Taskana 4123 follow-up: persists the pending detached-child report queue
   * snapshot (or null, once it drains) into the same column the core/codex
   * boots use. Buffered while no row exists yet (never dropped, never able to
   * conjure the row early) and serialized behind the CREATE once it does.
   */
  savePendingChildReports(json: string | null): Promise<unknown> {
    if (this.options.pendingChildReportsPort === undefined) {
      return Promise.resolve(undefined);
    }
    const port = this.options.pendingChildReportsPort;
    if (this.chain === null) {
      this.bufferedReportJson = json;
      return Promise.resolve(undefined);
    }
    this.liveReportSaves += 1;
    return this.chain
      .then(() => port.savePendingChildReports(this.options.rowId, json))
      .then(() => undefined);
  }

  /**
   * Taskana 4123 cross-review F1: the buffered flush's fire-and-forget twin of
   * `touch()`'s catch — a rejected save (SQLITE_BUSY past busy_timeout is the
   * realistic trigger) must surface through `onError` (the boot logs it like
   * any create/touch failure), NEVER as an unhandled rejection: under Node's
   * default `--unhandled-rejections=throw` that would kill the host on the
   * session's very first turn. No re-buffering on failure: nothing would ever
   * re-flush it (materialize fires once; a live `savePendingChildReports`
   * would already carry newer state), and a stale resurrected snapshot is its
   * own hazard — the queue's NEXT mutation re-persists the full current
   * snapshot through the live path, which is the honest retry mechanism.
   *
   * Taskana 4123 review N1: the flush runs as the first link AFTER the create
   * on the same serialized chain it appended itself to at materialize() time —
   * so any live save registered in between stays strictly AHEAD of it. If one
   * did, the buffered snapshot is stale by construction (the live path always
   * carries the newest full-queue state); the buffer is dropped, never allowed
   * to land last in NEW, OLD order and clobber it — worst case a stale json
   * overwriting a live `null` (the drained queue), which would resurrect
   * already-acknowledged reports after a restart.
   */
  private flushBufferedReportJson(): void {
    const json = this.bufferedReportJson;
    this.bufferedReportJson = undefined;
    if (json === undefined || this.liveReportSaves > 0) {
      return;
    }
    void this.savePendingChildReports(json).catch((error: unknown) => {
      this.options.onError(error, "pending_reports");
    });
  }

  /**
   * Called from the first turn-scoped `system/init`, with the posture the
   * ENGINE settled on (already reconciled against that init, so `model` is the
   * catalog `value` — never the resolved id the CLI reports, which would fail
   * `catalog.has()` on the next resume).
   *
   * CREATE for a fresh session, TOUCH for a resume — never a second INSERT on
   * the same primary key (main sends `--resume <id>` for every respawn).
   */
  materialize(posture: { model: string; mode: string }): void {
    if (this.chain !== null) {
      void this.touch(posture);
      return;
    }
    const created = this.options.port
      .create(this.options.rowId, { ...this.options.identity, ...posture })
      .then(() => undefined);
    // `this.chain` never rejects (a failed create is swallowed into onError
    // so the boot survives it) — which is exactly why the flush below gates
    // on `created`'s OWN outcome, not on the chain settling.
    this.chain = created.catch((error: unknown) => this.options.onError(error, "create"));
    // The buffered writes' own view of that outcome: a strict (title) write
    // cannot have landed if the INSERT never did, and must say so.
    const createFailure = created.then(() => null, (error: unknown) => error);
    for (const item of this.buffered.splice(0, this.buffered.length)) {
      this.chain = this.chain.then(() => this.flushBufferedWrite(item, createFailure));
    }
    // Taskana 4123 follow-up: flush the newest report snapshot (if any was
    // buffered) after the CREATE, through the same serialized chain.
    // Taskana 4123 cross-review F1: strictly after the create settles, and
    // only if it SUCCEEDED — a rejected create leaves no row, so flushing
    // anyway would fire a silent no-op UPDATE (0 rows match, no error) while
    // the queue believes its snapshot is durable. (The `.catch(() => undefined)`
    // here only silences this gate's own view of the failure; the error itself
    // was already routed to onError through `this.chain` above.)
    // Taskana 4123 review N1: the flush link is appended to the chain HERE —
    // synchronously, while materialize() still owns the code between the
    // create's start and its settlement — not in `created.then(...)`. Deferred
    // registration let any live save issued in that window register FIRST, so
    // the older buffered snapshot landed last (NEW, OLD) and clobbered the
    // newer live state. Registered synchronously, the flush sits ahead of
    // every such save on the chain; `flushBufferedReportJson` then drops the
    // buffer if a live save registered anyway (defense against any future
    // reordering), and the create-success gate is evaluated when the link
    // RUNS, so `settled()` still covers the whole tail including the flush.
    // The buffered writes above reported their own outcomes as they settled,
    // so this tail only closes the chain (`settled()` covers it).
    this.chain = this.chain
      .then(() => created)
      .then(
        () => this.flushBufferedReportJson(),
        () => undefined,
      );
    void this.chain;
  }

  /**
   * Writes one buffered patch after the CREATE and reports its real outcome to
   * that write's own caller. Never rejects, so the serialized chain — and every
   * write queued behind this one — survives a failure.
   *
   * A plain `touch` keeps the pre-existing posture: it fires even after a
   * failed CREATE (a no-op UPDATE), so the writer is never stranded and its
   * promise still settles. A strict (`commitTitle`) write is a title a host is
   * about to acknowledge: a missing row or a failed UPDATE rejects it, because
   * a no-op UPDATE would otherwise pass for a durable title.
   */
  private async flushBufferedWrite(item: BufferedWrite, createFailure: Promise<unknown>): Promise<void> {
    const failure = await createFailure;
    if (failure !== null && item.strict) {
      // The INSERT failed; onError("create") already reported it.
      item.settle(failure);
      return;
    }
    try {
      await this.options.port.touch(this.options.rowId, item.patch);
    } catch (error) {
      this.options.onError(error, "touch");
      item.settle(error);
      return;
    }
    item.settle();
  }

  /** Resolves once every write issued so far has settled (tests; never awaited on the boot path). */
  async settled(): Promise<void> {
    await this.chain;
  }
}
