/**
 * Session-picker pure helpers (design/phase-2.md §4.3). The `<SessionPicker>`
 * dialog component was retired in the UI redesign (ui-redesign-direction.md
 * §2.2 / §4 decision 6): resume now lives in the Sidebar. This module is kept
 * at its original path because it owns the tested, reusable pure logic —
 * `describeCreateTabFailure`, `CreateTabCallbacks`, and `handleCreateTabResult`
 * — which the Sidebar (and SessionPicker.test.ts) import from here. No React,
 * no DOM: pure functions plus one interface.
 *

 * already bound to a live tab (`already_open` → `focusTabId`) focuses that tab
 * rather than opening a second writer for one session.
 */
import type { CreateTabResult } from "../../../shared/tabs.js";

/** Human-readable text for a failed `CreateTabRequest` (design §3.2/§4.3: `{ok:false}` branches surface as a notice-toast). */
export function describeCreateTabFailure(result: Extract<CreateTabResult, { ok: false }>): string {
  switch (result.reason) {
    case "cancelled":
      return "Cancelled.";
    case "max_tabs":
      return "Cannot open another tab — the maximum number of tabs is already open.";
    case "session_not_found":
      return "That task no longer exists.";
    case "already_open":
      return "That task is already open in another tab.";
    case "not_ready":

      // is configured. Renderer surfaces the configure-provider notice. 2.2.4
      // may refine the copy / route to the Settings screen.
      return "Configure a provider (API key + model) before opening a tab.";
    case "worktree_unavailable":
      return `This session's worktree is missing or no longer registered${result.worktreePath ? `: ${result.worktreePath}` : ""}. Restore or re-register that path with Git before resuming.`;
    case "connection_missing":
      // TASK.45 W10: the pinned provider connection was deleted. Resume must not
      // silently switch this session to the current default — route the user to
      // Settings to choose a replacement (the full in-place picker is W12).
      return "This task's provider connection was deleted. Open Settings and choose a replacement connection before resuming this task.";
    default: {
      const _exhaustive: never = result.reason;
      return _exhaustive;
    }
  }
}

export interface CreateTabCallbacks {
  /**
   * A brand-new tab was created (new session or a resume that wasn't already
   * open). `title` is populated on a resume (from the `SessionSummary` being
   * resumed, task 2.1.6 wiring of the tabs-store `setTitle` seam) — absent
   * for a brand-new session, which has no title yet.
   */
  onTabCreated(result: { tabId: string; workspace: string; title?: string }): void;
  /* */
  onFocusTab(tabId: string): void;
}

/**
 * Shared `CreateTabResult` handling for both the sidebar's resumable-row click
 * and its "New session" action (design §4.3: `{ok:false}` -> notice,
 * `already_open` -> focus). Returns the notice text to show, or `null` on a
 * plain success (the caller already got `onTabCreated`/`onFocusTab`).
 *
 * `extra.title`, when given, is forwarded onto a successful `onTabCreated` —
 * the resume path passes the resumed session's own title (task 2.1.6); the
 * "New session" path (no title exists yet) omits it.
 */
export function handleCreateTabResult(
  result: CreateTabResult,
  callbacks: CreateTabCallbacks,
  extra?: { title?: string },
): string | null {
  if (result.ok) {
    callbacks.onTabCreated({
      tabId: result.tabId,
      workspace: result.workspace,
      ...(extra?.title !== undefined ? { title: extra.title } : {}),
    });
    return null;
  }
  if (result.reason === "already_open" && result.focusTabId) {
    callbacks.onFocusTab(result.focusTabId);
  }
  return describeCreateTabFailure(result);
}
