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
import type { SessionDraft } from "./tabs-store.js";

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

/**
 * Keeps the historical Core create payload byte-for-byte additive apart from
 * the TASK.106 cut-1 stage A `connectionId` pick below. For a non-core
 * (Codex) draft, also forwards the draft's own model/preset/profile picks
 * (W3 join: main/tabs.ts's argv forwarding and the StartScreen pickers both
 * already existed — this is the missing wire between them). All are opaque
 * ids; omitted entirely when never explicitly picked, so the host (or main's
 * registry) applies its own default rather than receiving a stale/invalid id.
 */
export function createStartTabRequest(
  draft: Pick<SessionDraft, "workspace" | "engine" | "model" | "enginePreset" | "codexProfileId" | "connectionId">,
): CreateTabRequest {
  if (draft.workspace === null) {
    throw new Error("A workspace is required to create a tab");
  }
  if (draft.engine === "core") {
    return {
      kind: "new",
      workspace: draft.workspace,
      // TASK.106 cut-1 stage A: the New Session model picker's cross-connection
      // pick. Absent ⇒ main falls back to the active connection, unchanged.
      ...(draft.connectionId !== undefined ? { connectionId: draft.connectionId } : {}),
    };
  }
  return {
    kind: "new",
    workspace: draft.workspace,
    engine: draft.engine,
    ...(draft.model !== null ? { engineModel: draft.model } : {}),
    ...(draft.enginePreset !== undefined ? { enginePreset: draft.enginePreset } : {}),
    ...(draft.codexProfileId !== undefined ? { codexProfileId: draft.codexProfileId } : {}),
  };
}

export async function submitStartDraft(
  deps: StartSubmitDeps = defaultStartSubmitDeps(),
): Promise<StartSubmitResult> {
  const draft = deps.tabsStore.getState().draft;
  if (draft === null) {
    return { ok: false, message: "No draft to submit." };
  }
  const { workspace, prompt, model, mode, engine, images, engineEffort } = draft;
  if (workspace === null) {
    return { ok: false, message: "Choose a project first." };
  }
  if (prompt.trim() === "") {
    return { ok: false, message: "Type a message to send." };
  }

  let result: CreateTabResult;
  try {
    result = await deps.createTab(createStartTabRequest(draft));
  } catch (error: unknown) {
    console.warn("[start-session] createTab rejected", error);
    return { ok: false, message: "Failed to create the task." };
  }
  let createdTabId: string | null = null;
  const failure = handleCreateTabResult(
    result,
    {
      onTabCreated: ({ tabId, workspace: tabWorkspace }) => {
        createdTabId = tabId;
        deps.tabsStore.getState().addTab({ tabId, workspace: tabWorkspace });
        deps.tabsStore.getState().setActiveTab(tabId);
      },
      onFocusTab: (tabId) => {
        deps.tabsStore.getState().setActiveTab(tabId);
      },
    },
    { engine },
  );

  if (failure !== null || createdTabId === null) {
    return { ok: false, message: failure ?? "Failed to create the task." };
  }

  // Codex/Claude own model and approval policy natively (the model already
  // rode `engineModel` on the CreateTabRequest spawn above) — do not emit
  // AnyCode's first-turn model/mode controls for an external engine. Effort
  // is the opposite split: it has NO spawn-time channel at all, so it rides
  // `queueInitialPrompt` for every engine — but through the message that
  // engine actually speaks. A non-core draft's pick goes out as
  // `set_engine_effort` (TASK.81; host/session.ts fires that case only
  // through the engineSettings seam core never wires), a Core draft's as
  // `set_reasoning_effort` (TASK.131 — the New Session picker now offers the
  // effort level of whatever model it is about to start, from that model's
  // own declared vocabulary). Images ride `queueInitialPrompt` for every
  // engine alike — there is no spawn-time attachment channel for any of them.
  if (engine === "core") {
    deps.registry.queueInitialPrompt(createdTabId, prompt, model ?? undefined, mode, undefined, images, engineEffort);
  } else {
    deps.registry.queueInitialPrompt(createdTabId, prompt, undefined, undefined, engineEffort, images);
  }
  deps.tabsStore.getState().discardDraft();
  return { ok: true, tabId: createdTabId };
}
