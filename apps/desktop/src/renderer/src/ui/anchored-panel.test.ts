// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, createRef } from "react";
import { AnchoredPanel } from "./index.js";
import { accessibleName, byRole, click, createElement as h, key, mount } from "./ui.test-utils.js";

const noop = () => undefined;
function setup(props: Record<string, unknown> = {}) {
  const button = document.createElement("button"); button.textContent = "Trigger"; document.body.append(button); button.focus();
  const anchorRef = { current: button };
  const onClose = vi.fn();
  const view = mount(h(AnchoredPanel, { open: true, onClose, anchorRef, title: "Details", children: h("p", null, "Body"), ...props }));
  // The panel is portaled to <body>, so lookups go through the document.
  return { ...view, container: document.body, button, onClose, anchorRef };
}

it("AnchoredPanel: dialog named by its title, not modal, not a menu", () => {
  const { container, button } = setup();
  const dialog = byRole(container, "dialog", "Details");
  expect(dialog.getAttribute("aria-modal")).toBeNull();
  expect(container.querySelector("[role=menu]")).toBeNull();
  expect(accessibleName(dialog)).toBe("Details");
  button.remove();
});
it("AnchoredPanel: renders nothing when closed", () => {
  const { container, button } = setup({ open: false });
  expect(container.querySelector("[role=dialog]")).toBeNull();
  button.remove();
});
it("AnchoredPanel: Escape and the close button close it", () => {
  const { container, onClose, button } = setup();
  key("Escape"); expect(onClose).toHaveBeenCalledTimes(1);
  click(byRole(container, "button", "Close")); expect(onClose).toHaveBeenCalledTimes(2);
  button.remove();
});
it("AnchoredPanel: outside click closes, anchor and inside clicks do not", () => {
  const { container, onClose, button } = setup();
  button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  byRole(container, "dialog").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  expect(onClose).not.toHaveBeenCalled();
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  expect(onClose).toHaveBeenCalledOnce();
  button.remove();
});
it("AnchoredPanel: focus moves in and returns to the trigger", () => {
  const { container, button, unmount } = setup();
  expect(container.querySelector("[role=dialog]")!.contains(document.activeElement)).toBe(true);
  unmount();
  expect(document.activeElement).toBe(button);
  button.remove();
});
it("AnchoredPanel: header actions render before Close; body is scrollable region", () => {
  const { container, button } = setup({ headerActions: h("span", { "data-testid": "act" }, "act") });
  const header = container.querySelector(".ak-anchored__header")!;
  expect(header.children[1]?.textContent).toBe("act");
  expect(header.lastElementChild?.getAttribute("aria-label")).toBe("Close");
  expect(container.querySelector(".ak-anchored__body")).not.toBeNull();
  button.remove();
});
it("AnchoredPanel: placement flips above and clamps to the viewport", () => {
  const button = document.createElement("button"); document.body.append(button);
  const rect = (o: Partial<DOMRect>) => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: noop, ...o }) as DOMRect;
  button.getBoundingClientRect = () => rect({ left: 900, right: 1000, top: 700, bottom: 720, width: 100, height: 20 });
  const proto = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () { return this.classList?.contains("ak-anchored") ? rect({ width: 300, height: 200 }) : proto.call(this); };
  Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, configurable: true });
  try {
    const anchorRef = createRef<HTMLElement>() as { current: HTMLElement | null }; anchorRef.current = button;
    mount(h(AnchoredPanel, { open: true, onClose: noop, anchorRef, title: "T", align: "start" }));
    const container = document.body;
    const el = container.querySelector<HTMLElement>(".ak-anchored")!;
    expect(el.dataset.side).toBe("top");
    expect(parseFloat(el.style.left)).toBe(1024 - 300 - 8);
    expect(parseFloat(el.style.top)).toBe(700 - 6 - 200);
    act(() => { /* flush */ });
  } finally { HTMLElement.prototype.getBoundingClientRect = proto; button.remove(); }
});
it("AnchoredPanel: portaled to body so a containing-block ancestor cannot offset it", () => {
  const button = document.createElement("button"); document.body.append(button);
  const view = mount(h("div", { style: { containerType: "inline-size" } }, h(AnchoredPanel, { open: true, onClose: noop, anchorRef: { current: button }, title: "T" })));
  const panel = document.body.querySelector(".ak-anchored")!;
  expect(panel.parentElement).toBe(document.body);
  expect(view.container.contains(panel)).toBe(false);
  button.remove();
});
it("AnchoredPanel: mousedown inside the portaled panel does not close it", () => {
  const { onClose, button } = setup({ children: h("p", { id: "inner" }, "Body") });
  document.body.querySelector("#inner")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  document.body.querySelector(".ak-anchored__header")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  expect(onClose).not.toHaveBeenCalled();
  button.remove();
});
