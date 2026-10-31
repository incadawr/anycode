import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  computePreviewMenuVisible,
  derivePreviewMenuItems,
  SESSION_HEADER_TITLE_LINE_LIMIT,
  sessionHeaderTitleClass,
  worktreeExitControlState,
} from "./SessionHeader.js";
import type { PreviewChangedPayload, PreviewPanelInfo } from "../../../shared/preview-panel.js";

describe("sessionHeaderTitleClass (audit D12 — long titles cut mid-word)", () => {
  const WRAP = "session-header-title session-header-title-wrap";

  it("wraps a multi-word title, so the reported mid-word cut (…outside.txt conta) cannot happen", () => {
    // The one-line ellipsis cut the LAST visible word at a character boundary;
    // a title with any number of words must wrap like the single-token case.
    expect(sessionHeaderTitleClass("please read outside.txt and fix the header")).toBe(WRAP);
    expect(sessionHeaderTitleClass("Fix the bug")).toBe(WRAP);
  });

  it("wraps a single unbroken token (path/filename), which ellipsis would cut mid-word", () => {
    expect(sessionHeaderTitleClass("…outside.txt")).toBe(WRAP);
  });

  it("never returns the bare ellipsis class for ANY title", () => {
    for (const title of ["a", "two words", "an outside.txt file", "/Users/x/very/long/path"]) {
      expect(sessionHeaderTitleClass(title)).toBe(WRAP);
    }
  });
});

describe("session-header title-wrap clamp (audit D12 regression: the header has a fixed height)", () => {
  const css = readFileSync(new URL("../app.css", import.meta.url), "utf8");

  /** The declared body of `selector`; throws when the rule is missing. */
  function cssRule(selector: string): string {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const match = clean.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    if (!match) throw new Error(`no CSS rule ${selector}`);
    return match[1] ?? "";
  }

  it("the wrap rule clamps to SESSION_HEADER_TITLE_LINE_LIMIT lines, so no title length can grow the header", () => {
    const rule = cssRule(".session-header-title-wrap");
    // A clamp needs ALL three: the box layout, the limit, and overflow hidden
    // (without hidden the box grows past the clamp in Chromium).
    expect(rule).toMatch(/display:\s*-webkit-box/);
    expect(rule).toMatch(new RegExp(`-webkit-line-clamp:\\s*${SESSION_HEADER_TITLE_LINE_LIMIT}`));
    expect(rule).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    // The mid-word break the wrap exists for still happens at the edge.
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("the wrap rule cancels the base class's one-line ellipsis, which cut multi-word titles mid-word", () => {
    // `.session-header-title` sets nowrap + ellipsis; if the wrap rule did not
    // override both, a multi-word title would keep being cut at a character
    // boundary instead of breaking between words.
    const rule = cssRule(".session-header-title-wrap");
    expect(rule).toMatch(/white-space:\s*normal/);
    expect(rule).toMatch(/text-overflow:\s*clip/);
    const base = cssRule(".session-header-title");
    expect(base).toMatch(/white-space:\s*nowrap/);
    expect(sessionHeaderTitleClass("fix the header bug")).toBe("session-header-title session-header-title-wrap");
  });
});

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

describe("header toggles", () => {
  // The header used one Terminal glyph for BOTH the background-tasks toggle
  // and the terminal toggle, so the two read as the same control.
  it("background tasks and terminal do not share one glyph", () => {
    const source = readFileSync(new URL("./SessionHeader.tsx", import.meta.url), "utf8");
    const tasks = source.slice(source.indexOf('aria-label="Toggle background tasks"'), source.indexOf("</button>", source.indexOf('aria-label="Toggle background tasks"')));
    const terminal = source.slice(source.indexOf('aria-label="Toggle terminal"'), source.indexOf("</button>", source.indexOf('aria-label="Toggle terminal"')));
    expect(tasks).toContain("<TaskList />");
    expect(tasks).not.toContain("<Terminal />");
    expect(terminal).toContain("<Terminal />");
  });
});
