// @vitest-environment jsdom
/**
 * The first-run role dialog's Skip button, exercised through the Start screen
 * that renders it — not through the submission helper. A helper-only test
 * would still pass if the dialog's Skip handler went back to only closing the
 * dialog, which is exactly the regression being guarded.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartScreen } from "./StartScreen.js";
import { tabRegistry } from "../tab-registry.js";
import { useSettingsStore } from "../settings-store.js";
import { useTabsStore } from "../tabs-store.js";
import { cloneDefaults } from "../../../settings/schema.js";
import type { SettingsSnapshot } from "../../../shared/settings.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
const createTab = vi.fn(async (request: { workspace: string }) => ({ ok: true as const, tabId: "t1", workspace: request.workspace }));

const originalSnapshot = useSettingsStore.getState().snapshot;
const originalTabsState = useTabsStore.getState();

function snapshot(): SettingsSnapshot {
  return {
    settings: cloneDefaults(),
    secrets: [],
    providerReady: true,
    envOverrides: [],
    readOnly: false,
    catalog: [],
  };
}

beforeEach(() => {
  // jsdom implements <dialog> but not its modal methods.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };
  container = document.createElement("div");
  document.body.append(container);
  Object.defineProperty(window, "anycode", {
    configurable: true,
    value: {
      createTab,
      listSessions: vi.fn(async () => []),
      listAvailableEngines: vi.fn(async () => ({ engineIds: ["core"] })),
      onEnginesChanged: vi.fn(() => () => {}),
      pickWorkspace: vi.fn(async () => ({ workspace: null })),
      codex: {
        recheck: vi.fn(async () => ({ report: { status: "unavailable" } })),
        listProfiles: vi.fn(async () => ({ profiles: [] })),
      },
    },
  });
  useSettingsStore.setState({ snapshot: snapshot(), notice: null });
  useTabsStore.setState({
    draft: null,
    draftActive: false,
    availableEngines: ["core"],
    codexModels: [],
    tabs: [],
    activeTabId: null,
  });
});

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
  useSettingsStore.setState({ snapshot: originalSnapshot, notice: null });
  useTabsStore.setState(originalTabsState, true);
  createTab.mockClear();
  vi.restoreAllMocks();
});

async function mount(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(StartScreen, { onToast: vi.fn() }));
  });
}

describe("Start screen first-run role dialog", () => {
  it("Skip starts the orchestration task instead of only closing the dialog", async () => {
    const queueInitialPrompt = vi.spyOn(tabRegistry, "queueInitialPrompt");
    await mount();

    await act(async () => {
      useTabsStore.getState().openDraft("/ws/a");
      useTabsStore.getState().setDraftPrompt("/orchestrate say hi");
    });

    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    await act(async () => {
      send.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The gate opened the same dialog the in-tab /orchestrate flow uses.
    const skip = container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]');
    expect(skip).not.toBeNull();
    expect(createTab).not.toHaveBeenCalled();

    await act(async () => {
      skip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Skip proceeds exactly like Save: one task created, the task text queued
    // with orchestrate on, the draft consumed.
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab).toHaveBeenCalledWith({ kind: "new", workspace: "/ws/a" });
    expect(queueInitialPrompt).toHaveBeenCalledWith("t1", "say hi", undefined, "build", undefined, undefined, undefined, true);
    expect(useTabsStore.getState().draft).toBeNull();
    expect(container.querySelector('[data-testid="role-picker-skip"]')).toBeNull();
  });
});
