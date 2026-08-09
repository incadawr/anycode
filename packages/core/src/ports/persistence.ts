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
  /** Atomically refuses a path already active or pending cleanup in another session. */
  claimWorktree?(id: string, path: string, patch: SessionMetaPatch): Promise<boolean>;
  appendHistory(sessionId: string, items: readonly HistoryItem[]): Promise<void>;
  /** Atomic swap of the whole history (compaction); MUST be transactional. */
  replaceHistory(sessionId: string, items: readonly HistoryItem[]): Promise<void>;
  loadHistory(sessionId: string): Promise<HistoryItem[]>;
  close(): Promise<void>;
}
