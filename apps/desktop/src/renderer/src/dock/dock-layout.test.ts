/**
 * Pure-logic tests for the dock geometry/tab algebra (Taskana 4703,
 * docs/development/dock.md). `.test.ts`-only, node env — no jsdom in this
 * package's vitest config (App.test.ts header precedent): every case passes
 * plain numbers / plain objects / a Map-backed storage shim.
 */
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_MIN_PX,
  DOCK_HANDLE_PX,
  DOCK_SPLIT_MIN_PX,
  DOCK_WIDTH_DEFAULT,
  DOCK_WIDTH_MAX,
  DOCK_WIDTH_MIN,
  DOCK_WIDTH_STORAGE_KEY,
  canSplit,
  clampDockWidth,
  closeTab,
  computeDockMode,
  derivePreviewTabs,
  isSplittableTab,
  openTab,
  openTabInBackground,
  readDockWidth,
  type DockStorage,
  type DockTab,
} from "./dock-layout.js";
import type { PreviewPanelInfo } from "../../../shared/preview-panel.js";

function memoryStorage(entries: Record<string, string> = {}): DockStorage {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function preview(overrides: Partial<PreviewPanelInfo> & { previewId: string }): PreviewPanelInfo {
  return {
    url: "file:///tmp/x.html",
    title: null,
    sourcePath: null,
    viewKind: "web",
    container: "panel",
    status: "ready",
    ...overrides,
  } as PreviewPanelInfo;
}

const TAB_A: DockTab = { id: "preview:a", kind: "preview", title: "A" };
const TAB_B: DockTab = { id: "preview:b", kind: "preview", title: "B" };
const TAB_C: DockTab = { id: "git", kind: "git", title: "Review" };

describe("readDockWidth", () => {
  it("absent dock key + legacy anycode.preview.width in range seeds from the legacy value", () => {
    expect(readDockWidth(memoryStorage({ "anycode.preview.width": "700" }))).toBe(700);
  });

  it("absent dock key + legacy out of the dock's own range falls to the default (legacy max was 1280)", () => {
    expect(readDockWidth(memoryStorage({ "anycode.preview.width": "1100" }))).toBe(DOCK_WIDTH_DEFAULT);
    expect(readDockWidth(memoryStorage({ "anycode.preview.width": "100" }))).toBe(DOCK_WIDTH_DEFAULT);
  });

  it("absent both keys → default 640", () => {
    expect(readDockWidth(memoryStorage())).toBe(640);
  });

  it("the dock key wins over the legacy seed and clamps to its own range", () => {
    expect(readDockWidth(memoryStorage({ "anycode.dock.width": "500" }))).toBe(500);
    expect(readDockWidth(memoryStorage({ "anycode.dock.width": "10" }))).toBe(DOCK_WIDTH_MIN);
    expect(readDockWidth(memoryStorage({ "anycode.dock.width": "9999" }))).toBe(DOCK_WIDTH_MAX);
    // "garbage" parses as NaN → out of range → the key reads as ABSENT → the
    // legacy seed applies; with no legacy either, the default.
    expect(readDockWidth(memoryStorage({ "anycode.dock.width": "garbage", "anycode.preview.width": "700" }))).toBe(700);
    expect(readDockWidth(memoryStorage({ "anycode.dock.width": "garbage" }))).toBe(DOCK_WIDTH_DEFAULT);
  });
});

describe("clampDockWidth", () => {
  it("plenty of room keeps the requested width", () => {
    expect(clampDockWidth(640, 2000)).toBe(640);
  });

  it("never goes below the dock's own min even when the window cannot afford it (drawer mode's job)", () => {
    // available - 420 - 8 = 272 → max(320, min(960, 272)) = 320
    expect(clampDockWidth(640, 700)).toBe(320);
  });

  it("boundary cases around the 748px column threshold", () => {
    expect(clampDockWidth(640, 752)).toBe(324); // 752-428=324 → min(640,324)=324 → max(320,324)=324
  });

  it("clamps to available-428 between min and max", () => {
    expect(clampDockWidth(640, 760)).toBe(332);
  });

  it("caps at the absolute max on huge windows", () => {
    expect(clampDockWidth(2000, 2000)).toBe(960);
  });
});

describe("computeDockMode", () => {
  it("747 available → drawer (a min dock column + handle leaves 419 < 420 for the conversation)", () => {
    expect(computeDockMode(747)).toBe("drawer");
  });

  it("748 available → column (420+8+320=748 exactly)", () => {
    expect(computeDockMode(748)).toBe("column");
  });

  it("wide windows are columns", () => {
    expect(computeDockMode(2000)).toBe("column");
  });

  it("the threshold is exactly the documented constant sum", () => {
    expect(CONVERSATION_MIN_PX + DOCK_HANDLE_PX + DOCK_WIDTH_MIN).toBe(748);
  });
});

describe("derivePreviewTabs", () => {
  it("panel-container previews only, window previews excluded; title fallback chain title→sourcePath→url", () => {
    const tabs = derivePreviewTabs([
      preview({ previewId: "p1", title: "Doc" }),
      preview({ previewId: "p2", sourcePath: "/tmp/other.md" }),
      preview({ previewId: "p3", url: "file:///tmp/three.html" }),
      preview({ previewId: "w1", container: "window" }),
    ]);
    expect(tabs).toEqual([
      { id: "preview:p1", kind: "preview", title: "Doc" },
      { id: "preview:p2", kind: "preview", title: "/tmp/other.md" },
      { id: "preview:p3", kind: "preview", title: "file:///tmp/three.html" },
    ]);
  });

  it("no previews → no tabs", () => {
    expect(derivePreviewTabs([])).toEqual([]);
  });
});

describe("openTab", () => {
  it("a new tab is appended and focused", () => {
    const result = openTab([TAB_A], TAB_B);
    expect(result.tabs.map((t) => t.id)).toEqual(["preview:a", "preview:b"]);
    expect(result.activeTabId).toBe("preview:b");
  });

  it("an already-open tab is kept (not duplicated/reordered) but STILL focused", () => {
    const result = openTab([TAB_A, TAB_B], TAB_A);
    expect(result.tabs.map((t) => t.id)).toEqual(["preview:a", "preview:b"]);
    expect(result.activeTabId).toBe("preview:a");
  });
});

describe("closeTab", () => {
  it("closing the ACTIVE middle tab focuses the nearest right neighbor", () => {
    const result = closeTab([TAB_A, TAB_B, TAB_C], "preview:b", "preview:b");
    expect(result.tabs.map((t) => t.id)).toEqual(["preview:a", "git"]);
    expect(result.activeTabId).toBe("git");
  });

  it("closing the ACTIVE last tab focuses the left neighbor", () => {
    const result = closeTab([TAB_A, TAB_B, TAB_C], "git", "git");
    expect(result.activeTabId).toBe("preview:b");
  });

  it("closing an INACTIVE tab keeps the active tab unchanged", () => {
    const result = closeTab([TAB_A, TAB_B, TAB_C], "preview:a", "preview:b");
    expect(result.tabs.map((t) => t.id)).toEqual(["preview:a", "git"]);
    expect(result.activeTabId).toBe("preview:a");
  });

  it("closing the last remaining tab leaves no active tab", () => {
    const result = closeTab([TAB_A], "preview:a", "preview:a");
    expect(result.tabs).toEqual([]);
    expect(result.activeTabId).toBe(null);
  });

  it("closing an unknown id is a no-op", () => {
    const result = closeTab([TAB_A], "preview:a", "nope");
    expect(result.tabs.map((t) => t.id)).toEqual(["preview:a"]);
    expect(result.activeTabId).toBe("preview:a");
  });
});

describe("storage key contract", () => {
  it("the dock width persists under its own key", () => {
    expect(DOCK_WIDTH_STORAGE_KEY).toBe("anycode.dock.width");
  });
});

// ── Stage 2 (§3) ──

describe("canSplit (Stage 2)", () => {
  it("the threshold is exactly conversation floor + two min dock columns + two handles (420+640+16=1076)", () => {
    expect(CONVERSATION_MIN_PX + 2 * DOCK_WIDTH_MIN + 2 * DOCK_HANDLE_PX).toBe(1076);
  });

  it("boundary cases: 1075 no, 1076 yes, wider yes", () => {
    expect(canSplit(1075)).toBe(false);
    expect(canSplit(1076)).toBe(true);
    expect(canSplit(1800)).toBe(true);
  });

  it("DOCK_SPLIT_MIN_PX aliases the dock's own min", () => {
    expect(DOCK_SPLIT_MIN_PX).toBe(DOCK_WIDTH_MIN);
  });
});

describe("background open + split eligibility (Taskana 4703 cross-review D1/D3)", () => {
  const MD = { id: "preview:md", kind: "preview" as const, title: "doc.md" };
  const GIT = { id: "git", kind: "git" as const, title: "Review" };

  it("openTabInBackground appends a new tab but keeps the current focus", () => {
    const result = openTabInBackground([GIT], "git", MD);
    expect(result.tabs.map((t) => t.id)).toEqual(["git", "preview:md"]);
    expect(result.activeTabId).toBe("git");
  });

  it("openTabInBackground on an empty dock focuses the first tab (nothing to keep)", () => {
    const result = openTabInBackground([], null, MD);
    expect(result.tabs.map((t) => t.id)).toEqual(["preview:md"]);
    expect(result.activeTabId).toBe("preview:md");
  });

  it("openTabInBackground never duplicates an already-open tab and keeps focus", () => {
    const result = openTabInBackground([GIT, MD], "git", MD);
    expect(result.tabs.map((t) => t.id)).toEqual(["git", "preview:md"]);
    expect(result.activeTabId).toBe("git");
  });

  it("a web preview is never split (its WebContentsView only fits the primary body)", () => {
    expect(isSplittableTab({ id: "preview:w", kind: "preview", title: "web" }, "git", "web")).toBe(false);
  });

  it("the active (primary) tab is never split with itself", () => {
    expect(isSplittableTab(GIT, "git", undefined)).toBe(false);
    expect(isSplittableTab(MD, "preview:md", "dom-md")).toBe(false);
  });

  it("markdown previews, git and subagents remain splittable when not primary", () => {
    expect(isSplittableTab(MD, "git", "dom-md")).toBe(true);
    expect(isSplittableTab(MD, "git", undefined)).toBe(true);
    expect(isSplittableTab(GIT, "preview:md", undefined)).toBe(true);
  });
});
