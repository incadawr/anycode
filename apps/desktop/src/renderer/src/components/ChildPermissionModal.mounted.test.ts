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

vi.spyOn(document, "hasFocus").mockReturnValue(true);

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
    expect(send).toHaveBeenCalledWith("tab-one", { type: "approval_visibility", requestId: "same", visible: true });
    expect(send).not.toHaveBeenCalledWith("tab-two", { type: "approval_visibility", requestId: "same", visible: true });
    await act(async () => parent.getState().applyHostMessage({ type: "agent_event", turnId: "turn", event: { type: "tool_call", toolCall: { id: "call-one", name: "Agent", input: { description: "Review code" } } } }));
    expect(container.textContent).toContain("Subagent: Review code");
    await act(async () => parent.getState().applyHostMessage({ type: "agent_event", turnId: "turn", event: { type: "subagent_start", toolCallId: "call-one", agentType: "executor", description: "Joining child" } }));
    expect(container.textContent).toContain("Subagent: Joining child");
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-allow-button")!.click());
    expect(send).toHaveBeenCalledWith("tab-one", expect.objectContaining({ requestId: "same", behavior: "allow" }));
    await act(async () => first.getState().applyHostMessage({ type: "permission_settled", requestId: "same", behavior: "allow", origin: "ui" }));
    expect(container.textContent).toContain("Subagent: two");
    expect(send).toHaveBeenCalledWith("tab-two", { type: "approval_visibility", requestId: "same", visible: true });
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


it("shows child expiry and sends recovery only to that child", async () => {
  const parent = createDesktopStore();
  const first = createDesktopStore();
  const second = createDesktopStore();
  parent.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "parent" });
  for (const [store, id] of [[first, "one"], [second, "two"]] as const) store.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: id });
  first.getState().applyHostMessage({ type: "approval_state", unattended: true, pending: null });
  const lookup = vi.spyOn(tabRegistry, "getStore").mockImplementation((id) => id === "tab-one" ? first : id === "tab-two" ? second : undefined);
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  childRelationStore.getState().registerChild("parent", "call-one", "tab-one", "one");
  childRelationStore.getState().registerChild("parent", "call-two", "tab-two", "two");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "parent-tab", store: parent } }, createElement(ConnectedChildPermissionModal))));
    expect(container.textContent).toContain("Subagent: one");
    expect(container.textContent).toContain("denied automatically");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("tab-one", { type: "approval_recover" });
    await act(async () => first.getState().applyHostMessage({ type: "approval_state", unattended: false, pending: null }));
    expect(container.textContent).not.toContain("denied automatically");
  } finally {
    await act(async () => root.unmount());
    childRelationStore.getState().reset();
    lookup.mockRestore(); send.mockRestore();
  }
});


it("keeps the expiry visible when the child finishes immediately", async () => {
  const parent = createDesktopStore();
  const child = createDesktopStore();
  parent.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "parent" });
  child.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "one" });
  const lookup = vi.spyOn(tabRegistry, "getStore").mockImplementation((id) => id === "tab-one" ? child : undefined);
  childRelationStore.getState().registerChild("parent", "call-one", "tab-one", "one");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "parent-tab", store: parent } }, createElement(ConnectedChildPermissionModal))));
    await act(async () => {
      child.getState().applyHostMessage({ type: "approval_state", unattended: true, pending: null });
      childRelationStore.getState().markChildGone("tab-one", child.getState().unattended);
    });
    expect(container.textContent).toContain("an unanswered request expired before this subagent finished");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.textContent).not.toContain("an unanswered request expired");
  } finally {
    await act(async () => root.unmount());
    childRelationStore.getState().reset();
    lookup.mockRestore();
  }
});


it("reports visibility only while the window is visible and focused", async () => {
  const parent = createDesktopStore();
  const child = createDesktopStore();
  parent.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "parent" });
  child.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "one" });
  child.getState().applyHostMessage({ type: "permission_request", requestId: "ask", toolName: "Bash", input: {}, mode: "build", metadata: { name: "Bash", description: "run", readOnly: false, destructive: false, riskLevel: "medium", sideEffectScope: "process" } });
  const lookup = vi.spyOn(tabRegistry, "getStore").mockReturnValue(child);
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  childRelationStore.getState().registerChild("parent", "call", "child", "one");
  const root = createRoot(document.createElement("div"));
  const expected = (visible: boolean) => ({ type: "approval_visibility", requestId: "ask", visible });
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "parent-tab", store: parent } }, createElement(ConnectedChildPermissionModal))));
    expect(send).toHaveBeenLastCalledWith("child", expected(false));
    focus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    expect(send).toHaveBeenLastCalledWith("child", expected(true));
    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(send).toHaveBeenLastCalledWith("child", expected(false));
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(send).toHaveBeenLastCalledWith("child", expected(true));
    window.dispatchEvent(new Event("blur"));
    expect(send).toHaveBeenLastCalledWith("child", expected(false));
  } finally {
    await act(async () => root.unmount());
    childRelationStore.getState().reset(); lookup.mockRestore(); send.mockRestore(); hidden.mockRestore(); focus.mockReturnValue(true);
  }
});
