import { describe, expect, it } from "vitest";
import { computePreviewMenuVisible, derivePreviewMenuItems, worktreeExitControlState } from "./SessionHeader.js";
import type { PreviewChangedPayload, PreviewPanelInfo } from "../../../shared/preview-panel.js";

describe("worktreeExitControlState", () => {
  it("disables Exit with an accessible running-turn explanation", () => {
    expect(worktreeExitControlState("running", "ready")).toEqual({
      disabled: true,
      title: "Exit worktree is unavailable while a turn is running",
      ariaLabel: "Exit worktree unavailable while a turn is running",
    });
  });

  it.each(["awaiting_port", "awaiting_host_ready", "host_exited"] as const)(
    "disables Exit while the connection is %s",
    (connection) => {
      expect(worktreeExitControlState("idle", connection)).toEqual({
        disabled: true,
        title: "Exit worktree is unavailable until the host connection is ready",
        ariaLabel: "Exit worktree unavailable until the host connection is ready",
      });
    },
  );

  it("enables Exit only for an idle turn on a ready connection", () => {
    expect(worktreeExitControlState("idle", "ready")).toEqual({
      disabled: false,
      title: "Exit worktree; clean AnyCode-owned worktrees are removed automatically",
      ariaLabel: "Exit worktree",
    });
  });
});

function preview(overrides: Partial<PreviewPanelInfo> = {}): PreviewPanelInfo {
  return {
    previewId: "p1",
    tabId: "tab-a",
    url: "https://example.com/",
    status: "ready",
    container: "panel",
    ...overrides,
  };
}

describe("computePreviewMenuVisible (D15, TASK.96 96-P3)", () => {
  it("is false with no previews", () => {
    expect(computePreviewMenuVisible([])).toBe(false);
  });

  it("is true with a single panel-container preview", () => {
    expect(computePreviewMenuVisible([preview({ container: "panel" })])).toBe(true);
  });

  it("is true with a single window-container preview (ANY container)", () => {
    expect(computePreviewMenuVisible([preview({ container: "window" })])).toBe(true);
  });

  it("is true with a mix of containers", () => {
    expect(
      computePreviewMenuVisible([preview({ previewId: "p1", container: "panel" }), preview({ previewId: "p2", container: "window" })]),
    ).toBe(true);
  });
});

describe("derivePreviewMenuItems (D15, TASK.96 96-P3)", () => {
  it("maps an empty payload to an empty item list", () => {
    const payload: PreviewChangedPayload = { tabId: "tab-a", previews: [], visiblePanelPreviewId: null };
    expect(derivePreviewMenuItems(payload)).toEqual([]);
  });

  it("label falls back title -> sourcePath -> url, in that order", () => {
    const payload: PreviewChangedPayload = {
      tabId: "tab-a",
      previews: [
        preview({ previewId: "titled", title: "My Title", sourcePath: "/a.html", url: "https://a/" }),
        preview({ previewId: "path-only", sourcePath: "/b.html", url: "https://b/" }),
        preview({ previewId: "url-only", url: "https://c/" }),
      ],
      visiblePanelPreviewId: null,
    };
    const items = derivePreviewMenuItems(payload);
    expect(items.map((i) => i.label)).toEqual(["My Title", "/b.html", "https://c/"]);
  });

  it("carries the container kind through verbatim", () => {
    const payload: PreviewChangedPayload = {
      tabId: "tab-a",
      previews: [preview({ previewId: "p1", container: "panel" }), preview({ previewId: "p2", container: "window" })],
      visiblePanelPreviewId: null,
    };
    const items = derivePreviewMenuItems(payload);
    expect(items.map((i) => i.container)).toEqual(["panel", "window"]);
  });

  it("visible is true only for the panel-container item matching visiblePanelPreviewId", () => {
    const payload: PreviewChangedPayload = {
      tabId: "tab-a",
      previews: [
        preview({ previewId: "hidden-panel", container: "panel" }),
        preview({ previewId: "visible-panel", container: "panel" }),
        preview({ previewId: "a-window", container: "window" }),
      ],
      visiblePanelPreviewId: "visible-panel",
    };
    const items = derivePreviewMenuItems(payload);
    expect(items.find((i) => i.previewId === "visible-panel")?.visible).toBe(true);
    expect(items.find((i) => i.previewId === "hidden-panel")?.visible).toBe(false);
    expect(items.find((i) => i.previewId === "a-window")?.visible).toBe(false);
  });

  it("a window-container item is never 'visible' even if its previewId coincidentally matches visiblePanelPreviewId", () => {
    const payload: PreviewChangedPayload = {
      tabId: "tab-a",
      previews: [preview({ previewId: "same-id", container: "window" })],
      visiblePanelPreviewId: "same-id",
    };
    expect(derivePreviewMenuItems(payload)[0]?.visible).toBe(false);
  });
});
