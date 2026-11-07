import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach } from "vitest";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
export { createElement };
export function mount(element: ReactElement) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  let unmounted = false;
  const unmount = () => { if (!unmounted) { act(() => root.unmount()); container.remove(); unmounted = true; } };
  cleanups.push(unmount);
  return { container, unmount, render: (next: ReactElement) => act(() => root.render(next)) };
}
export const click = (element: HTMLElement) => act(() => element.click());
export const key = (value: string, target: Element | null = document.activeElement, shiftKey = false) =>
  act(() => { target?.dispatchEvent(new KeyboardEvent("keydown", {key:value, shiftKey, bubbles:true, cancelable:true})); });
/** Text of an element, excluding content hidden from the screen reader (aria-hidden). */
function visibleText(el: Element | null): string {
  if (!el) return "";
  const clone = el.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll("[aria-hidden=\"true\"]")) hidden.remove();
  return clone.textContent ?? "";
}
export function accessibleName(el: Element): string {
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) return labelledby.split(/\s+/).map(id => visibleText(document.getElementById(id))).join(" ").trim();
  if (el.hasAttribute("aria-label")) return el.getAttribute("aria-label")!;
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
    return [...(el.labels ?? [])].map(label => visibleText(label)).join(" ").trim();
  return visibleText(el).trim();
}
export function byRole(root: ParentNode, role: string, name?: string | RegExp): HTMLElement {
  const implicit: Record<string, string> = { button: "button", dialog: "dialog", textbox: 'input:not([type]),input[type=text],textarea', searchbox:'input[type=search]', combobox:'select', img:'svg[role=img]', checkbox:'input[type=checkbox]', radio:'input[type=radio]', switch:'button[role=switch]' };
  const elements = [...root.querySelectorAll<HTMLElement>(`[role="${role}"]${implicit[role] ? ','+implicit[role] : ''}`)]
    .filter(el => !el.hasAttribute("role") || el.getAttribute("role") === role);
  const found = elements.find(el => name === undefined || (typeof name === "string" ? accessibleName(el) === name : name.test(accessibleName(el))));
  if (!found) throw new Error(`Missing role ${role} named ${String(name)}`);
  return found;
}
