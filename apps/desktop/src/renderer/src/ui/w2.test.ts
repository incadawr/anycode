// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { Badge, Button, Drawer, Menu, MenuItem, MenuSeparator, Modal, Toast, ToastStack } from "./index.js";
import { byRole, click, createElement as h, key, mount } from "./ui.test-utils.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const noop = () => {};
// jsdom replaces the global URL class, so resolve the sheet path without it.
const css = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui.css"), "utf8");

/* ── Family 5: Dialog (Modal) + Drawer ───────────────────────────────────── */

it("Modal exposes header/body/footer slots with a labelled title and described subtitle", () => {
  const { container } = mount(h(Modal, {
    open: true, onClose: noop, title: "Confirm run", subtitle: "Files will change",
    headerExtra: h(Badge, { status: "warn", label: "review" }),
    footer: h(Button, null, "Run"),
  }, "Body text"));
  const dialog = byRole(container, "dialog", "Confirm run");
  const headingId = dialog.getAttribute("aria-labelledby")!;
  expect(headingId).not.toMatch(/\s/);
  expect(document.getElementById(headingId)?.textContent).toBe("Confirm run");
  expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("Files will change");
  expect(container.querySelector(".ak-modal__head")?.textContent).toContain("review");
  expect(container.querySelector(".ak-modal__body")?.textContent).toBe("Body text");
  expect(container.querySelector(".ak-modal__foot")?.textContent).toBe("Run");
});

it("Modal sizes map to token-driven widths and keep wide as the lg alias", () => {
  const { container, render } = mount(h(Modal, { open: true, onClose: noop, title: "T", size: "sm" }));
  expect(container.querySelector("dialog")!.classList.contains("ak-modal--sm")).toBe(true);
  render(h(Modal, { open: true, onClose: noop, title: "T", size: "md" }));
  expect(container.querySelector("dialog")!.classList.contains("ak-modal--md")).toBe(true);
  render(h(Modal, { open: true, onClose: noop, title: "T", size: "lg" }));
  expect(container.querySelector("dialog")!.classList.contains("ak-modal--lg")).toBe(true);
  render(h(Modal, { open: true, onClose: noop, title: "T", wide: true }));
  expect(container.querySelector("dialog")!.classList.contains("ak-modal--wide")).toBe(true);
});

