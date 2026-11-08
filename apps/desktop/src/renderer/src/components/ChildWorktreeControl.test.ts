// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChildWorktreeControl } from "./ChildWorktreeControl.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("mounts durable resources, copies recovery values, toggles main policy and polls only in open details", async () => {
  vi.useFakeTimers();
  const resource = { id: "receipt", childSessionId: "gone", path: "/checkout", branch: "branch", baseSha: "abcdef123456789", phase: "active", reason: null };
  const request = vi.fn(async (q: any) => ({ enabled: q.enabled ?? false, canToggle: true, lastRefusal: "Choose Core", resources: [resource] }));
  Object.defineProperty(window, "anycode", { configurable: true, value: { childWorktrees: request } });
  const copy = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(createElement(ChildWorktreeControl, { tabId: "parent" })));
    expect((node.querySelector('input') as HTMLInputElement).checked).toBe(false);
    expect(node.textContent).toContain("Last creation refused:");
    expect(node.querySelectorAll("ul > li")).toHaveLength(1);
    expect(node.textContent).toContain("Not a sandbox");
    expect(node.textContent).toContain("uncommitted files aren't copied");
    expect(node.textContent).not.toContain("Review retained work manually");
    expect(node.querySelector('a')?.getAttribute('href')).toBe('https://github.com/incadawr/anycode/blob/master/docs/user/subagents.md#session-children-in-worktrees');
    await act(async () => vi.advanceTimersByTime(6000)); expect(request).toHaveBeenCalledTimes(1);
    const details = node.querySelector("details")!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(node.textContent).toContain("Worktree · cwd only"); expect(node.textContent).toContain("Choose Core");
    await act(async () => (node.querySelector('button[aria-label="Copy path"]') as HTMLButtonElement).click());
    expect(copy).toHaveBeenCalledWith("/checkout");
    expect(node.querySelector('button[aria-label="Copy path"]')?.textContent).toBe("Copied");
    await act(async () => (node.querySelector('button[aria-label="Copy branch"]') as HTMLButtonElement).click());
    expect(copy).toHaveBeenCalledWith("branch");
    resource.phase = "removed"; resource.reason = "Empty checkout removed; branch retained" as never;
    await act(async () => vi.advanceTimersByTime(3000)); expect(node.textContent).toContain("removed");
    expect(node.querySelector('button[aria-label*="Open"]')).toBeNull();
    expect(node.textContent).not.toContain("Folder removed; branch retained.");
    await act(async () => (node.querySelector('input') as HTMLInputElement).click());
    expect(request).toHaveBeenLastCalledWith({ tabId: "parent", enabled: true });
    await act(async () => { details.open = false; details.dispatchEvent(new Event("toggle")); });
    const count = request.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(6000)); expect(request).toHaveBeenCalledTimes(count);
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(ChildWorktreeControl, { tabId: "parent" })));
    expect(node.textContent).toContain("removed");
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
});

