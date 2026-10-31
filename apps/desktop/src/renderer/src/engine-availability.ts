import type { EngineId } from "../../shared/engines.js";
import { useTabsStore } from "./tabs-store.js";

/**
 * Readiness publication for the shell store — the ONE place a pane may read
 * readiness from. Every watcher below publishes here, so a surface that
 * subscribed once (the Roles editor, the first-run role dialog) sees an engine
 * that signs in while it is already open. A reader that sampled the store with
 * `getState()` or kept its own copy is why a ready engine could read "not
 * connected".
 *
 * ORDER across publishers, not just within one: several surfaces ask main for
 * the same list (the shell watcher, the Codex pane's re-check listener). Each
 * request takes a ticket; a response may publish only while its ticket is the
 * newest issued. Without this, an OLDER request that resolves late can restore
 * a stale verdict — a ready engine flips back to "not connected" and the Roles
 * editor re-selects a preset that no longer fits.
 */
let latestRequest = 0;

/** Take the newest readiness ticket. Every request, from any surface, calls this once. */
export function beginEngineAvailabilityRequest(): number {
  latestRequest += 1;
  return latestRequest;
}

/**
 * Publish a confirmed verdict. With a ticket, the verdict is dropped when a
 * newer request has been issued since — the newest answer wins regardless of
 * resolution order. Without one (a caller that already knows it is the newest
 * authority) the write always lands. Returns whether it landed.
 */
export function publishEngineAvailability(engineIds: readonly EngineId[], request?: number): boolean {
  if (request !== undefined && request !== latestRequest) {
    return false;
  }
  useTabsStore.getState().setAvailableEngines(engineIds);
  return true;
}

/**
 * Ask for the shell list and publish the answer only if no newer request was
 * issued meanwhile. Fire-and-forget: panes that only mirror the shell list (the
 * Codex pane's `onEnginesChanged` listener) use THIS, never a bare
 * `setAvailableEngines`, so their request joins the same order.
 */
export function refreshEngineAvailability(bridge: {
  listAvailableEngines(): Promise<{ engineIds: EngineId[] }>;
}): number {
  const request = beginEngineAvailabilityRequest();
  void bridge.listAvailableEngines().then(
    ({ engineIds }) => {
      publishEngineAvailability(engineIds, request);
    },
    () => {
      publishEngineAvailability([], request);
    },
  );
  return request;
}

/** Subscribe before reading so a login/install completion cannot be missed. */
export function watchExternalEngines(
  bridge: {
    listAvailableEngines(): Promise<{ engineIds: EngineId[] }>;
    onEnginesChanged?(callback: () => void): () => void;
  },
  apply: (available: boolean, engineIds: EngineId[]) => void,
): () => void {
  let disposed = false;
  let epoch = 0;
  const refresh = (): void => {
    const current = ++epoch;
    const request = beginEngineAvailabilityRequest();
    // A superseded verdict is neither published NOR applied: the local epoch
    // covers this watcher's own out-of-order responses, the ticket covers a
    // competing publisher's newer one.
    const settle = (engineIds: EngineId[], available: boolean): void => {
      if (disposed || current !== epoch) return;
      if (publishEngineAvailability(engineIds, request)) {
        apply(available, engineIds);
      }
    };
    void bridge.listAvailableEngines().then(
      ({ engineIds }) => settle(engineIds, engineIds.some((engine) => engine !== "core")),
      () => settle([], false),
    );
  };
  const unsubscribe = bridge.onEnginesChanged?.(refresh);
  refresh();
  return () => { disposed = true; unsubscribe?.(); };
}
