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
import type { EngineId } from "../../../shared/engines.js";

/**
 * Human-readable text for a failed `CreateTabRequest` (design §3.2/§4.3:
 * `{ok:false}` branches surface as a notice-toast).
 *
 * `engine`, when given, only affects the `not_ready` branch (S1b-1): main's
 * `tab-ipc.ts` returns the same `reason:"not_ready"` for both a Core draft
 * missing provider config AND a Codex draft with no signed-in profile
 * (`canSpawn(codex)`=false) — the historical copy ("Configure a provider…")
 * only makes sense for the former. Omitting `engine` (every pre-existing call
 * site except `start-session.ts`'s `submitStartDraft`) keeps this branch
 * byte-identical to the historical text — 0 wire-δ for those callers.
 */
export function describeCreateTabFailure(
  result: Extract<CreateTabResult, { ok: false }>,
  engine?: EngineId,
): string {
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
      if (engine === "codex") {
        return "Sign in to a Codex account in Settings → Codex before opening a tab.";
      }
      // is configured. Renderer surfaces the configure-provider notice. 2.2.4
      // may refine the copy / route to the Settings screen.
      return "Configure a provider (API key + model) before opening a tab.";
    case "worktree_unavailable":
      return `This session's worktree is missing or no longer registered${result.worktreePath ? `: ${result.worktreePath}` : ""}. Restore or re-register that path with Git before resuming.`;
    case "connection_missing":
      // TASK.45 W10-FIX F1: the pinned provider connection was deleted. Resume must
      // NOT silently switch this session to the current default — the Sidebar turns
      // this into an actionable notice: an explicit "Resume on the current
      // connection" button (which re-pins the session) when one is configured, else
      // a Settings pointer. This base text states only the fact (the prior copy told
      // the user to "choose a replacement in Settings", which never re-pinned).
      return "This task's provider connection was deleted.";
    default: {
      const _exhaustive: never = result.reason;
      return _exhaustive;
    }
  }
}

/**
 * The re-pin action a resume failure should arm on the notice toast (TASK.45
 * W10-FIX F1), or null when none applies. An actionable re-pin is offered ONLY
 * for `connection_missing` AND only when a current connection exists to re-pin
 * onto — every other outcome (success, a different failure, or no connection
 * configured) returns null, so the toast shows just its text (the no-connection
 * case points the user to Settings instead of a dead-end button). The action is
 * armed but NEVER auto-invoked — resuming on the replacement requires the user's
 * explicit click, which is the boundary against the forbidden "silent switch".
 * Exported for unit testing.
 */
export function resolveConnectionMissingAction(
  result: CreateTabResult,
  sessionId: string,
  activeConnectionId: string | undefined,
): { sessionId: string; replacementConnectionId: string } | null {
  if (result.ok || result.reason !== "connection_missing" || activeConnectionId === undefined) {
    return null;
  }
  return { sessionId, replacementConnectionId: activeConnectionId };
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
 *
 * `extra.engine`, when given, is forwarded to `describeCreateTabFailure`
 * (S1b-1) so a `not_ready` refusal on a Codex draft gets the codex-specific
 * copy. Only `start-session.ts`'s `submitStartDraft` passes it (it has
 * `draft.engine` in scope); every other call site omits it and keeps the
 * historical copy.
 */
export function handleCreateTabResult(
  result: CreateTabResult,
  callbacks: CreateTabCallbacks,
  extra?: { title?: string; engine?: EngineId },
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
  return describeCreateTabFailure(result, extra?.engine);
}
