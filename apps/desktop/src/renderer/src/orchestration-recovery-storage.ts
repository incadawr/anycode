import type { DesktopState } from "./store.js";

type Recovery = Pick<DesktopState, "promptQueue" | "queueInFlight" | "orchestrationDeliveries" | "restoredComposerDraft" | "composerRolePicker" | "queuePaused" | "queuePauseReason">;
const key = (tabId: string) => `anycode:orchestration-recovery:${tabId}`;

/** Window-session storage survives a renderer reload, but not a fresh app session. */
export function saveRecovery(tabId: string, state: DesktopState): boolean {
  try {
    if (typeof sessionStorage === "undefined") return true;
    const { promptQueue, queueInFlight, orchestrationDeliveries, restoredComposerDraft, composerRolePicker, queuePaused, queuePauseReason } = state;
    sessionStorage.setItem(key(tabId), JSON.stringify({ promptQueue, queueInFlight, orchestrationDeliveries, restoredComposerDraft, composerRolePicker, queuePaused, queuePauseReason }));
    return true;
  } catch { return false; }
}

export function loadRecovery(tabId: string): Recovery | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    const raw = sessionStorage.getItem(key(tabId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Recovery;
    if (!Array.isArray(value.promptQueue) || !Array.isArray(value.orchestrationDeliveries)) return null;
    return { ...value, queueInFlight: value.queueInFlight ?? null, restoredComposerDraft: value.restoredComposerDraft ?? null,
      composerRolePicker: value.composerRolePicker ? { ...value.composerRolePicker, saveOperation: undefined, completionClaim: undefined } : null,
      queuePaused: true, queuePauseReason: "error" };
  } catch { return null; }
}

export function clearRecovery(tabId: string): void {
  try { if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(key(tabId)); } catch { /* best effort */ }
}

export function savePendingInitial(tabId: string, prompt: unknown): void {
  try { if (typeof sessionStorage !== "undefined") sessionStorage.setItem(`${key(tabId)}:initial`, JSON.stringify(prompt)); } catch { /* the live registry still retains it */ }
}
export function loadPendingInitial(tabId: string): unknown {
  try { const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(`${key(tabId)}:initial`); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function clearPendingInitial(tabId: string): void {
  try { if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(`${key(tabId)}:initial`); } catch { /* best effort */ }
}
