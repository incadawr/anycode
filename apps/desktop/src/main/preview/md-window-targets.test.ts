/**
 * Unit tests for md-window-targets.ts — the webContents → preview registry
 * that binds the detached Markdown popout's document IPC to the EXACT preview
 * it was created for. Pure identity-keyed map semantics: no Electron, no
 * zod — the handlers that consult these helpers carry their own payload
 * validation (mirrors the pure-helper half of ipc-guard.test.ts).
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  mdWindowMayUsePreview,
  mdWindowMayUseTab,
  mdWindowTargetOf,
  registerMdWindowTarget,
  resetMdWindowTargetsForTests,
  unregisterMdWindowTarget,
} from "./md-window-targets.js";

const POPOUT_CONTENTS = { mainFrame: { frame: "md-popout" } };
const OTHER_CONTENTS = { mainFrame: { frame: "md-popout-2" } };
const MAIN_SENDER = { mainFrame: { frame: "main" } };

beforeEach(() => {
  resetMdWindowTargetsForTests();
});

describe("md window target registry", () => {
  it("registers a popout to its exact preview and looks it up by sender identity", () => {
    registerMdWindowTarget(POPOUT_CONTENTS, { tabId: "t1", previewId: "p1" });
    expect(mdWindowTargetOf(POPOUT_CONTENTS)).toEqual({ tabId: "t1", previewId: "p1" });
    // Unknown senders (the main window, foreign windows) have no target.
    expect(mdWindowTargetOf(MAIN_SENDER)).toBeUndefined();
    expect(mdWindowTargetOf(OTHER_CONTENTS)).toBeUndefined();
    expect(mdWindowTargetOf(undefined)).toBeUndefined();
  });

  it("unregister drops exactly the registered entry (the closed handler's cleanup)", () => {
    registerMdWindowTarget(POPOUT_CONTENTS, { tabId: "t1", previewId: "p1" });
    registerMdWindowTarget(OTHER_CONTENTS, { tabId: "t2", previewId: "p2" });
    unregisterMdWindowTarget(POPOUT_CONTENTS);
    expect(mdWindowTargetOf(POPOUT_CONTENTS)).toBeUndefined();
    // The sibling popout keeps its entry.
    expect(mdWindowTargetOf(OTHER_CONTENTS)).toEqual({ tabId: "t2", previewId: "p2" });
  });

  it("mdWindowMayUsePreview: an unknown sender is unrestricted; a popout is bound to its own pair", () => {
    registerMdWindowTarget(POPOUT_CONTENTS, { tabId: "t1", previewId: "p1" });
    expect(mdWindowMayUsePreview(MAIN_SENDER, "t9", "p9")).toBe(true);
    expect(mdWindowMayUsePreview(POPOUT_CONTENTS, "t1", "p1")).toBe(true);
    // Wrong previewId under the right tab: refused (a stale popout must not steer the preview it lost).
    expect(mdWindowMayUsePreview(POPOUT_CONTENTS, "t1", "p2")).toBe(false);
    // Wrong tab entirely: refused.
    expect(mdWindowMayUsePreview(POPOUT_CONTENTS, "t2", "p1")).toBe(false);
  });

  it("mdWindowMayUseTab: an unknown sender is unrestricted; a popout only its own tab (artifacts/list plane)", () => {
    registerMdWindowTarget(POPOUT_CONTENTS, { tabId: "t1", previewId: "p1" });
    expect(mdWindowMayUseTab(MAIN_SENDER, "t9")).toBe(true);
    expect(mdWindowMayUseTab(POPOUT_CONTENTS, "t1")).toBe(true);
    expect(mdWindowMayUseTab(POPOUT_CONTENTS, "t2")).toBe(false);
    // A payload without a usable tabId never matches the popout's own tab.
    expect(mdWindowMayUseTab(POPOUT_CONTENTS, undefined)).toBe(false);
  });
});
