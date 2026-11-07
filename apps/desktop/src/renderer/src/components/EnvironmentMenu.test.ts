// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
// Mount the real rows: switches must retain the same tab-scoped bridge calls.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createDesktopStore } from "../store.js";
import { TabContext } from "../tab-context.js";
import { EnvironmentMenu } from "./EnvironmentMenu.js";

import type { CommandHookDeclaration, LspServerStatus } from "@anycode/core";
import {
  formatEnvironmentHooksDetail,
  formatEnvironmentLspDetail,
  hasCrashedLspServer,
  workspaceLabel,
} from "./EnvironmentMenu.js";

function server(overrides: Partial<LspServerStatus> = {}): LspServerStatus {
  return {
    name: "typescript",
    state: "ready",
    extensions: [".ts", ".tsx"],
    stderrTail: "",
    ...overrides,
  };
}

function hook(overrides: Partial<CommandHookDeclaration> = {}): CommandHookDeclaration {
  return {
    event: "PreToolUse",
    command: "echo hi",
    ...overrides,
  };
}

describe("workspaceLabel", () => {
  it("returns the path unchanged when it fits within maxChars", () => {
    const main = "/Users/<user>/projects/tools/anycode";
    expect(main.length).toBeLessThanOrEqual(44);
    expect(workspaceLabel(main)).toBe(main);
  });

  it("head-ellipsizes a worktree path, preserving the distinguishing tail", () => {
    const worktree = "/Users/<user>/projects/tools/anycode/.anycode/worktrees/orch-4108";
    const label = workspaceLabel(worktree);
    expect(label.startsWith("…")).toBe(true);
    expect(label.endsWith("worktrees/orch-4108")).toBe(true);
    expect(label).not.toBe(workspaceLabel("/Users/<user>/projects/tools/anycode"));
  });

  it("preserves the tail for Windows-style separators", () => {
    const win = "C:\\Users\\someone\\projects\\tools\\proj\\.anycode\\worktrees\\orch-1";
    const label = workspaceLabel(win);
    expect(label.endsWith("proj/.anycode/worktrees/orch-1")).toBe(true);
    expect(label.startsWith("…")).toBe(true);
  });

  it("short/root paths survive untouched", () => {
    expect(workspaceLabel("/solo")).toBe("/solo");
    expect(workspaceLabel("/")).toBe("/");
    expect(workspaceLabel("C:\\")).toBe("C:\\");
    expect(workspaceLabel("")).toBe("");
  });

  it("degrades to an ellipsis + raw tail slice when the tail alone exceeds maxChars (never empty)", () => {
    const huge = `/repo/${"x".repeat(80)}/final-segment-of-great-length`;
    const label = workspaceLabel(huge, 20);
    expect(label.startsWith("…")).toBe(true);
    expect(label.length).toBeGreaterThan(1);
    expect(label.length).toBeLessThanOrEqual(20);
    // The raw-tail degradation still ends with the path's own bytes.
    expect(huge.endsWith(label.slice(1))).toBe(true);
  });
});

// ── Environment-menu status rows (pure derivations) ──

describe("formatEnvironmentLspDetail", () => {
  it("renders 'Not configured' for an empty server list", () => {
    expect(formatEnvironmentLspDetail([])).toBe("Not configured");
  });

  it("marks a single ready server with ✓", () => {
    expect(formatEnvironmentLspDetail([server({ name: "typescript" })])).toBe("typescript ✓");
  });

  it("summarizes mixed states per server", () => {
    const servers = [
      server({ name: "typescript", state: "ready" }),
      server({ name: "python", state: "crashed", extensions: [".py"] }),
    ];
    expect(formatEnvironmentLspDetail(servers)).toBe("typescript ✓, python —");
  });

  it("renders — for every non-ready state (initializing, not_started, disposed, crashed)", () => {
    for (const state of ["initializing", "not_started", "disposed", "crashed"] as const) {
      expect(formatEnvironmentLspDetail([server({ name: "s", state })])).toBe(`s —`);
    }
  });
});

describe("hasCrashedLspServer", () => {
  it("is false for an empty list", () => {
    expect(hasCrashedLspServer([])).toBe(false);
  });

  it("is false when every server is healthy (ready + initializing)", () => {
    expect(
      hasCrashedLspServer([server({ state: "ready" }), server({ name: "py", state: "initializing" })]),
    ).toBe(false);
  });

  it("is true only when at least one server crashed", () => {
    expect(hasCrashedLspServer([server({ state: "ready" }), server({ name: "py", state: "crashed" })])).toBe(true);
  });
});

