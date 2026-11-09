// @vitest-environment jsdom
import { isOverlayOpen } from "../preview/overlay-flag.js";
import { describe, expect, it, vi } from "vitest";
// Mount the real rows: switches must retain the same tab-scoped bridge calls.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createDesktopStore } from "../store.js";
import { TabContext } from "../tab-context.js";
import type { UiToHostMessage } from "../../../shared/protocol.js";
import { branchSwitchAction, runBranchSwitchAction, diagnosticsExportAction } from "../App.js";
import { matchKeymap } from "../keymap.js";
import { useTabsStore } from "../tabs-store.js";
import { EnvironmentMenu } from "./EnvironmentMenu.js";

import { workspaceLabel } from "./EnvironmentMenu.js";

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
    for (const title of ["Workspace", "Session access"]) {
      expect(dialog.querySelector('section[aria-label="' + title + '"]')).not.toBeNull();
    }
    expect(dialog.textContent).toContain("1 on");
    expect(dialog.querySelector('section[aria-label="Workspace"] .environment-menu-row-main > span')?.textContent).toBe("notes");
    expect(dialog.querySelector('section[aria-label="Diagnostics"]')).toBeNull();
    expect(dialog.lastElementChild?.textContent).toContain("Export diagnostics…");
    expect(dialog.querySelector('section[aria-label="Workspace"]')?.textContent).toContain("Git is not available for this workspace.");
    expect(dialog.querySelector('[aria-label="Native session access"]')).toBeNull();
    const access = '[data-environment-action="sessions-api-access"]';
    expect(host.querySelector(access)?.getAttribute("aria-checked")).toBe("false");
    await click(access);
    expect(communication.setSessionAccess).toHaveBeenCalledWith("tab", true);
    expect(host.querySelector(".environment-menu-scope")?.textContent).toBe("2 on");
    expect(host.querySelector(access)?.getAttribute("aria-checked")).toBe("true");
    expect(host.querySelector(".environment-menu-dependents input")).not.toBeNull();
    await click('[data-environment-action="sessions-api-approvals"]');
    expect(communication.setSessionApprovals).toHaveBeenCalledWith("tab", true);
    expect(host.querySelector(".environment-menu-row-detail-warning")?.textContent).toBe("Agent can use any website without asking");
    const browser = '[data-environment-action="browser-full-access"]';
    expect(host.querySelector(browser)?.getAttribute("aria-checked")).toBe("true");
    await click(browser);
    expect(browserAccess.set).toHaveBeenCalledWith("tab", false);
    expect(host.querySelector('[title^="Full browser access"]')).toBeNull();
    expect(host.querySelector('[title="Sessions API enabled"]')).not.toBeNull();
    expect(host.querySelector('.environment-menu-title .environment-menu-scope')?.textContent).toBe("1 on");
    expect(host.querySelector(browser)?.getAttribute("aria-checked")).toBe("false");
    expect(host.querySelector(".environment-trigger")?.getAttribute("aria-label")).toContain(", Sessions API enabled");
    expect(host.querySelector(".environment-trigger")?.getAttribute("aria-label")).not.toContain("accesses");
    await click(access);
    expect(host.querySelector(".environment-risks")).toBeNull();
    expect(host.querySelector(".environment-menu-scope")?.textContent).toBe("this session only");
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

async function branchMenu(run: (host: HTMLDivElement, store: ReturnType<typeof createDesktopStore>, send: ReturnType<typeof vi.spyOn>) => Promise<void>, { placement = "header", branch = true }: { placement?: "header" | "composer"; branch?: boolean } = {}) {
  const { tabRegistry } = await import("../tab-registry.js");
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  const bridge = Object.getOwnPropertyDescriptor(window, "anycode");
  Object.defineProperty(window, "anycode", { configurable: true, value: { communication: { get: async () => ({ ok: false }) }, browserAccess: { get: async () => ({ ok: false }), onChanged: () => () => {} }, sessionPeers: { get: async () => ({ ok: false }) } } });
  const store = createDesktopStore();
  store.setState({ connection: "ready", workspace: "/fixture/repo", git: { ...store.getState().git, statusKnown: true,
    status: branch ? { head: { branch: "main", sha: "abcdef123", detached: false, ahead: null, behind: null }, staged: [], unstaged: [], untracked: [], dirtyCount: 0, filesTruncated: false } : null } });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(EnvironmentMenu, { placement }))));
    await act(async () => host.querySelector<HTMLButtonElement>(".environment-trigger")!.click());
    if (branch) await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent?.startsWith("Branch"))!.click());
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
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
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
    expect(host.textContent).toContain("No other branches");
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

it("keeps a long branch name available in the row and its tooltip", async () => {
  await branchMenu(async (host, store) => {
    const name = "feature/" + "long-branch-segment-".repeat(18);
    await act(async () => store.setState({ git: { ...store.getState().git, pending: {}, branches: [{ name, current: false, sha: "abcdef123" }] } }));
    const option = host.querySelector('[role="option"][aria-selected="false"]')!;
    expect(option.textContent).toBe(name);
    expect(option.querySelector("span")?.getAttribute("title")).toBe(name);
  });
});

const clickText = async (host: HTMLElement, text: string) => act(async () => {
  Array.from(host.querySelectorAll("button")).find(b => b.textContent === text)!.click();
});
async function readyBranches(store: ReturnType<typeof createDesktopStore>, dirtyCount = 0) {
  await act(async () => store.setState({ git: { ...store.getState().git, pending: Object.fromEntries(Object.entries(store.getState().git.pending).filter(([, p]) => p.kind === "mutation")), branches: branchItems,
    status: { ...store.getState().git.status!, dirtyCount } } }));
}
const pickTopic = async (host: HTMLElement) => act(async () => host.querySelector<HTMLElement>('[role="option"][aria-selected="false"]')!.click());
function switchRequest(send: ReturnType<typeof vi.spyOn>) {
  const calls = send.mock.calls as [string, UiToHostMessage][];
  return calls.map(c => c[1]).filter((m): m is Extract<UiToHostMessage, { type: "git_command" }> => m.type === "git_command" && m.command.op === "switch_branch").at(-1)!;
}

