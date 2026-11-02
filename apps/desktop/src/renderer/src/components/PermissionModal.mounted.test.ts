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
  const request = { requestId: "1", toolName: "Write", input: { file_path: "/private/tmp/project/a.txt" }, mode: "build", metadata: { name: "Write", description: "", readOnly: false, destructive: false, riskLevel: "medium", sideEffectScope: "process" } } as import("../store.js").PermissionUiRequest;
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