describe("formatEnvironmentHooksDetail", () => {
  it("renders 'None' for an empty hook list", () => {
    expect(formatEnvironmentHooksDetail([])).toBe("None");
  });

  it("uses the singular 'hook' for a single declaration", () => {
    expect(formatEnvironmentHooksDetail([hook()])).toBe("1 hook (PreToolUse 1)");
  });

  it("counts hooks and groups per event", () => {
    const hooks = [
      hook({ event: "PreToolUse" }),
      hook({ event: "PostToolUse", command: "b" }),
      hook({ event: "PostToolUse", command: "c" }),
    ];
    expect(formatEnvironmentHooksDetail(hooks)).toBe("3 hooks (PreToolUse 1, PostToolUse 2)");
  });

  it("follows groupHooksByEvent's stable event order, not input order", () => {
    const hooks = [
      hook({ event: "SubagentStop" }),
      hook({ event: "UserPromptSubmit" }),
      hook({ event: "PreToolUse" }),
    ];
    // EVENT_LABELS key order: PreToolUse, PostToolUse, ..., UserPromptSubmit, Stop, SubagentStop.
    expect(formatEnvironmentHooksDetail(hooks)).toBe("3 hooks (PreToolUse 1, UserPromptSubmit 1, SubagentStop 1)");
  });

  it("groups a duplicate event into one group with its count", () => {
    const hooks = [hook({ event: "Stop", command: "a" }), hook({ event: "Stop", command: "b" })];
    expect(formatEnvironmentHooksDetail(hooks)).toBe("2 hooks (Stop 2)");
  });
});


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("opens one dialog trigger with sections and preserves access toggle handlers", async () => {
  const originalShowModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  const store = createDesktopStore();
  store.setState({ workspace: "/fixture/notes", git: { ...store.getState().git, status: null, statusKnown: true } });
  const view = (enabled: boolean, approvals = false) => ({ tabs: [{ tabId: "tab", enabled, approvals }] });
  const communication = {
    get: async () => ({ ok: true, envControlled: false, view: view(false) }),
    setSessionAccess: vi.fn(async (_id, enabled) => ({ ok: true, view: view(enabled) })),
    setSessionApprovals: vi.fn(async (_id, approvals) => ({ ok: true, view: view(true, approvals) })),
    setSessionHandle: vi.fn(),
  };
  const browserAccess = {
    get: async () => ({ ok: true, tabs: [{ tabId: "tab", fullAccess: true }] }),
    onChanged: () => () => {},
    set: vi.fn(async (tabId, fullAccess) => ({ ok: true, tab: { tabId, fullAccess } })),
  };
  const originalBridge = Object.getOwnPropertyDescriptor(window, "anycode");
  Object.defineProperty(window, "anycode", { configurable: true, value: {
    communication, browserAccess,
    sessionPeers: { get: async () => ({ ok: true, view: { available: false } }) },
  } });
  const host = document.createElement("div"); const root = createRoot(host);
  const click = async (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(EnvironmentMenu, { placement: "header" }))));
    expect(host.querySelectorAll("[aria-haspopup]")).toHaveLength(1);
    expect(host.querySelector("[aria-haspopup]")?.getAttribute("aria-haspopup")).toBe("dialog");
    await click(".environment-trigger");
    const dialog = host.querySelector('[role="dialog"][aria-label="Environment"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute("aria-modal")).toBe("false");
    for (const title of ["Workspace", "Session access", "Diagnostics"]) {
      expect(dialog.querySelector('section[aria-label="' + title + '"]')).not.toBeNull();
    }
    expect(dialog.textContent).toContain("this session only");
    expect(dialog.querySelector('section[aria-label="Workspace"]')?.textContent).toContain("Git is not available for this workspace.");
    expect(dialog.querySelector('[aria-label="Native session access"]')).toBeNull();
    const access = '[data-environment-action="sessions-api-access"]';
    expect(host.querySelector(access)?.getAttribute("aria-checked")).toBe("false");
    await click(access);
    expect(communication.setSessionAccess).toHaveBeenCalledWith("tab", true);
    expect(host.querySelector(access)?.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector(".environment-menu-dependents input")).not.toBeNull();
    await click('[data-environment-action="sessions-api-approvals"]');
    expect(communication.setSessionApprovals).toHaveBeenCalledWith("tab", true);
    expect(host.querySelector(".environment-menu-row-detail-warning")?.textContent).toBe("Agent can use any website without asking");
    const browser = '[data-environment-action="browser-full-access"]';
    expect(host.querySelector(browser)?.getAttribute("aria-checked")).toBe("true");
    await click(browser);
    expect(browserAccess.set).toHaveBeenCalledWith("tab", false);
    expect(host.querySelector(browser)?.getAttribute("aria-checked")).toBe("false");
    await click(browser);
    expect(host.textContent).toContain("Allow full browser access?");
    expect(browserAccess.set).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    HTMLDialogElement.prototype.showModal = originalShowModal;
    if (originalBridge) Object.defineProperty(window, "anycode", originalBridge);
    else Reflect.deleteProperty(window, "anycode");
  }
});

