/**
 * Workspace trust decision channel (Taskana 4736). The renderer answers the
 * per-tab trust question with `{ tabId, decision }` only. Main owns the folder
 * and the hash (the tab's own record, reported by its host on the control
 * channel), persists `trust`/`deny` through the core decision store, keeps
 * `once` in memory for this app run, and restarts that tab's host so the boot
 * re-decides. The store file is written tmp+rename with mode 0600.
 */

import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ipcMain } from "electron";
import {
  canonicalWorkspacePath,
  defaultTrustStorePath,
  writeTrustDecision,
  type TrustStoreFs,
} from "@anycode/core/workspace-trust";
import {
  WORKSPACE_TRUST_DECIDE_CHANNEL,
  workspaceTrustDecideSchema,
  type WorkspaceTrustDecideResult,
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
}

/** The in-memory "trust once" hash for a workspace, if the user approved it this run. */
export function workspaceTrustOnceFor(
  onceApprovals: ReadonlyMap<string, string>,
  workspace: string,
): string | undefined {
  return onceApprovals.get(canonicalWorkspacePath(workspace));
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

  if (decision === "once") {
    deps.onceApprovals.set(canonicalWorkspacePath(pending.workspace), pending.hash);
  } else {
    try {
      await writeTrustDecision(
        deps.fs,
        defaultTrustStorePath(deps.home),
        pending.workspace,
        decision === "trust" ? "trusted" : "denied",
        pending.hash,
        deps.now?.() ?? new Date().toISOString(),
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

export function registerWorkspaceTrustIpc(deps: WorkspaceTrustIpcDeps): void {
  ipcMain.handle(WORKSPACE_TRUST_DECIDE_CHANNEL, (_event, raw: unknown) => handleWorkspaceTrustDecide(deps, raw));
}