it("warns on dirty selection; Cancel keeps the branch and confirm sends the same request", async () => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store, 3);
    await pickTopic(host);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("3 uncommitted changes");
    expect(switchRequest(send)).toBeUndefined();
    await clickText(host, "Cancel");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(store.getState().git.status!.head.branch).toBe("main");
    expect(switchRequest(send)).toBeUndefined();
    await pickTopic(host);
    await clickText(host, "Switch anyway");
    expect(switchRequest(send).command).toEqual({ op: "switch_branch", name: "topic/z" });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

it("switches clean trees directly, locks controls with a row spinner, and closes on success", async () => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store);
    await pickTopic(host);
    const request = switchRequest(send);
    expect(request.command).toEqual({ op: "switch_branch", name: "topic/z" });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="option"][aria-busy="true"]')?.textContent).toContain("topic/z");
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Switching");
    expect(host.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.disabled).toBe(true);
    const count = send.mock.calls.length;
    await pickTopic(host);
    expect(send.mock.calls).toHaveLength(count);
    await act(async () => store.getState().applyHostMessage({ type: "git_result", requestId: request.requestId, outcome: { ok: true, kind: "unit" } }));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});

it("keeps refusals readable inside the panel, retains Current, and retries the request", async () => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store);
    await pickTopic(host);
    const fail = async (reason: string) => act(async () => store.getState().applyHostMessage({ type: "git_result", requestId: switchRequest(send).requestId, outcome: { ok: false, reason } }));
    await fail("Local changes would be overwritten by checkout.");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Local changes would be overwritten");
    expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe("main✓");
    const first = switchRequest(send).requestId;
    await clickText(host, "Retry");
    expect(switchRequest(send).requestId).not.toBe(first);
    expect(switchRequest(send).command).toEqual({ op: "switch_branch", name: "topic/z" });
    await fail("Still refused");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click());
    expect(host.querySelector('section[aria-label="Session access"]')).not.toBeNull();
  });
});

it.each([true, false])("ignores a stale switch result after close/reopen (success=%s)", async ok => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store);
    await pickTopic(host);
    const old = switchRequest(send);
    await act(async () => store.setState({ git: { ...store.getState().git, pending: {} } }));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await act(async () => host.querySelector<HTMLButtonElement>(".environment-trigger")!.click());
    await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent?.startsWith("Branch"))!.click());
    await readyBranches(store);
    await pickTopic(host);
    const current = switchRequest(send);
    await act(async () => store.getState().applyHostMessage({ type: "git_result", requestId: old.requestId,
      outcome: ok ? { ok: true, kind: "unit" } : { ok: false, reason: "Old refusal" } }));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Old refusal");
    expect(host.querySelector('[role="option"][aria-busy="true"]')).not.toBeNull();
    await act(async () => store.getState().applyHostMessage({ type: "git_result", requestId: current.requestId, outcome: { ok: true, kind: "unit" } }));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});

async function filterBranches(host: HTMLElement, value: string) {
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}
it("trims the filter and Enter switches the first match without an arrow key", async () => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store);
    expect(host.querySelector('h3')?.parentElement?.textContent).toContain("Switch branch3 branches");
    expect(host.textContent).toContain("↑↓ · Enter · Esc");
    const input = await filterBranches(host, "  TOPIC/A  ");
    expect(host.querySelector('[aria-label="Matching"]')?.textContent).toBe("Matching · 1topic/a");
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toBe("topic/a");
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(switchRequest(send).command).toEqual({ op: "switch_branch", name: "topic/a" });
  });
});
it("distinguishes empty branches from a filter with no matches and treats spaces as empty", async () => {
  await branchMenu(async (host, store) => {
    await readyBranches(store);
    await filterBranches(host, "   ");
    expect(host.querySelectorAll('[aria-label="Matching"] [role="option"]')).toHaveLength(2);
    await filterBranches(host, "absent");
    expect(host.textContent).toContain("No branches match");
    await filterBranches(host, "");
    await act(async () => store.setState({ git: { ...store.getState().git, branches: [branchItems[1]!] } }));
    expect(host.textContent).toContain("No other branches");
  });
});
it("clears a branch-list error when reopening the menu", async () => {
  await branchMenu(async (host, store) => {
    const requestId = Object.entries(store.getState().git.pending).find(([, p]) => p.kind === "branches")![0];
    await act(async () => store.getState().applyHostMessage({ type: "git_result", requestId, outcome: { ok: false, reason: "Old list failure" } }));
    expect(host.textContent).toContain("Old list failure");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await act(async () => host.querySelector<HTMLButtonElement>(".environment-trigger")!.click());
    await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent?.startsWith("Branch"))!.click());
    expect(store.getState().git.branchesError).toBeNull();
    expect(host.textContent).not.toContain("Old list failure");
    expect(host.textContent).toContain("Loading branches…");
  });
});

