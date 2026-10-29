// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createDesktopStore } from "../store.js";
import { TabContext } from "../tab-context.js";
import { tabRegistry } from "../tab-registry.js";
import { childRelationStore } from "../child-sessions.js";
import { ConnectedChildPermissionModal } from "./ChildPermissionModal.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };

it("updates late descriptions and answers the correct sibling", async () => {
  const parent = createDesktopStore();
  const first = createDesktopStore();
  const second = createDesktopStore();
  parent.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "parent" });
  parent.getState().applyHostMessage({ type: "turn_started", requestId: "request", turnId: "turn" });
  for (const [store, id] of [[first, "one"], [second, "two"]] as const) {
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: id });
    store.getState().applyHostMessage({ type: "permission_request", requestId: "same", toolName: "Bash", input: { command: "ls" }, mode: "build", metadata: { name: "Bash", description: "run", readOnly: false, destructive: false, riskLevel: "medium", sideEffectScope: "process" } });
  }
  const lookup = vi.spyOn(tabRegistry, "getStore").mockImplementation((id) => id === "tab-one" ? first : id === "tab-two" ? second : undefined);
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  childRelationStore.getState().registerChild("parent", "call-one", "tab-one", "one");
  childRelationStore.getState().registerChild("parent", "call-two", "tab-two", "two");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "parent-tab", store: parent } }, createElement(ConnectedChildPermissionModal))));
    expect(container.textContent).toContain("Subagent: one");
    await act(async () => parent.getState().applyHostMessage({ type: "agent_event", turnId: "turn", event: { type: "tool_call", toolCall: { id: "call-one", name: "Agent", input: { description: "Review code" } } } }));
    expect(container.textContent).toContain("Subagent: Review code");
    await act(async () => parent.getState().applyHostMessage({ type: "agent_event", turnId: "turn", event: { type: "subagent_start", toolCallId: "call-one", agentType: "executor", description: "Joining child" } }));
    expect(container.textContent).toContain("Subagent: Joining child");
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-allow-button")!.click());
    expect(send).toHaveBeenCalledWith("tab-one", expect.objectContaining({ requestId: "same", behavior: "allow" }));
    await act(async () => first.getState().applyHostMessage({ type: "permission_settled", requestId: "same", behavior: "allow", origin: "ui" }));
    expect(container.textContent).toContain("Subagent: two");
    await act(async () => parent.getState().applyHostMessage({ type: "agent_event", turnId: "turn", event: { type: "tool_call", toolCall: { id: "call-two", name: "Agent", input: { description: "   " } } } }));
    expect(container.textContent).toContain("Subagent: two");
    await act(async () => parent.getState().applyHostMessage({ type: "background_children", children: [{ childSessionId: "two", description: "Review code", agentType: "executor", startedAt: Date.now() }] }));
    expect(container.textContent).toContain("Subagent: Review code");
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-deny-button")!.click());
    expect(send).toHaveBeenCalledWith("tab-two", expect.objectContaining({ requestId: "same", behavior: "deny" }));
  } finally {
    await act(async () => root.unmount());
    childRelationStore.getState().reset();
    lookup.mockRestore(); send.mockRestore();
  }
});
