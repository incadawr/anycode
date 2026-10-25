/**
 * "Full browser access" IPC (Taskana 4759 owner amendment): the ONLY write path
 * for the per-session switch. Exported pure handlers over a deps bag (testable
 * without ipcMain), zod `.strict()` on every payload.
 *
 * Only the user can toggle: both channels refuse any sender that is not the
 * app's main window webContents (a preview WebContentsView/BrowserWindow, or an
 * unknown sender, is refused). Nothing in the host, the tools, MCP or the
 * Sessions API reaches these handlers; the host can only send PreviewOps, and
 * the PreviewOp union has no kind that writes the switch.
 *
 * Every response is the EFFECTIVE (trust-gated) value, never the raw stored
 * switch, so the UI cannot show ON for an untrusted folder.
 */
import { ipcMain } from "electron";
import { z } from "zod";
import {
  BROWSER_ACCESS_GET_CHANNEL,
  BROWSER_ACCESS_SET_CHANNEL,
  type BrowserAccessGetResult,
  type BrowserAccessSetResult,
  type BrowserAccessTabState,
} from "../shared/browser-access.js";
import { effectiveFullAccess, type BrowserAccessStore } from "./browser-access.js";

export interface BrowserAccessIpcDeps {
  store: BrowserAccessStore;
  /** Live tab list (root and child). Only tabId and sessionId are read here. */
  tabs(): ReadonlyArray<{ tabId: string; sessionId: string }>;
  /** `TabHostManager.workspaceTrustPendingFor`: anything but "no_pending" means the folder is not trusted yet. */
  trustPendingFor(tabId: string): unknown;
  /** True only for the app's main window webContents. */
  isMainWindowSender(sender: unknown): boolean;
  /** Called after a successful set; the caller pushes the change (dedupes on the effective value). */
  onChanged?(tabId: string): void;
}

const emptyPayload = z.object({}).strict();
const setSchema = z.object({ tabId: z.string().min(1).max(200), enabled: z.boolean() }).strict();

/** The effective state of one live tab, or undefined for an unknown tab. */
export function effectiveTabState(deps: BrowserAccessIpcDeps, tabId: string): BrowserAccessTabState | undefined {
  const tab = deps.tabs().find((candidate) => candidate.tabId === tabId);
  if (tab === undefined) return undefined;
  const trust = deps.trustPendingFor(tab.tabId);
  const fullAccess = effectiveFullAccess(deps.store.isOn(tab.sessionId), trust);
  // A folder whose trust is not decided is always OFF and says why (the row is disabled).
  if (trust !== "no_pending") return { tabId: tab.tabId, fullAccess: false, reason: "trust" };
  return { tabId: tab.tabId, fullAccess };
}

export function handleBrowserAccessGet(deps: BrowserAccessIpcDeps, raw: unknown, sender: unknown): BrowserAccessGetResult {
  if (!deps.isMainWindowSender(sender)) return { ok: false, reason: "not_main_window" };
  if (!emptyPayload.safeParse(raw).success) return { ok: false, reason: "invalid" };
  const tabs: BrowserAccessTabState[] = [];
  for (const tab of deps.tabs()) {
    const state = effectiveTabState(deps, tab.tabId);
    if (state !== undefined) tabs.push(state);
  }
  return { ok: true, tabs };
}

export function handleBrowserAccessSet(deps: BrowserAccessIpcDeps, raw: unknown, sender: unknown): BrowserAccessSetResult {
  if (!deps.isMainWindowSender(sender)) return { ok: false, reason: "not_main_window" };
  const parsed = setSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const tab = deps.tabs().find((candidate) => candidate.tabId === parsed.data.tabId);
  if (tab === undefined) return { ok: false, reason: "unknown_tab" };
  if (!deps.store.set(tab.sessionId, parsed.data.enabled)) return { ok: false, reason: "io_error" };
  deps.onChanged?.(tab.tabId);
  const state = effectiveTabState(deps, tab.tabId);
  if (state === undefined) return { ok: false, reason: "unknown_tab" };
  return { ok: true, tab: state };
}

/**
 * Pushes the EFFECTIVE value of a tab exactly once per change: `refresh` compares
 * against the last value this notifier sent (or was seeded with at fork time).
 */
export interface BrowserAccessNotifier {
  seed(tabId: string, fullAccess: boolean): void;
  refresh(tabId: string): void;
  forget(tabId: string): void;
}

export function createBrowserAccessNotifier(deps: {
  effective(tabId: string): BrowserAccessTabState | undefined;
  push(state: BrowserAccessTabState): void;
}): BrowserAccessNotifier {
  const last = new Map<string, boolean>();
  return {
    seed(tabId, fullAccess) {
      last.set(tabId, fullAccess);
    },
    refresh(tabId) {
      const state = deps.effective(tabId);
      if (state === undefined) {
        last.delete(tabId);
        return;
      }
      if (last.get(tabId) === state.fullAccess) return;
      last.set(tabId, state.fullAccess);
      deps.push(state);
    },
    forget(tabId) {
      last.delete(tabId);
    },
  };
}

export function registerBrowserAccessIpc(deps: BrowserAccessIpcDeps): void {
  ipcMain.handle(BROWSER_ACCESS_GET_CHANNEL, (event, raw: unknown) => handleBrowserAccessGet(deps, raw, event.sender));
  ipcMain.handle(BROWSER_ACCESS_SET_CHANNEL, (event, raw: unknown) => handleBrowserAccessSet(deps, raw, event.sender));
}
