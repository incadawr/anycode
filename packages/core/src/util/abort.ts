/**
 * Propagates an abort from a parent signal to a child controller.
 * Returns a disposer that removes the listener (must be called after the
 * child operation settles to avoid leaks on long-lived parent signals).
 * If the parent is already aborted, the child is aborted synchronously.
 */
export function linkAbortSignal(parent: AbortSignal, child: AbortController): () => void {
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }

  const onAbort = () => {
    child.abort(parent.reason);
  };
  parent.addEventListener("abort", onAbort, { once: true });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    parent.removeEventListener("abort", onAbort);
  };
}

export interface TimeoutRaceResult<T> {
  timedOut: boolean;
  value?: T;
}

/**
 * Races `operation` against a timeout. On timeout the provided controller is
 * aborted with reason "timeout" so the underlying work is actually cancelled,
 * not merely abandoned. The timer is cleared when the operation settles first.
 * Rejection of the operation (before the timeout fires) is propagated to the
 * caller; a rejection that arrives after the timeout has already won is
 * swallowed so it never surfaces as an unhandled rejection.
 */
export function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<TimeoutRaceResult<T>> {
  return new Promise<TimeoutRaceResult<T>>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort("timeout");
      resolve({ timedOut: true });
    }, timeoutMs);

    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
