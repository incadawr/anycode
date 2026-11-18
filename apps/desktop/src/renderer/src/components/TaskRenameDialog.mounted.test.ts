// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TaskRenameDialog } from "./TaskRenameDialog.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("selects the name, retains it after failure, and resets on request", async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  const save = vi.fn(async () => false); const cancel = vi.fn();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TaskRenameDialog, { row: { kind: "resumable", key: "s", sessionId: "s", title: "Custom", baseTitle: "Base", userTitle: "Custom", age: "1d" }, onSave: save, onCancel: cancel })));
    const input = container.querySelector("input")!;
    expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(6);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledWith("Custom"); expect(input.value).toBe("Custom"); expect(container.querySelector('[role="alert"]')).not.toBeNull();
    const reset = Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Reset to automatic title")!;
    await act(async () => reset.click()); expect(save).toHaveBeenLastCalledWith("");
    await act(async () => container.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(cancel).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
