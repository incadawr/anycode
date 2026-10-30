/**
 * The in-tab mode menu's Orchestrate row, through the REAL Composer.
 *
 * Owner-reported (UI/UX audit D5/D6): clicking Orchestrate in the mode menu
 * closed the menu with no visible effect, and an orchestrated tab's chip still
 * read only "Plan". This mounts Composer with a core session and no roles
 * configured, clicks the row, and pins both halves: the first run is asked for
 * roles before the enable goes out, and once the host acks, the chip says so.
 */
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore } from "../store.js";
import { useTabsStore } from "../tabs-store.js";
import { useSettingsStore } from "../settings-store.js";
import { tabRegistry } from "../tab-registry.js";
import { cloneDefaults } from "../../../settings/schema.js";
import type { HostToUiMessage } from "../../../shared/protocol.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalSnapshot = useSettingsStore.getState().snapshot;

function coreReady(mode: "plan" | "build"): HostToUiMessage {
  return {
    type: "host_ready",
    workspace: "/ws",
    mode,
    model: "glm-5.3",
    sessionId: "sess-1",
    engine: {
      id: "core",
      capabilities: {
        supportsCorePermissions: true,
        supportsRewind: true,
        supportsWorkflow: true,
        supportsGitMutations: true,
        supportsContextUsage: true,
        supportsContextBreakdown: true,
        supportsInteractiveApprovals: true,
        costAccounting: true,
        supportsModelSelection: true,
        supportsReasoningEffort: true,
        supportsImages: true,
        supportsTasks: true,
        supportsFileSnapshots: true,
        supportsManualCompact: true,
      },
      model: { current: "glm-5.3", available: [] },
      permissions: { presets: [], activePresetId: "" },
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  useTabsStore.setState({ availableEngines: [] });
  useSettingsStore.setState({ snapshot: originalSnapshot, notice: null });
});

// jsdom implements <dialog> but not its modal methods (RolePickerDialog uses them).
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.open = false;
};

describe("Composer — mode menu's Orchestrate row", () => {
  it("asks for roles on the first enable, then enables and shows Orchestrate on the chip", async () => {
    // No roles in the settings snapshot: exactly the first-run state.
    useSettingsStore.setState({ snapshot: { settings: cloneDefaults(), secrets: [], providerReady: true, envOverrides: [], readOnly: false, catalog: [] } });
    useTabsStore.setState({ availableEngines: ["core"] });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    const store = createDesktopStore();
    store.getState().applyHostMessage(coreReady("build"));

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(TabContext.Provider, { value: { tabId: "tab-1", store } }, createElement(Composer)));
      });

      const chip = container.querySelector<HTMLButtonElement>(".mode-chip")!;
      expect(chip.textContent).toContain("build");
      await act(async () => chip.click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mode-menu-orchestrate"]')!.click());

      // Roles first: nothing has been sent to the host yet.
      expect(container.querySelector('[data-testid="role-picker-skip"]')).not.toBeNull();
      expect(send).not.toHaveBeenCalledWith("tab-1", expect.objectContaining({ type: "set_orchestrate" }));

      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]')!.click());
      expect(send).toHaveBeenCalledWith("tab-1", { type: "set_orchestrate", enabled: true });

      // The host's ack is what makes the tab visibly orchestrate.
      await act(async () => {
        store.getState().applyHostMessage({ type: "orchestrate_changed", enabled: true });
        store.getState().applyHostMessage({ type: "mode_changed", mode: "plan" });
      });
      expect(container.querySelector(".mode-chip")!.textContent).toContain("Orchestrate");
      expect(container.querySelector(".mode-chip")!.classList.contains("mode-chip-orchestrate")).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
