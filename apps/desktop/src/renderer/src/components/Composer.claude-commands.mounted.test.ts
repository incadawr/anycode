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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    orchestration: { enabled: false, available: true, posture: "off" },
    orchestrationProtocol: { version: 1, hostIncarnation: "host", connectionId: "conn", atomicSubmit: true, correlatedToggle: true },
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

beforeEach(() => {
  const connection = {};
  vi.spyOn(tabRegistry, "getLiveHostConnection").mockImplementation((_id, store) => store.getState().connection === "ready" ? connection : null);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  useTabsStore.setState({ availableEngines: [] });
  useSettingsStore.setState({ snapshot: originalSnapshot, notice: null });
});


describe("Claude command completion", () => {
  it("requests a catalog for a namespace with no static match and inserts without sending", async () => {
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    const store = createDesktopStore();
    const ready = coreReady("build");
    if (ready.type !== "host_ready" || !ready.engine) throw new Error("fixture");
    ready.engine.id = "claude";
    store.getState().applyHostMessage(ready);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab-1", store } }, createElement(Composer))));
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "/ci:");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.setSelectionRange(4, 4);
        textarea.dispatchEvent(new Event("keyup", { bubbles: true }));
      });
      const request = send.mock.calls.map(call => call[1]).find(message => message.type === "claude_commands_request");
      expect(request?.type).toBe("claude_commands_request");
      if (!request || request.type !== "claude_commands_request") throw new Error("no request");
      await act(async () => store.getState().applyHostMessage({ type: "claude_commands_result", requestId: request.requestId, rows: [{ name: "ci:inspect", scope: "project", description: "Inspect", argumentHint: "target" }] }));
      expect(container.textContent).toContain("Project");
      expect(container.textContent).toContain("target");
      const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent?.includes("ci:inspect"));
      expect(option).toBeDefined();
      await act(async () => option!.click());
      expect(textarea.value).toBe("/ci:inspect ");
      expect(send).not.toHaveBeenCalledWith("tab-1", expect.objectContaining({ type: "user_message" }));
    } finally { await act(async () => root.unmount()); }
  });
});
