/**
 * Checkpoint contracts (design slice-4.7-cut.md §2.1). shadow-git workspace
 * snapshots + /rewind. This file owns the slice's shared types; the wave
 * consumers (dispatcher/loop/cli) import these directly from
 * ../ports/checkpoints.js — ports/index.ts is intentionally NOT touched
 * (precedent: ports/subagent.js imported directly by the loop). The narrow
 * CheckpointStore is implemented additively by SqlitePersistenceAdapter;
 * PersistencePort itself is not extended.
 */

import type { HistoryItem } from "../types/history.js";

export type CheckpointReason = "auto" | "pre-rewind";

/* */
export interface CheckpointMeta {
  id: string; // uuid
  sessionId: string;
  commitHash: string; // shadow-git commit
  createdAt: number; // epoch ms
  reason: CheckpointReason;
  label: string;
  /**
   * GitHub #36: the session's compaction-record sequence that was current when
   * this checkpoint's HISTORY SNAPSHOT was taken (the turn's start), not when
   * the row was written — the capture is lazy. A rewind keeps records with
   * `seq <= boundary` and drops the rest.
   *
   * Absent on checkpoints written before this field existed (and in the CLI,
   * which keeps no compaction records): the rewind then falls back to judging
   * by the restored history.
   */
  compactionSeq?: number;
}

export interface CheckpointRecord extends CheckpointMeta {
  /* */
  historyJson: string;
}

/* */
export interface CheckpointStore {
  /* */
  saveCheckpoint(record: CheckpointRecord, opts?: { keepPerSession?: number }): Promise<void>;
  /* */
  listCheckpoints(sessionId: string, opts?: { limit?: number }): Promise<CheckpointMeta[]>;
  getCheckpoint(id: string): Promise<CheckpointRecord | null>;
}

/* */
export interface TurnCheckpointRequest {
  /* */
  userInput: string;
  /* */
  historySnapshot: readonly HistoryItem[];
  /**
   * GitHub #36: the compaction-record sequence current when `historySnapshot`
   * was captured (the turn start), sampled there and carried here because the
   * capture itself is lazy — it fires at the turn's first write-effect tool,
   * by which time an auto compaction of that same turn may already have
   * recorded an outcome. Absent = the caller keeps no records (the CLI).
   */
  compactionSeq?: number;
}

export type CheckpointCaptureResult =
  | { kind: "created"; id: string; label: string }
  | { kind: "failed"; reason: string }
  | { kind: "skipped" };

/* */
export interface CheckpointCapturer {
  capture(req: TurnCheckpointRequest): Promise<CheckpointCaptureResult>;
}

/* */
export interface TurnCheckpointControl {
  /* */
  ensure(): Promise<CheckpointCaptureResult | null>;
}
