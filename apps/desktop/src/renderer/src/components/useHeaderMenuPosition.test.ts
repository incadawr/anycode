// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useHeaderMenuPosition } from "./useHeaderMenuPosition.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it("repositions an open menu on resize and removes the listener on close", async () => {
  let left = 750;
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ left, width: 300 } as DOMRect));
  const host = document.createElement("div"), root = createRoot(host);
  const Menu = ({ open }: { open: boolean }) => {
    const ref = useRef<HTMLDivElement>(null);
    useHeaderMenuPosition(open, ref);
    return createElement("div", null, createElement("div", { ref, style: { "--sp-4": "16px" } as React.CSSProperties }));
  };
  try {
    await act(async () => root.render(createElement(Menu, { open: true })));
    const menu = host.firstElementChild!.firstElementChild as HTMLDivElement;
    expect(menu.style.left).toBe("-42px");
    left = -20;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(menu.style.left).toBe("36px");
    await act(async () => root.render(createElement(Menu, { open: false })));
    expect(menu.style.left).toBe("");
    left = 750;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(menu.style.left).toBe("");
  } finally { await act(async () => root.unmount()); rect.mockRestore(); }
});
