// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChildWorktreeControl } from "./ChildWorktreeControl.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("mounts durable resources, copies recovery values, toggles main policy and polls only in open details", async () => {
  vi.useFakeTimers();
  const resource = { childSessionId: "gone", path: "/checkout", branch: "branch", baseSha: "abcdef123456789", phase: "active", reason: null };
  const request = vi.fn(async (q: any) => ({ enabled: q.enabled ?? true, canToggle: true, lastRefusal: "Choose Core", resources: [resource] }));
  Object.defineProperty(window, "anycode", { configurable: true, value: { childWorktrees: request } });
  const copy = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(createElement(ChildWorktreeControl, { tabId: "parent" })));
    expect(node.textContent).toContain("not a security sandbox");
    expect(node.textContent).toContain("uncommitted files are not copied");
    await act(async () => vi.advanceTimersByTime(6000)); expect(request).toHaveBeenCalledTimes(1);
    const details = node.querySelector("details")!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(node.textContent).toContain("Worktree · cwd only"); expect(node.textContent).toContain("Choose Core");
    await act(async () => (node.querySelector('button[aria-label="Copy path"]') as HTMLButtonElement).click());
    expect(copy).toHaveBeenCalledWith("/checkout");
    await act(async () => (node.querySelector('button[aria-label="Copy branch"]') as HTMLButtonElement).click());
    expect(copy).toHaveBeenCalledWith("branch");
    resource.phase = "removed"; resource.reason = "Empty checkout removed; branch retained" as never;
    await act(async () => vi.advanceTimersByTime(3000)); expect(node.textContent).toContain("removed");
    expect(node.querySelector('button[aria-label*="Open"]')).toBeNull();
    await act(async () => (node.querySelector('input') as HTMLInputElement).click());
    expect(request).toHaveBeenLastCalledWith({ tabId: "parent", enabled: false });
    await act(async () => { details.open = false; details.dispatchEvent(new Event("toggle")); });
    const count = request.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(6000)); expect(request).toHaveBeenCalledTimes(count);
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(ChildWorktreeControl, { tabId: "parent" })));
    expect(node.textContent).toContain("removed");
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
});
