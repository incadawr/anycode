// @vitest-environment jsdom
/**
 * Pure-logic tests for GitPanel's exported helpers (design .../
 * slice-5.8-cut.md §2.6). Same rationale as GitDiffPane.test.ts/
 * GitPill.test.ts: only the branch-lock test below uses jsdom (pragma above).
 * The panel's actual JSX/tab wiring is otherwise exercised only by the (owner)
 * live-Electron smoke
 * — this file covers the pure dispatch-shape builders the component's JSX
 * calls into, plus the guard that keeps destructive intent construction the

 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WireGitStatus } from "../../../shared/protocol.js";
import { createDesktopStore } from "../store.js";
import { TabContext } from "../tab-context.js";
import { useTabsStore } from "../tabs-store.js";
import { GitPanel, buildDiffRequest, buildUnstageAllRequest, discardAllIntent, stagedPaths, unstagedPaths } from "./GitPanel.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function status(overrides: Partial<WireGitStatus>): WireGitStatus {
  return {
    head: { branch: "main", detached: false, sha: "abc123", ahead: null, behind: null },
    staged: [],
    unstaged: [],
    untracked: [],
    dirtyCount: 0,
    filesTruncated: false,
    ...overrides,
  };
}

describe("stagedPaths / unstagedPaths", () => {
  it("returns [] for a null status", () => {
    expect(stagedPaths(null)).toEqual([]);
    expect(unstagedPaths(null)).toEqual([]);
  });

  it("extracts just the path from each file change", () => {
    const s = status({
      staged: [{ path: "a.ts", kind: "modified" }],
      unstaged: [{ path: "b.ts", kind: "added" }, { path: "c.ts", kind: "deleted" }],
    });
    expect(stagedPaths(s)).toEqual(["a.ts"]);
    expect(unstagedPaths(s)).toEqual(["b.ts", "c.ts"]);
  });
});

describe("buildDiffRequest", () => {
  it("builds a diff command and a matching pending diff spec for a staged file", () => {
    const { command, pending } = buildDiffRequest("src/foo.ts", "staged");
    expect(command).toEqual({ op: "diff", target: "staged", path: "src/foo.ts" });
    expect(pending).toEqual({ kind: "diff", diff: { path: "src/foo.ts", target: "staged" }, label: "diff" });
  });

  it("builds a worktree-target request for an unstaged file", () => {
    const { command } = buildDiffRequest("src/bar.ts", "worktree");
    expect(command).toEqual({ op: "diff", target: "worktree", path: "src/bar.ts" });
  });
});

describe("buildUnstageAllRequest", () => {
  it("returns null when nothing is staged (would violate the wire schema's paths.min(1))", () => {
    expect(buildUnstageAllRequest(null)).toBeNull();
    expect(buildUnstageAllRequest(status({ staged: [] }))).toBeNull();
  });

  it("collects every staged path into one unstage command", () => {
    const s = status({ staged: [{ path: "a.ts", kind: "modified" }, { path: "b.ts", kind: "added" }] });
    const request = buildUnstageAllRequest(s);
    expect(request).toEqual({
      command: { op: "unstage", paths: ["a.ts", "b.ts"] },
      pending: { kind: "mutation", label: "unstage all" },
    });
  });
});

describe("discardAllIntent", () => {
  it("returns null when there is nothing unstaged to discard", () => {
    expect(discardAllIntent(null)).toBeNull();
    expect(discardAllIntent(status({ unstaged: [] }))).toBeNull();
  });

  it("stages a discard intent over every unstaged path (never a wire command directly, ruling R2)", () => {
    const s = status({ unstaged: [{ path: "a.ts", kind: "modified" }, { path: "b.ts", kind: "deleted" }] });
    expect(discardAllIntent(s)).toEqual({ op: "discard", paths: ["a.ts", "b.ts"] });
  });
});

describe("GitPanel branch lock", () => {
  async function withPanel(tabs: unknown[], childWorktrees: Record<string, unknown>, check: (host: HTMLElement) => void): Promise<void> {
    const { tabRegistry } = await import("../tab-registry.js");
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    const previous = useTabsStore.getState();
    useTabsStore.setState({ tabs, childWorktrees } as never);
    const store = createDesktopStore();
    store.setState({ git: { ...store.getState().git, panelOpen: true, status: status({}) } });
    const host = document.createElement("div"), root = createRoot(host);
    try {
      await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(GitPanel))));
      check(host);
    } finally {
      await act(async () => root.unmount());
      send.mockRestore();
      useTabsStore.setState({ tabs: previous.tabs, childWorktrees: previous.childWorktrees });
    }
  }
  const select = (host: HTMLElement) => host.querySelector<HTMLSelectElement>('select[aria-label="Current branch"]');
  const newBranch = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="New branch"]');

  it("disables the branch select and new-branch button for owned and child worktrees, and not otherwise", async () => {
    await withPanel([{ tabId: "tab", worktree: { ownedByAnyCode: true } }], {}, host => {
      expect(select(host)?.disabled).toBe(true);
      expect(select(host)?.title).toBe("Managed worktree branch; switch from the parent checkout");
      expect(newBranch(host)?.disabled).toBe(true);
    });
    const allocation = { id: "child", path: "/fixture/child", branch: "topic", baseRef: "main", ownedByAnyCode: false, parentSessionId: "parent-session" };
    await withPanel([{ tabId: "tab" }], { tab: allocation }, host => {
      expect(select(host)?.disabled).toBe(true);
      expect(select(host)?.title).toBe("Branch is managed by the parent session");
      expect(newBranch(host)?.disabled).toBe(true);
    });
  });
});
