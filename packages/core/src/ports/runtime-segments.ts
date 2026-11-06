import type { HistoryItem } from "../types/history.js";

export type RuntimeEngine = "core" | "codex" | "claude";
import type { RuntimeSettings } from "./runtime-settings.js";
export type { RuntimeSettings, RuntimeNativeBase } from "./runtime-settings.js";
export interface RuntimeSegment {
  sessionId: string;
  id: string;
  ordinal: number;
  engine: RuntimeEngine;
  connectionId?: string;
  profileId?: string;
  /** Native account namespace; empty denotes the historical ambient account. */
  accountScope: string;
  nativeRef?: string;
  nativeState: "fresh" | "materialized";
  selected: RuntimeSettings;
  applied: RuntimeSettings;
  startedAt: number;
  endedAt?: number;
  coverage: "available_history";
}
export interface RuntimeBoundary {
  id: string;
  segmentId: string;
  afterItemId?: string;
  text: string;
  createdAt: number;
}
export interface RuntimeHandoff {
  id: string;
  segmentId: string;
  sourceWatermark: string | null;
  payload: string;
  digest: string;
  state: "pending" | "dispatching" | "accepted" | "uncertain";
  turnId?: string;
  originalText?: string;
  injectedText?: string;
}
export interface RuntimeSessionSnapshot {
  revision: number;
  activeSegmentId: string;
  segments: RuntimeSegment[];
  items: HistoryItem[];
  boundaries: RuntimeBoundary[];
  handoff: RuntimeHandoff | null;
}
export interface RuntimeSwitchCommit {
  expectedRevision: number;
  sourceSegmentId: string;
  segment: Omit<RuntimeSegment, "sessionId" | "ordinal" | "endedAt">;
  sourceItems: readonly HistoryItem[];
  boundary: RuntimeBoundary;
  handoff: RuntimeHandoff;
}

/** Durable display history and per-runtime model context have separate custody. */
export interface RuntimeSegmentStore {
  ensureRuntimeSession(sessionId: string): RuntimeSessionSnapshot;
  loadRuntimeSession(sessionId: string): RuntimeSessionSnapshot | null;
}
