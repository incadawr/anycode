/**
 * Tab control-plane IPC handlers (design/phase-2.md §3.2/§4.1): the three
 * `ipcMain.handle` endpoints the renderer drives via its contextBridge `anycode`
 * object. Requests are zod-validated here — main is the trust boundary for the

 * page is parsed before it reaches the manager/persistence.
 *
 * zod is imported directly (a direct dep of @anycode/desktop), NOT through the
 * @anycode/core barrel: routing runtime schemas through the barrel would bundle
 * core's ai-SDK runtime into the thin main process. The channel constants + wire
 * types come from shared/tabs.ts (value-only, no zod), the persistence access
 * point from the @anycode/core/persistence subpath (via main/index.ts wiring).
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { ipcMain } from "electron";
import { z } from "zod";
import type { PersistencePort, SessionMeta } from "@anycode/core";
import {
  ENGINES_LIST_CHANNEL,
  SESSIONS_LIST_CHANNEL,
  TAB_CLOSE_CHANNEL,
  TAB_CREATE_CHANNEL,
  WORKSPACE_PICK_CHANNEL,
} from "../shared/tabs.js";
import type {
  AvailableEngines,
  CloseTabResult,
  CreateTabRequest,
  CreateTabResult,
  SessionSummary,
  WorkspacePickResult,
} from "../shared/tabs.js";
import type { TabHostManager } from "./tabs.js";
import { isEngineId } from "../shared/engines.js";

/** Structural view of dialog.showOpenDialog (injected so main owns the real one). */
export interface DialogLike {
  showOpenDialog(options: {
    properties: Array<"openDirectory">;
    defaultPath?: string;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/**
 * Resolution of a resumed session's pinned provider connection (TASK.45 W10):
 * `ok` with the connection id to re-pin the tab to (undefined = a legacy session
 * with no pin — resume on the current default, documented behaviour), or a
 * refusal carrying the deleted connection's id (the renderer offers a
 * replacement instead of silently switching accounts).
 *
 * TASK.45 W10-FIX F3: the `ok` branch carries a `release` the caller MUST invoke
 * (in a `finally`) once the tab is registered or on any failure — it drops the
 * synchronous pin reservation that guards the resume/delete race. Optional so
 * legacy wiring / unit fixtures that don't reserve stay source-compatible.
 */
export type ResumePinResult =
  | { ok: true; connectionId?: string; release?: () => void }
  | { ok: false; connectionId: string };

export interface TabIpcDeps {
  manager: TabHostManager;
  /**
   * The picker/resume reads main uses (§2.3), plus `touchSession` (W10-FIX F1):
   * re-pinning a resumed session to a replacement connection writes only
   * `SessionMetaPatch.connectionId` (already part of the core port — ZERO core
   * delta). No other new port methods needed.
   */
  persistence: Pick<PersistencePort, "getSession" | "listSessions" | "touchSession">;
  dialog: DialogLike;
  /** Production gate proves the path is still a registered worktree on the persisted branch. */
  validateWorktreeResume?(meta: SessionMeta): Promise<boolean>;
  /**
   * The active provider connection id, pinned onto a NEW core session at creation
   * (TASK.45 W10). Undefined = no default configured (a fresh install, or an
   * env-override boot) — the tab stays unpinned and runs on the current default.
   * Never consulted for a non-core engine (Codex owns its own account).
   */
  activeConnectionId?(): string | undefined;
  /**
   * Resolves the connection a RESUMED session is pinned to (TASK.45 W10). Absent
   * = pinning disabled (legacy wiring / unit fixtures) so resume behaves as before.
   */
  resolveResumePin?(meta: SessionMeta): Promise<ResumePinResult>;
}

/** exported for tests (tab-ipc.test.ts): the fail-closed request schema. */
export const createTabRequestSchema: z.ZodType<CreateTabRequest> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("new"),
    workspace: z.string().min(1).max(4096).optional(),
    engine: z.enum(["core", "codex"]).optional(),
    // W3 join: bounds only (a hostile-length string). IDENTITY is the host's
    // job (its own live catalog / frozen preset table), never main's.
    engineModel: z.string().min(1).max(128).optional(),
    enginePreset: z.string().min(1).max(128).optional(),
  }),
  z.object({
    kind: z.literal("resume"),
    sessionId: z.string().min(1),
    // W10-FIX F1: additive-optional re-pin target (bounds only — main validates
    // existence against live settings via resolveResumePin, never trusts the id).
    replacementConnectionId: z.string().min(1).max(128).optional(),
  }),
]);

const closeTabRequestSchema = z.object({ tabId: z.string().min(1) });

