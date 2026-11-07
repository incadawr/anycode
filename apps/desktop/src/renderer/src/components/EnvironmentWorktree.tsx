import type { ConnectionPhase, TurnState } from "../store.js";
import type { WorktreeProjection } from "../../../shared/protocol.js";
import { Button } from "../ui/index.js";
import { useTabSend, useTabStore } from "../tab-context.js";

export interface WorktreeExitControlState {
  disabled: boolean;
  title: string;
  ariaLabel: string;
}

/** Pure projection shared by the real button and its node-environment tests. */
export function worktreeExitControlState(
  turnStatus: TurnState["status"],
  connection: ConnectionPhase,
): WorktreeExitControlState {
  if (connection !== "ready") {
    return {
      disabled: true,
      title: "Exit worktree is unavailable until the host connection is ready",
      ariaLabel: "Exit worktree unavailable until the host connection is ready",
    };
  }
  if (turnStatus === "running") {
    return {
      disabled: true,
      title: "Exit worktree is unavailable while a turn is running",
      ariaLabel: "Exit worktree unavailable while a turn is running",
    };
  }
  return {
    disabled: false,
    title: "Exit worktree; AnyCode-owned worktrees with no changes, including ignored files, are removed automatically",
    ariaLabel: "Exit worktree",
  };
}

export function EnvironmentWorktree({ worktree, known, dirtyCount, parentLabel, managed }: { worktree: WorktreeProjection; known: boolean; dirtyCount: number; parentLabel?: string | undefined; managed?: boolean }) {
  const send = useTabSend();
  const turn = useTabStore(s => s.turn.status);
  const connection = useTabStore(s => s.connection);
  const exit = worktreeExitControlState(turn, connection);
  return <div className="environment-worktree-block">
    {parentLabel && <div className="environment-worktree-parent">{parentLabel}</div>}
    <div>Branch <code>{worktree.branch}</code></div>
    <div>Base <code>{worktree.baseRef}</code></div>
    <div>{managed ? "Lifecycle · Managed by the parent session" : <>On exit · {!worktree.ownedByAnyCode ? "Checkout and branch are kept" : !known ? "Checking the checkout…" : dirtyCount ? "Worktree with changes is kept" : "Removed on exit if it has no changes, including ignored files; otherwise kept"}</>}</div>
    {worktree.ownedByAnyCode && <p>Its merged branch may be removed.</p>}
    {!managed && <Button size="sm" variant="secondary" disabled={exit.disabled} title={exit.title} aria-label={exit.ariaLabel}
      onClick={() => send({ type: "exit_worktree", cleanup: "auto" })}>Exit</Button>}
  </div>;
}
