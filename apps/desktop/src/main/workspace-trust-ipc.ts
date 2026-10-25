/**
 * Workspace trust decision channel (Taskana 4736). The renderer answers the
 * per-tab trust question with `{ tabId, decision }` only. Main owns the folder
 * and the hash (the tab's own record, reported by its host on the control
 * channel), persists `trust`/`deny` through the core decision store, keeps
 * `once` in memory for this app run, and restarts that tab's host so the boot
 * re-decides. The store file is written tmp+rename with mode 0600.
 *
 * Taskana 4739 adds Settings → Permissions list/forget: list returns ONLY
 * `{ key, decision, decidedAt }` rows (never the hash); forget takes a `key`
 * main itself listed and treats it as an opaque lookup handle into the
 * freshly-read store (never a path). Folder keys are realpath-canonical
 * (`canonicalWorkspaceKey`), so a symlinked workspace and its target share one
 * record. Every store mutation (decide, forget, migrate) is serialised
 * through one promise queue so concurrent read-modify-writes cannot lose an
 * update.
 */

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ipcMain } from "electron";
import {
  canonicalWorkspaceKey,
  defaultTrustStorePath,
  forgetTrustDecision,
  readTrustStore,
  writeTrustDecision,
  type TrustStoreFs,
} from "@anycode/core/workspace-trust";
import {
  WORKSPACE_TRUST_DECIDE_CHANNEL,
  WORKSPACE_TRUST_FORGET_CHANNEL,
  WORKSPACE_TRUST_LIST_CHANNEL,
  workspaceTrustDecideSchema,
  workspaceTrustForgetSchema,
  type WorkspaceTrustDecideResult,
  type WorkspaceTrustForgetResult,
  type WorkspaceTrustListResult,
} from "../shared/workspace-trust.js";

/** Node adapter for the four file operations the trust store needs (no core barrel import). */
export const nodeTrustStoreFs: TrustStoreFs = {
  exists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (path) => readFile(path, "utf8"),
  writeFile: async (path, content, opts) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: "utf8", mode: opts?.mode });
  },
  rename: (from, to) => rename(from, to),
};

/** The tab surface the decision needs: its pending question, forgetting it, and a deliberate restart. */
export interface WorkspaceTrustTabs {
  workspaceTrustPendingFor(
    tabId: string,
  ): { workspace: string; hash: string } | "unknown_tab" | "no_pending";
  clearWorkspaceTrustPending(tabId: string): void;
  restartTabHost(tabId: string): { ok: true } | { ok: false; reason: string };
}

export interface WorkspaceTrustIpcDeps {
  fs: TrustStoreFs;
  /** The user's home; the store lives at `<home>/.anycode/workspace-trust.json`. */
  home: string;
  tabs: WorkspaceTrustTabs;
  /** canonical folder -> hash approved "once" for this app run. Never persisted. */
  onceApprovals: Map<string, string>;
  now?: () => string;
  logger?: { error(message: string): void };
  /**
   * Taskana 4739: canonical folder keys are realpath-canonical when this is
   * present. Defaults to `node:fs`'s realpathSync in production; tests inject
   * a fake. Must stay SYNCHRONOUS — `workspaceTrustOnceFor` runs on the tab
   * fork path.
   */
  realpathSync?: (path: string) => string;
}

/**
 * S6: one serialisation queue for every store mutation. Decide, forget and
 * the startup migration are all read-modify-write cycles over the same file;
 * running them concurrently could lose an update (the second read happens
 * before the first write lands). `queueStoreMutation` chains them.
 */
const storeMutations: { tail: Promise<unknown> } = { tail: Promise.resolve() };

export function queueStoreMutation<T>(op: () => Promise<T>): Promise<T> {
  const next = storeMutations.tail.then(op, op);
  // Keep the queue alive even when an op rejects (the caller still sees the
  // error; later ops must not be skipped).
  storeMutations.tail = next.catch(() => undefined);
  return next;
}

/** The in-memory "trust once" hash for a workspace, if the user approved it this run. */
export function workspaceTrustOnceFor(
  onceApprovals: ReadonlyMap<string, string>,
  workspace: string,
  realpathSync?: (path: string) => string,
): string | undefined {
  return onceApprovals.get(canonicalWorkspaceKey(workspace, realpathSync));
}