function toSummary(meta: SessionMeta, manager: TabHostManager): SessionSummary {
  const openInTabId = manager.sessionOpenInTab(meta.id);
  return {
    id: meta.id,
    workspace: meta.workspace,
    ...(meta.projectRoot !== undefined ? { projectRoot: meta.projectRoot } : {}),
    ...(meta.worktree !== undefined ? { worktree: meta.worktree } : {}),
    model: meta.model,
    mode: meta.mode,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(openInTabId !== undefined ? { openInTabId } : {}),
  };
}

/**
 * tab-create (§3.2 CreateTabResult) — exported for tests (tab-ipc.test.ts):
 *  - new: capacity-guard -> workspace source (GUI-P1: a preselected
 *    `req.workspace` skips the dialog; otherwise showOpenDialog, cancel ->
 *    "cancelled") -> fresh uuid session -> spawn + deliver.
 *  - resume: getSession (missing -> "session_not_found") -> already_open guard

 * MAX_TABS is enforced authoritatively by manager.createTab.
 */
export async function handleCreate(deps: TabIpcDeps, req: CreateTabRequest): Promise<CreateTabResult> {

  // reading persistence (createTab is the authoritative guard; this avoids a
  // pointless dialog). Renderer maps not_ready to a "configure your provider"
  // notice.
  if (req.kind === "new") {
    const engine = req.engine ?? "core";
    if (!deps.manager.canSpawn(engine)) {
      return { ok: false, reason: "not_ready" };
    }
    // Guard capacity BEFORE prompting: never make the user pick a folder we
    // cannot open (UI also disables "+" at capacity, this is the backstop).
    if (deps.manager.atCapacity()) {
      return { ok: false, reason: "max_tabs" };
    }

    // DEV facade) is used verbatim, skipping the folder dialog. No existence
    // check — parity with the resume branch, which boots into a possibly-vanished
    // meta.workspace today. Absent workspace ⇒ dialog path, byte-equivalent to
    // pre-GUI-P1 (cancel -> "cancelled" no-op).
    let workspace: string;
    if (req.workspace !== undefined) {
      workspace = req.workspace;
    } else {
      const picked = await deps.dialog.showOpenDialog({ properties: ["openDirectory"], defaultPath: homedir() });
      const dialogWorkspace = picked.filePaths[0];
      if (picked.canceled || dialogWorkspace === undefined) {
        return { ok: false, reason: "cancelled" };
      }
      workspace = dialogWorkspace;
    }
    // TASK.45 W10: a NEW core session is pinned to the active connection at
    // creation (main stamps it into the fork env, the host persists it), so a
    // later default-switch never retargets this session's account. Codex owns
    // its own account, so a codex tab is never pinned to a core connection.
    const newConnectionId = engine === "core" ? deps.activeConnectionId?.() : undefined;
    const result = deps.manager.createTab({
      workspace,
      sessionId: randomUUID(),
      resume: false,
      ...(req.engine !== undefined ? { engine } : {}),
      // W3 join: forwarded verbatim (bounded above); manager.createTab (main/
      // tabs.ts) re-bounds via argvId and rides them into argv ONLY on this
      // session-creating spawn.
      ...(req.engineModel !== undefined ? { engineModel: req.engineModel } : {}),
      ...(req.enginePreset !== undefined ? { enginePreset: req.enginePreset } : {}),
      ...(newConnectionId !== undefined ? { connectionId: newConnectionId } : {}),
    });
    if (!result.ok) {
      return result;
    }
    deps.manager.deliverTabPort(result.tab);
    return { ok: true, tabId: result.tab.tabId, workspace: result.tab.workspace };
  }

  const meta = await deps.persistence.getSession(req.sessionId);
  if (meta === null) {
    return { ok: false, reason: "session_not_found" };
  }
  if (meta.worktree !== undefined) {
    if (meta.workspace !== meta.worktree.path || !existsSync(meta.worktree.path)) {
      return { ok: false, reason: "worktree_unavailable", worktreePath: meta.worktree.path };
    }
    if (deps.validateWorktreeResume !== undefined && !(await deps.validateWorktreeResume(meta))) {
      return { ok: false, reason: "worktree_unavailable", worktreePath: meta.worktree.path };
    }
  }
  // A resumed engine is persisted host metadata, never renderer input. Old
  // rows have no identity and remain the historical core engine.
  const engine = meta.engineId ?? "core";
  if (!isEngineId(engine) || !deps.manager.canSpawn(engine)) {
    return { ok: false, reason: "not_ready" };
  }
  const openInTabId = deps.manager.sessionOpenInTab(req.sessionId);
  if (openInTabId !== undefined) {
    return { ok: false, reason: "already_open", focusTabId: openInTabId };
  }
  // TASK.45 W10: resume resolves the connection the session was pinned to. A
  // deleted pin refuses `connection_missing` (renderer offers a replacement — no
  // silent switch to the current default); a legacy session (no pin) resolves
  // `{ok:true}` with no connectionId and resumes on the current default.
  let pinnedConnectionId: string | undefined;
  // W11-FIX M5: `releasePin` is assigned in the SAME synchronous continuum as
  // the ok-pin is obtained (immediately after each `resolveResumePin` await
  // settles, before any further await) and `try` wraps everything from the
  // FIRST reservation onward — including `touchSession` — so a rejection at
  // ANY point after a reservation exists (e.g. a SQLite write failure) still
  // hits `finally` and releases it. Previously `touchSession`'s await sat
  // OUTSIDE the try/finally, so its rejection leaked the replacement's
  // reservation forever (`connectionInUse` refused that connection's delete
  // until an app restart).
  let releasePin: (() => void) | undefined;
  try {
    if (deps.resolveResumePin !== undefined) {
      let pin = await deps.resolveResumePin(meta);
      if (pin.ok) {
        releasePin = pin.release;
      }
      // W10-FIX F1: a DEAD stored pin + an explicit user-chosen replacement re-targets
      // the session to the replacement, then resumes on the replacement's pinned path.
      // A live stored pin ignores the replacement entirely (never retarget a healthy
      // pin); a replacement that is itself gone stays refused `connection_missing`.
      if (!pin.ok && req.replacementConnectionId !== undefined) {
        const retargeted = await deps.resolveResumePin({ ...meta, connectionId: req.replacementConnectionId });
        if (!retargeted.ok) {
          return { ok: false, reason: "connection_missing", connectionId: retargeted.connectionId };
        }
        releasePin = retargeted.release;
        // Persist the re-pin BEFORE createTab so the host reads the new connection on
        // spawn. touchSession writes only connectionId (SessionMetaPatch, zero core delta).
        await deps.persistence.touchSession(req.sessionId, { connectionId: req.replacementConnectionId });
        pin = retargeted;
      }
      if (!pin.ok) {
        return { ok: false, reason: "connection_missing", connectionId: pin.connectionId };
      }
      pinnedConnectionId = pin.connectionId;
    }
    const result = deps.manager.createTab({
      workspace: meta.workspace,
      ...(meta.projectRoot !== undefined ? { projectRoot: meta.projectRoot } : {}),
      ...(meta.worktree !== undefined ? { worktree: meta.worktree } : {}),
      sessionId: req.sessionId,
      resume: true,
      engine,
      ...(pinnedConnectionId !== undefined ? { connectionId: pinnedConnectionId } : {}),
    });
    if (!result.ok) {
      return result;
    }
    deps.manager.deliverTabPort(result.tab);
    return { ok: true, tabId: result.tab.tabId, workspace: result.tab.workspace };
  } finally {
    releasePin?.();
  }
}

