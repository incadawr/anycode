// jsdom is supplied by Vitest but does not ship TypeScript declarations.
// @ts-expect-error no @types/jsdom dependency
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { createHarness } from "../../../host/test-harness.js";
import { writeTool } from "@anycode/core";
import { IpcPermissionBroker } from "../../../host/permission-broker.js";



it("recovery click reaches the session and the next request prompts", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLDialogElement: dom.window.HTMLDialogElement, IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.document.hasFocus = () => true;
  Object.defineProperty(dom.window.document, "hidden", { value: false, configurable: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createDesktopStore } = await import("../store.js");
  const { TabContext } = await import("../tab-context.js");
  const { tabRegistry } = await import("../tab-registry.js");
  const { childRelationStore } = await import("../child-sessions.js");
  const { ConnectedChildPermissionModal } = await import("./ChildPermissionModal.js");
  const h = createHarness({ steps: [], brokerTimeoutMs: 80 });
  const parent = createDesktopStore();
  const child = createDesktopStore();
  parent.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "parent" });
  const lookup = vi.spyOn(tabRegistry, "getStore").mockImplementation((id) => id === "tab-one" ? child : undefined);
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation((id, message) => { if (id === "tab-one") h.send(message); });
  childRelationStore.getState().registerChild("parent", "call-one", "tab-one", "one");
  const container = document.createElement("div");
  const root = createRoot(container);
  let applied = 0;
  const feed = () => { for (; applied < h.received.length; applied++) child.getState().applyHostMessage(h.received[applied]!); };
  const request = { toolName: "Write", input: { file_path: "/workspace/a", content: "x" }, metadata: writeTool.metadata, mode: "build" as const };
  try {
    h.send({ type: "ui_ready" });
    await h.waitUntil(() => h.received.some((message) => message.type === "host_ready"));
    await act(async () => { feed(); root.render(createElement(TabContext.Provider, { value: { tabId: "parent-tab", store: parent } }, createElement(ConnectedChildPermissionModal))); });
    const first = h.broker.requestPermission(request);
    await h.waitUntil(() => h.received.some((message) => message.type === "permission_settled" && message.origin === "timeout"));
    await first;
    await act(async () => feed());
    expect(container.textContent).toContain("denied automatically");
    const recoveryAt = h.received.length;
    await act(async () => container.querySelector<HTMLButtonElement>(".approval-status button")!.click());
    await h.waitUntil(() => h.received.slice(recoveryAt).some((message) => message.type === "approval_state" && !message.unattended));
    await act(async () => feed());
    const second = h.broker.requestPermission(request);
    await h.waitUntil(() => h.received.slice(recoveryAt).some((message) => message.type === "permission_request"));
    await act(async () => feed());
    expect(container.querySelector(".permission-deny-button")).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-deny-button")!.click());
    await expect(second).resolves.toMatchObject({ behavior: "deny" });
  } finally {
    await act(async () => root.unmount());
    childRelationStore.getState().reset(); lookup.mockRestore(); send.mockRestore(); h.close(); dom.window.close();
  }
});

it("shows the parent's recovery control while a child view is open", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLDialogElement: dom.window.HTMLDialogElement, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(dom.window, "anycode", { value: { previewPanel: { list: async () => ({ tabId: "parent-tab", previews: [] }), setState: async () => {} } } });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createDesktopStore } = await import("../store.js");
  const { TabContext } = await import("../tab-context.js");
  const { tabRegistry } = await import("../tab-registry.js");
  const { childLayoutStore } = await import("../child-layout.js");
  const { ActiveTabBody } = await import("../App.js");
  const parent = createDesktopStore();
  parent.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "parent" });
  parent.getState().applyHostMessage({ type: "approval_state", unattended: true, pending: null });
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  childLayoutStore.getState().open("parent-tab", "finished-child");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "parent-tab", store: parent } }, createElement(ActiveTabBody, { tabId: "parent-tab", sidebarCollapsed: false, onToggleSidebar: () => {}, onToast: () => {} }))));
    expect(container.querySelector(".child-session-breadcrumb")).not.toBeNull();
    expect(container.textContent).toContain("New approval requests are being denied automatically");
    await act(async () => container.querySelector<HTMLButtonElement>(".approval-status button")!.click());
    expect(send).toHaveBeenCalledWith("parent-tab", { type: "approval_recover" });
  } finally {
    await act(async () => root.unmount());
    childLayoutStore.getState().close("parent-tab");
    send.mockRestore(); dom.window.close();
  }
});


