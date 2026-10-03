import type { EngineId } from "../../shared/engines.js";

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
        if (!disposed && current === epoch) apply(engineIds.some((engine) => engine !== "core"), engineIds);
      },
      () => {
        if (!disposed && current === epoch) apply(false, []);
      },
    );
  };
  const unsubscribe = bridge.onEnginesChanged?.(refresh);
  refresh();
  return () => { disposed = true; unsubscribe?.(); };
}