it("offers creation last only without an exact name and Enter creates and switches", async () => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store);
    for (const query of ["", "main", "topic/a"]) {
      await filterBranches(host, query);
      expect(host.textContent).not.toContain("Create branch “");
    }
    await filterBranches(host, "topic");
    expect(host.querySelector('[role="option"]:last-child')).not.toBeNull();
    expect(Array.from(host.querySelectorAll('[role="option"]')).at(-1)?.textContent).toBe('Create branch “topic”');
    await act(async () => store.getState().gitRequestStarted("unrelated-refresh", { kind: "refresh", label: "refresh" }));
    await filterBranches(host, "new/topic");
    await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(send).toHaveBeenLastCalledWith("tab", expect.objectContaining({ command: { op: "create_branch", name: "new/topic", switch: true } }));
    expect(host.textContent).toContain("Creating…");
    const requestId = Object.entries(store.getState().git.pending).find(([, request]) => request.kind === "mutation")![0];
    await act(async () => store.getState().applyHostMessage({ type: "git_result", requestId, outcome: { ok: false, reason: "Creation refused" } }));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Creation refused");
    await clickText(host, "Retry");
    expect(send).toHaveBeenLastCalledWith("tab", expect.objectContaining({ command: { op: "create_branch", name: "new/topic", switch: true } }));
  });
});
it.each(["bad name", "-flag", "a..b", "a@{b", "a.lock", "a/.hidden", "a//b", "a?b", "a/", "@", "HEAD"])("refuses invalid branch %s inline without sending", async name => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store);
    await filterBranches(host, name);
    const count = send.mock.calls.length;
    await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Invalid branch name");
    expect(send.mock.calls).toHaveLength(count);
    expect(host.querySelector('[role="alert"] button')).toBeNull();
  });
});
it("opens the branch screen directly from a tab-scoped command and focuses its filter", async () => {
  await branchMenu(async (host) => {
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await act(async () => window.dispatchEvent(new CustomEvent("anycode:switch-branch", { detail: "another-tab" })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => window.dispatchEvent(new CustomEvent("anycode:switch-branch", { detail: "tab" })));
    expect(host.textContent).toContain("Switch branch");
    expect(document.activeElement).toBe(host.querySelector("input"));
    host.querySelector("input")!.blur();
    await act(async () => window.dispatchEvent(new CustomEvent("anycode:switch-branch", { detail: "tab" })));
    expect(document.activeElement).toBe(host.querySelector("input"));
  });
});

it("focuses Copy path on open, restores Branch on Back and trigger on Escape/outside", async () => {
  await branchMenu(async host => {
    const trigger = host.querySelector<HTMLButtonElement>(".environment-trigger")!;
    const back = host.querySelector<HTMLButtonElement>('[aria-label="Back"]')!;
    expect(document.activeElement).toBe(host.querySelector("input"));
    const input = host.querySelector("input")!;
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(back);
    await act(async () => back.click());
    expect(document.activeElement?.textContent).toContain("Branch");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Copy path"]'));
    await act(async () => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
it("lets Tab leave the main panel without moving focus back", async () => {
  await branchMenu(async host => {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click());
    const outside = document.createElement("button"); document.body.append(outside);
    try {
      await act(async () => outside.focus());
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(outside);
    } finally { outside.remove(); }
  });
});
it("keeps pending switches open and recovers when their store record resets", async () => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store); await pickTopic(host);
    const request = switchRequest(send);
    expect(store.getState().git.pending[request.requestId]).toMatchObject({ kind: "mutation", label: "switch branch" });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await act(async () => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => store.getState().reset());
    expect(host.querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    await act(async () => store.setState({ git: { ...store.getState().git, statusKnown: true,
      status: { head: { branch: "main", sha: "abcdef", detached: false, ahead: null, behind: null }, staged: [], unstaged: [], untracked: [], dirtyCount: 0, filesTruncated: false } } }));
    await readyBranches(store); await pickTopic(host);
    expect(switchRequest(send).requestId).not.toBe(request.requestId);
  });
});
it("allows another warning target and emphasizes Cancel", async () => {
  await branchMenu(async (host, store) => {
    await readyBranches(store, 3); await pickTopic(host);
    await act(async () => Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).at(-1)!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Switch to topic/a?");
    expect(Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Cancel")?.className).toContain("secondary");
  });
});
it("shows known nonzero git counts and copies the unchanged path with one reset timer", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.useFakeTimers();
  try {
    await branchMenu(async (host, store) => {
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click());
      await act(async () => store.setState({ git: { ...store.getState().git, status: {
        ...store.getState().git.status!, dirtyCount: 3, head: { ...store.getState().git.status!.head, ahead: 2, behind: 1 }
      } } }));
      const trigger = host.querySelector(".environment-trigger")!;
      expect(trigger.textContent).toContain("●3"); expect(trigger.textContent).toContain("↑2 ↓1");
      await act(async () => store.setState({ git: { ...store.getState().git, status: {
        ...store.getState().git.status!, dirtyCount: 0, head: { ...store.getState().git.status!.head, ahead: 0, behind: null }
      } } }));
      expect(trigger.textContent).not.toContain("●"); expect(trigger.textContent).not.toContain("↑");
      const copy = host.querySelector<HTMLButtonElement>('[aria-label="Copy path"]')!;
      await act(async () => copy.click());
      expect(writeText).toHaveBeenCalledWith("/fixture/repo");
      expect(host.querySelector('[role="status"]')?.textContent).toBe("Copied");
      expect(host.textContent).toContain("/fixture/repo");
      await act(async () => vi.advanceTimersByTime(1000));
      await act(async () => copy.click());
      await act(async () => vi.advanceTimersByTime(600));
      expect(host.querySelector('[role="status"]')?.textContent).toBe("Copied");
      await act(async () => vi.advanceTimersByTime(900));
      expect(host.querySelector('[role="status"]')).toBeNull();
      await act(async () => store.setState({ git: { ...store.getState().git, statusKnown: false } }));
      expect(trigger.textContent).not.toContain("●3"); expect(trigger.textContent).not.toContain("↑2");
      await act(async () => copy.click()); // unmount must cancel this timer
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard"); }
});

it("uses a creation-specific dirty warning and keeps creation pending open", async () => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store, 3);
    await filterBranches(host, "feature/new");
    await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const warning = host.querySelector('[role="alert"]')!;
    expect(warning.textContent).toContain("Create and switch to feature/new?");
    expect(warning.textContent).not.toContain("Git will refuse");
    await clickText(host, "Create and switch");
    expect(send).toHaveBeenLastCalledWith("tab", expect.objectContaining({ command: { op: "create_branch", name: "feature/new", switch: true } }));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
it("suspends branch choices when status disappears and recovers their indices", async () => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store);
    const status = store.getState().git.status;
    await act(async () => store.setState({ git: { ...store.getState().git, status: null } }));
    await filterBranches(host, "feature/new");
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(0);
    const count = send.mock.calls.length;
    await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(send.mock.calls).toHaveLength(count);
    await act(async () => store.setState({ git: { ...store.getState().git, status } }));
    await readyBranches(store);
    await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(send).toHaveBeenLastCalledWith("tab", expect.objectContaining({ command: { op: "create_branch", name: "feature/new", switch: true } }));
  });
});

