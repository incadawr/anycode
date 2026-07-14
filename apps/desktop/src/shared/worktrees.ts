/** Main↔host control-plane contract for relocating one existing session/tab. */
export const WORKTREE_TRANSITION_MESSAGE_TYPE = "anycode:worktree-transition" as const;

export interface WorktreeIdentity {
  id: string;
  path: string;
  branch: string;
  baseRef: string;
  ownedByAnyCode: boolean;
}

export interface WorktreeCleanupIntent {
  path: string;
  mode: "auto" | "keep" | "remove";
  ownedByAnyCode: boolean;
}

export interface WorktreeTransitionMessage {
  type: typeof WORKTREE_TRANSITION_MESSAGE_TYPE;
  sessionId: string;
  fromWorkspace: string;
  toWorkspace: string;
  projectRoot: string;
  worktree?: WorktreeIdentity;
  cleanup?: WorktreeCleanupIntent;
}

export const WORKTREE_CLEANUP_ENV = "ANYCODE_WORKTREE_CLEANUP_JSON" as const;
