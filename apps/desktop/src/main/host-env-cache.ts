/**
 * the per-pinned-connection env cache merge. `refreshProviderState`
 * rebuilds the cache from a snapshot of REGISTERED pins taken BEFORE its awaits,
 * then replaces the cache wholesale. A pin primed (reserved) or registered
 * during those awaits is absent from that snapshot, so the replacement would
 * drop its freshly-built env — the tab then respawns fail-closed into
 * `crash_looped`. This pure merge re-adds any entry that is still in use
 * (reserved OR a live registered pin) and was not recomputed in `next`.
 */
export function mergeHostEnvCache(input: {
  /** The freshly rebuilt cache (from the pre-await snapshot). */
  next: Map<string, NodeJS.ProcessEnv>;
  /** The cache as it was before (and possibly during) the rebuild. */
  previous: ReadonlyMap<string, NodeJS.ProcessEnv>;
  /** True while an in-flight prime holds a reservation for the id. */
  reserved(id: string): boolean;
  /** True while a live tab is pinned to the id (registered, not just reserved). */
  livePin(id: string): boolean;
}): Map<string, NodeJS.ProcessEnv> {
  for (const [id, env] of input.previous) {
    if (!input.next.has(id) && (input.reserved(id) || input.livePin(id))) {
      input.next.set(id, env);
    }
  }
  return input.next;
}

/**
 * the rebuild `refreshProviderState` actually runs — the one
 * production call site of `mergeHostEnvCache`. Snapshots the live pin set
 * SYNCHRONOUSLY (before its first await, exactly as the old inline loop did),
 * rebuilds each non-active pin's env, then merges: an entry that was primed
 * (`ensurePinnedEnv` writes the module cache in place) or registered as a live
 * pin while those awaits were in flight is re-added instead of being dropped
 * by the wholesale replacement.
 *
 * The caller passes `previous` as the LIVE cache map (not a copy) so writes
 * that happen during the awaits are visible to the merge.
 */
export async function rebuildHostEnvCache(input: {
  /** The cache as it was before the rebuild (the live map, mutated by priming). */
  previous: ReadonlyMap<string, NodeJS.ProcessEnv>;
  /** Live pinned ids, read synchronously at call time. */
  pinned: Iterable<string>;
  /** The active connection uses `currentHostEnv`; it is never cached here. */
  activeConnectionId?: string;
  /** False for a pin whose connection record is gone (defensive). */
  connectionExists(id: string): boolean;
  buildEnv(id: string): Promise<NodeJS.ProcessEnv>;
  reserved(id: string): boolean;
  livePin(id: string): boolean;
}): Promise<Map<string, NodeJS.ProcessEnv>> {
  const snapshot = [...input.pinned];
  const next = new Map<string, NodeJS.ProcessEnv>();
  for (const id of snapshot) {
    if (id !== input.activeConnectionId && input.connectionExists(id)) {
      next.set(id, await input.buildEnv(id));
    }
  }
  return mergeHostEnvCache({
    next,
    previous: input.previous,
    reserved: input.reserved,
    livePin: input.livePin,
  });
}
