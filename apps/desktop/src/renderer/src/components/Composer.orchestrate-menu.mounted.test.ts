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

// jsdom implements <dialog> but not its modal methods (RolePickerDialog uses them).
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
  this.open = true;
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
  this.open = false;
};

describe("Composer — mode menu's Orchestrate row", () => {
  it("restores an ordinary held draft and its attachment without sending automatically", async () => {
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    const store = createDesktopStore(); store.getState().applyHostMessage(coreReady("build"));
    const image = {name:"ordinary.png",sizeBytes:3,attachment:{mediaType:"image/png" as const,data:"YWJj"}};
    store.getState().enqueuePrompt({text:"ordinary",images:[image],requiresRestore:true});
    const container = document.createElement("div"); document.body.append(container);
    let root = createRoot(container);
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"tab-1",store}}, createElement(Composer))));
      await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-restore")!.click());
      expect(container.querySelector<HTMLTextAreaElement>(".composer-textarea")!.value).toBe("ordinary");
      expect(container.querySelector(".composer-image-pill-name")?.textContent).toBe("ordinary.png");
      expect(send).not.toHaveBeenCalledWith("tab-1", expect.objectContaining({type:"user_message"}));
      await act(async () => container.querySelector<HTMLButtonElement>('.composer-send')!.click());
      expect(send).toHaveBeenCalledWith("tab-1", expect.objectContaining({type:"user_message",text:"ordinary",images:[image.attachment]}));
    } finally { await act(async () => root.unmount()); }
  });
  it("restores a held orchestration draft only into an empty composer and never sends it as an ordinary turn", async () => {
    useSettingsStore.setState({ snapshot: { settings: cloneDefaults(), secrets: [], providerReady: true, envOverrides: [], readOnly: false, catalog: [] } });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    const store = createDesktopStore();
    store.getState().applyHostMessage(coreReady("build"));
    const image = {name:"a.png",sizeBytes:3,attachment:{mediaType:"image/png" as const,data:"YWJj"}};
    store.getState().enqueuePrompt({text:"recover me",images:[image],orchestrate:"enable",initialPicks:{model:"glm-5.3",mode:"build",reasoningEffort:"high"}});
    store.getState().enqueuePrompt({text:"next message",images:[]});
    const container = document.createElement("div"); document.body.append(container);
    let root = createRoot(container);
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"tab-1",store}}, createElement(Composer))));
      let textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      const type = async (text: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,text); textarea.dispatchEvent(new Event("input",{bubbles:true})); }); };
      await type("new edit");
      await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-restore")!.click());
      expect(textarea.value).toBe("new edit");
      expect(store.getState().promptQueue).toHaveLength(2);
      await type("");
      await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-restore")!.click());
      expect(textarea.value).toBe("recover me");
      expect(container.querySelector(".composer-image-pill-name")?.textContent).toBe("a.png");
      expect(container.textContent).toContain("Orchestration intent retained");
      expect(store.getState().promptQueue).toHaveLength(1);
      await type("recover me edited");
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"tab-1",store}}, createElement(Composer))));
      textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      expect(textarea.value).toBe("recover me edited");
      expect(store.getState().restoredComposerDraft?.initialPicks).toEqual({model:"glm-5.3",mode:"build",reasoningEffort:"high"});
      expect(container.textContent).toContain("glm-5.3 / build / high");
      expect(container.querySelector(".composer-image-pill-name")?.textContent).toBe("a.png");
      expect(container.textContent).toContain("Orchestration intent retained");
      await act(async () => container.querySelector<HTMLButtonElement>('.composer-send')!.click());
      expect(send).not.toHaveBeenCalledWith("tab-1", expect.objectContaining({type:"user_message"}));
      const removeIntent = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Remove orchestration intent")!;
      await act(async () => removeIntent.click());
      await act(async () => container.querySelector<HTMLButtonElement>('.composer-send')!.click());
      expect(send).not.toHaveBeenCalledWith("tab-1", expect.objectContaining({type:"user_message"}));
      await act(async () => store.setState({reasoningEffort:"high"}));
      await act(async () => container.querySelector<HTMLButtonElement>('.composer-send')!.click());
      expect(send).toHaveBeenCalledWith("tab-1", expect.objectContaining({type:"user_message",text:"recover me edited",images:[image.attachment]}));
      await act(async () => { expect(store.getState().takeQueueHead("next")?.text).toBe("next message"); });
    } finally { await act(async () => root.unmount()); }
  });
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
      // The truncated chip's full text rides the title in EVERY state, not
      // only while orchestrate is on (the label can ellipsize to its 3ch
      // floor, so hover is the only place the full name survives).
      expect(chip.title).toBe("build");
      await act(async () => chip.click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mode-menu-orchestrate"]')!.click());

      // Roles first: nothing has been sent to the host yet.
      expect(container.querySelector('[data-testid="role-picker-skip"]')).not.toBeNull();
      expect(send).not.toHaveBeenCalledWith("tab-1", expect.objectContaining({ type: "set_orchestrate" }));

      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]')!.click());
      expect(send).toHaveBeenCalledWith("tab-1", expect.objectContaining({ type: "set_orchestrate", enabled: true, connectionId: "conn", requestId: expect.any(String) }));
      const requestId = (send.mock.calls.at(-1)![1] as {requestId: string}).requestId;
      expect(store.getState().orchestrateActive).toBe(false);

      // The host's ack is what makes the tab visibly orchestrate.
      await act(async () => {
        store.getState().applyHostMessage({ type: "orchestrate_changed", enabled: true });
        expect(store.getState().orchestrateActive).toBe(false);
        store.getState().applyHostMessage({ type: "orchestrate_result", requestId, connectionId: "conn", outcome: "applied", enabled: true });
        store.getState().applyHostMessage({ type: "mode_changed", mode: "plan" });
      });
      expect(container.querySelector(".mode-chip")!.textContent).toContain("Orchestrate");
      expect(container.querySelector(".mode-chip")!.classList.contains("mode-chip-orchestrate")).toBe(true);
      expect(container.querySelector<HTMLButtonElement>(".mode-chip")!.title).toBe("Orchestrate is on: child agents do the work, the session runs in Plan");
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("retains the task when the role picker is cancelled and sends one atomic message after skip", async () => {
    useSettingsStore.setState({ snapshot: { settings: cloneDefaults(), secrets: [], providerReady: true, envOverrides: [], readOnly: false, catalog: [] } });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    const store = createDesktopStore(); store.getState().applyHostMessage(coreReady("build"));
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"tab-1",store}}, createElement(Composer))));
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      const type = async (value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,value); textarea.dispatchEvent(new Event("input",{bubbles:true})); }); };
      await type("/orchestrate do work");
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(container.querySelector('[data-testid="role-picker-cancel"]')).not.toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-cancel"]')!.click());
      expect(textarea.value).toBe("/orchestrate do work");
      expect(send).not.toHaveBeenCalled();
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]')!.click());
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("tab-1", expect.objectContaining({ type: "user_message", text: "do work", orchestrate: "enable", connectionId: "conn", requestId: expect.any(String) }));
      expect(store.getState().orchestration.posture).toBe("transitioning");
      expect(store.getState().orchestrationDeliveries[0]?.status).toBe("pending");
    } finally { await act(async () => root.unmount()); }
  });

  it("resends a restored orchestration draft with its image atomically", async () => {
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    const store = createDesktopStore(); store.getState().applyHostMessage(coreReady("build"));
    const image = {name:"a.png",sizeBytes:3,attachment:{mediaType:"image/png" as const,data:"YWJj"}};
    store.getState().enqueuePrompt({ text:"review image", images:[image], orchestrate:"enable", requiresRestore:true });
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"tab-1",store}}, createElement(Composer))));
      await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-restore")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(send).toHaveBeenCalledWith("tab-1", expect.objectContaining({ type:"user_message", text:"review image", images:[image.attachment], orchestrate:"enable", connectionId:"conn" }));
      expect(store.getState().orchestrationDeliveries).toMatchObject([{ text:"review image", images:[image], status:"pending" }]);
    } finally { await act(async () => root.unmount()); }
  });

  it.each(["codex","claude"] as const)("exposes %s orchestration only when the host advertises it and waits for the toggle acknowledgement", async engineId => {
    useSettingsStore.setState({ snapshot: { settings: cloneDefaults(), secrets: [], providerReady: true, envOverrides: [], readOnly: false, catalog: [] } });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    const store = createDesktopStore();
    const ready = coreReady("build") as Extract<HostToUiMessage, {type:"host_ready"}>;
    ready.engine = { ...ready.engine!, id: engineId, capabilities: { ...ready.engine!.capabilities, supportsCorePermissions: false } };
    ready.orchestration = {enabled:false, available:false};
    store.getState().applyHostMessage(ready);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"tab-1",store}}, createElement(Composer))));
      expect(container.textContent).not.toContain("Orchestrate");
      await act(async () => store.getState().applyHostMessage({...ready, orchestration:{enabled:false,available:true,posture:"off"}}));
      // Icon-only toggle: the accessible name carries the state, the chip's
      // own text is gone (a text chip wrapped and inflated the chip row).
      const toggle = () => container.querySelector<HTMLButtonElement>("button.orchestrate-toggle")!;
      expect(toggle()).not.toBeNull();
      expect(toggle().getAttribute("aria-label")).toBe("Orchestrate: delegate work to child agents");
      expect(toggle().getAttribute("aria-pressed")).toBe("false");
      expect(container.querySelector(".mode-menu")).toBeNull();
      await act(async () => toggle().click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]')!.click());
      const request = send.mock.calls.at(-1)![1] as {requestId:string};
      expect(store.getState().orchestrateActive).toBe(false);
      await act(async () => store.getState().applyHostMessage({type:"orchestrate_result",requestId:request.requestId,connectionId:"conn",outcome:"applied",enabled:true}));
      // The host's ack is what flips the pressed state (and the label with it).
      expect(toggle().getAttribute("aria-pressed")).toBe("true");
      expect(toggle().getAttribute("aria-label")).toBe("Orchestration is on: child agents do the work");
    } finally { await act(async () => root.unmount()); }
  });

  it("sends a Codex slash task atomically after the role picker and retains unavailable tasks", async () => {
    useSettingsStore.setState({ snapshot: { settings: cloneDefaults(), secrets: [], providerReady: true, envOverrides: [], readOnly: false, catalog: [] } });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    const store = createDesktopStore();
    const ready = coreReady("build") as Extract<HostToUiMessage, {type:"host_ready"}>;
    ready.engine = { ...ready.engine!, id:"codex", capabilities:{...ready.engine!.capabilities,supportsCorePermissions:false} };
    ready.orchestration = {enabled:false,available:false};
    store.getState().applyHostMessage(ready);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"tab-1",store}}, createElement(Composer))));
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"/orchestrate do work"); textarea.dispatchEvent(new Event("input",{bubbles:true})); });
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(textarea.value).toBe("/orchestrate do work");
      expect(send).not.toHaveBeenCalled();
      await act(async () => store.getState().applyHostMessage({...ready,orchestration:{enabled:false,available:true,posture:"off"}}));
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]')!.click());
      expect(send).toHaveBeenCalledWith("tab-1",expect.objectContaining({type:"user_message",text:"do work",orchestrate:"enable",connectionId:"conn",requestId:expect.any(String)}));
    } finally { await act(async () => root.unmount()); }
  });

});
