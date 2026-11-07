import { realpath } from "node:fs/promises";
import path from "node:path";
import { NodeGitAdapter } from "@anycode/core/node-git";
import { NodeExecutionAdapter } from "@anycode/core/node-execution";
import { ChildWorktreeResources, receiptsEqual, type ChildWorktreeReceipt } from "./child-worktree-resource.js";

type Disposition = { phase: "removed" | "retained" | "unknown"; reason: string };
interface SettleOptions {
  resources: ChildWorktreeResources;
  receipt: ChildWorktreeReceipt;
  // Main must prove actual host exit, stopped admission and no uncertain writers.
  // A teardown timeout or a request to kill is not this permission.
  permission: { appRunId: string; childSessionId: string; actualExit: boolean;
    admissionStopped: boolean; writersStopped: boolean };
  hasOtherClaims: (receipt: ChildWorktreeReceipt) => Promise<boolean>;
}

/** Only current-run, provably empty checkouts are eligible. Never deletes refs. */
export async function settleChildWorktree(options: SettleOptions): Promise<Disposition> {
  const { resources, permission, hasOtherClaims } = options;
  let receipt: ChildWorktreeReceipt;
  try {
    receipt = await resources.read(options.receipt.id);
    if (!receiptsEqual(receipt, options.receipt))
      return { phase: "unknown", reason: "Receipt does not match" };
  } catch { return { phase: "unknown", reason: "Receipt could not be verified" }; }
  const record = async (phase: Disposition["phase"], reason: string): Promise<Disposition> => {
    try { receipt = await resources.update(receipt, phase, reason); return { phase, reason }; }
    catch { return { phase: "unknown", reason: "Receipt update failed; manual inspection required" }; }
  };
  if (receipt.phase !== "active")
    return { phase: "unknown", reason: "Receipt is not active; automatic cleanup refused" };
  if (permission.appRunId !== receipt.appRunId || permission.childSessionId !== receipt.childSessionId ||
      !permission.actualExit || !permission.admissionStopped || !permission.writersStopped)
    return record("unknown", "Lifecycle permission does not prove safe cleanup");
  try {
    const expectedPath = path.join(receipt.storageRoot, ".anycode", "worktrees", `child-${receipt.id}`);
    if (receipt.path !== expectedPath || receipt.branch !== `anycode-wt/child-${receipt.id}` ||
        !/^[a-f0-9]{40,64}$/.test(receipt.baseSha) ||
        await realpath(receipt.storageRoot) !== receipt.storageRoot ||
        await realpath(receipt.path) !== receipt.path)
      return record("unknown", "Canonical resource identity does not match");
    if (await hasOtherClaims(receipt)) return record("unknown", "Another binding or claim exists");
    const git = new NodeGitAdapter({ cwd: receipt.storageRoot, exec: new NodeExecutionAdapter() });
    const listed = await git.worktreeList();
    if (!listed.ok) return record("unknown", "Worktree registrations could not be read");
    const mains = listed.value.filter((entry) => entry.isMain);
    const entries = listed.value.filter((entry) => entry.path === receipt.path);
    const entry = entries[0];
    if (mains.length !== 1 || mains[0]!.path !== receipt.storageRoot || entries.length !== 1 || !entry ||
        entry.isMain || entry.locked || entry.prunable || entry.detached || entry.branch !== receipt.branch)
      return record("unknown", "Owned unlocked registration could not be verified");
    if (!entry.head || !/^[a-f0-9]{40,64}$/.test(entry.head))
      return record("unknown", "Registered HEAD could not be read");
    if (entry.head !== receipt.baseSha) return record("retained", "HEAD changed; checkout and branch retained");
    const child = new NodeGitAdapter({ cwd: receipt.path, exec: new NodeExecutionAdapter() });
    const pristine = await child.worktreeIsPristine();
    if (!pristine.ok) return record("unknown", "Checkout pristine check failed");
    if (pristine.value !== true) return record("retained", "Checkout is not pristine; work retained");
    // Persist uncertainty before removal. A crash/final-write failure must never
    // leave an active receipt inviting a second automatic removal attempt.
    const pending = await record("unknown", "Empty checkout removal pending");
    if (pending.reason !== "Empty checkout removal pending") return pending;
    if (await hasOtherClaims(receipt)) return record("unknown", "Another binding or claim exists");
    const removed = await git.worktreeRemove({ path: receipt.path });
    return removed.ok ? record("removed", "Empty checkout removed; branch retained")
      : record("unknown", "Non-force removal failed");
  } catch { return record("unknown", "Resource verification or removal failed; manual inspection required"); }
}
