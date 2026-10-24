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
 * (migration v19), with the same contract that a durability bookkeeping write
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
  onError(error: unknown, stage: "create" | "touch"): void;
}

export class ClaudeSessionRowWriter {
  /** Serializes writes behind the CREATE; null exactly while no row exists. */
  private chain: Promise<void> | null;
  private readonly buffered: ClaudeSessionRowPatch[] = [];
  /**
   * Taskana 4123 follow-up: the pending-child-reports snapshot saved before
   * the row exists. At most one entry is ever live (each save overwrites the
   * whole snapshot — `null` once the queue drains), so the buffer keeps only
   * the newest json; it flushes through the serialized chain right after the
   * CREATE, mirroring `buffered`'s own flush below.
   */
  private bufferedReportJson: string | null | undefined;

  constructor(private readonly options: ClaudeSessionRowWriterOptions) {
    this.chain = options.rowExists ? Promise.resolve() : null;
  }

  /** True once a row exists (or is being created) — i.e. once patches stop buffering. */
  get materialized(): boolean {
    return this.chain !== null;
  }

  /** Fire-and-forget patch. Buffered while no row exists yet, never dropped. */
  touch(patch: ClaudeSessionRowPatch): void {
    if (this.chain === null) {
      this.buffered.push(patch);
      return;
    }
    this.chain = this.chain
      .then(() => this.options.port.touch(this.options.rowId, patch))
      .then(() => undefined)
      .catch((error: unknown) => this.options.onError(error, "touch"));
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
    return this.chain
      .then(() => port.savePendingChildReports(this.options.rowId, json))
      .then(() => undefined);
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
      this.touch(posture);
      return;
    }
    this.chain = this.options.port
      .create(this.options.rowId, { ...this.options.identity, ...posture })
      .then(() => undefined)
      .catch((error: unknown) => this.options.onError(error, "create"));
    for (const patch of this.buffered.splice(0, this.buffered.length)) this.touch(patch);
    // Taskana 4123 follow-up: flush the newest report snapshot (if any was
    // buffered) after the CREATE, through the same serialized chain.
    if (this.bufferedReportJson !== undefined) {
      const json = this.bufferedReportJson;
      this.bufferedReportJson = undefined;
      void this.savePendingChildReports(json);
    }
  }

  /** Resolves once every write issued so far has settled (tests; never awaited on the boot path). */
  async settled(): Promise<void> {
    await this.chain;
  }
}