export async function handleWorkspaceTrustDecide(
  deps: WorkspaceTrustIpcDeps,
  raw: unknown,
): Promise<WorkspaceTrustDecideResult> {
  const parsed = workspaceTrustDecideSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { tabId, decision } = parsed.data;
  const pending = deps.tabs.workspaceTrustPendingFor(tabId);
  if (pending === "unknown_tab") {
    return { ok: false, reason: "unknown_tab" };
  }
  if (pending === "no_pending") {
    return { ok: false, reason: "no_pending" };
  }

  // Taskana 4739: canonicalise BEFORE the write and BEFORE keying the
  // once-approval, so a symlinked workspace and its target share one record.
  const key = canonicalWorkspaceKey(pending.workspace, deps.realpathSync);

  if (decision === "once") {
    deps.onceApprovals.set(key, pending.hash);
  } else {
    try {
      await queueStoreMutation(() =>
        writeTrustDecision(
          deps.fs,
          defaultTrustStorePath(deps.home),
          key,
          decision === "trust" ? "trusted" : "denied",
          pending.hash,
          deps.now?.() ?? new Date().toISOString(),
        ),
      );
    } catch (error) {
      deps.logger?.error(
        `[main] workspace trust decision not saved: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false, reason: "write_failed" };
    }
  }

  deps.tabs.clearWorkspaceTrustPending(tabId);
  const restart = deps.tabs.restartTabHost(tabId);
  if (!restart.ok) {
    // The decision is recorded; the next boot of this tab applies it.
    deps.logger?.error(`[main] workspace trust decided for tab ${tabId}; host restart skipped (${restart.reason})`);
  }
  return { ok: true };
}

/**
 * Settings → Permissions list (Taskana 4739). Returns ONLY display rows
 * `{ key, decision, decidedAt }` — never the hash, never file contents.
 */
export async function handleWorkspaceTrustList(
  deps: WorkspaceTrustIpcDeps,
): Promise<WorkspaceTrustListResult> {
  try {
    const store = await readTrustStore(deps.fs, defaultTrustStorePath(deps.home));
    const folders = Object.keys(store.folders)
      .sort()
      .map((key) => {
        const record = store.folders[key]!;
        return { key, decision: record.decision, decidedAt: record.decidedAt };
      });
    return { ok: true, folders };
  } catch (error) {
    deps.logger?.error(
      `[main] workspace trust list failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, reason: "read_failed" };
  }
}

/**
 * Settings → Permissions "Forget" (Taskana 4739). The `key` is an opaque
 * lookup handle into the FRESHLY-READ store — main never resolves it, never
 * uses it as a file path, and never logs it unescaped. A key that is not an
 * own property of the store's `folders` (including `__proto__`/`constructor`)
 * is `not_found` and writes nothing.
 */
export async function handleWorkspaceTrustForget(
  deps: WorkspaceTrustIpcDeps,
  raw: unknown,
): Promise<WorkspaceTrustForgetResult> {
  const parsed = workspaceTrustForgetSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const { key } = parsed.data;
  try {
    const forgot = await queueStoreMutation(() => forgetTrustDecision(deps.fs, defaultTrustStorePath(deps.home), key));
    if (!forgot) {
      return { ok: false, reason: "not_found" };
    }
    // S8: forget never grants anything — drop the in-memory "trust once"
    // approval for the same key too, so the folder is asked again at the next
    // open even within this app run.
    deps.onceApprovals.delete(key);
    return { ok: true };
  } catch (error) {
    deps.logger?.error(
      `[main] workspace trust forget failed for ${JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}…` : key)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, reason: "write_failed" };
  }
}

export function registerWorkspaceTrustIpc(deps: WorkspaceTrustIpcDeps): void {
  ipcMain.handle(WORKSPACE_TRUST_DECIDE_CHANNEL, (_event, raw: unknown) => handleWorkspaceTrustDecide(deps, raw));
  ipcMain.handle(WORKSPACE_TRUST_LIST_CHANNEL, () => handleWorkspaceTrustList(deps));
  ipcMain.handle(WORKSPACE_TRUST_FORGET_CHANNEL, (_event, raw: unknown) => handleWorkspaceTrustForget(deps, raw));
}
