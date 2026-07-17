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
import type {
  PersistencePort,
  SessionMeta,
  SessionMetaPatch,
  SessionWorktree,
  SessionWorktreeCleanup,
} from "../../ports/persistence.js";
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
  {
    version: 5,
    statements: [
      // codex-fixes W6 errata: every row written by the v4-era host writer
      // has `position_in_turn` counted in the WRONG coordinate space (it
      // counted ALL live item completions, including `reasoning`, which
      // `thread/read` never returns — see history-projection.ts's
      // NATIVE_PERSISTED doc). Those rows cannot be converted to the new
      // coordinate space after the fact — the dropped `reasoning`/other
      // completions that would let us recompute the correct anchor are gone.
      // Deleting them is the only sound option; the resume-projection's
      // existing `shadowMissing` marker (history-projection.ts) makes that
      // one-time degradation honest instead of silently misordering forever.
      // The DELETE runs BEFORE the ALTER so a mid-migration failure (the
      // runner's own BEGIN/COMMIT/ROLLBACK, see `migrate()`) undoes it too —
      // a poisoned second statement must never leave stale rows half-deleted.
      "DELETE FROM codex_thread_items",
      // `seq_in_turn`: the raw live-completion-order tiebreaker every future
      // row carries (history-projection.ts's `ShadowCommandItem.seqInTurn`).
      // DEFAULT 0 only satisfies SQLite's NOT-NULL-column-add requirement —
      // the table is empty immediately after the DELETE above, and every
      // future write supplies a real value explicitly.
      "ALTER TABLE codex_thread_items ADD COLUMN seq_in_turn INTEGER NOT NULL DEFAULT 0",
    ],
  },
  {
    version: 6,
    statements: [
      "ALTER TABLE sessions ADD COLUMN project_root TEXT",
      "ALTER TABLE sessions ADD COLUMN worktree_id TEXT",
      "ALTER TABLE sessions ADD COLUMN worktree_path TEXT",
      "ALTER TABLE sessions ADD COLUMN worktree_branch TEXT",
      "ALTER TABLE sessions ADD COLUMN worktree_base_ref TEXT",
      "ALTER TABLE sessions ADD COLUMN worktree_owned_by_anycode INTEGER",
      "ALTER TABLE sessions ADD COLUMN continuation_pending INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE sessions ADD COLUMN continuation_mode TEXT",
      "ALTER TABLE sessions ADD COLUMN worktree_cleanup_path TEXT",
      "ALTER TABLE sessions ADD COLUMN worktree_cleanup_mode TEXT",
      "ALTER TABLE sessions ADD COLUMN worktree_cleanup_owned_by_anycode INTEGER",
      // A legacy session's project identity was its only workspace. Keeping the
      // stored value explicit makes later workspace relocation unambiguous.
      "UPDATE sessions SET project_root = workspace WHERE project_root IS NULL",
    ],
  },
  {
    version: 7,
    statements: ["ALTER TABLE sessions ADD COLUMN worktree_transition_json TEXT"],
  },
  {
    version: 8,
    statements: ["ALTER TABLE sessions ADD COLUMN worktree_exit_notice_pending INTEGER NOT NULL DEFAULT 0"],
  },
  {
    version: 9,
    statements: [
      "ALTER TABLE sessions ADD COLUMN worktree_cleanup_branch TEXT",
      // v7/v8 cleanup ledgers were path-only. Backfill solely when the durable
      // transition journal supplies an exact, path-matching AnyCode branch;
      // malformed/mismatched/foreign JSON remains NULL and is retained by the
      // runtime rather than guessed from a directory basename.
      `UPDATE sessions
       SET worktree_cleanup_branch = json_extract(worktree_transition_json, '$.worktree.branch')
       WHERE worktree_cleanup_branch IS NULL
         AND worktree_cleanup_owned_by_anycode = 1
         AND worktree_cleanup_path IS NOT NULL
         AND json_valid(worktree_transition_json)
         AND json_type(worktree_transition_json, '$.worktree.path') = 'text'
         AND json_type(worktree_transition_json, '$.worktree.branch') = 'text'
         AND json_extract(worktree_transition_json, '$.worktree.path') = worktree_cleanup_path
         AND json_extract(worktree_transition_json, '$.worktree.branch') LIKE 'anycode-wt/%'`,
    ],
  },
  {
    version: 10,
    statements: [
      // Provider connection pinned to a session (TASK.45 W10). Additive-only,
      // nullable: every pre-v10 row reads back NULL (no connectionId), which is
      // the documented legacy-session fallback. New core sessions store their
      // pinned connection id here so resume resolves the same account/credential.
      "ALTER TABLE sessions ADD COLUMN connection_id TEXT",
    ],
  },
  {
    version: 11,
    statements: [
      // Codex account profile pinned to a session (codex-profiles cut §3.3,
      // W3-F). Additive-only, nullable: every pre-v11 row reads back NULL (no
      // codexProfileId), the documented legacy/system-profile fallback. A
      // Codex session created under a real (non-`system`) profile stores its
      // id here so resume re-resolves the same CODEX_HOME.
      "ALTER TABLE sessions ADD COLUMN codex_profile_id TEXT",
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
  project_root: string | null;
  worktree_id: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  worktree_base_ref: string | null;
  worktree_owned_by_anycode: number | null;
  continuation_pending: number;
  continuation_mode: string | null;
  worktree_exit_notice_pending: number;
  worktree_cleanup_path: string | null;
  worktree_cleanup_mode: string | null;
  worktree_cleanup_owned_by_anycode: number | null;
  worktree_cleanup_branch: string | null;
  worktree_transition_json: string | null;
  connection_id: string | null;
  codex_profile_id: string | null;
}

function parseWorktreeTransitionJson(raw: string | null): SessionMeta["worktreeTransition"] {
  if (typeof raw !== "string") return undefined;
  try {
    const value = JSON.parse(raw) as Partial<NonNullable<SessionMeta["worktreeTransition"]>>;
    if (
      (value.kind !== "enter_worktree" && value.kind !== "exit_worktree") ||
      (value.origin !== "tool" && value.origin !== "chrome") ||
      typeof value.projectRoot !== "string" ||
      typeof value.fromWorkspace !== "string" ||
      typeof value.toWorkspace !== "string" ||
      value.worktree === undefined ||
      typeof value.worktree.id !== "string" ||
      typeof value.worktree.path !== "string" ||
      typeof value.worktree.branch !== "string" ||
      typeof value.worktree.baseRef !== "string" ||
      typeof value.worktree.ownedByAnyCode !== "boolean"
    ) return undefined;
    return value as NonNullable<SessionMeta["worktreeTransition"]>;
  } catch {
    return undefined;
  }
}

function rowToWorktreeTransition(row: SessionRow): SessionMeta["worktreeTransition"] {
  return parseWorktreeTransitionJson(row.worktree_transition_json);
}

function rowToWorktreeCleanup(row: SessionRow): SessionWorktreeCleanup | undefined {
  if (
    typeof row.worktree_cleanup_path !== "string" ||
    row.worktree_cleanup_path.length === 0 ||
    (row.worktree_cleanup_mode !== "auto" && row.worktree_cleanup_mode !== "remove") ||
    (row.worktree_cleanup_owned_by_anycode !== 0 && row.worktree_cleanup_owned_by_anycode !== 1)
  ) {
    return undefined;
  }
  return {
    path: row.worktree_cleanup_path,
    mode: row.worktree_cleanup_mode,
    ownedByAnyCode: row.worktree_cleanup_owned_by_anycode === 1,
    ...(typeof row.worktree_cleanup_branch === "string" && row.worktree_cleanup_branch.length > 0
      ? { branch: row.worktree_cleanup_branch }
      : {}),
  };
}

function rowToSessionWorktree(row: SessionRow): SessionWorktree | undefined {
  if (
    typeof row.worktree_id !== "string" ||
    row.worktree_id.length === 0 ||
    typeof row.worktree_path !== "string" ||
    row.worktree_path.length === 0 ||
    typeof row.worktree_branch !== "string" ||
    row.worktree_branch.length === 0 ||
    typeof row.worktree_base_ref !== "string" ||
    row.worktree_base_ref.length === 0 ||
    (row.worktree_owned_by_anycode !== 0 && row.worktree_owned_by_anycode !== 1)
  ) {
    return undefined;
  }
  return {
    id: row.worktree_id,
    path: row.worktree_path,
    branch: row.worktree_branch,
    baseRef: row.worktree_base_ref,
    ownedByAnyCode: row.worktree_owned_by_anycode === 1,
  };
}

function rowToSessionMeta(row: SessionRow): SessionMeta {
  const worktree = rowToSessionWorktree(row);
  const worktreeCleanup = rowToWorktreeCleanup(row);
  const worktreeTransition = rowToWorktreeTransition(row);
  const projectRoot = typeof row.project_root === "string" ? row.project_root : row.workspace;
  return {
    id: row.id,
    workspace: row.workspace,
    model: row.model,
    mode: row.mode as PermissionMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title ?? undefined,
    // Preserve strict legacy projections for ordinary sessions. Consumers use
    // `projectRoot ?? workspace` as the semantic project identity.
    ...(projectRoot !== row.workspace || worktree !== undefined ? { projectRoot } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(row.continuation_pending === 1 ? { continuationPending: true } : {}),
    ...(row.continuation_mode === "model" || row.continuation_mode === "none"
      ? { continuationMode: row.continuation_mode }
      : {}),
    ...(row.worktree_exit_notice_pending === 1 ? { worktreeExitNoticePending: true } : {}),
    ...(worktreeCleanup !== undefined ? { worktreeCleanup } : {}),
    ...(worktreeTransition !== undefined ? { worktreeTransition } : {}),
    ...(row.engine_id !== null && row.engine_id !== undefined ? { engineId: row.engine_id } : {}),
    ...(row.external_session_ref !== null && row.external_session_ref !== undefined
      ? { externalSessionRef: row.external_session_ref }
      : {}),
    ...(typeof row.connection_id === "string" && row.connection_id.length > 0
      ? { connectionId: row.connection_id }
      : {}),
    ...(typeof row.codex_profile_id === "string" && row.codex_profile_id.length > 0
      ? { codexProfileId: row.codex_profile_id }
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
// Codex shadow command log (migration v4, codex-fixes TASK.42 cut §2(e);
// `seq_in_turn` added + all pre-existing rows deleted by migration v5, W6 —
// v4-era rows were written in a coordinate space `thread/read`'s actual
// native-item subset cannot be reconciled against, see MIGRATIONS above)

/** One `commandExecution` completion the host observed live, keyed by the native thread it belongs to. */
export interface CodexShadowCommandItem {
  itemId: string;
  turnOrdinal: number;
  positionInTurn: number;
  /** Raw live-completion-order tiebreaker (migration v5) — see history-projection.ts's `ShadowCommandItem.seqInTurn`. */
  seqInTurn: number;
  command: string;
  cwd?: string;
  exitCode?: number;
  outputHead?: string;
}

interface CodexThreadItemRow {
  thread_id: string;
  turn_ordinal: number;
  position_in_turn: number;
  seq_in_turn: number;
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
    seqInTurn: row.seq_in_turn,
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
    const projectRoot = meta.projectRoot ?? meta.workspace;
    db.prepare(
      `INSERT INTO sessions (
         id, workspace, model, mode, created_at, updated_at, title, engine_id, external_session_ref,
         project_root, worktree_id, worktree_path, worktree_branch, worktree_base_ref, worktree_owned_by_anycode,
         continuation_pending, continuation_mode, worktree_cleanup_path, worktree_cleanup_mode, worktree_cleanup_owned_by_anycode,
         worktree_cleanup_branch,
         worktree_transition_json, worktree_exit_notice_pending, connection_id, codex_profile_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      projectRoot,
      full.worktree?.id ?? null,
      full.worktree?.path ?? null,
      full.worktree?.branch ?? null,
      full.worktree?.baseRef ?? null,
      full.worktree === undefined ? null : full.worktree.ownedByAnyCode ? 1 : 0,
      full.continuationPending === true ? 1 : 0,
      full.continuationMode ?? null,
      full.worktreeCleanup?.path ?? null,
      full.worktreeCleanup?.mode ?? null,
      full.worktreeCleanup === undefined ? null : full.worktreeCleanup.ownedByAnyCode ? 1 : 0,
      full.worktreeCleanup?.branch ?? null,
      full.worktreeTransition === undefined ? null : JSON.stringify(full.worktreeTransition),
      full.worktreeExitNoticePending === true ? 1 : 0,
      full.connectionId ?? null,
      full.codexProfileId ?? null,
    );
    // Return the same backward-compatible projection as get/list.
    return rowToSessionMeta(
      db.prepare("SELECT * FROM sessions WHERE id = ?").get(full.id) as unknown as SessionRow,
    );
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

  async touchSession(id: string, patch?: SessionMetaPatch): Promise<void> {
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
    if (patch?.workspace !== undefined) {
      sets.push("workspace = ?");
      params.push(patch.workspace);
    }
    if (patch?.projectRoot !== undefined) {
      sets.push("project_root = ?");
      params.push(patch.projectRoot);
    }
    if (patch?.worktree !== undefined) {
      sets.push(
        "worktree_id = ?",
        "worktree_path = ?",
        "worktree_branch = ?",
        "worktree_base_ref = ?",
        "worktree_owned_by_anycode = ?",
      );
      params.push(
        patch.worktree?.id ?? null,
        patch.worktree?.path ?? null,
        patch.worktree?.branch ?? null,
        patch.worktree?.baseRef ?? null,
        patch.worktree === null ? null : patch.worktree.ownedByAnyCode ? 1 : 0,
      );
    }
    if (patch?.continuationPending !== undefined) {
      sets.push("continuation_pending = ?");
      params.push(patch.continuationPending ? 1 : 0);
    }
    if (patch?.continuationMode !== undefined) {
      sets.push("continuation_mode = ?");
      params.push(patch.continuationMode);
    }
    if (patch?.worktreeExitNoticePending !== undefined) {
      sets.push("worktree_exit_notice_pending = ?");
      params.push(patch.worktreeExitNoticePending ? 1 : 0);
    }
    if (patch?.worktreeCleanup !== undefined) {
      sets.push(
        "worktree_cleanup_path = ?",
        "worktree_cleanup_mode = ?",
        "worktree_cleanup_owned_by_anycode = ?",
        "worktree_cleanup_branch = ?",
      );
      params.push(
        patch.worktreeCleanup?.path ?? null,
        patch.worktreeCleanup?.mode ?? null,
        patch.worktreeCleanup === null ? null : patch.worktreeCleanup.ownedByAnyCode ? 1 : 0,
        patch.worktreeCleanup?.branch ?? null,
      );
    }
    if (patch?.worktreeTransition !== undefined) {
      sets.push("worktree_transition_json = ?");
      params.push(patch.worktreeTransition === null ? null : JSON.stringify(patch.worktreeTransition));
    }
    if (patch?.connectionId !== undefined) {
      sets.push("connection_id = ?");
      params.push(patch.connectionId);
    }
    if (patch?.codexProfileId !== undefined) {
      sets.push("codex_profile_id = ?");
      params.push(patch.codexProfileId);
    }
    params.push(id);
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  async claimWorktree(id: string, target: string, patch: SessionMetaPatch): Promise<boolean> {
    if (
      (patch.worktree === undefined || patch.worktree === null || patch.workspace === undefined) &&
      patch.worktreeCleanup?.path !== target
    ) {
      throw new Error("claimWorktree requires an active identity or cleanup resource patch");
    }
    const db = this.open();
    // IMMEDIATE serializes competing claims across host processes before the
    // read, so two sessions can never both observe an unclaimed canonical path.
    db.exec("BEGIN IMMEDIATE");
    try {
      const claims = db.prepare(
        `SELECT id, worktree_path, worktree_cleanup_path, worktree_transition_json
         FROM sessions`,
      ).all() as Array<{
        id: string;
        worktree_path: string | null;
        worktree_cleanup_path: string | null;
        worktree_transition_json: string | null;
      }>;
      const conflict = claims.some((candidate) => {
        const transition = parseWorktreeTransitionJson(candidate.worktree_transition_json);
        // A malformed non-null transition is an unknown durable claim. Refuse
        // every new owner rather than risk overwriting an unparseable resource.
        if (candidate.worktree_transition_json !== null && transition === undefined) return true;
        if (candidate.id === id) {
          // The only legal self-upgrade is creation-intent -> active identity
          // for the exact same target. Active or transitioning sessions cannot
          // overwrite their own ledger with a retry.
          if (candidate.worktree_path !== null || transition !== undefined) return true;
          return candidate.worktree_cleanup_path !== null && candidate.worktree_cleanup_path !== target;
        }
        return candidate.worktree_path === target ||
          candidate.worktree_cleanup_path === target ||
          transition?.worktree.path === target;
      });
      if (conflict) {
        db.exec("ROLLBACK");
        return false;
      }
      if (patch.worktree !== undefined && patch.worktree !== null && patch.workspace !== undefined) {
        db.prepare(
          `UPDATE sessions SET
             updated_at = ?, project_root = ?, workspace = ?,
             worktree_id = ?, worktree_path = ?, worktree_branch = ?, worktree_base_ref = ?, worktree_owned_by_anycode = ?,
             continuation_pending = ?, continuation_mode = ?,
             worktree_cleanup_path = ?, worktree_cleanup_mode = ?, worktree_cleanup_owned_by_anycode = ?, worktree_cleanup_branch = ?,
             worktree_transition_json = ?
           WHERE id = ?`,
        ).run(
          Date.now(), patch.projectRoot ?? patch.workspace, patch.workspace,
          patch.worktree.id, patch.worktree.path, patch.worktree.branch, patch.worktree.baseRef,
          patch.worktree.ownedByAnyCode ? 1 : 0,
          patch.continuationPending === true ? 1 : 0, patch.continuationMode ?? null,
          patch.worktreeCleanup?.path ?? null, patch.worktreeCleanup?.mode ?? null,
          patch.worktreeCleanup === undefined || patch.worktreeCleanup === null
            ? null : patch.worktreeCleanup.ownedByAnyCode ? 1 : 0,
          patch.worktreeCleanup?.branch ?? null,
          patch.worktreeTransition === undefined || patch.worktreeTransition === null
            ? null : JSON.stringify(patch.worktreeTransition),
          id,
        );
      } else {
        db.prepare(
          `UPDATE sessions SET updated_at = ?, project_root = ?,
             continuation_pending = ?, continuation_mode = ?,
             worktree_cleanup_path = ?, worktree_cleanup_mode = ?, worktree_cleanup_owned_by_anycode = ?, worktree_cleanup_branch = ?,
             worktree_transition_json = ?
           WHERE id = ?`,
        ).run(
          Date.now(), patch.projectRoot ?? null,
          patch.continuationPending === true ? 1 : 0, patch.continuationMode ?? null,
          patch.worktreeCleanup!.path, patch.worktreeCleanup!.mode,
          patch.worktreeCleanup!.ownedByAnyCode ? 1 : 0,
          patch.worktreeCleanup!.branch ?? null,
          patch.worktreeTransition === undefined || patch.worktreeTransition === null
            ? null : JSON.stringify(patch.worktreeTransition),
          id,
        );
      }
      db.exec("COMMIT");
      return true;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
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
  // Codex shadow command log (migration v4 + v5, cut §2(e)/W6). Additive to
  // PersistencePort — host-only usage, never consumed through that interface.

  /**
   * First-write-wins for the ANCHOR (`turn_ordinal`/`position_in_turn`/
   * `seq_in_turn`/`created_at` are NEVER in the `DO UPDATE SET` clause — the
   * anchor and the row's first-recorded time are permanent for the life of
   * the shadow log; see the W7 regression test below, which this upsert must
   * keep green unmodified: a conflicting second write's anchor must never
   * win).
   *
   * The PAYLOAD columns are NOT one class (W9 — supersedes W8 MEDIUM-1(b)'s
   * `COALESCE(excluded.col, col)` rule, which was itself unsound: an empty
   * string is NOT NULL, so a re-delivered `outputHead: ""` blanked an
   * already-recorded `"all passed\n"`, and a conflicting non-null redelivery
   * could overwrite `command` itself — showing the user a false command under
   * a correctly-frozen anchor. The mirror-image fix, `COALESCE(col,
   * excluded.col)` ("fill only a NULL hole"), is ALSO unsound: a sparse first
   * delivery's non-null `outputHead: ""` would then permanently block
   * enrichment from a later, richer delivery of the SAME item — see the
   * "shield" regression test below, which any single fill-direction rule
   * fails). Four classes, no `DO UPDATE SET` entry may ever let a redelivery
   * DECREASE the information already recorded:
   *   - `command`: IMMUTABLE. Absent from `DO UPDATE SET` entirely — the
   *     first recorded value stands forever. A different command string
   *     under the same `item.id` is not enrichment, it is identity
   *     corruption; the writer only ever calls this with a real string
   *     `command` (the column is `NOT NULL`), so there is no hole to fill by
   *     construction.
   *   - `cwd`/`exit_code`: fill-only-if-NULL, `COALESCE(col, excluded.col)`
   *     — unknown (NULL) is filled by the first value learned; an already-
   *     known value is never replaced (a terminal exit code is a fact, it
   *     only ever transitions from unknown to known).
   *   - `output_head`: NUL-SANITIZED, then MONOTONIC GROWTH BY BYTE LENGTH
   *     (W10 — supersedes W9's `length(TEXT)` comparison, which two NUL
   *     hazards defeat together). Before binding, every NUL (U+0000) in the
   *     incoming `outputHead` is replaced with U+FFFD (REPLACEMENT
   *     CHARACTER) at this single write site, so the column is NUL-free by
   *     construction and every prior write already went through the same
   *     substitution. This is required because (a) the `node:sqlite` driver
   *     does not round-trip a NUL through a TEXT column on read — it
   *     truncates the returned JS string at the first NUL even though the
   *     full bytes reached storage — so an unsanitized value reads back
   *     truncated regardless of what is stored; and (b) SQLite's
   *     `length(TEXT)` is itself NUL-terminated (`length('a\0') ==
   *     length('a\0b')`), which independently defeats the growth comparison
   *     below for any value containing a NUL. The comparison itself measures
   *     BYTES, via `length(CAST(col AS BLOB))` — not `octet_length()`, which
   *     requires SQLite >= 3.43 and the SQLite version bundled with the
   *     Electron runtime is not under this codebase's control — so
   *     multi-byte UTF-8 (including the replacement character just
   *     substituted in) is measured correctly. Updates only when the
   *     incoming value is non-null AND strictly longer in bytes than what is
   *     already stored (or nothing is stored yet). An empty or shorter
   *     redelivery can never shrink a longer recorded output; an
   *     equal-length redelivery keeps the already-stored value
   *     (deterministic tie-break).
   */
  async recordCodexThreadItem(threadId: string, item: CodexShadowCommandItem): Promise<void> {
    const db = this.open();
    // NUL-free by construction: SQLite's length(TEXT) is NUL-terminated and
    // node:sqlite truncates TEXT on read at the first NUL, so a raw NUL
    // byte would both defeat the growth comparison below and read back
    // silently shortened. Substituting (not stripping) keeps the column
    // 1:1 with the incoming code units, so cap/length math elsewhere is
    // unaffected and the substitution is visible rather than silent.
    const outputHead = item.outputHead == null ? null : item.outputHead.replaceAll("\u0000", "\uFFFD");
    db.prepare(
      `INSERT INTO codex_thread_items
         (thread_id, turn_ordinal, position_in_turn, seq_in_turn, item_id, command, cwd, exit_code, output_head, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, item_id) DO UPDATE SET
         cwd = COALESCE(cwd, excluded.cwd),
         exit_code = COALESCE(exit_code, excluded.exit_code),
         output_head = CASE
           WHEN excluded.output_head IS NOT NULL
             AND (output_head IS NULL OR length(CAST(excluded.output_head AS BLOB)) > length(CAST(output_head AS BLOB)))
           THEN excluded.output_head
           ELSE output_head
         END`,
    ).run(
      threadId,
      item.turnOrdinal,
      item.positionInTurn,
      item.seqInTurn,
      item.itemId,
      item.command,
      item.cwd ?? null,
      item.exitCode ?? null,
      outputHead,
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
 * current queue tail with that legacy fail-soft behaviour. flushChecked() is
 * the explicit durability barrier: it rejects when any queued write since the
 * previous checked barrier failed, then resets that checked failure window.
 */
export class WriteBehindHistorySink implements HistorySink {
  private tail: Promise<void> = Promise.resolve();
  private failureCount = 0;
  private checkedFailureCount = 0;
  private lastFailure: unknown;
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

  /**
   * Waits for the writes queued at call time and rejects if any write failed
   * since the previous checked barrier. The failure window is acknowledged
   * before rejection, so a following barrier reports only newer failures.
   */
  async flushChecked(): Promise<void> {
    const barrier = this.tail;
    await barrier;
    if (this.failureCount === this.checkedFailureCount) {
      return;
    }
    this.checkedFailureCount = this.failureCount;
    throw new Error(`WriteBehindHistorySink: persistence failed for session ${this.sessionId}`, {
      cause: this.lastFailure,
    });
  }

  private enqueue(op: "append" | "replaceAll", run: () => Promise<void>): void {
    // Chaining off `this.tail` (rather than firing independently) is what
    // guarantees ordering: `run` only starts once every previously-enqueued
    // write has settled (successfully or not).
    this.tail = this.tail.then(run).catch((error: unknown) => {
      this.failureCount += 1;
      this.lastFailure = error;
      try {
        this.logger.error(`WriteBehindHistorySink: ${op} failed for session ${this.sessionId}`, error);
      } catch {
        // A broken logger must not poison the queue for subsequent writes.
      }
    });
  }
}
