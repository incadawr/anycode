import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { guardedIpcHandle } from "./ipc-guard.js";
import type { TabHost } from "./tabs.js";
import type { ChildWorktreeResources } from "./child-worktree-resource.js";
import { CHILD_WORKTREE_CHANNEL, type ChildWorktreeView } from "../shared/child-worktree-view.js";
const request = z.object({ tabId: z.string().min(1), enabled: z.boolean().optional() }).strict();
export function registerChildWorktreeIpc(deps: {
  userData: string; appRunId: string; resources: Pick<ChildWorktreeResources, "read">;
  getTab: (id: string) => TabHost | undefined;
}): void {
  guardedIpcHandle(CHILD_WORKTREE_CHANNEL, async (_event, raw): Promise<ChildWorktreeView> => {
    const q = request.parse(raw), tab = deps.getTab(q.tabId);
    if (!tab || tab.state !== "running") throw new Error("Live session required");
    const canToggle = !tab.childOf && !tab.childWorktree;
    if (q.enabled !== undefined) {
      if (!canToggle) throw new Error("Only a parent session can change child worktree policy");
      tab.childWorktreePolicy = q.enabled;
    }
    const view: ChildWorktreeView = { enabled: tab.childWorktreePolicy === true, canToggle,
      lastRefusal: tab.childWorktreeRefusal, resources: [] };
    const project = await realpath(tab.projectRoot);
    let files: string[];
    try { files = await readdir(join(deps.userData, "child-worktrees")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return view; throw error; }
    for (const file of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const r = await deps.resources.read(file.slice(0, -5));
      if (r.projectRoot !== project || (!canToggle && r.childSessionId !== tab.sessionId)) continue;
      const stale = r.appRunId !== deps.appRunId && ["intent", "active"].includes(r.phase);
      view.resources.push({ id: r.id, childSessionId: r.childSessionId, path: r.path, branch: r.branch,
        baseSha: r.baseSha, phase: stale ? "unknown" : r.phase,
        reason: stale ? "Previous app run; completion unconfirmed. Inspect manually; no automatic cleanup." : r.reason });
    }
    return view;
  }, { mainWindowOnly: true });
}
