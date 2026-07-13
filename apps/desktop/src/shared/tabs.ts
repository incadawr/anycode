/**
 * Control-plane contract for the tab invoke-API between main and renderer
 * (design/phase-2.md §3.2, refrozen by task 2.1.1). The renderer drives tab
 * lifecycle via `ipcRenderer.invoke` (exposed through a contextBridge `anycode`
 * object in task 2.1.2); main answers with `ipcMain.handle`.
 *
 * VALUE-ONLY module with zero imports, by the exact precedent of

 * CJS), the renderer web bundle, AND main, so it must never drag zod or the
 * @anycode/core barrel into a bundle that cannot afford it. The zod schemas
 * that validate these request shapes live in main/tab-ipc.ts (a task-2.1.2
 * file, main-only), NOT here — same reasoning that keeps the runtime schemas
 * out of shared/protocol.ts's type surface.
 *
 * Nothing consumes these types yet; they are declared now so the whole 2.1
 * wave can build against a frozen contract (main-side handlers = 2.1.2,
 * renderer-side picker/TabBar = 2.1.4/2.1.5).
 *
 * Additive amendment (task 2.1.6, ratified by the integration-architect
 * ruling): `CloseTabResult` below is added to close the gap left by the freeze
 * — main (2.1.2) and the renderer (2.1.4/2.1.5) each declared their own local
 * copy, which conflicted at the ambient-type seam. This is a pure addition;
 * nothing above is changed.
 */

/** invoke channel: create a tab (new session or resume). */
export const TAB_CREATE_CHANNEL = "anycode:tab-create";

/** invoke channel: close a tab by id. */
export const TAB_CLOSE_CHANNEL = "anycode:tab-close";

/** invoke channel: list persisted sessions for the picker. */
export const SESSIONS_LIST_CHANNEL = "anycode:sessions-list";

/** invoke channel: open the folder-picker dialog for the New Session start screen (slice P7.12 §4.4). No request payload. */
export const WORKSPACE_PICK_CHANNEL = "anycode:workspace-pick";

/** IPC channel returning engines that main has already validated as spawnable. */
export const ENGINES_LIST_CHANNEL = "anycode:engines-list";

/**
 * Main-owned availability snapshot. This is deliberately only an identity
 * list: paths, diagnostics, account data, and raw environment never cross the
 * preload boundary.
 */
export interface AvailableEngines {
  engineIds: readonly ("core" | "codex")[];
}

/** Request to open a tab: a brand-new session (workspace chosen by main) or a resume. */
export type CreateTabRequest =
  // workspace absent ⇒ main prompts via dialog.showOpenDialog (unchanged);
  // workspace present ⇒ preselected project path, no folder dialog
  // (sidebar project menu, GUI-P1).
  | {
      kind: "new";
      workspace?: string;
      engine?: "core" | "codex";
      /**
       * The New Session start screen's Codex draft picks (W3 join, closing
       * TASK.39's dangling wire: the draft picker existed, main's argv
       * forwarding existed, nothing connected them). Opaque ids only — main
       * (tab-ipc.ts) bounds their length, the host validates IDENTITY against
       * its own live model catalog / frozen preset table before either ever
       * reaches the wire. Absent ⇒ the host's own default applies. Only read
       * on the session-CREATING spawn (main/tabs.ts), never a resume/respawn.
       */
      engineModel?: string;
      enginePreset?: string;
    }
  | { kind: "resume"; sessionId: string };

/**
 * Result of a create-tab request; `already_open` carries the tab to focus instead.
 *

 * `secret-clear` on an open window lets `+` spawn a host with no provider key —
 * main refuses `createTab` while `providerReady` is false and the renderer maps
 * it to a "configure your provider" notice.
 */
export type CreateTabResult =
  | { ok: true; tabId: string; workspace: string }
  | {
      ok: false;
      reason: "cancelled" | "max_tabs" | "session_not_found" | "already_open" | "not_ready";
      focusTabId?: string; // already_open -> renderer focuses this tab
    };

/** Result of a close-tab request; main refuses to close the last remaining tab or an id it doesn't know about. */
export type CloseTabResult = { ok: true } | { ok: false; reason: "last_tab" | "unknown_tab" };

/** Result of a workspace-pick request (slice P7.12 §4.4); `workspace: null` means the dialog was cancelled. */
export type WorkspacePickResult = { workspace: string | null };

/**
 * Projection of persistence SessionMeta (ports/persistence.ts) for the picker.
 * `openInTabId` is main's annotation: the session is already bound to a live tab.
 */
export interface SessionSummary {
  id: string;
  workspace: string;
  model: string;
  mode: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  openInTabId?: string; // session already bound to a live tab (main's annotation)
}
