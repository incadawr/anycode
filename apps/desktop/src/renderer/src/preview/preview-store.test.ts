/**
 * Pure-logic tests for `applyChangedPayload`/`computePreviewPanelOpen` (CUT.md
 * §3 96-P2 test list): replace-tab semantics, visible-id passthrough,
 * unknown-tab add. The zustand-backed `usePreviewStore`/`createPreviewStore`
 * wiring is untested per D16 (same convention as tabs-store.ts's own
 * `createTabsStore` factory, which is likewise covered only through the pure
 * functions it delegates to where they exist).
 */
import { describe, expect, it } from "vitest";
import type { PreviewChangedPayload, PreviewPanelInfo } from "../../../shared/preview-panel.js";
import { applyChangedPayload, computePreviewPanelOpen, type PreviewByTabState } from "./preview-store.js";

function info(overrides: Partial<PreviewPanelInfo> = {}): PreviewPanelInfo {
  return {
    previewId: "p1",
    tabId: "t1",
    url: "file:///a.html",
    status: "ready",
    container: "panel",
    ...overrides,
  };
}

describe("applyChangedPayload", () => {
  it("adds an unknown tab", () => {
    const state: PreviewByTabState = { byTab: {} };
    const payload: PreviewChangedPayload = { tabId: "t1", previews: [info()], visiblePanelPreviewId: "p1" };
    const next = applyChangedPayload(state, payload);
    expect(next.byTab.t1).toEqual({ previews: [info()], visiblePanelPreviewId: "p1" });
  });

  it("REPLACES (never merges) an already-known tab's previews array", () => {
    const state: PreviewByTabState = {
      byTab: { t1: { previews: [info({ previewId: "old" })], visiblePanelPreviewId: "old" } },
    };
    const payload: PreviewChangedPayload = {
      tabId: "t1",
      previews: [info({ previewId: "new" })],
      visiblePanelPreviewId: "new",
    };
    const next = applyChangedPayload(state, payload);
    expect(next.byTab.t1!.previews).toEqual([info({ previewId: "new" })]);
    expect(next.byTab.t1!.previews.some((p) => p.previewId === "old")).toBe(false);
  });

  it("passes visiblePanelPreviewId through unchanged, including null", () => {
    const state: PreviewByTabState = { byTab: {} };
    const payload: PreviewChangedPayload = { tabId: "t1", previews: [], visiblePanelPreviewId: null };
    expect(applyChangedPayload(state, payload).byTab.t1!.visiblePanelPreviewId).toBeNull();
  });

  it("leaves every OTHER tab's entry untouched", () => {
    const state: PreviewByTabState = {
      byTab: { other: { previews: [info({ tabId: "other" })], visiblePanelPreviewId: "p1" } },
    };
    const payload: PreviewChangedPayload = { tabId: "t1", previews: [info()], visiblePanelPreviewId: "p1" };
    const next = applyChangedPayload(state, payload);
    expect(next.byTab.other).toEqual(state.byTab.other);
  });
});

describe("computePreviewPanelOpen", () => {
  it("is false for an empty preview list", () => {
    expect(computePreviewPanelOpen([])).toBe(false);
  });

  it("is false when every preview is window-container", () => {
    expect(computePreviewPanelOpen([info({ container: "window" })])).toBe(false);
  });

  it("is true when at least one preview is panel-container", () => {
    expect(
      computePreviewPanelOpen([info({ container: "window", previewId: "p1" }), info({ container: "panel", previewId: "p2" })]),
    ).toBe(true);
  });
});
