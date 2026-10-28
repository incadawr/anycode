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

export class ClaudeSessionRowWriter {
  /** Serializes writes behind the CREATE; null exactly while no row exists. */
  private chain: Promise<void> | null;
  private readonly buffered: ClaudeSessionRowPatch[] = [];
  /**
   * Resolvers of `touch()` calls that arrived while the row did not exist yet.
   * Resolved after the CREATE + buffered-flush tail settles, so a caller that
   * promises persistence waits for the real write instead of the buffer.
   */
  private readonly bufferedWaiters: Array<() => void> = [];
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
   * failure is reported through `onError`), so the Sessions API title ack can
   * wait for the commit instead of the enqueue.
   */
  touch(patch: ClaudeSessionRowPatch): Promise<void> {
    if (this.chain === null) {
      this.buffered.push(patch);
      return new Promise<void>((resolve) => { this.bufferedWaiters.push(resolve); });
    }
    const write = this.chain
      .then(() => this.options.port.touch(this.options.rowId, patch))
      .then(() => undefined)
      .catch((error: unknown) => this.options.onError(error, "touch"));
    this.chain = write;
    return write;
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
    for (const patch of this.buffered.splice(0, this.buffered.length)) void this.touch(patch);
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
    // The buffered patches' waiters resolve LAST: every `touch` above re-chained
    // behind `created`, so by the time this tail link runs their writes settled.
    const waiters = this.bufferedWaiters.splice(0, this.bufferedWaiters.length);
    this.chain = this.chain
      .then(() => created)
      .then(
        () => this.flushBufferedReportJson(),
        () => undefined,
      )
      .then(() => {
        for (const resolve of waiters) resolve();
      });
    void this.chain;
  }

  /** Resolves once every write issued so far has settled (tests; never awaited on the boot path). */
  async settled(): Promise<void> {
    await this.chain;
  }
}