async function branchMenu(run: (host: HTMLDivElement, store: ReturnType<typeof createDesktopStore>, send: ReturnType<typeof vi.spyOn>) => Promise<void>) {
  const { tabRegistry } = await import("../tab-registry.js");
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  const bridge = Object.getOwnPropertyDescriptor(window, "anycode");
  Object.defineProperty(window, "anycode", { configurable: true, value: { communication: { get: async () => ({ ok: false }) }, browserAccess: { get: async () => ({ ok: false }), onChanged: () => () => {} }, sessionPeers: { get: async () => ({ ok: false }) } } });
  const store = createDesktopStore();
  store.setState({ workspace: "/fixture/repo", git: { ...store.getState().git, statusKnown: true,
    status: { head: { branch: "main", sha: "abcdef123", detached: false, ahead: null, behind: null }, staged: [], unstaged: [], untracked: [], dirtyCount: 0, filesTruncated: false } } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(EnvironmentMenu, { placement: "header" }))));
    await act(async () => host.querySelector<HTMLButtonElement>(".environment-trigger")!.click());
    await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent?.startsWith("Branch"))!.click());
    await run(host, store, send);
  } finally { await act(async () => root.unmount()); host.remove(); send.mockRestore(); if (bridge) Object.defineProperty(window, "anycode", bridge); else Reflect.deleteProperty(window, "anycode"); }
}
const branchItems = ["topic/z", "main", "topic/a"].map(name => ({ name, current: name === "main", sha: "abcdef123" }));

it("drills into a branch screen, groups and filters in server order, and goes back", async () => {
  await branchMenu(async (host, store) => {
    expect(host.textContent).toContain("Switch branch");
    expect(host.querySelector('section[aria-label="Session access"]')).toBeNull();
    await act(async () => store.setState({ git: { ...store.getState().git, pending: {}, branches: branchItems } }));
    expect(Array.from(host.querySelectorAll('[role="option"]')).map(n => n.textContent)).toEqual(["main✓", "topic/z", "topic/a"]);
    const input = host.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "TOPIC/A");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector('[role="group"][aria-label="Current"]')?.textContent).toContain("main");
    expect(host.querySelector('[role="group"][aria-label="Matching"]')?.textContent).toBe("Matching · 1topic/a");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click());
    expect(host.querySelector('section[aria-label="Session access"]')).not.toBeNull();
  });
});

it("navigates options with arrows and Enter sends the existing switch command", async () => {
  await branchMenu(async (host, store, send) => {
    await act(async () => store.setState({ git: { ...store.getState().git, pending: {}, branches: branchItems } }));
    const input = host.querySelector("input")!;
    const count = send.mock.calls.length;
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(send.mock.calls).toHaveLength(count);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    const active = input.getAttribute("aria-activedescendant");
    expect(host.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe("main✓");
    expect(document.getElementById(active!)?.textContent).toBe("topic/z");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(send).toHaveBeenCalledWith("tab", expect.objectContaining({ type: "git_command", command: { op: "switch_branch", name: "topic/z" } }));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});

it("shows loading, list error and Retry, then empty results", async () => {
  await branchMenu(async (host, store, send) => {
    expect(host.textContent).toContain("Loading branches…");
    const request = Object.entries(store.getState().git.pending).find(([, p]) => p.kind === "branches")![0];
    await act(async () => store.getState().applyHostMessage({ type: "git_result", requestId: request, outcome: { ok: false, reason: "list failed" } }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("list failed");
    await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Retry")!.click());
    expect(send).toHaveBeenLastCalledWith("tab", expect.objectContaining({ command: { op: "branches" } }));
    expect(host.textContent).toContain("Loading branches…");
    const retry = Object.entries(store.getState().git.pending).find(([, p]) => p.kind === "branches")![0];
    await act(async () => store.getState().applyHostMessage({ type: "git_result", requestId: retry, outcome: { ok: true, kind: "branches", branches: [] } }));
    expect(host.textContent).toContain("No branches match");
  });
});

it.each([{ branch: null, sha: "123456789", detached: true, label: "detached @1234567" }, { branch: "new", sha: null, detached: false, label: "unborn" }])("keeps $label in Current", async head => {
  await branchMenu(async (host, store) => {
    await act(async () => store.setState({ git: { ...store.getState().git, pending: {}, branches: [], status: { ...store.getState().git.status!, head: { ...store.getState().git.status!.head, ...head } } } }));
    expect(host.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe(head.label + "✓");
  });
});

it("clicking a matching branch uses the same switch request", async () => {
  await branchMenu(async (host, store, send) => {
    await act(async () => store.setState({ git: { ...store.getState().git, pending: {}, branches: branchItems } }));
    await act(async () => host.querySelector<HTMLElement>('[role="option"][aria-selected="false"]')!.click());
    expect(send).toHaveBeenLastCalledWith("tab", expect.objectContaining({ command: { op: "switch_branch", name: "topic/z" } }));
  });
});

it("Escape closes the branch screen through the existing panel handler", async () => {
  await branchMenu(async (host) => {
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
