# Worktrees

AnyCode uses git worktrees in two ways. Both are separate checkouts, **not** a
security sandbox: absolute paths and shell commands can still reach other folders.

## 1. A session moves into a worktree (EnterWorktree / ExitWorktree)

Available in Native desktop sessions when the project has a `.git` entry and the
session is not itself a child worktree.

- `EnterWorktree` with `name` (new, up to 64 characters) and optional `baseRef`,
  or `existing` to enter a registered checkout. Do not combine `existing` with
  `name` or `baseRef`. With neither, AnyCode generates a name. Worktrees are created in `<project>/.anycode/worktrees/` on a branch
  `anycode-wt/<name>`. AnyCode adds `/.anycode/worktrees/` to git's exclude file.
- `ExitWorktree` with `cleanup`:
  - `auto`: removes the worktree only if AnyCode created it and it is clean;
  - `keep`: always keeps it;
  - `remove`: deletes it, and asks for approval.
- On success the session continues in the new folder. The built-in skill
  `using-git-worktrees` tells the model how to use these tools.

## 2. Child sessions in worktrees

In the parent header, open **Child worktrees** and turn on **New session children in
worktrees**. The switch is per tab, off by default, and resets when the app restarts.

- Applies to new Core session children. Claude and Codex children are refused while it is on.
- Each child gets `<project>/.anycode/worktrees/child-<id>` on branch
  `anycode-wt/child-<id>`, created from the parent's **committed** HEAD. Uncommitted
  files are not copied.
- Folder trust and access grants are not inherited.
- **Cleanup:** an empty checkout is removed after a verified safe shutdown; the branch
  stays. Dirty files, new commits, ignored caches or an uncertain writer keep the
  checkout. After a crash nothing is cleaned automatically.
- The details list (parent header) shows path, branch, base SHA and state, with Copy
  buttons. The environment menu shows the worktree row and the parent of a
  delegated worktree. Branch switching is locked for AnyCode-managed worktrees.

## Recover changes

1. `git -C '<child-path>' status` and `git -C '<child-path>' diff HEAD`. Check untracked files separately.
2. Commit in the child checkout if needed.
3. In the parent: `git diff <base-sha>..<branch>`, then merge or cherry-pick after review.

Nothing merges automatically.

## Availability and recovery

Entry relocates the same session and ends the current host segment. Continue
work after the new host is ready. A session already in a managed worktree
must exit to its project root before entering another one.

For managed child worktrees, a retained checkout can be inspected in a new
session. Managed child sessions themselves cannot resume. The resource list
can show retained or unknown state after an interrupted shutdown; inspect the
checkout before removing it. Neither cleanup nor a branch name transfers
uncommitted changes to the parent.

See [subagents](subagents.md#session-children-in-worktrees) for lifecycle
details and [files and paths](files-and-paths.md) for storage locations.
