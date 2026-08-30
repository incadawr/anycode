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
  /**
   * Present ONLY on a child session (TASK.102 S2a §2.4): the parent session
   * that spawned it via `Agent(tier:"session")`. Root sessions never have
   * this field. Paired with `spawnToolCallId`; set once at creation, never
   * patched.
   */
  parentSessionId?: string;
  /**
   * The parent's Agent tool-call id that spawned this child session (TASK.102
   * S2a §2.4). Present iff `parentSessionId` is present; the pair is unique
   * per parent (a parent can never spawn two children off the same tool
   * call).
   */
  spawnToolCallId?: string;
  /**
   * Vision-fallback image registry counter (TASK.198 plan §2): the NEXT
   * number reserveImageRef will hand out for this session. Surfaced only
   * once at least one ref has actually been reserved (value > 1) — every
   * untouched/legacy session decodes to the column's `DEFAULT 1` and omits
   * this field, matching every other NOT-NULL-DEFAULT bookkeeping column on
   * this type (continuationPending, worktreeExitNoticePending, ...). Never
   * settable through SessionMetaPatch — the only writer is reserveImageRef's
   * own atomic UPDATE.
   */
  nextImageRef?: number;
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
  /**
   * UX-facing selection (TASK.102 S2a §2.4): ONLY root sessions
   * (`parentSessionId` absent). This is the SOLE list any picker, history
   * view, or `/sessions` command may read — a child session is structurally
   * unreachable through it, filtered in SQL before any LIMIT is applied (a
   * post-limit JS filter would silently starve the page instead).
   */
  listRootSessions(opts?: { workspace?: string; limit?: number }): Promise<SessionMeta[]>;
  /** UX-facing point read: null for both an unknown id AND a child session's id (no resume-through-id escape hatch). */
  getRootSession(id: string): Promise<SessionMeta | null>;
  /**
   * Maintenance selection: EVERY row, including children — janitor/worktree-
   * ownership/startup-probe need the child's live claim to avoid reaping it.
   * `limit` is additive-only opt-in: omitting it (every existing caller)
   * keeps the "sees everyone" contract exactly as before; a caller that only
   * needs proof the schema is open — not the rows themselves — may cap the
   * read instead of paying for a full table scan (TASK.102 S2 review MINOR).
   */
  listSessionsForMaintenance(opts?: { limit?: number }): Promise<SessionMeta[]>;
  /** Internal point read by id, no root/child filtering — host boot resolves by an id main already trusts (root or child). */
  getSessionById(id: string): Promise<SessionMeta | null>;
  /**
   * Authorized child access (TASK.102 S2a §2.4): null unless a row exists
   * whose OWN `(parentSessionId, spawnToolCallId)` matches BOTH arguments —
   * the query itself is the authorization check, not a bare id lookup a
   * caller could fool with a stolen spawnToolCallId under the wrong parent.
   */
  getChildSession(parentSessionId: string, spawnToolCallId: string): Promise<SessionMeta | null>;
  listChildSessions(parentSessionId: string): Promise<SessionMeta[]>;
  /**
   * Transactional cascade delete of `rootId` and every descendant reachable
   * through `parentSessionId` chains, plus their `history_items`/
   * `checkpoints`/`codex_thread_items`/`claude_transcript_items` rows, all in
   * ONE transaction (a mid-cascade failure rolls back everything, including
   * the earlier deletes in the same call). `externalSessionRefs` is every
   * deleted row's native engine ref (for a future native-side cleanup
   * consumer) — never interpreted or acted on here.
   */
  deleteSessionTree(rootId: string): Promise<{ deletedSessionIds: string[]; externalSessionRefs: string[] }>;
  touchSession(id: string, patch?: SessionMetaPatch): Promise<void>;
  /**
   * Atomically reserves and returns the session's next vision-fallback image
   * ref (TASK.198 plan §2), incrementing the persisted counter in the SAME
   * step — never through touchSession's patch mechanism (a partial UPDATE
   * with last-write-wins semantics could replay a stale value after a
   * crash and hand out a number twice). Numbering starts at 1 and is
   * assigned unconditionally, once per image, for the life of the session —
   * a compaction that later drops the highest-ref image can never make a
   * fresh reservation reuse its number.
   */
  reserveImageRef(sessionId: string): Promise<number>;
  /** Atomically refuses a path already active or pending cleanup in another session. */
  claimWorktree?(id: string, path: string, patch: SessionMetaPatch): Promise<boolean>;
  appendHistory(sessionId: string, items: readonly HistoryItem[]): Promise<void>;
  /** Atomic swap of the whole history (compaction); MUST be transactional. */
  replaceHistory(sessionId: string, items: readonly HistoryItem[]): Promise<void>;
  loadHistory(sessionId: string): Promise<HistoryItem[]>;
  /**
   * TASK.114: hard-delete one session and its cascade (TASK.102 children via
   * `parentSessionId` chains, history, checkpoints, and the shadow mirrors
   * keyed by `externalSessionRef`) in ONE transaction — a thin summary-adding
   * wrapper over `deleteSessionTree`'s engine. The active-session gate lives
   * with the caller (main), NOT here. An unknown id is a no-op, never a
   * domain throw.
   */
  deleteSession(rootId: string): Promise<SessionDeleteSummary>;
  /**
   * TASK.114 bulk-delete candidates: this project's ROOT sessions whose
   * `updatedAt` is older than `cutoffMs`. The `workspace` argument is the
   * project-identity key (`projectRoot ?? workspace`, the sidebar's grouping
   * key). Child sessions (`parentSessionId` set) are excluded — they leave
   * with their root's cascade, never on their own.
   */
  listSessionsOlderThan(workspace: string, cutoffMs: number): Promise<SessionMeta[]>;
  /** TASK.114: deleteSession for each id in ONE transaction; summaries are aggregated. */
  deleteSessions(ids: readonly string[]): Promise<SessionDeleteSummary>;
  close(): Promise<void>;
}
