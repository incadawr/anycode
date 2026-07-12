/**
 * New Session draft submission (slice P7.12 §4.3): the single shared
 * implementation behind both the start screen's Send button and the
 * automation facade's `startScreenSubmit` (W2) — no second path.
 *
 * Flow: read the draft off `tabsStore` -> guard (no draft / no workspace /
 * empty prompt) -> `createTab({kind:"new", workspace})` (reuses the existing
 * GUI-P1 dialog-skip branch, tab-ipc.ts) -> on success, seed the tabs-store
 * row + focus it (mirrors App.tsx's `handleTabCreated`, idempotent against the
 * port-delivery race), queue the draft's prompt for dispatch on `host_ready`
 * (tab-registry.ts's `queueInitialPrompt`), then discard the draft. On
 * refusal (`{ok:false}` from `handleCreateTabResult`, including `already_open`
 * focus, or a rejected `createTab` IPC call), the draft is left untouched
 * (§3-D8) so the user can retry.
 */
import { handleCreateTabResult } from "./components/SessionPicker.js";
import { tabRegistry, type TabRegistry } from "./tab-registry.js";
import { useTabsStore, type TabsStoreApi } from "./tabs-store.js";
import type { CreateTabRequest, CreateTabResult } from "../../shared/tabs.js";

export type StartSubmitResult = { ok: true; tabId: string } | { ok: false; message: string };

export interface StartSubmitDeps {
  /** Default: `window.anycode.createTab`. */
  createTab(req: CreateTabRequest): Promise<CreateTabResult>;
  /** Default: the app's singleton `tabRegistry`. */
  registry: Pick<TabRegistry, "queueInitialPrompt">;
  /** Default: the app's singleton `useTabsStore`. */
  tabsStore: TabsStoreApi;
}

function defaultStartSubmitDeps(): StartSubmitDeps {
  return {
    createTab: (req) => window.anycode.createTab(req),
    registry: tabRegistry,
    tabsStore: useTabsStore,
  };
}

export async function submitStartDraft(
  deps: StartSubmitDeps = defaultStartSubmitDeps(),
): Promise<StartSubmitResult> {
  const draft = deps.tabsStore.getState().draft;
  if (draft === null) {
    return { ok: false, message: "No draft to submit." };
  }
  const { workspace, prompt, model, mode } = draft;
  if (workspace === null) {
    return { ok: false, message: "Choose a project first." };
  }
  if (prompt.trim() === "") {
    return { ok: false, message: "Type a message to send." };
  }

  let result: CreateTabResult;
  try {
    result = await deps.createTab({ kind: "new", workspace });
  } catch (error: unknown) {
    console.warn("[start-session] createTab rejected", error);
    return { ok: false, message: "Failed to create the task." };
  }
  let createdTabId: string | null = null;
  const failure = handleCreateTabResult(result, {
    onTabCreated: ({ tabId, workspace: tabWorkspace }) => {
      createdTabId = tabId;
      deps.tabsStore.getState().addTab({ tabId, workspace: tabWorkspace });
      deps.tabsStore.getState().setActiveTab(tabId);
    },
    onFocusTab: (tabId) => {
      deps.tabsStore.getState().setActiveTab(tabId);
    },
  });

  if (failure !== null || createdTabId === null) {
    return { ok: false, message: failure ?? "Failed to create the task." };
  }

  deps.registry.queueInitialPrompt(createdTabId, prompt, model ?? undefined, mode);
  deps.tabsStore.getState().discardDraft();
  return { ok: true, tabId: createdTabId };
}
