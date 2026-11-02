// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PermissionModal } from "./PermissionModal.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal = function () { this.open = true; };

it("shows a deadline-derived countdown and announces the expiry policy", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(PermissionModal, {
      request: { requestId: "one", toolName: "Write", input: {}, mode: "build", deadline: 1_120_000, metadata: { name: "Write", description: "write", readOnly: false, destructive: false, riskLevel: "medium", sideEffectScope: "process" } },
      onAllow: () => {}, onDeny: () => {},
    })));
    expect(container.textContent).toContain("Automatically denied in 2:00 if unanswered");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("automatically denied if unanswered");
    await act(async () => { vi.advanceTimersByTime(31_000); });
    expect(container.textContent).toContain("Automatically denied in 1:29 if unanswered");
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("offers a directory mask and explains a blank write rule", async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const request = { requestId: "1", workspaceWriteInside: false, toolName: "Write", input: { file_path: "/private/tmp/project/a.txt" }, mode: "build", metadata: { name: "Write", description: "", readOnly: false, destructive: false, riskLevel: "medium", sideEffectScope: "process" } } as import("../store.js").PermissionUiRequest;
  try {
    await act(async () => root.render(createElement(PermissionModal, { request, workspace: "/workspace", onAllow: vi.fn(), onDeny: vi.fn() })));
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Always-allow pattern"]')!;
    expect(input.value).toBe("/private/tmp/project/**");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("will not apply outside the session workspace");
  } finally { await act(async () => root.unmount()); container.remove(); }
});


it("rejects a whole-home mask and displays save failures", async () => {
  Object.defineProperty(window, "anycode", { configurable: true, value: { homeDirectory: async () => "/mnt/profiles/current" } });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const onAllow = vi.fn().mockRejectedValue(new Error("invalid"));
  const request = { requestId: "home", toolName: "Write", input: { file_path: "/mnt/profiles/current/file" }, mode: "build", metadata: { name: "Write", description: "", readOnly: false, destructive: false, riskLevel: "medium", sideEffectScope: "process" } } as import("../store.js").PermissionUiRequest;
  try {
    await act(async () => root.render(createElement(PermissionModal, { request, onAllow, onDeny: vi.fn() })));
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Always-allow pattern"]')!;
    const setPattern = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await setPattern("/mnt/profiles/current/**");
    expect(container.textContent).toContain("Enter a narrowly scoped absolute path mask");
    await setPattern("/mnt/profiles/current/project/**");
    await act(async () => container.querySelector<HTMLButtonElement>(".permission-allow-button")!.click());
    expect(container.textContent).toContain("Could not save the always-allow rule");
    expect(onAllow).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); delete (window as unknown as { anycode?: unknown }).anycode; }
});
