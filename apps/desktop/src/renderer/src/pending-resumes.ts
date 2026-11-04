/**
 * Shared renderer-side "this session is opening right now" markers, keyed by
 * sessionId. While a resume is in flight the sidebar (and the command palette,
 * which renders the same grouping) must show ONE row per session: the open tab
 * row replaces the session's history row for the whole click → hydration
 * window. That dedupe cannot live in one component's local state — a session
 * can be resumed from the sidebar, the command palette, the Codex rollout
 * import dialog, or the automation facade, and every entry point must suppress
 * the same history row.
 *
 * Marker lifecycle (the pure helpers below; the store's actions wrap them):
 *  - `markPendingResume` arms the marker synchronously at call time — BEFORE
 *    the `createTab` reply lands — because the new tab can enter the
 *    tabs-store via the port envelope before the IPC reply (a one-frame
 *    duplicate otherwise). `tabId` stays null until the reply names the
 *    representing tab;
 *  - the reply settles it: ok → the new tab's id, `already_open` → the focused
 *    existing tab's id (`resumedRepresentingTabId`). Any other refusal — or a
 *    rejected call — CLEARS the marker (`clearPendingResume`): the prune
 *    effect alone cannot, since `tabs` does not change on a failure;
 *  - `prunePendingResumes` retires settled markers on tabs-store changes:
 *    bound → drop (the sessionId dedupe in buildSidebarGroups takes over),
 *    representing tab gone → drop (closed mid-hydration — the history row must
 *    come back), representing tab `hostExited` → drop (the host died before
 *    host_ready — the session must become re-resumable), unbound + live → keep.
 *
 * `resumeWithMarker` is the one seam every resume entry point goes through, so
 * no caller can forget to arm or settle the marker; it returns the verbatim
 * `CreateTabResult` so callers keep their existing `handleCreateTabResult`
 * handling.
 *
 * Factory-plus-singleton, same shape as tabs-store.ts's `createTabsStore` /
 * `useTabsStore`: `createPendingResumesStore` for test isolation,
 * `usePendingResumes` for the app.
 */
import { create } from "zustand";
import type { CreateTabResult } from "../../shared/tabs.js";
import type { TabInfo } from "./tabs-store.js";

/** sessionId → the tabId that currently represents it; null = armed, the `createTab` reply has not named the tab yet. */
export type PendingResumeMarks = ReadonlyMap<string, string | null>;

/** Arms (or re-targets) a session's marker. Without `tabId` the marker is armed before the reply names the representing tab. */
export function markPendingResume(prev: PendingResumeMarks, sessionId: string, tabId?: string): PendingResumeMarks {
  return new Map(prev).set(sessionId, tabId ?? null);
}

/** Drops a session's marker (a refused/failed resume — the history row comes back). */
export function clearPendingResume(prev: PendingResumeMarks, sessionId: string): PendingResumeMarks {
  const next = new Map(prev);
  next.delete(sessionId);
  return next;
}

/**
 * Retires markers that have done their job, per the lifecycle in the module
 * doc. Pure: returns `prev` itself when nothing changes (so a store action can
 * skip the notification), never mutates the input.
 */
export function prunePendingResumes(prev: PendingResumeMarks, tabs: readonly TabInfo[]): PendingResumeMarks {
  const liveByTabId = new Map(tabs.map((t) => [t.tabId, t] as const));
  let next: Map<string, string | null> | null = null;
  for (const [sessionId, tabId] of prev) {
    let drop: boolean;
    if (tabs.some((t) => t.sessionId === sessionId)) {
      drop = true; // bound — buildSidebarGroups's sessionId dedupe takes over
    } else if (tabId === null) {
      drop = false; // armed, representing tab not named yet — keep
    } else {
      const representing = liveByTabId.get(tabId);
      drop = representing === undefined || representing.hostExited; // closed, or the host died before host_ready
    }
    if (drop) {
      if (next === null) {
        next = new Map(prev);
      }
      next.delete(sessionId);
    }
  }
  return next ?? prev;
}

/**
 * The tabId that represents a resumed session once its `createTab` reply
 * landed: the new tab on ok, the focused existing tab on `already_open`,
 * undefined on any other refusal (the marker must clear).
 */
export function resumedRepresentingTabId(result: CreateTabResult): string | undefined {
  return result.ok ? result.tabId : result.reason === "already_open" ? result.focusTabId : undefined;
}

/** The resume-shaped `createTab` request — what every resume entry point sends. */
export interface ResumeTabRequest {
  kind: "resume";
  sessionId: string;
  /** W10-FIX F1 re-pin target (only ever set by the notice button). */
  replacementConnectionId?: string;
}

export type ResumeTabOpener = (request: ResumeTabRequest) => Promise<CreateTabResult>;

/**
 * Arms the shared marker synchronously, performs the resume `createTab` call,
 * then settles the marker from the reply (representing tabId on ok /
 * `already_open`, cleared on any refusal — and on a rejection, which rethrows
 * so the caller's existing error handling runs unchanged).
 */
export async function resumeWithMarker(
  sessionId: string,
  createTab: ResumeTabOpener,
  replacementConnectionId?: string,
): Promise<CreateTabResult> {
  usePendingResumes.getState().mark(sessionId);
  try {
    const result = await createTab(
      replacementConnectionId !== undefined ? { kind: "resume", sessionId, replacementConnectionId } : { kind: "resume", sessionId },
    );
    const tabId = resumedRepresentingTabId(result);
    if (tabId === undefined) {
      usePendingResumes.getState().clear(sessionId);
    } else {
      usePendingResumes.getState().mark(sessionId, tabId);
    }
    return result;
  } catch (error: unknown) {
    usePendingResumes.getState().clear(sessionId);
    throw error;
  }
}

export interface PendingResumesState {
  marks: PendingResumeMarks;
  mark(sessionId: string, tabId?: string): void;
  clear(sessionId: string): void;
  /** Retires settled markers; called on every tabs-store change (the Sidebar's prune effect). */
  prune(tabs: readonly TabInfo[]): void;
}

export function createPendingResumesStore() {
  return create<PendingResumesState>()((set, get) => ({
    marks: new Map(),

    mark(sessionId, tabId): void {
      set({ marks: markPendingResume(get().marks, sessionId, tabId) });
    },

    clear(sessionId): void {
      set({ marks: clearPendingResume(get().marks, sessionId) });
    },

    prune(tabs): void {
      set({ marks: prunePendingResumes(get().marks, tabs) });
    },
  }));
}

export const usePendingResumes = createPendingResumesStore();
