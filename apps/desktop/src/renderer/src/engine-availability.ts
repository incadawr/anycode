import type { EngineId } from "../../shared/engines.js";
import { useTabsStore } from "./tabs-store.js";

/**
 * The shell's live engine list — the ONE place a pane may read readiness from.
 * Every watcher below publishes here, so a surface that subscribed once (the
 * Roles editor, the first-run role dialog) sees an engine that signs in while
 * it is already open. A reader that sampled the store with `getState()` or kept
 * its own copy is why a ready engine could read "not connected".
 */
export function publishEngineAvailability(engineIds: readonly EngineId[]): void {
  useTabsStore.getState().setAvailableEngines(engineIds);
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
    void bridge.listAvailableEngines().then(
      ({ engineIds }) => {
        if (!disposed && current === epoch) {
          publishEngineAvailability(engineIds);
          apply(engineIds.some((engine) => engine !== "core"), engineIds);
        }
      },
      () => {
        if (!disposed && current === epoch) {
          publishEngineAvailability([]);
          apply(false, []);
        }
      },
    );
  };
  const unsubscribe = bridge.onEnginesChanged?.(refresh);
  refresh();
  return () => { disposed = true; unsubscribe?.(); };
}
