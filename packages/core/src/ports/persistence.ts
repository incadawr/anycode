/**
 * PersistencePort (design §2.4): domain-level session/history storage, not a
 * SQL surface. The SQLite adapter lives in adapters/node/sqlite-persistence.ts;
 * the loop never talks to this port directly — history writes flow through the
 * write-behind HistorySink (context/history.ts).
 */

import type { HistoryItem } from "../types/history.js";
import type { PermissionMode } from "../types/permissions.js";

export interface SessionMeta {
  id: string;
  workspace: string;
  model: string;
  mode: PermissionMode;
  createdAt: number;
  updatedAt: number;
  title?: string;
  /** Opaque, host-selected engine identity; absent preserves historical core sessions. */
  engineId?: string;
  /** Opaque native-session reference owned by an external engine; never credentials/config JSON. */
  externalSessionRef?: string;
}

export interface PersistencePort {
  createSession(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta>;
  getSession(id: string): Promise<SessionMeta | null>;
  listSessions(opts?: { workspace?: string; limit?: number }): Promise<SessionMeta[]>;
  touchSession(
    id: string,
    patch?: Partial<Pick<SessionMeta, "title" | "mode" | "model" | "engineId" | "externalSessionRef">>,
  ): Promise<void>;
  appendHistory(sessionId: string, items: readonly HistoryItem[]): Promise<void>;
  /** Atomic swap of the whole history (compaction); MUST be transactional. */
  replaceHistory(sessionId: string, items: readonly HistoryItem[]): Promise<void>;
  loadHistory(sessionId: string): Promise<HistoryItem[]>;
  close(): Promise<void>;
}
