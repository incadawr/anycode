// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ModelPill } from "./ModelPill.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore } from "../store.js";
import { useSettingsStore } from "../settings-store.js";
import { tabRegistry } from "../tab-registry.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("saves the checked effort only after an unchanged acknowledgement, to the original connection", async () => {
  const previous = useSettingsStore.getState();
  const update = vi.fn().mockResolvedValue({ok: true});
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  (window as unknown as {anycode: unknown}).anycode = {listSessions: () => Promise.resolve([])};
  useSettingsStore.setState({
    connectionUpdate: update,
    snapshot: {settings: {provider: {activeConnectionId:"c", connections:[{id:"c", providerId:"z-ai"}], custom:[]}}, catalog:[{id:"z-ai", name:"Z.AI", authKind:"api_key", models:[{id:"glm-5.2", reasoning:true, effortLevels:["off","high","max"]}]}]} as never,
  });
  const store = createDesktopStore();
  store.setState({connection:"ready", model:"glm-5.2", reasoningEffort:"off", availableEffortLevels:["off","high","max"], pinnedConnection:{connectionId:"c", providerId:"z-ai"}});
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(TabContext.Provider, {value:{tabId:"tab", store}}, createElement(ModelPill))); });
    await act(async () => { container.querySelector<HTMLButtonElement>('.model-pill-chip')!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>('.start-model-effort-row')!.click(); });
    const off = container.querySelector<HTMLButtonElement>('[role="menuitemradio"][data-effort="off"]')!;
    expect(off.getAttribute("aria-checked")).toBe("true");
    await act(async () => { off.click(); });
    expect(send).toHaveBeenCalledWith("tab", {type:"set_reasoning_effort", effort:"off", requestId:expect.any(String)});
    expect(update).not.toHaveBeenCalled();
    useSettingsStore.setState({snapshot: {...useSettingsStore.getState().snapshot!, settings:{...useSettingsStore.getState().snapshot!.settings, provider:{...useSettingsStore.getState().snapshot!.settings.provider, activeConnectionId:"other"}}}});
    await act(async () => { store.getState().applyHostMessage({type:"reasoning_effort_changed", effort:"off", requestId: (send.mock.lastCall![1] as {requestId: string}).requestId}); });
    expect(update).toHaveBeenCalledWith({id:"c", modelOverrideModel:"glm-5.2", reasoningEffort:"off"});
    for (let i = 0; i < 2; i++) {
      await act(async () => { container.querySelector<HTMLButtonElement>(".model-pill-chip")!.click(); });
      await act(async () => { container.querySelector<HTMLButtonElement>(".start-model-effort-row")!.click(); });
      await act(async () => { container.querySelector<HTMLButtonElement>('[role="menuitemradio"][data-effort="high"]')!.click(); });
      await act(async () => { store.getState().applyHostMessage({type:"reasoning_effort_changed", effort:"high", requestId: (send.mock.lastCall![1] as {requestId: string}).requestId}); });
    }
    expect(update).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenLastCalledWith({id:"c", modelOverrideModel:"glm-5.2", reasoningEffort:"high"});
  } finally {
    await act(async () => root.unmount());
    useSettingsStore.setState(previous, true);
    send.mockRestore();
    container.remove();
  }
});
