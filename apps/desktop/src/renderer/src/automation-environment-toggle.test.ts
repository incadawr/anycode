/**
 * Taskana 4711 cross-review F1: the real LSP/Hooks panel drivers open the
 * panel through the Environment menu. React 19 commits a click-driven state
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

/**
 * A minimal document: the `.environment-trigger` click schedules the menu
 * commit for a microtask (as React 19 does for discrete events); the Details
 * actions only exist in the tree after that commit.
 */
function installFakeEnvironmentMenu(): {
  lspClicks: () => number;
  hooksClicks: () => number;
} {
  let pendingCommit = false;
  let menuMounted = false;
  let lspClicks = 0;
  let hooksClicks = 0;

  const trigger: FakeButton = {
    click: () => {
      pendingCommit = true;
      queueMicrotask(() => {
        if (pendingCommit) {
          pendingCommit = false;
          menuMounted = true;
        }
      });
    },
  };
  const lspDetails: FakeButton = { click: () => void (lspClicks += 1) };
  const hooksDetails: FakeButton = { click: () => void (hooksClicks += 1) };

  commit.run = () => {
    if (pendingCommit) {
      pendingCommit = false;
      menuMounted = true;
    }
  };

  vi.stubGlobal("document", {
    querySelector: (selector: string): FakeButton | null => {
      if (selector === ".environment-trigger") return trigger;
      if (!menuMounted) return null;
      if (selector === '[data-environment-action="lsp-details"]') return lspDetails;
      if (selector === '[data-environment-action="hooks-details"]') return hooksDetails;
      return null;
    },
  });

  return { lspClicks: () => lspClicks, hooksClicks: () => hooksClicks };
}

describe("Environment-menu panel drivers (Taskana 4711 cross-review F1)", () => {
  beforeEach(() => {
    commit.run = (): void => {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("realLspPanelDom.toggle() reaches the Details action in the same task", () => {
    const env = installFakeEnvironmentMenu();
    realLspPanelDom().toggle();
    expect(env.lspClicks()).toBe(1);
  });

  it("realHooksPanelDom.toggle() reaches the Details action in the same task", () => {
    const env = installFakeEnvironmentMenu();
    realHooksPanelDom().toggle();
    expect(env.hooksClicks()).toBe(1);
  });
});
