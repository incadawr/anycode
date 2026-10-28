/**
 * The title-persistence seams a native-engine boot hands to `Session`.
 *
 * Two engines write a session's title through the same store and under the same
 * contract, and the difference between them is one mapping (a Codex preset id
 * shares the row's `mode` TEXT column, cut §2(k).4). They live here, not in the
 * composition root, because the contract they carry is load-bearing:
 *
 * - `touch` is FAIL-SOFT. A turn must never be failed by its own title write, so
 *   a rejected UPDATE is reported and swallowed.
 * - `commitTitle` is STRICT. The Sessions API answers `set_agent_title` only
 *   after a write that COMMITTED; swallowing here would acknowledge a title the
 *   next boot cannot read back and let main drop the only copy of the handle.
 *   A missing store therefore rejects, and a failed UPDATE reaches the caller.
 *
 * Keeping them in a module lets main's acknowledgement be tested against the
 * REAL store instead of a hand-rolled callback in a test.
 */

import type { PermissionMode } from "@anycode/core";
import type { SessionPersistence } from "./session.js";

/** The one method these seams use; `SqlitePersistenceAdapter` satisfies it. */
export interface SessionTitleStore {
  touchSession(id: string, patch: { title?: string; mode?: PermissionMode; model?: string }): Promise<void>;
}

export interface SessionTitlePersistenceDeps {
  /** The store, read at CALL time — null until boot wires one. */
  adapter(): SessionTitleStore | null;
  /** The row id this session writes (the AnyCode row id, never a native ref). */
  sessionId: string;
  /** Diagnostics for the fail-soft path; never rethrown. */
  onError(error: unknown): void;
}

function strictTitleCommit(deps: SessionTitlePersistenceDeps): (title: string) => Promise<void> {
  return (title) => {
    const adapter = deps.adapter();
    if (adapter === null) return Promise.reject(new Error("No persistence port"));
    return adapter.touchSession(deps.sessionId, { title });
  };
}

/** The CORE boot's seam: the row id is main's session id. */
export function createCoreSessionTitlePersistence(deps: SessionTitlePersistenceDeps): SessionPersistence {
  return {
    touch(patch) {
      const adapter = deps.adapter();
      if (adapter === null) return;
      return adapter.touchSession(deps.sessionId, patch).catch((error: unknown) => deps.onError(error));
    },
    commitTitle: strictTitleCommit(deps),
  };
}

/**
 * The CODEX boot's seam: same contract, plus the preset-id -> `mode` column
 * mapping that keeps the two vocabularies apart everywhere but this boundary.
 */
export function createCodexSessionTitlePersistence(deps: SessionTitlePersistenceDeps): SessionPersistence {
  return {
    touch(patch) {
      const adapter = deps.adapter();
      if (adapter === null) return;
      const { enginePreset, ...rest } = patch;
      const row = { ...rest, ...(enginePreset !== undefined ? { mode: enginePreset as PermissionMode } : {}) };
      return adapter.touchSession(deps.sessionId, row).catch((error: unknown) => deps.onError(error));
    },
    commitTitle: strictTitleCommit(deps),
  };
}