it("connects App's shortcut and palette command to the active tab panel and disables both without git", async () => {
  await branchMenu(async (host, store) => {
    const { tabRegistry } = await import("../tab-registry.js");
    const previous = useTabsStore.getState().activeTabId;
    const getStore = vi.spyOn(tabRegistry, "getStore").mockImplementation(id => id === "tab" ? store : undefined);
    useTabsStore.setState({ activeTabId: "tab" });
    const escape = () => act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    try {
      await escape();
      const match = matchKeymap(new KeyboardEvent("keydown", { key: "B", code: "KeyB", metaKey: true, shiftKey: true }), "darwin")!;
      await act(async () => { expect(runBranchSwitchAction(match.action)).toBe(true); });
      expect(document.activeElement).toBe(host.querySelector(".environment-branch-picker input"));
      await escape();
      const action = branchSwitchAction("⇧⌘B");
      expect(action).toMatchObject({ id: "branch.switch", label: "Switch branch…", hint: "⇧⌘B", enabled: true });
      await act(async () => action.run());
      expect(document.activeElement).toBe(host.querySelector(".environment-branch-picker input"));
      await escape();
      await act(async () => store.setState({ git: { ...store.getState().git, status: null } }));
      expect(branchSwitchAction(null).enabled).toBe(false);
      await act(async () => { branchSwitchAction(null).run(); runBranchSwitchAction(match.action); });
      expect(host.querySelector('[role="dialog"]')).toBeNull();
      expect(runBranchSwitchAction("sidebar.toggle")).toBe(false);
      useTabsStore.setState({ activeTabId: "foreign" });
      expect(branchSwitchAction(null).enabled).toBe(false);
    } finally { getStore.mockRestore(); useTabsStore.setState({ activeTabId: previous }); }
  });
});

it.each(["awaiting_port", "awaiting_host_ready", "host_exited"] as const)("does not send after disconnect: %s", async connection => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store);
    await act(async () => store.setState({ connection }));
    const count = send.mock.calls.length;
    await pickTopic(host);
    expect(send.mock.calls).toHaveLength(count);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(connection === "host_exited" ? "Host process exited" : connection === "awaiting_port" ? "Host connection is unavailable" : "Waiting for host readiness");
    expect(host.querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
});
it.each(["exit", "respawn", "timeout"])("unlocks an unanswered switch after %s", async event => {
  vi.useFakeTimers();
  try { await branchMenu(async (host, store, send) => {
    await readyBranches(store); await pickTopic(host);
    const request = switchRequest(send);
    await act(async () => {
      if (event === "exit") store.getState().setHostExited(false, { code: "spawn_refused", message: "Host stopped unexpectedly" });
      else if (event === "respawn") store.getState().reset();
      else vi.advanceTimersByTime(30_000);
    });
    expect(store.getState().git.pending[request.requestId]).toBeUndefined();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(event === "exit" ? "Host stopped unexpectedly" : event === "respawn" ? "interrupted" : "timed out");
    expect(host.querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
    await act(async () => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  }); } finally { vi.useRealTimers(); }
});
it("ignores a late success for a switch retired by its timeout: error stays, no second switch, dialog stays open", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try { await branchMenu(async (host, store, send) => {
    await readyBranches(store); await pickTopic(host);
    const request = switchRequest(send);
    const sent = send.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(store.getState().git.pending[request.requestId]).toBeUndefined();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("timed out");
    await act(async () => store.getState().applyHostMessage({ type: "git_result", requestId: request.requestId, outcome: { ok: true, kind: "unit" } }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("timed out");
    expect(host.querySelector<HTMLInputElement>("input")!.disabled).toBe(false);
    expect(send.mock.calls).toHaveLength(sent);
  }); } finally { warn.mockRestore(); vi.useRealTimers(); }
});
it.each([false, true])("Enter creates a partial match unless an arrow selects it: %s", async arrow => {
  await branchMenu(async (host, store, send) => {
    await readyBranches(store, 1);
    const input = await filterBranches(host, "topic");
    if (arrow) await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("1 uncommitted change");
    expect(host.querySelector('[role="alert"]')?.textContent).not.toContain("1 uncommitted changes");
    if (arrow) expect(host.querySelector('[role="alert"]')?.textContent).toContain("target branch");
    expect(switchRequest(send)).toBeUndefined();
    await clickText(host, arrow ? "Switch anyway" : "Create and switch");
    expect(send).toHaveBeenLastCalledWith("tab", expect.objectContaining({ command: arrow ? { op: "switch_branch", name: "topic/a" } : { op: "create_branch", name: "topic", switch: true } }));
  });
});
it("palette activation reads current git availability and active tab", async () => {
  const { tabRegistry } = await import("../tab-registry.js");
  const store = createDesktopStore();
  const previous = useTabsStore.getState().activeTabId;
  const getStore = vi.spyOn(tabRegistry, "getStore").mockReturnValue(store);
  const dispatch = vi.spyOn(window, "dispatchEvent");
  try {
    useTabsStore.setState({ activeTabId: "first" });
    const action = branchSwitchAction(null);
    expect(action.enabled).toBe(false);
    store.setState({ git: { ...store.getState().git, status: { head: { branch: "main" } } as never } });
    useTabsStore.setState({ activeTabId: "second" });
    expect(action.enabled).toBe(true);
    action.run();
    expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({ detail: "second" });
    store.setState({ git: { ...store.getState().git, status: null } });
    dispatch.mockClear(); action.run(); expect(dispatch).not.toHaveBeenCalled();
  } finally { getStore.mockRestore(); dispatch.mockRestore(); useTabsStore.setState({ activeTabId: previous }); }
});


it.each([true, false, undefined])("shows worktree context and guards owned branches (%s)", async owned => {
  const { tabRegistry } = await import("../tab-registry.js");
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  const previous = useTabsStore.getState().tabs;
  const bridge = Object.getOwnPropertyDescriptor(window, "anycode");
  const worktree = owned === undefined ? undefined : { id: "child", path: "/fixture/checkout", branch: "topic", baseRef: "main", ownedByAnyCode: owned };
  useTabsStore.setState({ tabs: [{ tabId: "tab", worktree }] as never });
  const copy = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  Object.defineProperty(window, "anycode", { configurable: true, value: {
    communication: { get: async () => ({ ok: true, envControlled: false, view: { tabs: [{ tabId: "tab", enabled: true }] } }) },
    browserAccess: { get: async () => ({ ok: true, tabs: [{ tabId: "tab", fullAccess: true }] }), onChanged: () => () => {} },
    sessionPeers: { get: async () => ({ ok: false }) },
  } });
  const store = createDesktopStore();
  store.setState({ connection: "ready", workspace: worktree?.path ?? "/fixture/repo", git: { ...store.getState().git, statusKnown: true,
    status: { head: { branch: "topic", sha: "abcdef", detached: false, ahead: null, behind: null }, dirtyCount: 0, staged: [], unstaged: [], untracked: [], filesTruncated: false } } });
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(EnvironmentMenu, { placement: "header" }))));
    expect(!!host.querySelector('.environment-worktree-label')).toBe(owned !== undefined);
    expect(host.querySelector('[title^="Full browser access"] svg')).not.toBeNull();
    expect(host.querySelector('[title="Sessions API enabled"] svg')).not.toBeNull();
    expect(host.querySelector('.environment-risk-summary')?.textContent).toBe("2");
    expect(host.querySelector('.environment-trigger')?.getAttribute('aria-label')).toContain(", Full browser access and Sessions API enabled");
    await act(async () => host.querySelector<HTMLButtonElement>('.environment-trigger')!.click());
    expect(host.querySelector('section[aria-label="Session access"] .environment-menu-title')?.textContent).toContain("2 on");
    const branch = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.startsWith('Branch'))!;
    expect(branch.disabled).toBe(owned === true);
    if (worktree) {
      expect(host.textContent).toContain("Base main");
      expect(host.querySelector(".environment-worktree-block")?.textContent).toContain(owned ? "Removed on exit if it has no changes, including ignored files; otherwise kept" : "Checkout and branch are kept");
      expect(host.textContent?.includes("Its merged branch may be removed.")).toBe(owned);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy path"]')!.click());
      expect(copy).toHaveBeenCalledWith(worktree.path);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Exit worktree"]')!.click());
      expect(send).toHaveBeenLastCalledWith("tab", { type: "exit_worktree", cleanup: "auto" });
      await act(async () => store.setState({ turn: { ...store.getState().turn, status: "running" } }));
      expect(host.querySelector<HTMLButtonElement>('[aria-label^="Exit worktree"]')!.disabled).toBe(true);
      await act(async () => store.setState({ turn: { ...store.getState().turn, status: "idle" }, connection: "awaiting_host_ready" }));
      expect(host.querySelector<HTMLButtonElement>('[aria-label^="Exit worktree"]')!.disabled).toBe(true);
    }
    await act(async () => window.dispatchEvent(new CustomEvent("anycode:switch-branch", { detail: "tab" })));
    expect(!!host.querySelector('.environment-branch-picker')).toBe(owned !== true);
  } finally {
    await act(async () => root.unmount()); send.mockRestore(); useTabsStore.setState({ tabs: previous });
    if (bridge) Object.defineProperty(window, "anycode", bridge); else Reflect.deleteProperty(window, "anycode");
  }
});

