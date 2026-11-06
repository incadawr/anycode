import { normalizePeerWorkspaceKey, type SessionPeerPolicyStore } from "./session-peer-policy.js";

export type PeerOperation = "list" | "send" | "open" | "who_edits";
/** Main-authored snapshot of the current host; never derived from tool arguments. */
export interface PeerSessionFacts {
  workspace: string;
  /** Strict canonical key pinned when this workspace generation was admitted. */
  workspaceKey: string;
  live: boolean;
  root: boolean;
  restricted: boolean;
  readOnly: boolean;
}
export interface SessionPeerAccessDeps {
  enabled(): boolean;
  policy: SessionPeerPolicyStore;
  isTrusted(key: string): boolean | Promise<boolean>;
  /** Must return the same case representation used by pinned keys and trust.
   * Darwin preserves case: inject a stable realpath spelling for case aliases;
   * mismatched spellings fail closed rather than merging case-sensitive paths. */
  realpathSync(path: string): string;
  statSync(path: string): { isDirectory(): boolean };
  platform?: NodeJS.Platform;
}

export function createSessionPeerAccess(deps: SessionPeerAccessDeps) {
  const normalize = (path: string) => normalizePeerWorkspaceKey(path, deps.platform);
  const strictKey = (workspace: string, pinnedKey: string): string | null => {
    try {
      if (normalize(workspace) === null || normalize(pinnedKey) !== pinnedKey) return null;
      const realpath = deps.realpathSync(workspace);
      const key = normalize(realpath);
      if (key !== pinnedKey || !deps.statSync(realpath).isDirectory()) return null;
      return key;
    } catch { return null; }
  };
  const callerAllowed = (caller: PeerSessionFacts, operation: PeerOperation) =>
    caller.live && caller.root && !caller.restricted &&
    (!(operation === "send" || operation === "open") || !caller.readOnly);
  /** Re-run before dispatch/drain; no decision here is a reusable permit. */
  async function canAccessWorkspace(caller: PeerSessionFacts, workspace: string, pinnedKey: string,
    operation: PeerOperation, targetAllowsOpen = false): Promise<boolean> {
    try {
      if (!deps.enabled() || !callerAllowed(caller, operation)) return false;
      const from = strictKey(caller.workspace, caller.workspaceKey);
      const to = strictKey(workspace, pinnedKey);
      if (!from || !to || !await deps.isTrusted(from) || !await deps.isTrusted(to)) return false;
      if (!deps.enabled() || !callerAllowed(caller, operation)) return false;
      if (strictKey(caller.workspace, caller.workspaceKey) !== from || strictKey(workspace, pinnedKey) !== to) return false;
      if (!deps.policy.isNativeEnabled(from) || !deps.policy.isNativeEnabled(to)) return false;
      if (from === to) return true;
      if (operation === "who_edits" || !deps.policy.hasPairGrant(from, to)) return false;
      return operation !== "open" || targetAllowsOpen;
    } catch { return false; }
  }
  return {
    canAccessWorkspace,
    async canAccess(caller: PeerSessionFacts, target: PeerSessionFacts, operation: PeerOperation, targetAllowsOpen = false): Promise<boolean> {
      return target.live && target.root && !target.restricted &&
        canAccessWorkspace(caller, target.workspace, target.workspaceKey, operation, targetAllowsOpen);
    },
  };
}
