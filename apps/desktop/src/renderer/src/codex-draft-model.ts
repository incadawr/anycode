/**
 * TASK.241 / card 4053: the shared Codex draft-model decision module.
 * Extracted here (not in StartScreen.tsx or start-session.ts) so both can
 * import it without a component↔submit cycle, and so the catalog-refresh
 * lifecycle has one production implementation tests can drive directly.
 */
import type { EngineModelChoice } from "../../shared/protocol.js";
import { createAsyncEpochGate, issueGuarded } from "./components/async-epoch-gate.js";

export type CodexDraftModelDecision =
  | { kind: "send"; id: string }
  | { kind: "refuse"; message: string };

/**
 * TASK.241: one decision for display AND submit — the chip and the wire
 * can never disagree. An explicit member id is sent verbatim; no pick +
 * ready catalog sends the SAME first entry the chip displays; a stale id
 * or an unavailable catalog REFUSES (visible), never substitutes.
 */
export function decideCodexDraftModel(
  draftModel: string | null,
  available: readonly EngineModelChoice[],
): CodexDraftModelDecision {
  if (draftModel !== null) {
    return available.some((m) => m.id === draftModel)
      ? { kind: "send", id: draftModel }
      : { kind: "refuse", message: `Codex model "${draftModel}" is not available. Pick a model from the current list.` };
  }
  const first = available[0]?.id;
  return first !== undefined
    ? { kind: "send", id: first }
    : { kind: "refuse", message: "Codex model list is unavailable. Retry once Codex is ready, or start a Core session." };
}

/**
 * Display resolution: an explicit pick renders VERBATIM (a stale id stays
 * visible — preserved intent, no hidden fallback); no pick shows the
 * catalog's first entry (what submit would send); "" before the catalog
 * loads (caller already gates rendering on a non-empty catalog).
 */
export function resolveCodexDraftModel(draftModel: string | null, available: readonly EngineModelChoice[]): string {
  return draftModel !== null ? draftModel : (available[0]?.id ?? "");
}

export interface CodexDraftCatalogRefreshDeps {
  /** The production `window.anycode.codex.recheck()`; injectable for tests. */
  recheck(): Promise<CodexRecheckSnapshot>;
  /** Store write for the catalog (production: `setCodexModels` on the tabs store). */
  setModels(models: readonly EngineModelChoice[]): void;
  /** Fired when `recheck` rejects (already caught; production logs a warning). */
  onRecheckError?(error: unknown): void;
}

/** The slice of the codex recheck snapshot the refresh lifecycle reads. */
export interface CodexRecheckSnapshot {
  report: { status: string; models?: readonly EngineModelChoice[] };
}

/**
 * TASK.241: the production codex draft-catalog refresh lifecycle. Every
 * `refresh()` (initial mount, every `engines-changed` push / account switch)
 * CLEARS the catalog BEFORE re-fetching, so a submit racing a refresh is
 * refused on the empty catalog rather than validated against the previous
 * account's list; replies apply under an `AsyncEpochGate` (last-issued
 * wins — an older account's reply can never restore its models after a
 * newer reply); a failed/non-ready reply leaves the catalog EMPTY (picker
 * hidden, submit refused). `dispose()` invalidates the gate and re-clears,
 * retiring in-flight replies on unmount/engine-switch.
 */
export function createCodexDraftCatalogRefresh(deps: CodexDraftCatalogRefreshDeps) {
  const gate = createAsyncEpochGate();
  let disposed = false;
  function refresh(): void {
    if (disposed) {
      return;
    }
    // TASK.241: invalidate the previous list FIRST — a submit racing this
    // refresh (or an account switch) is refused on the empty catalog
    // instead of being validated against the previous account's ids.
    deps.setModels([]);
    issueGuarded(
      gate,
      deps.recheck().catch((error: unknown) => {
        deps.onRecheckError?.(error);
        return null;
      }),
      (snapshot) => {
        if (snapshot !== null && snapshot.report.status === "ready" && snapshot.report.models) {
          deps.setModels(snapshot.report.models);
        }
        // non-ready / failed: catalog stays [] — picker hidden, submit refused.
      },
    );
  }
  function dispose(): void {
    disposed = true;
    gate.invalidate();
    deps.setModels([]);
  }
  return { refresh, dispose };
}
