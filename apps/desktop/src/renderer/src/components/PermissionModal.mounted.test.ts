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
