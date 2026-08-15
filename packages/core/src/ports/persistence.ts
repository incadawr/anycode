/**
 * PersistencePort (design §2.4): domain-level session/history storage, not a
 * SQL surface. The SQLite adapter lives in adapters/node/sqlite-persistence.ts;
 * the loop never talks to this port directly — history writes flow through the
 * write-behind HistorySink (context/history.ts).
 */

import type { HistoryItem } from "../types/history.js";
import type { PermissionMode } from "../types/permissions.js";

export interface SessionWorktree {
  id: string;
  path: string;
  branch: string;
  baseRef: string;
  ownedByAnyCode: boolean;
}

export interface SessionWorktreeCleanup {
  path: string;
  mode: "auto" | "remove";
  ownedByAnyCode: boolean;
  /** Exact branch owned by this resource ledger, when known. */
  branch?: string;
}

/** Crash-recovery journal spanning terminal tool history and workspace metadata. */
export interface SessionWorktreeTransition {
  origin: "tool" | "chrome";
  kind: "enter_worktree" | "exit_worktree";
  projectRoot: string;
  fromWorkspace: string;
  toWorkspace: string;
  worktree: SessionWorktree;
  cleanup?: "auto" | "keep" | "remove";
  /** Exact durable-history correlation; absent only for direct chrome relocation. */
  toolCallId?: string;
}

export interface SessionMeta {
  id: string;
  /** Current effective cwd used by the session host. */
  workspace: string;
  /** Stable project identity. Absent means the same path as `workspace`. */
  projectRoot?: string;
  /** Present only while the session is hosted in a registered git worktree. */
  worktree?: SessionWorktree;
  /** Durable rehost marker; absent is equivalent to false. */
  continuationPending?: boolean;
  /** `model` resumes the terminal tool turn; `none` is a chrome-only relocation. */
  continuationMode?: "model" | "none";
  /** Direct UI exit notice waiting for the next real model turn. */
  worktreeExitNoticePending?: boolean;
  /** Deferred removal ledger, consumed only after rehost at projectRoot. */
  worktreeCleanup?: SessionWorktreeCleanup;
  /** Cleared only after the successful terminal tool result is durably flushed. */
  worktreeTransition?: SessionWorktreeTransition;
  model: string;
  mode: PermissionMode;
  createdAt: number;
  updatedAt: number;
  title?: string;
  /** Opaque, host-selected engine identity; absent preserves historical core sessions. */
  engineId?: string;
  /** Opaque native-session reference owned by an external engine; never credentials/config JSON. */
  externalSessionRef?: string;
  /**
   * Provider connection pinned to this session at creation (TASK.45 W10):
   * resume resolves the credential/model/baseUrl of THIS connection, not the
   * currently-active one. Absent is a legacy session that predates connection
   * pinning — resume falls back to the current default (documented behaviour).
   */
  connectionId?: string;
  /**
   * Codex account profile this session was created under (codex-profiles cut
   * §3.3, W3-F): resume re-resolves THIS profile's CODEX_HOME, never the
   * currently-active one. Absent is a legacy session (predates profiles) or a
   * `system`-pseudo-profile session — resume runs on the ambient CODEX_HOME,
   * byte-identical to today's ambient-only behaviour. Never set for a core
   * session (Codex owns its own account).
   */
  codexProfileId?: string;
}

export type SessionMetaPatch = Partial<
  Pick<
    SessionMeta,
    | "title"
    | "mode"
    | "model"
    | "engineId"
    | "externalSessionRef"
    | "workspace"
    | "projectRoot"
    | "continuationPending"
    | "worktreeExitNoticePending"
    | "connectionId"
    | "codexProfileId"
  >
> & {
  /** `null` atomically clears the active worktree identity fields. */
  worktree?: SessionWorktree | null;
  /** `null` atomically clears the deferred cleanup ledger. */
  worktreeCleanup?: SessionWorktreeCleanup | null;
  worktreeTransition?: SessionWorktreeTransition | null;
  continuationMode?: "model" | "none" | null;
};

/**
 * Result of a hard session delete (TASK.114). `deleted` are the root ids that
 * were actually removed this call; `removedIds` is every row that left
 * `sessions` (roots plus cascaded children); `counts` are the per-table rows
 * the cascade deleted. Unknown ids are a no-op (absent from `deleted`).
 */
export interface SessionDeleteSummary {
  deleted: string[];
  removedIds: string[];
  counts: {
    historyItems: number;
    checkpoints: number;
    claudeTranscriptItems: number;
    codexThreadItems: number;
  };
}

export interface PersistencePort {
  createSession(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta>;
  getSession(id: string): Promise<SessionMeta | null>;
  listSessions(opts?: { workspace?: string; limit?: number }): Promise<SessionMeta[]>;
  touchSession(id: string, patch?: SessionMetaPatch): Promise<void>;
  /** Atomically refuses a path already active or pending cleanup in another session. */
  claimWorktree?(id: string, path: string, patch: SessionMetaPatch): Promise<boolean>;
  appendHistory(sessionId: string, items: readonly HistoryItem[]): Promise<void>;
  /** Atomic swap of the whole history (compaction); MUST be transactional. */
  replaceHistory(sessionId: string, items: readonly HistoryItem[]): Promise<void>;
  loadHistory(sessionId: string): Promise<HistoryItem[]>;
  /**
   * TASK.114: hard-delete one session and its cascade (children of TASK.102
   * when the `parent_session_id` column exists, history, checkpoints, and the
   * shadow mirrors keyed by `external_session_ref`) in ONE transaction. The
   * active-session gate lives with the caller (main), NOT here. An unknown id
   * is a no-op, never a domain throw.
   */
  deleteSession(rootId: string): Promise<SessionDeleteSummary>;
  /**
   * TASK.114 bulk-delete candidates: sessions of this project whose
   * `updatedAt` is older than `cutoffMs`. The `workspace` argument is the
   * project-identity key (`projectRoot ?? workspace`, the sidebar's grouping
   * key). Child sessions (`parent_session_id NOT NULL`, when that column
   * exists) are excluded — they leave with their root's cascade, never on
   * their own.
   */
  listSessionsOlderThan(workspace: string, cutoffMs: number): Promise<SessionMeta[]>;
  /** TASK.114: deleteSession for each id in ONE transaction; summaries are aggregated. */
  deleteSessions(ids: readonly string[]): Promise<SessionDeleteSummary>;
  close(): Promise<void>;
}
