// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("selects a history task for rename without resuming it", async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { fn(0); return 1; });
  (window as unknown as { anycode: unknown }).anycode = { listSessions: async () => [{ id: "s", workspace: "/w", title: "Base", userTitle: "Custom", model: "m", mode: "build", createdAt: 0, updatedAt: 0 }] };
  const rename = vi.fn(); const resume = vi.fn(); const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(CommandPalette, { mode: "rename", actions: [], tabs: [], platform: "darwin", onSwitchMode: () => {}, onSelectTab: () => {}, onResumeSession: resume, onRenameTask: rename, onClose: () => {} })));
    expect(container.textContent).toContain("Custom");
    await act(async () => container.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(rename).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s", baseTitle: "Base", userTitle: "Custom" })); expect(resume).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
