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
    title: "Exit worktree; clean AnyCode-owned worktrees are removed automatically",
    ariaLabel: "Exit worktree",
  };
}

export function EnvironmentWorktree({ worktree, known, dirtyCount }: { worktree: WorktreeProjection; known: boolean; dirtyCount: number }) {
  const send = useTabSend();
  const turn = useTabStore(s => s.turn.status);
  const connection = useTabStore(s => s.connection);
  const exit = worktreeExitControlState(turn, connection);
  return <div className="environment-worktree-block">
    <div>Branch <code>{worktree.branch}</code></div>
    <div>Base <code>{worktree.baseRef}</code></div>
    <div>On exit · {!worktree.ownedByAnyCode ? "Checkout and branch are kept" : !known ? "Checking checkout; changes are kept" : dirtyCount ? "Worktree with changes is kept" : "Empty worktree is removed"}</div>
    <p>{worktree.ownedByAnyCode ? "Empty worktree is removed on exit; its merged branch may be removed. A worktree with changes is kept as is." : "Checkout and branch are kept on exit."}</p>
    <Button size="sm" variant="secondary" disabled={exit.disabled} title={exit.title} aria-label={exit.ariaLabel}
      onClick={() => send({ type: "exit_worktree", cleanup: "auto" })}>Exit</Button>
  </div>;
}
