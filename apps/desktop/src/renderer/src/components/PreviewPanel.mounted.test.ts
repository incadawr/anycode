// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TabContext } from "../tab-context.js";
import { usePreviewStore } from "../preview/preview-store.js";
import type { PreviewPanelInfo } from "../../../shared/preview-panel.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let overlayOpen = false;
vi.mock("../preview/overlay-flag.js", () => ({ useOverlayOpenSnapshot: () => overlayOpen }));
vi.mock("../preview/panel-bridge.js", () => ({ reportPanelBounds: vi.fn() }));
vi.mock("./MarkdownPreviewView.js", () => ({
  MarkdownPreviewView: () => createElement("div", { "data-testid": "md-view" }, "rendered markdown"),
}));

import { PreviewPanel } from "./PreviewPanel.js";

function info(overrides: Partial<PreviewPanelInfo>): PreviewPanelInfo {
  return { previewId: "p1", tabId: "t1", url: "file:///a", status: "ready", container: "panel", ...overrides };
}

async function render(previewId: string): Promise<{ container: HTMLElement; unmount(): Promise<void> }> {
  class RO { observe() {} disconnect() {} unobserve() {} }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        TabContext.Provider,
        { value: { tabId: "t1" } as never },
        createElement(PreviewPanel, { tabId: `preview:${previewId}`, previewId, onToast: () => {} }),
      ),
    ),
  );
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

afterEach(() => { overlayOpen = false; });

it("keeps a dom-md preview rendered while an overlay is open", async () => {
  overlayOpen = true;
  usePreviewStore.setState({ byTab: { t1: { previews: [info({ viewKind: "dom-md", sourcePath: "/a.md" })], visiblePanelPreviewId: "p1" } } });
  const view = await render("p1");
  try {
    expect(view.container.querySelector('[data-testid="md-view"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain("Preview hidden");
  } finally { await view.unmount(); }
});

it("still shows the placeholder for a web preview while an overlay is open", async () => {
  overlayOpen = true;
  usePreviewStore.setState({ byTab: { t1: { previews: [info({ viewKind: "web" })], visiblePanelPreviewId: "p1" } } });
  const view = await render("p1");
  try {
    expect(view.container.textContent).toContain("Preview hidden");
  } finally { await view.unmount(); }
});