it("disables the palette branch switch for an AnyCode-owned worktree", async () => {
  const { tabRegistry } = await import("../tab-registry.js");
  const store = createDesktopStore();
  store.setState({ git: { ...store.getState().git, status: { head: { branch: "topic" } } as never } });
  const previous = useTabsStore.getState();
  const getStore = vi.spyOn(tabRegistry, "getStore").mockReturnValue(store);
  try {
    useTabsStore.setState({ activeTabId: "tab", tabs: [{ tabId: "tab", worktree: { ownedByAnyCode: true } }] as never });
    expect(branchSwitchAction(null).enabled).toBe(false);
    useTabsStore.setState({ tabs: [{ tabId: "tab", worktree: { ownedByAnyCode: false } }] as never });
    expect(branchSwitchAction(null).enabled).toBe(true);
  } finally { getStore.mockRestore(); useTabsStore.setState({ activeTabId: previous.activeTabId, tabs: previous.tabs }); }
});

it("disables the palette branch switch for a managed child allocation", async () => {
  const { tabRegistry } = await import("../tab-registry.js");
  const store = createDesktopStore();
  store.setState({ git: { ...store.getState().git, status: { head: { branch: "topic" } } as never } });
  const previous = useTabsStore.getState();
  const getStore = vi.spyOn(tabRegistry, "getStore").mockReturnValue(store);
  const allocation = { id: "child", path: "/fixture/child", branch: "topic", baseRef: "main", ownedByAnyCode: false, parentSessionId: "parent-session" };
  try {
    useTabsStore.setState({ activeTabId: "tab", tabs: [{ tabId: "tab" }] as never, childWorktrees: { tab: allocation } as never });
    expect(branchSwitchAction(null).enabled).toBe(false);
    useTabsStore.setState({ childWorktrees: {} });
    expect(branchSwitchAction(null).enabled).toBe(true);
  } finally { getStore.mockRestore(); useTabsStore.setState({ activeTabId: previous.activeTabId, tabs: previous.tabs, childWorktrees: previous.childWorktrees }); }
});

/** Mounts the menu with a controllable Sessions API `get`; the trigger reads its state from that fetch. */
async function sessionsMenu(get: () => Promise<unknown>) {
  const bridge = Object.getOwnPropertyDescriptor(window, "anycode");
  const setSessionAccess = vi.fn(async (_id: string, enabled: boolean) => ({ ok: true, view: { tabs: [{ tabId: "tab", enabled, approvals: false }] } }));
  Object.defineProperty(window, "anycode", { configurable: true, value: {
    communication: { get, setSessionAccess, setSessionApprovals: vi.fn(), setSessionHandle: vi.fn() },
    browserAccess: { get: async () => ({ ok: true, tabs: [] }), onChanged: () => () => {}, set: vi.fn() },
    sessionPeers: { get: async () => ({ ok: false }) },
  } });
  const store = createDesktopStore();
  store.setState({ workspace: "/fixture/notes", git: { ...store.getState().git, status: null, statusKnown: true } });
  const host = document.createElement("div"), root = createRoot(host);
  await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(EnvironmentMenu, { placement: "header" }))));
  const restore = async () => {
    await act(async () => root.unmount());
    if (bridge) Object.defineProperty(window, "anycode", bridge); else Reflect.deleteProperty(window, "anycode");
  };
  return { host, setSessionAccess, restore };
}
const sessionsView = (enabled: boolean) => ({ ok: true, envControlled: false, view: { tabs: [{ tabId: "tab", enabled, approvals: false }] } });