it("does not count down child asks queued behind another child or the parent", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLDialogElement: dom.window.HTMLDialogElement, IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.document.hasFocus = () => true;
  Object.defineProperty(dom.window.document, "hidden", { value: false, configurable: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createDesktopStore } = await import("../store.js");
  const { TabContext } = await import("../tab-context.js");
  const { tabRegistry } = await import("../tab-registry.js");
  const { childRelationStore } = await import("../child-sessions.js");
  const { ConnectedChildPermissionModal } = await import("./ChildPermissionModal.js");
  const parent = createDesktopStore();
  const first = createDesktopStore();
  const second = createDesktopStore();
  parent.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "parent" });
  for (const [store, id] of [[first, "one"], [second, "two"]] as const) store.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: id });
  const brokers = [first, second].map((store) => new IpcPermissionBroker((message) => store.getState().applyHostMessage(message), 1000, null, true));
  const lookup = vi.spyOn(tabRegistry, "getStore").mockImplementation((id) => id === "tab-one" ? first : id === "tab-two" ? second : undefined);
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation((id, message) => {
    const broker = brokers[id === "tab-one" ? 0 : 1]!;
    if (message.type === "approval_visibility") broker.setApprovalVisibility(message.requestId, message.visible);
    if (message.type === "permission_response") broker.handleResponse(message.requestId, message.behavior);
  });
  childRelationStore.getState().registerChild("parent", "call-one", "tab-one", "one");
  childRelationStore.getState().registerChild("parent", "call-two", "tab-two", "two");
  const container = document.createElement("div");
  const root = createRoot(container);
  const request = { toolName: "Write", input: { file_path: "/workspace/a", content: "x" }, metadata: writeTool.metadata, mode: "build" as const };
  vi.useFakeTimers();
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "parent-tab", store: parent } }, createElement(ConnectedChildPermissionModal))));
    await act(async () => { void brokers[0]!.requestPermission(request); void brokers[1]!.requestPermission(request); });
    expect(brokers[0]!.approvalState().pending?.deadline).toEqual(expect.any(Number));
    await act(async () => vi.advanceTimersByTimeAsync(400));
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("blur")));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(brokers[0]!.pendingCount).toBe(1);
    expect(brokers[0]!.isUnattended).toBe(false);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    expect(brokers[0]!.approvalState().pending?.deadline).toBe(Date.now() + 600);
    expect(brokers[1]!.approvalState().pending?.deadline).toBeUndefined();
    await act(async () => parent.getState().applyHostMessage({ type: "permission_request", requestId: "parent-ask", toolName: "Write", input: {}, mode: "build", metadata: { name: "Write", description: "write", readOnly: false, destructive: false, riskLevel: "high", sideEffectScope: "filesystem" } }));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(brokers.map((broker) => broker.pendingCount)).toEqual([1, 1]);
    await act(async () => parent.getState().applyHostMessage({ type: "permission_settled", requestId: "parent-ask", behavior: "deny", origin: "ui" }));
    expect(brokers[0]!.approvalState().pending?.deadline).toBe(Date.now() + 600);
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-deny-button")!.click());
    expect(brokers[1]!.approvalState().pending?.deadline).toBe(Date.now() + 1000);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(brokers[1]!.isUnattended).toBe(true);
  } finally {
    await act(async () => root.unmount());
    for (const broker of brokers) broker.denyAll("test cleanup", "shutdown");
    vi.useRealTimers(); childRelationStore.getState().reset(); lookup.mockRestore(); send.mockRestore(); dom.window.close();
  }
});

it("places finished-child notices below the header and clears them on visiting that child", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLDialogElement: dom.window.HTMLDialogElement, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(dom.window, "anycode", { value: { previewPanel: { list: async () => ({ tabId: "parent-tab", previews: [] }), setState: async () => {} }, browserAccess: { get: async () => ({ ok: true, tabs: [] }), onChanged: () => () => {} }, listSessions: async () => [], childHistory: async () => ({ ok: true, items: [] }) } });
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createDesktopStore } = await import("../store.js");
  const { TabContext } = await import("../tab-context.js");
  const { childRelationStore } = await import("../child-sessions.js");
  const { childLayoutStore } = await import("../child-layout.js");
  const { useTabsStore } = await import("../tabs-store.js");
  useTabsStore.getState().addTab({ tabId: "parent-tab", workspace: "/w" });
  useTabsStore.getState().setSessionId("parent-tab", "parent");
  const { ActiveTabBody } = await import("../App.js");
  const parent = createDesktopStore();
  parent.getState().applyHostMessage({ type: "host_ready", workspace: "/w", mode: "build", model: "m", sessionId: "parent" });
  childRelationStore.getState().registerChild("parent", "call", "child-tab", "child");
  childRelationStore.getState().markChildGone("child-tab", true);
  childRelationStore.getState().registerChild("parent", "continuation", "continued-tab", "child");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "parent-tab", store: parent } }, createElement(ActiveTabBody, { tabId: "parent-tab", sidebarCollapsed: true, onToggleSidebar: () => {}, onToast: () => {} }))));
    const header = container.querySelector(".session-header")!;
    const notice = container.querySelector(".approval-status")!;
    expect(header.nextElementSibling).toBe(notice);
    await act(async () => childLayoutStore.getState().open("parent-tab", "call"));
    expect(childRelationStore.getState().getRelation("parent", "call")?.approvalExpired).toBe(false);
    expect(container.querySelector(".approval-status")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    childLayoutStore.getState().close("parent-tab"); childRelationStore.getState().reset(); useTabsStore.getState().removeTab("parent-tab"); dom.window.close(); vi.unstubAllGlobals();
  }
});
