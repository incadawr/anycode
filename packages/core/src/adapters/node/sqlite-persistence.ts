/**

 * native dependencies, works in the Electron utilityProcess (preflight: Node
 * 22.13 loads node:sqlite without flags, only an ExperimentalWarning; the
 * Electron-side preflight is a task 1.9 criterion; fallback plan is
 * better-sqlite3 behind this same port).
 *
 * Task 1.7 implements: open + WAL, schema v1 + migrations, session CRUD,
 * append/load history (JSON round-trip of HistoryItem), TRANSACTIONAL
 * replaceHistory (a mid-transaction failure must leave the old history
 * intact), close.
 *
 * Also co-located here (design §2.1, R8; avoids a barrel edit — this file is
 * already exported from adapters/node/index.ts): WriteBehindHistorySink, the
 * serialized-queue HistorySink implementation that fans writes out to any
 * PersistencePort without ever blocking or throwing into the turn.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HistorySink } from "../../context/history.js";
import type {
  CheckpointMeta,
  CheckpointReason,
  CheckpointRecord,
  CheckpointStore,
} from "../../ports/checkpoints.js";
import type { PersistencePort, SessionMeta } from "../../ports/persistence.js";
import type { HistoryItem } from "../../types/history.js";
import type { PermissionMode } from "../../types/permissions.js";

// ---------------------------------------------------------------------------
// Schema v1 + migration runner

interface Migration {
  version: number;
  statements: readonly string[];
}

/** Additive-only: append new entries here for future schema changes, never edit v1's statements. */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        model TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        title TEXT
      )`,
      `CREATE TABLE history_items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        item_id TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (session_id, item_id)
      )`,
      `CREATE INDEX idx_history_items_session ON history_items (session_id, seq)`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        commit_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        label TEXT NOT NULL,
        history_json TEXT NOT NULL
      )`,
      `CREATE INDEX idx_checkpoints_session ON checkpoints (session_id, created_at DESC)`,
    ],
  },
  {
    version: 3,
    statements: [
      "ALTER TABLE sessions ADD COLUMN engine_id TEXT",
      "ALTER TABLE sessions ADD COLUMN external_session_ref TEXT",
    ],
  },
  {
    version: 4,
    statements: [
      // Codex shadow command log (codex-fixes TASK.42, cut §2(e)): the native
      // `thread/read` never persists `commandExecution` items, not even
      // successful ones, so a relaunch would otherwise lose every command's
      // output. `(thread_id, item_id)` is the primary key so a duplicate live
      // write (e.g. a retried notification) can never double a row.
      `CREATE TABLE codex_thread_items (
        thread_id TEXT NOT NULL,
        turn_ordinal INTEGER NOT NULL,
        position_in_turn INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT,
        exit_code INTEGER,
        output_head TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (thread_id, item_id)
      )`,
      `CREATE INDEX idx_codex_thread_items_thread ON codex_thread_items (thread_id, turn_ordinal, position_in_turn)`,
    ],
  },
];

/**
 * Idempotent migration runner: tracks applied versions in schema_migrations
 * and runs each pending migration's statements inside its own BEGIN/COMMIT
 * (a failure rolls back that migration's DDL and rethrows).
 */
