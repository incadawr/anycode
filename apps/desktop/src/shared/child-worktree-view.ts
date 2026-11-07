export const CHILD_WORKTREE_CHANNEL = "anycode:child-worktrees";
export const CHILD_WORKTREE_LIMITATION = "Separate Git checkout, not a security sandbox. Absolute paths and shell commands can still modify files outside the child worktree. New children start from the parent's committed HEAD; uncommitted files are not copied.";
export interface ChildWorktreeRequest { tabId: string; enabled?: boolean }
export interface ChildWorktreeView {
  enabled: boolean;
  canToggle: boolean;
  lastRefusal?: string;
  unverified?: Array<{ id: string; reason: string }>;
  resources: Array<{ id: string; childSessionId: string; path: string; branch: string;
    baseSha: string; phase: string; reason: string | null }>;
}
