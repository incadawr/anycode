import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { EngineModelChoice } from "../../shared/protocol.js";
import { CLAUDE_DRAFT_MODELS } from "./claude-draft-models.js";
import { createCodexDraftCatalogRefresh, type CodexDraftCatalogRefreshDeps } from "./codex-draft-model.js";
import { useTabsStore } from "./tabs-store.js";
import { pickEngineModels } from "./role-model-options.js";
import { TabContext } from "./tab-context.js";

const subscribeNone = () => () => {};
const noEngine = () => null;

/** Prefer the composer's host projection; outside a matching live tab use the start screen's sources. */
export function useRoleEngineModels(open: boolean) {
  const context = useContext(TabContext);
  const engine = useSyncExternalStore(context?.store.subscribe ?? subscribeNone,
    context ? () => context.store.getState().engine : noEngine, noEngine);
  const codexModels = useTabsStore((state) => state.codexModels);
  const liveCodex = engine?.id === "codex" && engine.model !== undefined;
  useEffect(() => startRoleCodexCatalogRefresh(open && !liveCodex, {
    recheck: () => window.anycode.codex.recheck(),
    getModels: () => useTabsStore.getState().codexModels,
    setModels: (models) => useTabsStore.getState().setCodexModels(models),
    subscribe: (refresh) => window.anycode.onEnginesChanged(refresh),
  }), [open, liveCodex]);
  return useMemo(() => pickEngineModels(engine, CLAUDE_DRAFT_MODELS, codexModels), [engine, codexModels]);
}

/** Fill a missing shared catalog only; role editing must never clear StartScreen's models. */
export function startRoleCodexCatalogRefresh(
  enabled: boolean,
  deps: CodexDraftCatalogRefreshDeps & {
    getModels(): readonly EngineModelChoice[];
    subscribe(refresh: () => void): () => void;
  },
): (() => void) | undefined {
  if (!enabled) return;
  let disposed = false;
  const lifecycle = createCodexDraftCatalogRefresh({
    ...deps,
    // The draft lifecycle intentionally invalidates with []; that behavior belongs
    // to StartScreen, which owns account changes, not to this role editor.
    setModels: (models) => { if (!disposed && models.length > 0) deps.setModels(models); },
  });
  const refresh = () => {
    if (deps.getModels().length === 0) lifecycle.refresh();
  };
  refresh();
  const unsubscribe = deps.subscribe(refresh);
  return () => {
    disposed = true;
    lifecycle.dispose();
    unsubscribe();
  };
}
