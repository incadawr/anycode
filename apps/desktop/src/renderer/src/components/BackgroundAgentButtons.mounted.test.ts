// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BackgroundAgentButtons } from "./ToolCallCard.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("moves one or all running children using their call ids", async () => {
  const move = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(BackgroundAgentButtons, { ids: ["one", "two"], current: "one", move })));
    const buttons = container.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[0]!.click());
    await act(async () => buttons[1]!.click());
    expect(move.mock.calls).toEqual([[["one"]], [["one", "two"]]]);
    await act(async () => root.render(createElement(BackgroundAgentButtons, { ids: [], current: "one", move })));
    expect(container.querySelectorAll("button")).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
  }
});
