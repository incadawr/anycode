/**
 * Host-owned worktree control plane. Core tools request a prepared workspace
 * transition through this port; they never run git or mutate session metadata
 * themselves. A successful transition is terminal for the current loop
 * segment and is carried verbatim to the host in AgentEvent.
 */

export type WorktreeCleanup = "auto" | "keep" | "remove";

export interface WorktreeIdentity {
  id: string;
  path: string;
  branch: string;
  baseRef: string;
  ownedByAnyCode: boolean;
}

export interface EnterWorktreeRequest {
  name?: string;
  baseRef?: string;
  /** Absolute path of an already-registered worktree to enter. */
  existing?: string;
}

export interface ExitWorktreeRequest {
  cleanup: WorktreeCleanup;
  /** Host chrome may relocate without asking the model to continue. */
  continueAfterRehost?: boolean;
}

export type WorkspaceTransition =
  | {
      kind: "enter_worktree";
      projectRoot: string;
      fromWorkspace: string;
      toWorkspace: string;
      worktree: WorktreeIdentity;
      toolCallId?: string;
    }
  | {
      kind: "exit_worktree";
      projectRoot: string;
      fromWorkspace: string;
      toWorkspace: string;
      worktree: WorktreeIdentity;
      cleanup: WorktreeCleanup;
      toolCallId?: string;
    };

export type WorktreeControlResult =
  | { ok: true; transition: WorkspaceTransition; message?: string }
  | { ok: false; error: string; errorKind?: "invalid_input" | "cancelled" };

export interface WorktreeControlPort {
  enter(request: EnterWorktreeRequest, options: { signal: AbortSignal; toolCallId?: string }): Promise<WorktreeControlResult>;
  exit(request: ExitWorktreeRequest, options: { signal: AbortSignal; toolCallId?: string }): Promise<WorktreeControlResult>;
}