/**
 * The New Session start screen's folder control (slice P7.12 §4.4) — exported
 * for tests (tab-ipc.test.ts): no request payload, reuses the same injected
 * `DialogLike` as the legacy no-workspace `handleCreate` branch above. Cancel
 * (or an empty pick) -> `{ workspace: null }`.
 */
export async function handleWorkspacePick(deps: TabIpcDeps): Promise<WorkspacePickResult> {
  const picked = await deps.dialog.showOpenDialog({ properties: ["openDirectory"], defaultPath: homedir() });
  const workspace = picked.filePaths[0];
  return { workspace: picked.canceled || workspace === undefined ? null : workspace };
}

/**
 * Registers the four invoke handlers on ipcMain (design §4.1/§4.4). Each
 * validates its request; a malformed payload is rejected with the safe
 * negative result of that channel rather than throwing across the bridge.
 */
export function registerTabIpc(deps: TabIpcDeps): void {
  ipcMain.handle(TAB_CREATE_CHANNEL, async (_event, raw: unknown): Promise<CreateTabResult> => {
    const parsed = createTabRequestSchema.safeParse(raw);
    if (!parsed.success) {
      // A create request main cannot understand is treated as a no-op cancel.
      return { ok: false, reason: "cancelled" };
    }
    return handleCreate(deps, parsed.data);
  });

  ipcMain.handle(TAB_CLOSE_CHANNEL, async (_event, raw: unknown): Promise<CloseTabResult> => {
    const parsed = closeTabRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, reason: "unknown_tab" };
    }
    return deps.manager.closeTab(parsed.data.tabId);
  });

  ipcMain.handle(SESSIONS_LIST_CHANNEL, async (): Promise<SessionSummary[]> => {
    const sessions = await deps.persistence.listSessions();
    return sessions.map((meta) => toSummary(meta, deps.manager));
  });

  ipcMain.handle(WORKSPACE_PICK_CHANNEL, async (): Promise<WorkspacePickResult> => handleWorkspacePick(deps));

  ipcMain.handle(ENGINES_LIST_CHANNEL, (): AvailableEngines => ({
    engineIds: (["core", "codex"] as const).filter((engine) => deps.manager.canSpawn(engine)),
  }));
}
