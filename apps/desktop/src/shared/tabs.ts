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
  // SLICE-CC A1: "claude" added alongside "codex" — main's ENGINES_LIST_CHANNEL
  // handler (main/tab-ipc.ts) still filters this through canSpawn, so its
  // presence here is a type-widening only, not a behavior change (main/tabs.ts
  // refuses every claude canSpawn call unconditionally until CC-C).
  engineIds: readonly ("core" | "codex" | "claude")[];
}

/** Request to open a tab: a brand-new session (workspace chosen by main) or a resume. */
export type CreateTabRequest =
  // workspace absent ⇒ main prompts via dialog.showOpenDialog (unchanged);
  // workspace present ⇒ preselected project path, no folder dialog
  // (sidebar project menu, GUI-P1).
  | {
      kind: "new";
      workspace?: string;
      // SLICE-CC A1: "claude" widened alongside "codex" (main/tab-ipc.ts's zod
      // schema enum is the paired edit) — a request naming "claude" is still
      // refused by spawnableWhenKnown/canSpawn until CC-C, never by this type.
      engine?: "core" | "codex" | "claude";
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
      /**
       * Codex account-profile pick (codex-profiles cut §3.3, amended §A1.1
       * closing note): an opaque profile id from main's registry — never a
       * path. Absent ⇒ the `system` pseudo-profile (byte-identical to
       * today's ambient-`CODEX_HOME` behavior). Main resolves this id to
       * the concrete `--codex-profile`/`--codex-home`/`--codex-auth-link`
       * argv the host receives (main/tabs.ts, W2 lane A) — never forwarded
       * to the host verbatim. Only read on the session-CREATING spawn, same
       * discipline as `engineModel`/`enginePreset` above.
       */
      codexProfileId?: string;
    }
  | {
      kind: "resume";
      sessionId: string;
      /**
       * Re-pin target for a session whose stored connection was deleted (TASK.45
       * W10-FIX F1). Additive-optional: present ONLY when the user explicitly picks
       * a replacement from the `connection_missing` notice (never an automatic
       * switch). Ignored when the stored pin is still alive; a deleted pin + this
       * id re-targets the session to it before resuming. The full replacement
       * picker (W12) rides this SAME field — no second channel.
       */
      replacementConnectionId?: string;
    };

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
      reason:
        | "cancelled"
        | "max_tabs"
        | "session_not_found"
        | "already_open"
        | "not_ready"
        | "worktree_unavailable"
        // The session was pinned to a provider connection that has since been
        // deleted (TASK.45 W10). Resume must NOT silently fall back to the current
        // default — the renderer offers a replacement instead. `connectionId` is
        // the missing pin, for the actionable notice.
        | "connection_missing";
      focusTabId?: string; // already_open -> renderer focuses this tab
      worktreePath?: string; // actionable recovery detail for worktree_unavailable
      connectionId?: string; // connection_missing -> the deleted pin
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
  projectRoot?: string;
  worktree?: {
    id: string;
    path: string;
    branch: string;
    baseRef: string;
    ownedByAnyCode: boolean;
  };
  model: string;
  mode: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  openInTabId?: string; // session already bound to a live tab (main's annotation)
  /**
   * The engine the session was created under (projected from persistence
   * SessionMeta.engineId; opaque host identity, absent = a historical core
   * session). TASK.64: the Sidebar forwards this to `handleCreateTabResult` so a
   * `not_ready` resume failure on a Codex session reads the sign-in-specific copy
   * ("Sign in to Codex…") instead of the irrelevant "Configure a provider…"
   * core copy. Display-only — main is the authoritative spawn gate.
   */
  engineId?: string;
}
