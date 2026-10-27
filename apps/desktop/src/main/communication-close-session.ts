import type { CloseSessionOutcome } from "./communication-server.js";
import type { CloseTabResult } from "../shared/tabs.js";

/** Main owns admission; the UI's closeTab path owns host shutdown and removal. */
export async function closeSessionForAgent(
  manager: {
    listTabs(): ReadonlyArray<{ tabId: string; sessionId: string; workspace: string; state?: string }>;
    communicationRequest(sessionId: string, operation: string, payload?: unknown, expectedWorkspace?: string): Promise<unknown>;
    closeTab(tabId: string): Promise<CloseTabResult>;
  } | null,
  agentOpened: Set<string>,
  sessionId: string,
  notifyClosed: (tabId: string) => void,
): Promise<CloseSessionOutcome> {
  const tab = manager?.listTabs().find((t) => t.sessionId === sessionId);
  if (!manager || !tab || tab.state === "closing") return { ok: false, reason: "not_found" };
  if (!agentOpened.has(sessionId)) return { ok: false, reason: "not_agent_opened" };
  // a definitively crash-looped tab has no live host to answer a
  // status request (its host exited and the breaker gave up). Closing it must
  // not depend on an idle-host RPC. Route it straight to the UI close path,
  // which still enforces the last-tab and concurrent-close guards.
  if (tab.state === "crash_looped") {
    const result = await manager.closeTab(tab.tabId);
    if (!result.ok) return { ok: false, reason: result.reason === "unknown_tab" ? "not_found" : "last_tab" };
    agentOpened.delete(sessionId);
    notifyClosed(tab.tabId);
    return { ok: true };
  }
  try {
    // Recheck after the initial round trip: a prompt or queued next_turn may
    // have started while the first idle response was in flight. No await is
    // permitted between checking the final response and closeTab's seal below.
    for (let check = 0; check < 2; check++) {
      const status = await manager.communicationRequest(sessionId, "get_session_status", undefined, tab.workspace) as { state?: string };
      if (status?.state === "closing") return { ok: false, reason: "not_found" };
      if (status?.state !== "idle") return { ok: false, reason: "busy" };
    }
  } catch { return { ok: false, reason: "busy" }; }
  // Another close can have sealed the tab while its host answered our status request.
  const current = manager.listTabs().find((t) => t.sessionId === sessionId);
  if (!current || current.state === "closing") return { ok: false, reason: "not_found" };
  if (current.state !== undefined && current.state !== "running") return { ok: false, reason: "busy" };
  const result = await manager.closeTab(tab.tabId);
  if (!result.ok) return { ok: false, reason: result.reason === "unknown_tab" ? "not_found" : "last_tab" };
  agentOpened.delete(sessionId);
  notifyClosed(tab.tabId);
  return { ok: true };
}