it("keeps the Sessions API risk state while the menu reopens (no reset to off while refetching)", async () => {
  const pendingOpen: Array<(value: unknown) => void> = [];
  const get = vi.fn()
    .mockImplementationOnce(async () => sessionsView(true))
    .mockImplementation(() => new Promise(resolve => pendingOpen.push(resolve)));
  const { host, restore } = await sessionsMenu(get);
  try {
    expect(host.querySelector('[title="Sessions API enabled"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".environment-trigger")!.click());
    // opening the menu refetches (the trigger's own fetch plus SessionAccessRow's); the state stays on while they are in flight
    expect(pendingOpen).toHaveLength(2);
    expect(host.querySelector('[title="Sessions API enabled"]')).not.toBeNull();
    expect(host.querySelector(".environment-menu-scope")?.textContent).toBe("1 on");
    await act(async () => pendingOpen.forEach(resolve => resolve(sessionsView(true))));
  } finally { await restore(); }
});

it("ignores a fetch that resolves after a later Sessions API change made in the menu", async () => {
  let resolveMount!: (value: unknown) => void;
  const get = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { resolveMount = resolve; }))
    .mockImplementation(async () => sessionsView(false));
  const { host, setSessionAccess, restore } = await sessionsMenu(get);
  try {
    expect(host.querySelector('[title="Sessions API enabled"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".environment-trigger")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-environment-action="sessions-api-access"]')!.click());
    expect(setSessionAccess).toHaveBeenCalledWith("tab", true);
    expect(host.querySelector('[title="Sessions API enabled"]')).not.toBeNull();
    await act(async () => resolveMount(sessionsView(false)));
    expect(host.querySelector('[title="Sessions API enabled"]')).not.toBeNull();
    expect(host.querySelector('[data-environment-action="sessions-api-access"]')?.getAttribute("aria-checked")).toBe("true");
  } finally { await restore(); }
});

it("hides a matching header folder and keeps differing titles", async () => {
  await branchMenu(async (host) => {
    const previous = useTabsStore.getState().tabs;
    try {
      await act(async () => useTabsStore.setState({ tabs: [{ tabId: "tab", title: "repo" }] as typeof previous }));
      expect(host.querySelector(".environment-workspace")).toBeNull();
      expect(host.querySelector(".environment-separator")).toBeNull();
      expect(host.querySelector(".environment-trigger")?.getAttribute("aria-label")).toContain("repo");
      expect(host.querySelector(".environment-trigger")?.getAttribute("title")).toBe("/fixture/repo");
      await act(async () => useTabsStore.setState({ tabs: [{ tabId: "tab", title: "Fix login" }] as typeof previous }));
      expect(host.querySelector(".environment-workspace")?.textContent).toContain("repo");
      expect(host.querySelector(".environment-trigger")?.getAttribute("title")).toBe("/fixture/repo");
    } finally { await act(async () => useTabsStore.setState({ tabs: previous })); }
  });
});

it("keeps the folder name when it equals the title and nothing else would show it", async () => {
  const previous = useTabsStore.getState().tabs;
  try {
    await act(async () => useTabsStore.setState({ tabs: [{ tabId: "tab", title: "repo" }] as typeof previous }));
    await branchMenu(async (host) => {
      expect(host.querySelector(".environment-workspace")?.textContent).toContain("repo");
    }, { placement: "composer" });
    await branchMenu(async (host) => {
      expect(host.querySelector(".environment-workspace")?.textContent).toContain("repo");
      expect(host.querySelector(".environment-trigger")?.getAttribute("title")).toBe("/fixture/repo");
    }, { branch: false });
  } finally { await act(async () => useTabsStore.setState({ tabs: previous })); }
});

it("exports through the bottom row and active-tab palette entry using the existing preview", async () => {
  await branchMenu(async (host, store) => {
    const previous = useTabsStore.getState();
    const preview = vi.fn(async () => ({ ok: true, preview: "scrubbed bundle", summary: { bytes: 12, redactions: 0, truncated: false, sections: [] } }));
    Object.assign(window.anycode, { diagnostics: { preview, save: vi.fn() } });
    await act(async () => useTabsStore.setState({ activeTabId: "tab", tabs: [{ tabId: "tab", sessionId: "session-fixture" }] as typeof previous.tabs }));
    const { tabRegistry } = await import("../tab-registry.js");
    const getStore = vi.spyOn(tabRegistry, "getStore").mockReturnValue(store);
    try {
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      await act(async () => host.querySelector<HTMLButtonElement>(".environment-trigger")!.click());
      const row = host.querySelector<HTMLButtonElement>('[data-environment-action="diagnostics-preview"]')!;
      expect(row.textContent).toContain("Export diagnostics…");
      await act(async () => row.click());
      expect(preview).toHaveBeenCalledWith({ sessionId: "session-fixture" });
      expect(host.textContent).toContain("scrubbed bundle");
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      const action = diagnosticsExportAction();
      expect(action).toMatchObject({ id: "diagnostics.export", label: "Export diagnostics…", enabled: true });
      await act(async () => action.run());
      expect(preview).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain("scrubbed bundle");
      await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      await act(async () => host.querySelector<HTMLButtonElement>(".environment-trigger")!.click());
      expect(preview).toHaveBeenCalledTimes(2);
      expect(host.textContent).not.toContain("scrubbed bundle");
      // Same gates as the menu listener: no workspace or a pending branch switch means no command.
      await act(async () => store.setState({ workspace: null }));
      expect(action.enabled).toBe(false);
      await act(async () => store.setState({ workspace: "/fixture/repo" }));
      await act(async () => store.setState({ git: { ...store.getState().git, pending: { switch: { kind: "mutation", label: "switch branch" } } } }));
      expect(action.enabled).toBe(false);
      await act(async () => store.setState({ git: { ...store.getState().git, pending: {} } }));
      expect(action.enabled).toBe(true);
      await act(async () => useTabsStore.setState({ activeTabId: "foreign" }));
      expect(action.enabled).toBe(false);
      action.run();
      expect(preview).toHaveBeenCalledTimes(2);
    } finally { getStore.mockRestore(); await act(async () => useTabsStore.setState(previous)); }
  });
});


