import { realpathSync, statSync } from "node:fs";
import { sep } from "node:path";
import type { WorktreeTransitionMessage } from "../shared/worktrees.js";
import type { ChildWorktreeReceipt } from "./child-worktree-resource.js";

/** Why a managed child host asked to be rehosted while it was still starting. */
export type ManagedStartupVerdict =
  | { ok: true; target: string }
  | { ok: false; reason: string };

export interface ManagedStartupTransitionInput {
  /** The raw control-plane message the child's host posted before exiting. */
  message: unknown;
  /** Session id of the tab whose current process sent the message. */
  sessionId: string;
  parentSessionId: string;
  /** Workspace and project root main recorded for the child tab. */
  tabWorkspace: string;
  tabProjectRoot: string;
  /** The live receipt main holds for this session. */
  receipt: ChildWorktreeReceipt | undefined;
  runState: "starting" | "running" | "cancelling";
  /** True once this run has already used its single startup recovery. */
  recoveryUsed: boolean;
  parentClosing: boolean;
  /** True while the receipt is being settled (cleanup in progress). */
  receiptSettling: boolean;
}

export type CanonicalDirectory = (path: string) => string | null;

/** Canonical path of an existing directory, or null (missing, not a directory, unreadable). */
export const canonicalDirectory: CanonicalDirectory = (path) => {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
};

const refuse = (reason: string): ManagedStartupVerdict => ({ ok: false, reason });

/**
 * Judges a worktree-transition message from a managed child's host. Only one
 * shape is recoverable: the host booted in a directory that is not the child's
 * allocated checkout and found the persisted workspace to be that checkout.
 * Everything else (any other target, a started run, a closing parent, a
 * receipt that is no longer live) stays refused.
 */
export function evaluateManagedStartupTransition(
  input: ManagedStartupTransitionInput,
  canonical: CanonicalDirectory = canonicalDirectory,
): ManagedStartupVerdict {
  const { message, receipt } = input;
  if (message === null || typeof message !== "object") return refuse("malformed transition");
  const m = message as Partial<WorktreeTransitionMessage>;
  if (typeof m.sessionId !== "string" || typeof m.fromWorkspace !== "string" || typeof m.toWorkspace !== "string" ||
      typeof m.projectRoot !== "string" || m.toWorkspace === "" || m.projectRoot === "") return refuse("malformed transition");
  if (input.recoveryUsed) return refuse("the startup recovery for this run was already used");
  if (input.runState !== "starting") return refuse("the child already started");
  if (input.parentClosing) return refuse("the parent is closing");
  if (input.receiptSettling) return refuse("the checkout is being cleaned up");
  if (receipt === undefined || receipt.phase !== "active") return refuse("no live checkout receipt");
  if (m.sessionId !== input.sessionId || receipt.childSessionId !== input.sessionId ||
      receipt.parentSessionId !== input.parentSessionId) return refuse("the checkout belongs to another session");
  if (m.worktree !== undefined || m.cleanup !== undefined) return refuse("the transition carries its own worktree");
  const target = canonical(m.toWorkspace);
  const owned = canonical(receipt.path);
  const storage = canonical(receipt.storageRoot);
  if (target === null || owned === null || storage === null) return refuse("the checkout directory is missing");
  if (target !== owned) return refuse("the target is not the allocated checkout");
  if (!owned.startsWith(`${storage}${sep}.anycode${sep}worktrees${sep}`)) return refuse("the checkout is outside the managed worktree storage");
  const from = canonical(m.fromWorkspace);
  if (from !== null && from === owned) return refuse("the host already runs in the allocated checkout");
  const root = canonical(m.projectRoot);
  // A fresh child row records the checkout itself as its project root; the
  // receipt's own project root and the tab's recorded root name the same project.
  const roots = new Set([owned, canonical(receipt.projectRoot), canonical(input.tabProjectRoot)].filter((v): v is string => v !== null));
  if (root === null || !roots.has(root)) return refuse("the project root does not match the checkout");
  return { ok: true, target: receipt.path };
}