it("keeps a toggle result when an older GET arrives and uses only public states", async () => {
  vi.useFakeTimers();
  let resolveGet!: (value: any) => void;
  let calls = 0;
  const view = { enabled: false, canToggle: true, resources: [
    { id: "pending", phase: "not-created", path: "/pending", branch: "branch", baseSha: "abc", childSessionId: "child", reason: null },
  ], lastRefusal: "A readable Git repository is required" };
  const request = vi.fn((q: any) => {
    if (++calls === 3) return new Promise(resolve => { resolveGet = resolve; });
    return Promise.resolve({ ...view, enabled: q.enabled ?? false });
  });
  Object.defineProperty(window, "anycode", { configurable: true, value: { childWorktrees: request } });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(createElement(ChildWorktreeControl, { tabId: "parent" })));
    expect(node.textContent).toContain("unknown");
    expect(node.textContent).not.toMatch(/not-created|Child checkout active|Choose Core/);
    await act(async () => (node.querySelector('button') as HTMLButtonElement).click());
    const details = node.querySelector('details')!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    await act(async () => vi.advanceTimersByTime(2500));
    await act(async () => (node.querySelector('input') as HTMLInputElement).click());
    await act(async () => resolveGet(view));
    expect((node.querySelector('input') as HTMLInputElement).checked).toBe(true);
    view.canToggle = false;
    await act(async () => { details.open = false; details.dispatchEvent(new Event("toggle")); });
    expect((node.querySelector('input') as HTMLInputElement).disabled).toBe(true);
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
});
it("ignores an old parent's pending toggle after changing tabs and displays request errors", async () => {
  let finish!: (value: any) => void;
  const request = vi.fn((q: any) => q.enabled !== undefined ? new Promise(resolve => { finish = resolve; })
    : q.tabId === "broken" ? Promise.reject(Error("Request failed"))
      : Promise.resolve({ enabled: false, canToggle: true, resources: [] }));
  Object.defineProperty(window, "anycode", { configurable: true, value: { childWorktrees: request } });
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(createElement(ChildWorktreeControl, { tabId: "parent" })));
    await act(async () => (node.querySelector('input') as HTMLInputElement).click());
    await act(async () => root.render(createElement(ChildWorktreeControl, { tabId: "second" })));
    expect((node.querySelector('input') as HTMLInputElement).disabled).toBe(false);
    expect(node.querySelector("ul")).toBeNull();
    await act(async () => finish({ enabled: true, canToggle: true, resources: [] }));
    expect((node.querySelector('input') as HTMLInputElement).checked).toBe(false);
    await act(async () => root.render(createElement(ChildWorktreeControl, { tabId: "broken" })));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Request failed");
  } finally { await act(async () => root.unmount()); }
});

it.each([
  ["Agent: worktree session children require Core", false],
  ["Agent: worktree session children require Core; choose a Core child.", false],
  ["Worktree SessionOpen requires Core, the opener checkout, and an available allocator.", false],
])("adds advice only for an unambiguous engine refusal: %s", async (lastRefusal, advice) => {
  Object.defineProperty(window, "anycode", { configurable: true, value: { childWorktrees: async () => ({ resources: [], lastRefusal }) } });
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(createElement(ChildWorktreeControl, { tabId: "parent" })));
    expect(node.textContent?.includes("Choose Core and start a new child.")).toBe(advice);
  } finally { await act(async () => root.unmount()); }
});
it("shows unverified receipts, hides unconfirmed paths and resets the copy timer", async () => {
  vi.useFakeTimers();
  const resources = ["intent", "not-created", "removed"].map(phase => ({ id: phase, phase, path: `/${phase}`, branch: phase, baseSha: "abc" }));
  Object.defineProperty(window, "anycode", { configurable: true, value: { childWorktrees: async () => ({ resources, unverified: [{ id: "bad", reason: "Unreadable journal" }] }) } });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(createElement(ChildWorktreeControl, { tabId: "parent" })));
    expect(node.textContent).toContain("unverified"); expect(node.textContent).toContain("Unreadable journal");
    const buttons = node.querySelectorAll('button[aria-label="Copy path"]');
    expect(buttons).toHaveLength(1); expect(buttons[0]?.parentElement?.textContent).toContain("/removed");
    expect(node.textContent).not.toMatch(/\/intent|\/not-created/);
    await act(async () => (buttons[0] as HTMLButtonElement).click());
    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () => (buttons[0] as HTMLButtonElement).click());
    await act(async () => vi.advanceTimersByTime(500));
    expect(buttons[0]?.textContent).toBe("Copied");
    await act(async () => vi.advanceTimersByTime(1000));
    expect(buttons[0]?.textContent).toBe("Copy path");
    await act(async () => (buttons[0] as HTMLButtonElement).click());
  } finally { await act(async () => root.unmount()); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
});