it("resolves a child worktree's parent title live and omits unavailable attribution", async () => {
  const previous = useTabsStore.getState();
  const bridge = Object.getOwnPropertyDescriptor(window, "anycode");
  Object.defineProperty(window, "anycode", { configurable: true, value: {
    communication: { get: async () => ({ ok: false }) },
    browserAccess: { get: async () => ({ ok: false }), onChanged: () => () => {} },
    sessionPeers: { get: async () => ({ ok: false }) },
  } });
  const store = createDesktopStore();
  store.setState({ workspace: "/fixture/child", git: { ...store.getState().git, statusKnown: true,
    status: { head: { branch: "topic", sha: "abcdef", detached: false, ahead: null, behind: null }, dirtyCount: 0, staged: [], unstaged: [], untracked: [], filesTruncated: false } } });
  const childWorktrees = { tab: { id: "child", path: "/fixture/child", branch: "topic", baseRef: "main", ownedByAnyCode: false, parentSessionId: "parent-session" } };
  useTabsStore.setState({ childWorktrees, tabs: [{ tabId: "parent", sessionId: "parent-session", title: "Fix login" }] } as never);
  const host = document.createElement("div"), root = createRoot(host);
  const check = (title?: string) => {
    const label = title ? `worktree of “${title}”` : undefined;
    expect(host.querySelector(".environment-worktree-parent")?.textContent).toBe(label);
    const tooltip = host.querySelector(".environment-trigger")?.getAttribute("title") ?? "";
    if (label) expect(tooltip).toContain(label); else expect(tooltip).not.toContain("worktree of");
  };
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(EnvironmentMenu, { placement: "header" }))));
    await act(async () => host.querySelector<HTMLButtonElement>(".environment-trigger")!.click());
    check("Fix login");
    const branch = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.startsWith('Branch'))!;
    expect(branch.disabled).toBe(true);
    expect(branch.title).toBe("Branch is managed by the parent session");
    expect(host.querySelector(".environment-worktree-block")?.textContent).toContain("Lifecycle · Managed by the parent session");
    await act(async () => window.dispatchEvent(new CustomEvent("anycode:switch-branch", { detail: "tab" })));
    expect(host.querySelector(".environment-branch-picker")).toBeNull();
    expect(host.querySelector('[aria-label="Exit worktree"]')).toBeNull();
    await act(async () => useTabsStore.getState().setTitle("parent", "Fix redirect")); check("Fix redirect");
    await act(async () => useTabsStore.setState({ tabs: [{ tabId: "parent", sessionId: "parent-session" }] } as never)); check();
    await act(async () => useTabsStore.setState({ tabs: [{ tabId: "parent", sessionId: "parent-session", title: "  ", workspace: "/fixture/parent-repo" }] } as never)); check("parent-repo");
    await act(async () => useTabsStore.setState({ tabs: [{ tabId: "parent", sessionId: "parent-session", workspace: "/fixture/parent-repo" }] } as never)); check("parent-repo");
    await act(async () => useTabsStore.setState({ tabs: [{ tabId: "parent", sessionId: "parent-session" }] } as never)); check();
    await act(async () => useTabsStore.getState().removeTab("parent")); check();
    await act(async () => useTabsStore.setState({ tabs: [{ tabId: "other", sessionId: "unknown", title: "Wrong parent" }] } as never)); check();
    await act(async () => useTabsStore.setState({ childWorktrees: {}, tabs: [{ tabId: "tab", worktree: childWorktrees.tab }, { tabId: "parent", sessionId: "parent-session", title: "Fix login" }] } as never)); check();
  } finally {
    await act(async () => root.unmount()); useTabsStore.setState(previous);
    if (bridge) Object.defineProperty(window, "anycode", bridge); else Reflect.deleteProperty(window, "anycode");
  }
});

it("manages peers outside the menu, refetches on reopen and restores focus on Escape", async () => {
  const original = Object.getOwnPropertyDescriptor(window, "anycode");
  const project = { key: "/current", name: "current", enabled: true, trusted: true, granted: false };
  let peer = { key: "/other/peer", name: "peer", enabled: true, trusted: true, granted: false };
  const get = vi.fn(async () => ({ ok: true as const, view: { available: true, project, peers: [peer] } }));
  const set = vi.fn(async ({ enabled }: { enabled: boolean }) => {
    peer = { ...peer, granted: enabled };
    return { ok: true as const, view: { available: true, project, peers: [peer] } };
  });
  Object.defineProperty(window, "anycode", { configurable: true, value: {
    communication: { get: async () => ({ ok: false }) },
    browserAccess: { get: async () => ({ ok: false }), onChanged: () => () => {} },
    sessionPeers: { get, set },
  } });
  const store = createDesktopStore(); store.setState({ workspace: "/current" });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const trigger = () => host.querySelector<HTMLButtonElement>(".environment-trigger")!;
  try {
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(EnvironmentMenu, { placement: "header" }))));
    await act(async () => trigger().click());
    expect(host.textContent).toContain("Communicates with 0 projects");
    expect(host.querySelector(".session-peers-row")).toBeNull();
    expect(host.querySelector('button[aria-label="Native session access"]')).not.toBeNull();
    await clickText(host, "Manage…");
    expect(host.querySelector('[aria-label="Environment"]')).toBeNull();
    expect(host.querySelector(".session-peers-row")).not.toBeNull();
    expect(isOverlayOpen()).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => host.querySelector<HTMLButtonElement>('.session-peers-row button[role="switch"]')!.click());
    expect(host.querySelector('.session-peers-summary')?.textContent).toContain("configured with the peer project");
    await act(async () => host.querySelector<HTMLInputElement>('input[type="search"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector(".session-peers-row")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(isOverlayOpen()).toBe(false);
    await act(async () => trigger().click());
    expect(host.textContent).toContain("Communicates with 1 project");
    expect(get).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount()); host.remove();
    if (original) Object.defineProperty(window, "anycode", original); else Reflect.deleteProperty(window, "anycode");
  }
});

