/**
 * cross-review F1: the real LSP/Hooks panel drivers open the
 * panels through Extensions → LSP and Environment → Hooks. React 19 commits a click-driven state
 * update in a microtask (after `.click()` returns), so the menu's Details
 * action only exists once React has committed. This test simulates that
 * deferred commit on a fake document and drives the REAL accessors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commit = vi.hoisted(() => ({ run: (): void => {} }));

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return {
    ...actual,
    // Mirrors React's flushSync contract: updates scheduled inside fn are
    // committed before flushSync returns.
    flushSync: <T,>(fn: () => T): T => {
      const result = fn();
      commit.run();
      return result;
    },
  };
});

import { realHooksPanelDom, realLspPanelDom } from "./automation.js";

interface FakeButton {
  click: () => void;
}

/** Each click schedules a separate React commit; removed selectors never resolve. */
function installFakeMenus(): { clicks: string[] } {
  let pendingCommit: (() => void) | undefined;
  let environmentMounted = false;
  let extensionsMounted = false;
  let lspSelected = false;
  const clicks: string[] = [];
  const button = (name: string, update: () => void): FakeButton => ({ click: () => {
    clicks.push(name);
    pendingCommit = update;
    queueMicrotask(() => commit.run());
  } });
  const environment = button("environment", () => { environmentMounted = true; });
  const extensions = button("extensions", () => { extensionsMounted = true; });
  const lsp = button("lsp", () => { lspSelected = true; });
  const lspDetails = button("lsp-details", () => {});
  const hooksDetails = button("hooks-details", () => {});
  commit.run = () => {
    const update = pendingCommit;
    pendingCommit = undefined;
    update?.();
  };
  vi.stubGlobal("document", {
    querySelector: (selector: string): FakeButton | null => {
      if (selector === ".environment-trigger") return environment;
      if (selector === ".session-extensions-trigger") return extensions;
      if (extensionsMounted && selector === '[data-extension-category="lsp"]') return lsp;
      if (lspSelected && selector === '[data-extension-action="lsp-details"]') return lspDetails;
      if (environmentMounted && selector === '[data-environment-action="hooks-details"]') return hooksDetails;
      return null;
    },
  });
  return { clicks };
}

describe("Menu panel drivers (cross-review F1)", () => {
  beforeEach(() => {
    commit.run = (): void => {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("realLspPanelDom.toggle() opens Extensions then LSP then Details in the same task", () => {
    const env = installFakeMenus();
    realLspPanelDom().toggle();
    expect(env.clicks).toEqual(["extensions", "lsp", "lsp-details"]);
  });

  it("realLspPanelDom.toggle() closes an open panel directly", () => {
    const close = vi.fn();
    vi.stubGlobal("document", { querySelector: (selector: string) => {
      expect(selector).toBe("aside.lsp-panel:not(.hooks-panel)");
      return { querySelector: (child: string) => {
        expect(child).toBe(".lsp-panel-close");
        return { click: close };
      } };
    } });
    realLspPanelDom().toggle();
    expect(close).toHaveBeenCalledOnce();
  });

  it("realHooksPanelDom.toggle() reaches the Details action in the same task", () => {
    const env = installFakeMenus();
    realHooksPanelDom().toggle();
    expect(env.clicks).toEqual(["environment", "hooks-details"]);
  });
});
