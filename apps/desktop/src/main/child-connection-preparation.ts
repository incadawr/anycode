/**
 * Taskana 4269: prepares ONE already-resolved connection id for a child fork.
 *
 * This is `resolveResumePin`'s protocol (main/index.ts) borrowed, not
 * modified — a SYNCHRONOUS existence check + pin reservation (one microtask,
 * JS atomicity), then awaited env priming, then a post-await existence
 * re-check. A concurrent connection delete either sees the reservation and
 * refuses `connection_in_use`, or lands before it and this fails closed with
 * `{ ok: false }`; there is never a TOCTOU gap.
 *
 * Extracted from `main/index.ts`'s TabHostManager deps composition so the
 * ordering (reserve BEFORE the first await) and the release discipline
 * (exactly once, on every failure path) are unit-testable without booting the
 * whole Electron composition root.
 */

export interface ChildConnectionPreparationDeps {
  /** Synchronous existence check against the live connections registry. */
  connectionExists(connectionId: string): boolean;
  /** Synchronous pin reservation (refcount +1). */
  reserve(connectionId: string): void;
  /** Pin release (refcount -1). */
  release(connectionId: string): void;
  /** Awaited env priming for the pinned connection (may reject). */
  ensurePinnedEnv(connectionId: string): Promise<void>;
  /** True once the fork env for this connection is actually available. */
  hostEnvAvailable(connectionId: string): boolean;
}

export type ChildConnectionPreparationResult = { ok: true; release: () => void } | { ok: false };

export function createChildConnectionPreparer(
  deps: ChildConnectionPreparationDeps,
): (connectionId: string) => Promise<ChildConnectionPreparationResult> {
  return async (connectionId: string): Promise<ChildConnectionPreparationResult> => {
    // Synchronous: an unknown/deleted id is refused BEFORE any reservation, so
    // a missing id never leaves a pin behind.
    if (!deps.connectionExists(connectionId)) {
      return { ok: false };
    }
    // Synchronous reserve, before the first await (JS atomicity): a racing
    // delete sees the reservation and is refused `connection_in_use`.
    deps.reserve(connectionId);
    try {
      await deps.ensurePinnedEnv(connectionId);
    } catch {
      // A rejected env build releases the reservation and fails closed —
      // never an unhandled rejection, never a leaked pin.
      deps.release(connectionId);
      return { ok: false };
    }
    // Post-await re-check: the connection may have been deleted WHILE we
    // awaited, and existence is not availability — the env must actually be
    // present. Either way, release and fail closed.
    if (!deps.connectionExists(connectionId) || !deps.hostEnvAvailable(connectionId)) {
      deps.release(connectionId);
      return { ok: false };
    }
    let released = false;
    return {
      ok: true,
      // Idempotent: the caller may invoke this in a `finally` that also
      // covers paths which already released internally.
      release: (): void => {
        if (!released) {
          released = true;
          deps.release(connectionId);
        }
      },
    };
  };
}