/**
 * jsdom has no modal inertness; a real browser ignores focus() on anything
 * outside an open modal dialog. Emulate that so a focus call made while the
 * dialog is still open is lost, as it is in the app.
 */
function emulateModalInertness(): () => void {
  const original = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, ...args: Parameters<HTMLElement["focus"]>) {
    const dialog = document.querySelector("dialog[open]");
    if (dialog && !dialog.contains(this)) return;
    original.apply(this, args);
  };
  return () => { HTMLElement.prototype.focus = original; };
}

async function mountPeersMenu(view: () => unknown) {
  const original = Object.getOwnPropertyDescriptor(window, "anycode");
  const get = vi.fn(async () => ({ ok: true as const, view: view() }));
  const set = vi.fn(async () => ({ ok: true as const, view: view() }));
  Object.defineProperty(window, "anycode", { configurable: true, value: {
    communication: { get: async () => ({ ok: false }) },
    browserAccess: { get: async () => ({ ok: false }), onChanged: () => () => {} },
    sessionPeers: { get, set },
  } });
  const store = createDesktopStore(); store.setState({ workspace: "/current" });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(EnvironmentMenu, { placement: "header" }))));
  return {
    host, get, set,
    trigger: () => host.querySelector<HTMLButtonElement>(".environment-trigger")!,
    close: async () => {
      await act(async () => root.unmount()); host.remove();
      if (original) Object.defineProperty(window, "anycode", original); else Reflect.deleteProperty(window, "anycode");
    },
  };
}

describe("peers dialog focus return", () => {
  const peersView = () => ({
    available: true,
    project: { key: "/current", name: "current", enabled: true, trusted: true, granted: false },
    peers: [{ key: "/other/peer", name: "peer", enabled: true, trusted: true, granted: false }],
  });
  const closers: Record<string, (host: HTMLElement) => Promise<void>> = {
    "Escape from the search field": host => act(async () => {
      const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
      expect(document.activeElement).toBe(input);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }),
    "the close button": host => act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()),
    "a click outside the dialog": host => act(async () => host.querySelector<HTMLElement>("dialog")!.click()),
  };
  for (const [name, close] of Object.entries(closers)) {
    it(`puts the focus on the menu trigger after closing with ${name}`, async () => {
      const restoreFocus = emulateModalInertness();
      const originalShowModal = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      const t = await mountPeersMenu(peersView);
      try {
        await act(async () => t.trigger().click());
        await clickText(t.host, "Manage…");
        expect(t.host.querySelector("dialog[open]")).not.toBeNull();
        await close(t.host);
        expect(t.host.querySelector("dialog")).toBeNull();
        expect(document.activeElement).toBe(t.trigger());
        expect(t.trigger().getAttribute("aria-expanded")).toBe("false");
      } finally {
        await t.close(); restoreFocus(); HTMLDialogElement.prototype.showModal = originalShowModal;
      }
    });
  }
});

describe("menu summary after the current project is switched off", () => {
  it("shows the inactive note on reopen, whether or not the dialog saved anything", async () => {
    const originalShowModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    let enabled = true;
    const view = () => ({
      available: true,
      project: { key: "/current", name: "current", enabled, trusted: true, granted: false },
      peers: [{ key: "/other/peer", name: "peer", enabled: true, trusted: true, granted: true }],
    });
    const t = await mountPeersMenu(view);
    const summary = () => t.host.querySelector(".native-access-summary")?.textContent ?? "";
    try {
      await act(async () => t.trigger().click());
      expect(summary()).toContain("Communicates with 1 project");
      expect(summary()).not.toContain("Currently inactive");
      await clickText(t.host, "Manage…");
      // The project is switched off behind the open dialog (main, not this view).
      enabled = false;
      const key = (type: string) => act(async () => t.host.querySelector<HTMLInputElement>('input[type="search"]')!
        .dispatchEvent(new KeyboardEvent(type, { key: "Escape", bubbles: true })));
      await key("keydown");
      expect(t.host.querySelector("dialog")).toBeNull();
      await act(async () => t.trigger().click());
      // The reopened menu refetches instead of showing the snapshot taken before the switch-off.
      expect(summary()).toContain("Communicates with 1 project");
      expect(summary()).toContain("Currently inactive");
    } finally {
      await t.close(); HTMLDialogElement.prototype.showModal = originalShowModal;
    }
  });

  it("shows the inactive note after the dialog revokes a grant while the project is off", async () => {
    const originalShowModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    let enabled = true;
    let granted = [true, true];
    const view = () => ({
      available: true,
      project: { key: "/current", name: "current", enabled, trusted: true, granted: false },
      peers: granted.map((g, i) => ({ key: `/other/peer-${i}`, name: `peer-${i}`, enabled: true, trusted: true, granted: g })),
    });
    const t = await mountPeersMenu(view);
    t.set.mockImplementation(async () => { granted = [false, true]; return { ok: true as const, view: view() }; });
    try {
      await act(async () => t.trigger().click());
      await clickText(t.host, "Manage…");
      enabled = false;
      await act(async () => t.host.querySelector<HTMLButtonElement>('.session-peers-row[data-granted="true"] button[role="switch"]')!.click());
      expect(t.set).toHaveBeenCalledTimes(1);
      expect(t.host.querySelector(".session-peers-dialog")?.textContent).toContain("Currently inactive");
      await act(async () => t.host.querySelector<HTMLInputElement>('input[type="search"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await act(async () => t.trigger().click());
      expect(t.host.querySelector(".native-access-summary")?.textContent).toContain("Communicates with 1 project · Currently inactive");
    } finally {
      await t.close(); HTMLDialogElement.prototype.showModal = originalShowModal;
    }
  });
});
