export const CHILD_WORKTREE_CHANNEL = "anycode:child-worktrees";
export interface ChildWorktreeRequest { tabId: string; enabled?: boolean }
export interface ChildWorktreeView {
  enabled: boolean;
  canToggle: boolean;
  lastRefusal?: string;
  unverified?: Array<{ id: string; reason: string }>;
  resources: Array<{ id: string; childSessionId: string; path: string; branch: string;
    baseSha: string; phase: string; reason: string | null }>;
}