function migrate(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`,
  );
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number } | undefined;
  const current = row?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    db.exec("BEGIN");
    try {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

interface SessionRow {
  id: string;
  workspace: string;
  model: string;
  mode: string;
  created_at: number;
  updated_at: number;
  title: string | null;
  engine_id: string | null;
  external_session_ref: string | null;
}

function rowToSessionMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    workspace: row.workspace,
    model: row.model,
    mode: row.mode as PermissionMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title ?? undefined,
    ...(row.engine_id !== null && row.engine_id !== undefined ? { engineId: row.engine_id } : {}),
    ...(row.external_session_ref !== null && row.external_session_ref !== undefined
      ? { externalSessionRef: row.external_session_ref }
      : {}),
  };
}

interface CheckpointRow {
  id: string;
  session_id: string;
  commit_hash: string;
  created_at: number;
  reason: string;
  label: string;
  history_json: string;
}

function rowToCheckpointMeta(row: CheckpointRow): CheckpointMeta {
  return {
    id: row.id,
    sessionId: row.session_id,
    commitHash: row.commit_hash,
    createdAt: row.created_at,
    reason: row.reason as CheckpointReason,
    label: row.label,
  };
}

/** Default checkpoint retention per session (design slice-4.7-cut.md §2.1). */
const CHECKPOINTS_KEEP_PER_SESSION = 50;

// ---------------------------------------------------------------------------
// Codex shadow command log (migration v4, codex-fixes TASK.42 cut §2(e))

/** One `commandExecution` completion the host observed live, keyed by the native thread it belongs to. */
export interface CodexShadowCommandItem {
  itemId: string;
  turnOrdinal: number;
  positionInTurn: number;
  command: string;
  cwd?: string;
  exitCode?: number;
  outputHead?: string;
}

interface CodexThreadItemRow {
  thread_id: string;
  turn_ordinal: number;
  position_in_turn: number;
  item_id: string;
  command: string;
  cwd: string | null;
  exit_code: number | null;
  output_head: string | null;
  created_at: number;
}

function rowToCodexShadowCommandItem(row: CodexThreadItemRow): CodexShadowCommandItem {
  return {
    itemId: row.item_id,
    turnOrdinal: row.turn_ordinal,
    positionInTurn: row.position_in_turn,
    command: row.command,
    ...(row.cwd !== null ? { cwd: row.cwd } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.output_head !== null ? { outputHead: row.output_head } : {}),
  };
}

export class SqlitePersistenceAdapter implements PersistencePort, CheckpointStore {
  private db: DatabaseSync | undefined;

  /** dbPath: file path or ":memory:"; the database is opened lazily on first use. */
  constructor(private readonly dbPath: string) {}

  /** Opens (once) + migrates the database, creating the parent directory for file-backed paths. */
  private open(): DatabaseSync {
    if (this.db) {
      return this.db;
    }
    if (this.dbPath !== ":memory:") {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    const db = new DatabaseSync(this.dbPath);
    // WAL is a no-op on :memory: databases (sqlite keeps them in "memory" journal mode); harmless.
    db.exec("PRAGMA journal_mode = WAL;");
    migrate(db);
    this.db = db;
    return db;
  }

  /** Runs fn inside BEGIN/COMMIT; any throw (from fn or a statement) triggers ROLLBACK before rethrowing. */
  private transaction<T>(fn: (db: DatabaseSync) => T): T {
    const db = this.open();
    db.exec("BEGIN");
    try {
      const result = fn(db);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  async createSession(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta> {
    const db = this.open();
    const now = Date.now();
    const full: SessionMeta = { ...meta, createdAt: now, updatedAt: now };
    db.prepare(
      `INSERT INTO sessions (id, workspace, model, mode, created_at, updated_at, title, engine_id, external_session_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      full.id,
      full.workspace,
      full.model,
      full.mode,
      full.createdAt,
      full.updatedAt,
      full.title ?? null,
      full.engineId ?? null,
      full.externalSessionRef ?? null,
    );
    return full;
  }

  async getSession(id: string): Promise<SessionMeta | null> {
    const db = this.open();
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? rowToSessionMeta(row) : null;
  }

  async listSessions(opts?: { workspace?: string; limit?: number }): Promise<SessionMeta[]> {
    const db = this.open();
    let sql = "SELECT * FROM sessions";
    const params: (string | number)[] = [];
    if (opts?.workspace !== undefined) {
      sql += " WHERE workspace = ?";
      params.push(opts.workspace);
    }
    sql += " ORDER BY updated_at DESC";
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const rows = db.prepare(sql).all(...params) as unknown as SessionRow[];
    return rows.map(rowToSessionMeta);
  }

  async touchSession(
    id: string,
    patch?: Partial<Pick<SessionMeta, "title" | "mode" | "model" | "engineId" | "externalSessionRef">>,
  ): Promise<void> {
    const db = this.open();
    const sets: string[] = ["updated_at = ?"];
    const params: (string | number | null)[] = [Date.now()];
    if (patch?.title !== undefined) {
      sets.push("title = ?");
      params.push(patch.title);
    }
    if (patch?.mode !== undefined) {
      sets.push("mode = ?");
      params.push(patch.mode);
    }
    if (patch?.model !== undefined) {
      sets.push("model = ?");
      params.push(patch.model);
    }
    if (patch?.engineId !== undefined) {
      sets.push("engine_id = ?");
      params.push(patch.engineId);
    }
    if (patch?.externalSessionRef !== undefined) {
      sets.push("external_session_ref = ?");
      params.push(patch.externalSessionRef);
    }
    params.push(id);
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  async appendHistory(sessionId: string, items: readonly HistoryItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    this.transaction((db) => {
      const stmt = db.prepare("INSERT INTO history_items (session_id, item_id, data) VALUES (?, ?, ?)");
      for (const item of items) {
        stmt.run(sessionId, item.id, JSON.stringify(item));
      }
    });
  }

  /** Atomic swap of the whole history (compaction): DELETE + re-INSERT in one transaction. */
  async replaceHistory(sessionId: string, items: readonly HistoryItem[]): Promise<void> {
    this.transaction((db) => {
      db.prepare("DELETE FROM history_items WHERE session_id = ?").run(sessionId);
      const stmt = db.prepare("INSERT INTO history_items (session_id, item_id, data) VALUES (?, ?, ?)");
      for (const item of items) {
        stmt.run(sessionId, item.id, JSON.stringify(item));
      }
    });
  }

  async loadHistory(sessionId: string): Promise<HistoryItem[]> {
    const db = this.open();
    const rows = db
      .prepare("SELECT data FROM history_items WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId) as unknown as { data: string }[];
    return rows.map((row) => JSON.parse(row.data) as HistoryItem);
  }

  // -------------------------------------------------------------------------
  // CheckpointStore (design slice-4.7-cut.md §2.1/§2.3). Additive to
  // PersistencePort — the shadow-git service persists checkpoint metadata +
  // the pre-turn conversation snapshot here.

  /** INSERTs the record and prunes the session's oldest checkpoints past keepPerSession in ONE transaction. */
  async saveCheckpoint(record: CheckpointRecord, opts?: { keepPerSession?: number }): Promise<void> {
    const keep = opts?.keepPerSession ?? CHECKPOINTS_KEEP_PER_SESSION;
    this.transaction((db) => {
      db.prepare(
        `INSERT INTO checkpoints (id, session_id, commit_hash, created_at, reason, label, history_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.sessionId,
        record.commitHash,
        record.createdAt,
        record.reason,
        record.label,
        record.historyJson,
      );
      // Keep only the newest `keep` rows for this session; the subquery pins the
      // survivors by (created_at DESC, rowid DESC) so ties break deterministically.
      db.prepare(
        `DELETE FROM checkpoints
         WHERE session_id = ?
           AND id NOT IN (
             SELECT id FROM checkpoints
             WHERE session_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?
           )`,
      ).run(record.sessionId, record.sessionId, keep);
    });
  }

  /** Newest-first checkpoint metadata for a session; history_json is not loaded. */
  async listCheckpoints(sessionId: string, opts?: { limit?: number }): Promise<CheckpointMeta[]> {
    const db = this.open();
    let sql =
      "SELECT id, session_id, commit_hash, created_at, reason, label FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC, rowid DESC";
    const params: (string | number)[] = [sessionId];
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const rows = db.prepare(sql).all(...params) as unknown as CheckpointRow[];
    return rows.map(rowToCheckpointMeta);
  }

  /** Full checkpoint record (including the pre-turn history snapshot) by id, or null. */
  async getCheckpoint(id: string): Promise<CheckpointRecord | null> {
    const db = this.open();
    const row = db.prepare("SELECT * FROM checkpoints WHERE id = ?").get(id) as CheckpointRow | undefined;
    if (!row) {
      return null;
    }
    return { ...rowToCheckpointMeta(row), historyJson: row.history_json };
  }

  // -------------------------------------------------------------------------
  // Codex shadow command log (migration v4, cut §2(e)). Additive to
  // PersistencePort — host-only usage, never consumed through that interface.

  /** INSERT OR REPLACE keeps a re-delivered notification for the same item idempotent rather than duplicating a row. */
  async recordCodexThreadItem(threadId: string, item: CodexShadowCommandItem): Promise<void> {
    const db = this.open();
    db.prepare(
      `INSERT OR REPLACE INTO codex_thread_items
         (thread_id, turn_ordinal, position_in_turn, item_id, command, cwd, exit_code, output_head, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      threadId,
      item.turnOrdinal,
      item.positionInTurn,
      item.itemId,
      item.command,
      item.cwd ?? null,
      item.exitCode ?? null,
      item.outputHead ?? null,
      Date.now(),
    );
  }

  /** Ordered for direct consumption by `projectCodexHistory`'s merge: (turnOrdinal, then positionInTurn). */
  async listCodexThreadItems(threadId: string): Promise<CodexShadowCommandItem[]> {
    const db = this.open();
    const rows = db
      .prepare("SELECT * FROM codex_thread_items WHERE thread_id = ? ORDER BY turn_ordinal ASC, position_in_turn ASC")
      .all(threadId) as unknown as CodexThreadItemRow[];
    return rows.map(rowToCodexShadowCommandItem);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}

// ---------------------------------------------------------------------------
// Write-behind HistorySink (design §2.1, R8)

export interface HistorySinkLogger {
  error(message: string, error: unknown): void;
}

const defaultHistorySinkLogger: HistorySinkLogger = {
  error(message, error) {
    console.error(message, error);
  },
};

/**
 * Serialized async queue wrapping a PersistencePort + sessionId. append and
 * replaceAll enqueue their write and return immediately (never block the
 * turn); operations run strictly in submission order off a single queue, so
 * replaceAll can never overtake a queued append. A failed write is logged
 * and swallowed — it never throws outward into the loop. flush() awaits the
 * current queue tail (graceful shutdown / tests).
 */
export class WriteBehindHistorySink implements HistorySink {
  private tail: Promise<void> = Promise.resolve();
  private readonly logger: HistorySinkLogger;

  constructor(
    private readonly persistence: PersistencePort,
    private readonly sessionId: string,
    opts?: { logger?: HistorySinkLogger },
  ) {
    this.logger = opts?.logger ?? defaultHistorySinkLogger;
  }

  append(items: readonly HistoryItem[]): void {
    this.enqueue("append", () => this.persistence.appendHistory(this.sessionId, items));
  }

  replaceAll(items: readonly HistoryItem[]): void {
    this.enqueue("replaceAll", () => this.persistence.replaceHistory(this.sessionId, items));
  }

  flush(): Promise<void> {
    return this.tail;
  }

  private enqueue(op: "append" | "replaceAll", run: () => Promise<void>): void {
    // Chaining off `this.tail` (rather than firing independently) is what
    // guarantees ordering: `run` only starts once every previously-enqueued
    // write has settled (successfully or not).
    this.tail = this.tail.then(run).catch((error: unknown) => {
      try {
        this.logger.error(`WriteBehindHistorySink: ${op} failed for session ${this.sessionId}`, error);
      } catch {
        // A broken logger must not poison the queue for subsequent writes.
      }
    });
  }
}
