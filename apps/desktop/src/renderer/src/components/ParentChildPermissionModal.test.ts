import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveTabBody } from "../App.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore, type PermissionUiRequest } from "../store.js";
import { tabRegistry } from "../tab-registry.js";
import { childRelationStore } from "../child-sessions.js";
import { childLayoutStore } from "../child-layout.js";
import { useTabsStore } from "../tabs-store.js";
import { useDockStore } from "../dock/dock-store.js";

// Read the current snapshots during server rendering. Browser subscriptions use
// the real hook; this lets the real layout render without a browser runtime.
vi.mock("react", async (load) => {
  const actual = await load<typeof import("react")>();
  return { ...actual, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});
vi.mock("zustand", async (load) => {
  const actual = await load<typeof import("zustand")>();
  return {
    ...actual,
    useStore: (api: { getState(): unknown }, selector: (state: never) => unknown) => selector(api.getState() as never),
    create: (initializer?: unknown) => {
      const wrap = (init: unknown) => {
        const store = (actual.create as any)(init);
        return Object.assign((selector: (state: never) => unknown) => selector(store.getState() as never), store);
      };
      return initializer === undefined ? wrap : wrap(initializer);
    },
  };
});
vi.mock("./MessageList.js", () => ({ MessageList: () => null }));
vi.mock("./Composer.js", () => ({ Composer: () => null, shouldEnqueue: () => false }));
vi.mock("./SessionHeader.js", () => ({ SessionHeader: () => null }));
vi.mock("./BackgroundTasksPanel.js", () => ({ BackgroundTasksPanel: () => null }));
vi.mock("./LspPanel.js", () => ({ LspPanel: () => null }));
vi.mock("./HooksPanel.js", () => ({ HooksPanel: () => null }));
vi.mock("./WorkspaceTrustDialog.js", () => ({ WorkspaceTrustPrompt: () => null }));

function ask(id: string): PermissionUiRequest {
  return { requestId: id, toolName: "Write", input: { file_path: `/workspace/${id}.txt` }, mode: "build", metadata: { riskLevel: "medium", destructive: false, readOnly: false, needsApproval: true } } as unknown as PermissionUiRequest;
}

function setup(kind: "child" | "split", parentAsk: boolean, aAsk: boolean, bAsk: boolean) {
  vi.stubGlobal("window", { anycode: { platform: "darwin" }, innerWidth: 1280 });
  vi.stubGlobal("document", { querySelector: () => null });
  const root = createDesktopStore();
  const a = createDesktopStore();
  const b = createDesktopStore();
  root.setState({ sessionId: "parent", connection: "ready", workspace: "/workspace", permission: parentAsk ? ask("parent") : null });
  a.setState({ connection: "ready", childSurface: true, workspace: "/workspace", permission: aAsk ? ask("a") : null });
  b.setState({ connection: "ready", childSurface: true, workspace: "/workspace", permission: bAsk ? ask("b") : null });
  vi.spyOn(tabRegistry, "getStore").mockImplementation((id) => id === "a" ? a : id === "b" ? b : undefined);
  childRelationStore.getState().registerChild("parent", "call-a", "a", "session-a");
  childRelationStore.getState().registerChild("parent", "call-b", "b", "session-b");
  useTabsStore.setState({ tabs: [{ tabId: "root", sessionId: "parent", title: "Root" } as never] });
  childLayoutStore.getState().open("root", "call-a");
  if (kind === "split") {
    childLayoutStore.getState().enterSplit("root");
    useDockStore.setState({ ownerTabId: "root", tabs: [{ id: "subagents", kind: "subagents", title: "Subagents" }], activeTabId: "subagents", hidden: false, splitTabId: null });
  }
  return renderToStaticMarkup(createElement(TabContext.Provider, { value: { tabId: "root", store: root } },
    createElement(ActiveTabBody, { tabId: "root", sidebarCollapsed: false, onToggleSidebar: () => {}, onToast: () => {} })));
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); childRelationStore.getState().reset(); childLayoutStore.getState().reset(); useDockStore.setState({ ownerTabId: null, tabs: [], activeTabId: null, splitTabId: null }); });

describe.each(["child", "split"] as const)("permission presentation in %s layout", (kind) => {
  it("shows only the parent when parent and selected child both ask", () => {
    const html = setup(kind, true, true, true);
    expect(html.match(/<dialog class="permission-modal(?:"| )/g)).toHaveLength(1);
    expect(html).toContain("parent.txt");
    expect(html).not.toContain("Subagent: session-a");
  });
  it("shows one child in registration order even when another child is visible", () => {
    const html = setup(kind, false, true, true);
    expect(html.match(/<dialog class="permission-modal(?:"| )/g)).toHaveLength(1);
    expect(html).toContain("Subagent: session-a");
    expect(html).not.toContain("Subagent: session-b");
  });
  it("forwards the sibling while the selected child is visible", () => {
    const html = setup(kind, false, false, true);
    expect(html.match(/<dialog class="permission-modal(?:"| )/g)).toHaveLength(1);
    expect(html).toContain("Subagent: session-b");
    if (kind === "split") expect(html).toContain("child-split-pane");
    else expect(html).toContain("child-session-breadcrumb");
  });
});
