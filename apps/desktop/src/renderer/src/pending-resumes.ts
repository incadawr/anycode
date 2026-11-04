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
 *    representing tab. While armed the history row stays visible (consumers
 *    render it as an opening placeholder): nothing represents the session
 *    yet, so removing the row would blank it for the whole slow createTab —
 *    and on a refusal it would flicker;
 *  - when a NEW unbound tab appears (the resume's own tab arriving through
 *    the port envelope before the reply), the store's prune promotes the
 *    armed marker to that tab (`promoteArmedResumes` — arm-time tab ids are
 *    the baseline that tells "new" from pre-existing), restoring the one-row
 *    dedupe for the envelope-before-reply window without waiting for the
 *    reply;
 *  - the reply settles the marker: ok → the new tab's id, `already_open` →
 *    the focused existing tab's id (`resumedRepresentingTabId`). Settlement
 *    reconciles against the tabs AS THEY ARE THEN (`settlePendingResume`): a
 *    representing tab whose host already exited drops the marker — it died
 *    while the reply was in flight, and the prune effect alone runs on
 *    `tabs` changes, never on settlements. An absent tab keeps the marker
 *    (the envelope may still be in flight). Any other refusal — or a
 *    rejected call — CLEARS the marker: the prune effect alone cannot,
 *    since `tabs` does not change on a failure;
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
import { useTabsStore } from "./tabs-store.js";
import type { TabInfo } from "./tabs-store.js";

/** sessionId → the tabId that currently represents it; null = armed, the `createTab` reply has not named the tab yet. */
export type PendingResumeMarks = ReadonlyMap<string, string | null>;

/**
 * sessionId → the tabIds already present when that session's marker was armed.
 * A tab appearing AFTER arming is this resume's own tab coming through the
 * port envelope; one present at arm time belongs to someone else. Internal to
 * the store — exposed in its state only so tests can pin the promotion.
 */
export type PendingResumeArmBaselines = ReadonlyMap<string, ReadonlySet<string>>;

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
 * Promotes armed (null-tabId) markers to a representing tab: the FIRST unbound
 * tab that was not present when the marker was armed is this resume's own tab
 * arriving through the port envelope before the `createTab` reply. A promoted
 * marker rejoins the settled lifecycle (the caller prunes right after, so a
 * promotion onto a dead tab drops at once). Pure: returns the inputs untouched
 * when nothing promotes. Armed markers without a recorded baseline stay armed —
 * without the arm-time context a pre-existing unbound tab is indistinguishable
 * from the resume's own.
 */
export function promoteArmedResumes(
  prev: PendingResumeMarks,
  tabs: readonly TabInfo[],
  baselines: PendingResumeArmBaselines,
): { marks: PendingResumeMarks; baselines: PendingResumeArmBaselines } {
  let marks: Map<string, string | null> | null = null;
  let nextBaselines: Map<string, ReadonlySet<string>> | null = null;
  for (const [sessionId, tabId] of prev) {
    if (tabId !== null) {
      continue;
    }
    const baseline = baselines.get(sessionId);
    if (baseline === undefined) {
      continue;
    }
    const fresh = tabs.find((t) => t.sessionId === null && !baseline.has(t.tabId));
    if (fresh === undefined) {
      continue;
    }
    if (marks === null) {
      marks = new Map(prev);
      nextBaselines = new Map(baselines);
    }
    marks!.set(sessionId, fresh.tabId);
    nextBaselines!.delete(sessionId);
  }
  return marks === null ? { marks: prev, baselines } : { marks, baselines: nextBaselines! };
}

/**
 * Settles an armed marker from the `createTab` reply and reconciles it with
 * the tabs AS THEY ARE at that moment. The production prune runs on `tabs`
 * changes only, so a representing tab whose host died while the reply was in
 * flight would otherwise leave a stale marker that nothing re-checks (the
 * history row would stay hidden until an unrelated tabs change). A tab absent
 * from the store keeps the marker — the port envelope may still be in flight;
 * the next tabs change owns the absent case.
 */
export function settlePendingResume(
  prev: PendingResumeMarks,
  sessionId: string,
  tabId: string,
  tabs: readonly TabInfo[],
): PendingResumeMarks {
  if (tabs.some((t) => t.sessionId === sessionId)) {
    return clearPendingResume(prev, sessionId); // bound — the sessionId dedupe takes over
  }
  const representing = tabs.find((t) => t.tabId === tabId);
  if (representing !== undefined && representing.hostExited) {
    return clearPendingResume(prev, sessionId); // the host died before host_ready — the session must be re-resumable
  }
  return markPendingResume(prev, sessionId, tabId);
}

/**
 * The two sets buildSidebarGroups consumers feed it: `opening` names sessions
 * whose history row folds into their representing tab's row (settled marker —
 * the tab exists), `arming` names sessions still awaiting their tab, whose
 * history row stays visible as an opening placeholder. Splitting at the feed
 * keeps the armed-but-no-tab-yet window from blanking the session.
 */
export function pendingResumeRowSets(marks: PendingResumeMarks): { opening: ReadonlySet<string>; arming: ReadonlySet<string> } {
  const opening = new Set<string>();
  const arming = new Set<string>();
  for (const [sessionId, tabId] of marks) {
    (tabId === null ? arming : opening).add(sessionId);
  }
  return { opening, arming };
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
  /** Arm-time tab ids per armed marker (see `PendingResumeArmBaselines`); cleared on promotion, settlement and clear. */
  armBaselines: PendingResumeArmBaselines;
  mark(sessionId: string, tabId?: string): void;
  clear(sessionId: string): void;
  /** Retires settled markers; called on every tabs-store change (the Sidebar's prune effect). */
  prune(tabs: readonly TabInfo[]): void;
}

export function createPendingResumesStore() {
  return create<PendingResumesState>()((set, get) => ({
    marks: new Map(),
    armBaselines: new Map(),

    mark(sessionId, tabId): void {
      if (tabId === undefined) {
        // Arming: record the tabIds already present so the prune can tell the
        // resume's own envelope-published tab (new since arming) from a
        // pre-existing one.
        const baseline = new Set(useTabsStore.getState().tabs.map((t) => t.tabId));
        set({
          marks: markPendingResume(get().marks, sessionId),
          armBaselines: new Map(get().armBaselines).set(sessionId, baseline),
        });
        return;
      }
      // Settlement: re-check the tabs right here — nothing else runs the prune
      // on a settlement (see settlePendingResume).
      const baselines = new Map(get().armBaselines);
      baselines.delete(sessionId);
      set({
        marks: settlePendingResume(get().marks, sessionId, tabId, useTabsStore.getState().tabs),
        armBaselines: baselines,
      });
    },

    clear(sessionId): void {
      const baselines = new Map(get().armBaselines);
      baselines.delete(sessionId);
      set({ marks: clearPendingResume(get().marks, sessionId), armBaselines: baselines });
    },

    prune(tabs): void {
      const promoted = promoteArmedResumes(get().marks, tabs, get().armBaselines);
      const marks = prunePendingResumes(promoted.marks, tabs);
      if (marks === promoted.marks && promoted.marks === get().marks && promoted.baselines === get().armBaselines) {
        return; // nothing changed — skip the notification (no spurious writes)
      }
      set({ marks, armBaselines: promoted.baselines });
    },
  }));
}

export const usePendingResumes = createPendingResumesStore();
