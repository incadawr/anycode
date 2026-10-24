/**
 * Child spawn-mode cell (Taskana 4704 §A1 / R1): the permission mode a
 * session-tier child is spawned under, read by the host's child-session port
 * through `getPermissionMode`. host/index.ts builds ONE cell per boot and the
 * test harness builds the SAME cell (no copy), so a behavioural test pins the
 * production wiring, not a re-implementation of it.
 *
 * Before a Session exists (the child port is constructed first) the cell
 * derives the answer from the loop config. Once the Session exists, every read
 * delegates to `Session.childSpawnMode()` — the Session owns the orchestrate
 * state, so the two can never drift.
 *
 * The pre-orchestrate mode is captured in `onOrchestrateChanged(true)`, which
 * fires AFTER the Session already flipped `config.mode` to `plan`; the Session's
 * own `childSpawnPreOrchestrateMode()` (captured before the flip) is the honest
 * source in that case.
 */

import type { PermissionMode } from "@anycode/core";

/** The slice of Session the cell consults. */
export interface SpawnModeSession {
  childSpawnMode(): PermissionMode;
  childSpawnPreOrchestrateMode(): PermissionMode | undefined;
}

/** The slice of the loop config the cell reads and maintains. */
export interface SpawnModeConfig {
  mode: PermissionMode;
  orchestrate?: boolean;
}

export interface SpawnModeCell {
  /** The mode a child spawned right now would run under. */
  read(): PermissionMode;
  /** Host hook for Session's onOrchestrateChanged: keeps config.orchestrate in step. */
  onOrchestrateChanged(enabled: boolean): void;
}

export function createSpawnModeCell(
  config: SpawnModeConfig,
  getSession: () => SpawnModeSession | null,
): SpawnModeCell {
  let preOrchestrateMode: PermissionMode | undefined;
  return {
    read(): PermissionMode {
      const session = getSession();
      if (session !== null) {
        return session.childSpawnMode();
      }
      if (!config.orchestrate) {
        return config.mode;
      }
      const pre = preOrchestrateMode ?? "build";
      return pre === "plan" ? "build" : pre;
    },
    onOrchestrateChanged(enabled: boolean): void {
      if (enabled) {
        const session = getSession();
        preOrchestrateMode =
          config.mode === "plan" && session !== null
            ? (session.childSpawnPreOrchestrateMode() ?? config.mode)
            : config.mode;
        config.orchestrate = true;
      } else {
        preOrchestrateMode = undefined;
        delete config.orchestrate;
      }
    },
  };
}
