/**
 * Turn-completion desktop notification (ui-roadmap §4-R8(c,d)). Renderer-only:
 * HTML5 `new Notification` works in an Electron renderer without main-process
 * plumbing; the enable flag lives in localStorage (NOT the settings vault —
 * device-local preference, no IPC, same pattern as SIDEBAR_COLLAPSED_KEY).
 *
 * Pure, node-testable exports: shouldNotifyTurnEnd, notificationBody,
 * readTurnNotifyEnabled, TURN_NOTIFY_KEY. The hook + fire path touch the DOM
 * and are exercised by the visual harness, not unit tests.
 */
import { useEffect, useRef } from "react";
import type { TurnState } from "./store.js";
import { isTurnCompletion } from "./tab-status-store.js";

/** localStorage key (namespaced like anycode.sidebar.collapsed). Absent = enabled. */
export const TURN_NOTIFY_KEY = "anycode.notifications.turnComplete";

/**
 * Default ON (both references notify by default); "false" is the single
 * disabling value. try/catch: storage can be unavailable (node tests,
 * lockdown) — fail open to the default.
 */
export function readTurnNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(TURN_NOTIFY_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * The complete gate, pure and total: fire only on a turn-completion edge
 * (the R10-shared `isTurnCompletion` atom — slice-R10-cut §2.3), only when
 * the window cannot be watching (document hidden OR unfocused), only when
 * the setting is enabled. Permission is checked at fire time, not here
 * (impure).
 */
export function shouldNotifyTurnEnd(
  prevStatus: TurnState["status"],
  nextStatus: TurnState["status"],
  hidden: boolean,
  focused: boolean,
  enabled: boolean,
): boolean {
  return enabled && isTurnCompletion(prevStatus, nextStatus) && (hidden || !focused);
}

/**
 * Notification body (roadmap: "body: title"): the tab's session title when
 * known, else the workspace folder's leaf name, else a neutral constant.
 * Trailing separators are stripped so "/a/b/" → "b"; both separators handled
 * (paths may be win-style on linux/win builds).
 */
export function notificationBody(title: string | undefined, workspace: string | null): string {
  if (title !== undefined && title.trim().length > 0) {
    return title;
  }
  if (workspace !== null) {
    const leaf = workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
    if (leaf !== undefined && leaf.length > 0) {
      return leaf;
    }
  }
  return "Agent task";
}

function showTurnNotification(body: string): void {
  const notification = new Notification("Turn finished", { body });
  // Click = come back to the app. window.focus() from a notification click
  // focuses the BrowserWindow in Electron (renderer-only, best-effort).
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

/**
 * Fire with a defensive permission ladder: Electron renderers are typically
 * "granted" out of the box (no chrome prompt), but if an environment reports
 * "default" we request lazily AT FIRE TIME — the Settings toggle also
 * requests on enable (user gesture), so this path is a silent fallback, never
 * a surprise prompt on boot. "denied" is final: stay silent.
 */
function fireTurnNotification(body: string): void {
  if (typeof Notification === "undefined" || Notification.permission === "denied") {
    return;
  }
  if (Notification.permission === "granted") {
    showTurnNotification(body);
    return;
  }
  void Notification.requestPermission().then((permission) => {
    if (permission === "granted") {
      showTurnNotification(body);
    }
  });
}

/**
 * Watches the ACTIVE tab's turn for running→idle (cross-tab completion is
 * R10's territory — background tabs mount neither this hook nor the toast
 * capture). `<ActiveTab>` carries NO `key`, so switching tabs is a pure
 * re-render, not a remount — the hook instance (and its refs) is reused. A
 * tab switch is therefore made a non-transition EXPLICITLY: prevTabRef tracks
 * the tabId, and when it changes we treat `prev` as the incoming status so a
 * running→idle diff across two DIFFERENT tabs (e.g. leaving tab A mid-turn
 * for an idle tab B while the window is hidden) can never fire tab B's
 * "finished" notification. StrictMode's double effect run is safe (second run
 * sees prev === next); `body` changing alone re-runs with prev === next → no-op.
 */
export function useTurnCompletionNotification(turn: TurnState, body: string, tabId: string): void {
  const prevStatusRef = useRef(turn.status);
  const prevTabRef = useRef(tabId);
  useEffect(() => {
    // A tab switch is not a turn transition: seed `prev` to the current status
    // so only a running→idle change WITHIN one tab is a completion.
    const prev = prevTabRef.current === tabId ? prevStatusRef.current : turn.status;
    prevStatusRef.current = turn.status;
    prevTabRef.current = tabId;
    if (!shouldNotifyTurnEnd(prev, turn.status, document.hidden, document.hasFocus(), readTurnNotifyEnabled())) {
      return;
    }
    fireTurnNotification(body);
  }, [turn.status, body, tabId]);
}
