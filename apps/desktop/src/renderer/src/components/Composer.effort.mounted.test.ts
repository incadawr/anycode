/**
 * RENDERED regression for the effort control's handoff from Composer to the
 * native model menu. The menu-level test builds its own props; this one mounts
 * the REAL Composer, so a Composer that stops passing the effort control (or
 * gates it on a known current effort) fails here instead of silently rendering
 * a menu whose effort row cannot invoke anything.
 *
 * The engine model below is a synthetic id with no AnyCode provider-catalog
 * entry and no reported (applied) effort — exactly the session shape the
 * capability gate used to misread as "no effort support".
 */
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore } from "../store.js";
import { useTabsStore } from "../tabs-store.js";
import { tabRegistry } from "../tab-registry.js";
import type { HostToUiMessage } from "../../../shared/protocol.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EFFORTS = ["low", "medium", "high", "xhigh"];

/**
 * The two-model handshake: `model-a` is the APPLIED model and it is applied at
 * `xhigh`; `model-b` is a second catalog entry that also advertises `xhigh`.
 */
function twoModelReady(appliedEffort: string): HostToUiMessage {
  return {
    type: "host_ready",
    workspace: "/ws",
    mode: "build",
    model: "model-a",
    sessionId: "sess-1",
    engine: {
      id: "codex",
      capabilities: {
        supportsCorePermissions: false,
        supportsRewind: false,
        supportsWorkflow: false,
        supportsGitMutations: false,
        supportsContextUsage: true,
        supportsContextBreakdown: false,
        supportsInteractiveApprovals: true,
        costAccounting: false,
        supportsModelSelection: true,
        supportsReasoningEffort: true,
        supportsImages: true,
        supportsTasks: false,
        supportsFileSnapshots: false,
        supportsManualCompact: false,
      },
      model: {
        current: "model-a",
        available: [
          { id: "model-a", label: "Model A", efforts: EFFORTS },
          { id: "model-b", label: "Model B", efforts: EFFORTS },
        ],
        effort: appliedEffort,
      },
      permissions: { presets: [], activePresetId: "" },
    },
  };
}

function nativeStore() {
  const store = createDesktopStore();
  store.setState({
    connection: "ready",
    turn: { status: "idle", turnId: null, requestId: null },
    queueInFlight: null,
    model: null,
    reasoningEffort: "medium",
    availableEffortLevels: undefined,
    engine: {
      id: "codex",
      capabilities: {
        supportsCorePermissions: false,
        supportsRewind: false,
        supportsWorkflow: false,
        supportsGitMutations: false,
        supportsContextUsage: true,
        supportsContextBreakdown: false,
        supportsInteractiveApprovals: true,
        costAccounting: false,
        supportsModelSelection: true,
        supportsReasoningEffort: true,
        supportsImages: true,
        supportsTasks: false,
        supportsFileSnapshots: false,
        supportsManualCompact: false,
      },
      // `effort` stays absent: the session has not reported an applied effort.
      model: { current: "gpt-6.1-terra", available: [{ id: "gpt-6.1-terra", label: "Terra", efforts: EFFORTS }] },
      permissions: { presets: [], activePresetId: "" },
    },
    pendingEngineChange: null,
  });
  return store;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  useTabsStore.setState({ availableEngines: [] });
});

describe("Composer — native effort handoff", () => {
  it("offers the effort row and sends xhigh for a model whose current effort is unknown", async () => {
    const store = nativeStore();
    useTabsStore.setState({ availableEngines: ["codex"] });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(TabContext.Provider, { value: { tabId: "tab-1", store } }, createElement(Composer)),
      );
    });
    try {
      const chip = container.querySelector<HTMLButtonElement>('button[aria-label="Engine model and effort"]');
      expect(chip, "the native model menu must render").not.toBeNull();
      // No invented level: an unknown current effort reads as Default.
      expect(chip!.textContent).toContain("Default");

      await act(async () => chip!.click());
      const rootPage = container.querySelector<HTMLElement>('[data-model-pill-page="root"]');
      expect(rootPage, "the menu root page must open").not.toBeNull();
      const effortRow = [...rootPage!.querySelectorAll<HTMLButtonElement>("button.model-pill-row")]
        .find((button) => button.querySelector(".model-pill-row-name")?.textContent === "Effort");
      expect(effortRow, "the effort row must be offered without a known current effort").toBeDefined();
      await act(async () => effortRow!.click());

      const page = container.querySelector('[data-model-pill-page="effort"]');
      expect(page).not.toBeNull();
      const xhigh = [...page!.querySelectorAll<HTMLButtonElement>("button.model-pill-item")]
        .find((item) => item.getAttribute("data-effort") === "xhigh");
      expect(xhigh).toBeDefined();
      await act(async () => xhigh!.click());

      // The choice reaches the host through Composer's own handler (the prop
      // was not dropped, and the pick was not swallowed as "no change").
      expect(send).toHaveBeenCalledWith("tab-1", { type: "set_engine_effort", effort: "xhigh" });
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps an effort chosen for a newly selected model and reports it", async () => {
    // The whole scenario through the REAL reducer: the store is fed the host's
    // own messages, so nothing here is a hand-built `pendingEngineChange` or a
    // hand-built menu prop.
    const store = createDesktopStore();
    useTabsStore.setState({ availableEngines: ["codex"] });
    vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});

    // Host handshake: model A is applied at `xhigh`.
    store.getState().applyHostMessage(twoModelReady("xhigh"));
    // The host accepts a switch to B (...)
    store.getState().applyHostMessage({ type: "engine_settings_changed", model: "model-b", state: "pending", appliesFrom: "next_turn" });
    // (...) and then `xhigh` FOR B. That is the same string as A's applied
    // effort but a different model's choice, so it is a real pending change:
    // dropping it made the menu read Default although the host had accepted it.
    store.getState().applyHostMessage({ type: "engine_settings_changed", model: "model-b", effort: "xhigh", state: "pending", appliesFrom: "next_turn" });

    expect(store.getState().engine?.model?.current).toBe("model-a");
    expect(store.getState().pendingEngineChange).toEqual({ model: "model-b", effort: "xhigh" });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(TabContext.Provider, { value: { tabId: "tab-1", store } }, createElement(Composer)),
      );
    });
    try {
      // The chip reports the selected effort (Default is the applied effort of
      // the selected model, which B has not reported yet).
      const chip = container.querySelector<HTMLButtonElement>('button[aria-label="Engine model and effort"]');
      expect(chip, "the native model menu must render").not.toBeNull();
      expect(chip!.textContent).toContain("Model B");
      expect(chip!.textContent).toContain("xhigh");

      await act(async () => chip!.click());
      const rootPage = container.querySelector<HTMLElement>('[data-model-pill-page="root"]');
      const effortRow = [...rootPage!.querySelectorAll<HTMLButtonElement>("button.model-pill-row")]
        .find((button) => button.querySelector(".model-pill-row-name")?.textContent === "Effort");
      expect(effortRow).toBeDefined();
      await act(async () => effortRow!.click());

      const page = container.querySelector('[data-model-pill-page="effort"]');
      expect(page).not.toBeNull();
      const xhigh = [...page!.querySelectorAll<HTMLButtonElement>("button.model-pill-item")]
        .find((item) => item.getAttribute("data-effort") === "xhigh");
      expect(xhigh, "the selected effort must be offered").toBeDefined();
      // ...and it is the CHECKED row of its page, flagged as not yet in force.
      expect(xhigh!.getAttribute("aria-checked")).toBe("true");
      expect(xhigh!.textContent).toContain("next turn");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
