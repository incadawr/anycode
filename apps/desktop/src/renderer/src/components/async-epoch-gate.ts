/**
 * Guards CodexRolloutImportDialog's async effects (F1, codex-profiles cut
 * lane FXH review) against out-of-order resolution: a fast profile/file
 * switch fires a new `bridge.rolloutList`/`rolloutPreview` request before the
 * previous one settles, and without an epoch check a stale reply can land
 * after — and overwrite — a newer selection's state. `next()` mints a token
 * and retires every earlier one; `isCurrent` is only ever true for the most
 * recently minted token (or none, after `invalidate()`).
 */
export interface AsyncEpochGate {
  next(): number;
  isCurrent(epoch: number): boolean;
  invalidate(): void;
}

export function createAsyncEpochGate(): AsyncEpochGate {
  let issued = 0;
  let current = -1;
  return {
    next() {
      issued += 1;
      current = issued;
      return current;
    },
    isCurrent(epoch) {
      return epoch === current;
    },
    invalidate() {
      current = -1;
    },
  };
}

/**
 * Issues `request` under a fresh epoch and applies its result only if no
 * newer `next()`/`invalidate()` call has superseded it by the time it
 * settles — so a slow, stale reply can never overwrite a newer one's state,
 * regardless of resolution order.
 */
export function issueGuarded<T>(gate: AsyncEpochGate, request: Promise<T>, apply: (result: T) => void): void {
  const epoch = gate.next();
  void request.then((result) => {
    if (gate.isCurrent(epoch)) {
      apply(result);
    }
  });
}