it("Modal traps focus, closes on Escape once and restores focus to the trigger", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const onClose = vi.fn();
  const { container, render } = mount(h(Modal, { open: true, onClose, title: "Confirm" },
    h(Button, null, "First"), h(Button, null, "Last")));
  expect(document.activeElement).toBe(byRole(container, "button", "First"));
  const last = byRole(container, "button", "Last");
  last.focus();
  key("Tab");
  expect(document.activeElement).toBe(byRole(container, "button", "Close"));
  key("Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
  render(h(Modal, { open: false, onClose, title: "Confirm" }));
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it("Drawer labels the panel, traps focus and restores the trigger", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const onClose = vi.fn();
  const { container, render } = mount(h(Drawer, {
    open: true, onClose, title: "Connection", subtitle: "Provider",
    footer: h(Button, null, "Done"),
  }, h(Button, null, "Field")));
  const dialog = byRole(container, "dialog", "Connection");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("Connection");
  expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe("Provider");
  expect(container.querySelector(".ak-drawer__body")?.textContent).toBe("Field");
  expect(container.querySelector(".ak-drawer__footer")?.textContent).toBe("Done");
  key("Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
  render(h(Drawer, { open: false, onClose, title: "Connection" }));
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it("Drawer supports header extra content and the lg size", () => {
  const { container } = mount(h(Drawer, {
    open: true, onClose: noop, title: "Connection", size: "lg",
    headerExtra: h(Badge, { status: "ok", label: "live" }),
  }));
  expect(container.querySelector(".ak-drawer")!.classList.contains("ak-drawer--lg")).toBe(true);
  expect(container.querySelector(".ak-drawer__header")?.textContent).toContain("live");
});

it("overlay scrims and the modal backdrop use the --bg-scrim token", () => {
  const sheet = css();
  expect(sheet).toMatch(/\.ak-drawer__scrim\s*\{[^}]*background:\s*var\(--bg-scrim\)/s);
  expect(sheet).toMatch(/\.ak-modal::backdrop\s*\{[^}]*background:\s*var\(--bg-scrim\)/s);
  expect(sheet).not.toMatch(/rgba?\(/);
});

it("overlay bodies scroll while headers and footers stay fixed", () => {
  const sheet = css();
  expect(sheet).toMatch(/\.ak-modal__body\s*\{[^}]*overflow:\s*auto/s);
  expect(sheet).toMatch(/\.ak-drawer__body\s*\{[^}]*overflow:\s*auto/s);
  expect(sheet).toMatch(/\.ak-drawer__header\s*\{[^}]*position:\s*sticky/s);
});

/* ── Family 6: Menu / Popover ────────────────────────────────────────────── */

it("Menu trigger advertises the menu, toggles it and returns focus on close", () => {
  const { container } = mount(h(Menu, { label: "Actions", heading: "Access" },
    h(MenuItem, { label: "plan" }), h(MenuItem, { label: "build" })));
  const trigger = byRole(container, "button", "Actions");
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(byRole(container, "menu", "Access")).toBeTruthy();
  key("Escape");
  expect(container.querySelector("[role=menu]")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("Menu opens on ArrowDown and navigates items with the keyboard", () => {
  const { container } = mount(h(Menu, { label: "Actions" },
    h(MenuItem, { label: "plan" }), h(MenuItem, { label: "build" }), h(MenuItem, { label: "yolo", disabled: true })));
  const trigger = byRole(container, "button", "Actions");
  trigger.focus();
  key("ArrowDown", trigger);
  expect(byRole(container, "menu")).toBeTruthy();
  expect(document.activeElement).toBe(byRole(container, "menuitem", "plan"));
  key("ArrowDown");
  expect(document.activeElement).toBe(byRole(container, "menuitem", "build"));
  key("End");
  expect(document.activeElement).toBe(byRole(container, "menuitem", "build"));
  key("Home");
  expect(document.activeElement).toBe(byRole(container, "menuitem", "plan"));
});

it("Menu trigger can be disabled and a controlled Menu reports open changes", () => {
  const onOpenChange = vi.fn();
  const { container } = mount(h(Menu, { label: "Actions", disabled: true, onOpenChange },
    h(MenuItem, { label: "plan" })));
  const trigger = byRole(container, "button", "Actions");
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
  click(trigger);
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(container.querySelector("[role=menu]")).toBeNull();
});

it("Menu keeps the checked role and marks the current item", () => {
  const { container } = mount(h(Menu, { label: "Actions" },
    h(MenuItem, { label: "build", checkable: true, selected: true }),
    h(MenuItem, { label: "plan", active: true }),
    h(MenuSeparator)));
  const trigger = byRole(container, "button", "Actions");
  click(trigger);
  expect(byRole(container, "menuitemcheckbox", "build").getAttribute("aria-checked")).toBe("true");
  expect(byRole(container, "menuitem", "plan").getAttribute("aria-current")).toBe("true");
  expect(container.querySelector('[role="separator"]')).toBeTruthy();
});

it("Menu clamps to the viewport edge when opened near the right border", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: innerWidth - 20, right: innerWidth - 20, top: 10, bottom: 30, width: 100, height: 20,
  } as DOMRect);
  const { container } = mount(h(Menu, { label: "Actions" }, h(MenuItem, { label: "plan" })));
  click(byRole(container, "button", "Actions"));
  const menu = byRole(container, "menu");
  expect(parseFloat(menu.style.left)).toBeLessThanOrEqual(innerWidth - 8);
  expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
});

/* ── Family 7: Toast / Notice ────────────────────────────────────────────── */

it("Toast maps tones to status and alert live regions", () => {
  const { container } = mount(h("div", null,
    h(Toast, { status: "info", message: "Update" }),
    h(Toast, { status: "success", message: "Saved" }),
    h(Toast, { status: "warning", message: "Key expired" }),
    h(Toast, { status: "error", message: "Boom" })));
  const regions = [...container.querySelectorAll('[role="status"],[role="alert"]')];
  expect(regions.map(el => el.getAttribute("role"))).toEqual(["status", "status", "status", "alert"]);
  const alert = regions[3]!;
  expect(alert.getAttribute("aria-live")).toBe("assertive");
  expect(regions[0]!.getAttribute("aria-live")).toBe("polite");
});

it("Toast auto-hides on its timer and cancels it without leaking", () => {
  vi.useFakeTimers();
  const onAutoHide = vi.fn();
  const { unmount } = mount(h(Toast, { status: "info", message: "Update", duration: 4000, onAutoHide }));
  expect(onAutoHide).not.toHaveBeenCalled();
  vi.advanceTimersByTime(3999);
  expect(onAutoHide).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(onAutoHide).toHaveBeenCalledTimes(1);
  unmount();
  vi.advanceTimersByTime(10000);
  expect(onAutoHide).toHaveBeenCalledTimes(1);
});

it("Toast timer is cleared on unmount so no callback survives the component", () => {
  vi.useFakeTimers();
  const onAutoHide = vi.fn();
  const { unmount } = mount(h(Toast, { status: "info", message: "Update", duration: 1000, onAutoHide }));
  unmount();
  vi.advanceTimersByTime(5000);
  expect(onAutoHide).not.toHaveBeenCalled();
});

it("Toast without a duration never auto-hides and keeps the dismiss action", () => {
  vi.useFakeTimers();
  const onAutoHide = vi.fn();
  const onDismiss = vi.fn();
  const { container } = mount(h(Toast, { status: "ok", message: "Saved", onAutoHide, onDismiss }));
  vi.advanceTimersByTime(60000);
  expect(onAutoHide).not.toHaveBeenCalled();
  click(byRole(container, "button", "Dismiss"));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it("ToastStack can name its region for screen readers", () => {
  const { container } = mount(h(ToastStack, { label: "Notifications" },
    h(Toast, { status: "ok", message: "Saved" })));
  const region = container.querySelector('[role="region"]')!;
  expect(region.getAttribute("aria-label")).toBe("Notifications");
  expect(region.textContent).toBe("Saved");
});

it("Menu selection closes an uncontrolled menu", () => {
  const select = vi.fn();
  const { container } = mount(h(Menu, { label: "Actions" }, h(MenuItem, { label: "Choose", onSelect: select })));
  click(byRole(container, "button", "Actions"));
  click(byRole(container, "menuitem", "Choose"));
  expect(select).toHaveBeenCalledOnce();
  expect(container.querySelector("[role=menu]")).toBeNull();
});

it("positions a controlled menu when its parent opens it", () => {
  const { container, render } = mount(h(Menu, { label: "Actions", open: false }, h(MenuItem, { label: "Choose" })));
  const trigger = byRole(container, "button", "Actions");
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ left: 125, bottom: 85 } as DOMRect);
  render(h(Menu, { label: "Actions", open: true }, h(MenuItem, { label: "Choose" })));
  const menu = byRole(container, "menu");
  expect(menu.style.left).toBe("125px");
  expect(menu.style.top).toBe("89px");
});

it("keeps the toast deadline when the callback changes", () => {
  vi.useFakeTimers();
  const first = vi.fn(), latest = vi.fn();
  const { render } = mount(h(Toast, { status: "info", message: "Update", duration: 1000, onAutoHide: first }));
  vi.advanceTimersByTime(600);
  render(h(Toast, { status: "info", message: "Update", duration: 1000, onAutoHide: latest }));
  vi.advanceTimersByTime(400);
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
});
