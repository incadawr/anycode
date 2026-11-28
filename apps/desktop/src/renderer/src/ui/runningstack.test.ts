// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { RunningStack, type RunningStackItem, type RunningStackProps } from "./index.js";
import { createElement as h, mount } from "./ui.test-utils.js";

const item = (id: string, over: Partial<RunningStackItem> = {}): RunningStackItem => ({
  key: id, icon: h("svg", { "data-glyph": id }), typeLabel: "Bash", title: `run ${id}`, meta: "1m 1s", activatable: true, ...over,
});
const five = () => ["a", "b", "c", "d", "e"].map(id => item(id));

/** The stack with its fold flag held by a small stateful parent, like a real consumer. */
function Stack(props: Omit<RunningStackProps, "collapsed" | "onCollapsedChange"> & { startCollapsed?: boolean }): ReactElement {
  const [collapsed, setCollapsed] = useState(props.startCollapsed === true);
  return h(RunningStack, { ...props, collapsed, onCollapsedChange: setCollapsed });
}
const stack = (props: Omit<RunningStackProps, "collapsed" | "onCollapsedChange"> & { startCollapsed?: boolean }) => h(Stack, props);

const region = () => document.querySelector<HTMLElement>('[role="region"]');
const rowButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".ak-runningstack__row")];
const labels = () => rowButtons().map(b => b.getAttribute("aria-label"));
const textOf = (text: string) => [...document.querySelectorAll<HTMLElement>("button, span")].find(el => el.textContent?.trim() === text);
const over = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body })); });
const out = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })); });
const leave = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false, relatedTarget: document.body })); });
const focus = (el: HTMLElement) => act(() => el.focus());
const keyDown = (target: Element, key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  act(() => { target.dispatchEvent(event); });
  return event;
};
const outside = () => {
  const b = document.createElement("button");
  document.body.append(b);
  return b;
};

describe("RunningStack", () => {
  it("renders nothing for an empty list", () => {
    mount(stack({ items: [] }));
    expect(region()).toBeNull();
  });

  it("is a labelled region that can take programmatic focus, without aria-live", () => {
    mount(stack({ items: [item("a")] }));
    expect(region()!.getAttribute("aria-label")).toBe("Running");
    expect(region()!.tabIndex).toBe(-1);
    expect(document.querySelector("[aria-live]")).toBeNull();
  });

  it("names each row from its parts, and says when it cannot be activated", () => {
    mount(stack({ items: [item("a"), item("b", { activatable: false })] }));
    expect(labels()).toEqual(["Bash: run a, running, jump to its card", "Bash: run b, running"]);
    expect(rowButtons()[1]!.getAttribute("aria-disabled")).toBe("true");
    expect(rowButtons()[0]!.hasAttribute("aria-disabled")).toBe(false);
  });

  it("takes every string from labels, falling back to the English defaults", () => {
    mount(stack({ items: [item("a")], labels: { region: "Läuft", state: "läuft", activateHint: "springen", fold: "Aus", foldName: "Ausblenden" } }));
    expect(region()!.getAttribute("aria-label")).toBe("Läuft");
    expect(labels()).toEqual(["Bash: run a, läuft, springen"]);
    expect(document.querySelector(".ak-runningstack__fold")!.getAttribute("aria-label")).toBe("Ausblenden");
    expect(textOf("Aus")).toBeDefined();
  });

  it("shows three rows and a +N chip when closed, and every row once open", () => {
    mount(stack({ items: five() }));
    expect(rowButtons()).toHaveLength(3);
    expect(textOf("+2 running")).toBeDefined();
    over(rowButtons()[0]!);
    expect(rowButtons()).toHaveLength(5);
    expect(textOf("+2 running")).toBeUndefined();
  });

  it("respects maxVisible", () => {
    mount(stack({ items: five(), maxVisible: 1 }));
    expect(rowButtons()).toHaveLength(1);
    expect(textOf("+4 running")).toBeDefined();
  });

  it("shows the meta, the cue of an activatable row and the type pill", () => {
    mount(stack({ items: [item("a"), item("b", { activatable: false, meta: undefined })] }));
    const [a, b] = rowButtons();
    expect(a!.querySelector(".ak-runningstack__meta")!.textContent).toBe("1m 1s");
    expect(a!.querySelector(".ak-runningstack__cue")!.textContent).toBe("↑ jump");
    expect(a!.querySelector(".ak-runningstack__type")!.textContent).toBe("Bash");
    expect(b!.querySelector(".ak-runningstack__meta")).toBeNull();
    expect(b!.querySelector(".ak-runningstack__cue")).toBeNull();
  });

  it("describes a row by its detail line only when it has one", () => {
    mount(stack({ items: [item("a", { detail: "turn 3 · 12 tools" }), item("b")] }));
    const [a, b] = rowButtons();
    const id = a!.getAttribute("aria-describedby")!;
    expect(document.getElementById(id)!.textContent).toBe("turn 3 · 12 tools");
    expect(b!.hasAttribute("aria-describedby")).toBe(false);
  });

  it("folds into one count chip and reopens on click", () => {
    mount(stack({ items: five() }));
    act(() => textOf("Hide")!.click());
    expect(rowButtons()).toHaveLength(0);
    const chip = document.querySelector<HTMLButtonElement>(".ak-runningstack__chip")!;
    expect(chip.textContent).toBe("5 running");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    act(() => chip.click());
    expect(rowButtons()).toHaveLength(3);
  });

  it("opens on focus within, and mounts every row", () => {
    mount(stack({ items: five() }));
    expect(region()!.hasAttribute("data-open")).toBe(false);
    focus(rowButtons()[0]!);
    expect(region()!.hasAttribute("data-open")).toBe(true);
    expect(rowButtons()).toHaveLength(5);
  });

  it("does not open when the fold control takes focus", () => {
    mount(stack({ items: five() }));
    focus(document.querySelector<HTMLButtonElement>(".ak-runningstack__fold")!);
    expect(region()!.hasAttribute("data-open")).toBe(false);
  });

  it("closes on Escape, consumes it, and stays closed until focus leaves", () => {
    mount(stack({ items: five() }));
    const first = rowButtons()[0]!;
    focus(first);
    const event = keyDown(first, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(region()!.hasAttribute("data-open")).toBe(false);
    focus(outside());
    focus(rowButtons()[0]!);
    expect(region()!.hasAttribute("data-open")).toBe(true);
  });

  it("closes on Escape when only the pointer has it open and focus is elsewhere, and consumes the key", () => {
    mount(stack({ items: five() }));
    const elsewhere = outside();
    focus(elsewhere);
    over(rowButtons()[0]!);
    expect(region()!.hasAttribute("data-open")).toBe(true);
    const event = keyDown(elsewhere, "Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(region()!.hasAttribute("data-open")).toBe(false);
  });

  it("leaves Escape alone when the pointer is not on the stack, and stops listening once it leaves", () => {
    mount(stack({ items: five() }));
    const elsewhere = outside();
    focus(elsewhere);
    expect(keyDown(elsewhere, "Escape").defaultPrevented).toBe(false);
    const first = rowButtons()[0]!;
    over(first);
    out(first);
    leave(region()!);
    expect(region()!.hasAttribute("data-open")).toBe(false);
    expect(keyDown(elsewhere, "Escape").defaultPrevented).toBe(false);
  });

  it("leaves Escape to an open dialog or menu even while the pointer rests on the stack", () => {
    mount(stack({ items: five() }));
    over(rowButtons()[0]!);
    expect(region()!.hasAttribute("data-open")).toBe(true);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    expect(keyDown(menu, "Escape").defaultPrevented).toBe(false);
    expect(region()!.hasAttribute("data-open")).toBe(true);
    menu.remove();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    expect(keyDown(document.body, "Escape").defaultPrevented).toBe(false);
    expect(region()!.hasAttribute("data-open")).toBe(true);
  });

  it("does not consume Escape while closed, so a global Escape handler still sees it", () => {
    mount(stack({ items: five() }));
    expect(keyDown(rowButtons()[0]!, "Escape").defaultPrevented).toBe(false);
  });

  it("activates an activatable row on click, and does nothing for one that cannot", () => {
    const onActivate = vi.fn();
    mount(stack({ items: [item("a"), item("b", { activatable: false })], onActivate }));
    const [a, b] = rowButtons();
    act(() => a!.click());
    expect(onActivate).toHaveBeenCalledWith("a", expect.objectContaining({ key: "a" }));
    act(() => b!.click());
    expect(onActivate).toHaveBeenCalledTimes(1);
    // A native button turns Enter and Space into a click; jsdom does not, so the same path is exercised through click().
    expect(a!.tagName).toBe("BUTTON");
    expect((a as HTMLButtonElement).type).toBe("button");
  });

  it("does not let a mouse press focus a row that cannot be activated, so it cannot pin the stack open", () => {
    mount(stack({ items: [item("a"), item("b", { activatable: false })] }));
    const [a, b] = rowButtons();
    const press = (el: Element) => {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      act(() => { el.dispatchEvent(event); });
      return event;
    };
    expect(press(b!).defaultPrevented).toBe(true);
    expect(press(a!).defaultPrevented).toBe(false);
  });

  it("closes after a row is activated, so a frozen list does not keep a row whose card is now in view", () => {
    const onActivate = vi.fn();
    mount(stack({ items: five(), onActivate }));
    const first = rowButtons()[0]!;
    over(first);
    expect(region()!.hasAttribute("data-open")).toBe(true);
    act(() => first.click());
    expect(onActivate).toHaveBeenCalledWith("a", expect.objectContaining({ key: "a" }));
    expect(region()!.hasAttribute("data-open")).toBe(false);
  });

  it("freezes the rows while the pointer is on the stack and applies changes when it leaves", () => {
    const rows = [item("a"), item("b"), item("c")];
    const view = mount(stack({ items: rows }));
    const first = rowButtons()[0]!;
    over(first);
    view.render(stack({ items: rows.slice(0, 2) }));
    expect(labels().some(l => l?.includes("run c"))).toBe(true);
    leave(region()!);
    out(first);
    expect(labels().some(l => l?.includes("run c"))).toBe(false);
  });

  it("follows the live rows under keyboard focus alone, and does not bring a finished row back when the pointer arrives", () => {
    const rows = [item("a"), item("b"), item("c")];
    const view = mount(stack({ items: rows }));
    focus(rowButtons()[0]!);
    view.render(stack({ items: rows.slice(0, 2) }));
    expect(labels().some(l => l?.includes("run c"))).toBe(false);
    over(rowButtons()[0]!);
    expect(labels().some(l => l?.includes("run c"))).toBe(false);
  });

  it("shows a row added while keyboard focus holds the stack open", () => {
    const rows = [item("a"), item("b")];
    const view = mount(stack({ items: rows }));
    focus(rowButtons()[0]!);
    view.render(stack({ items: [...rows, item("c")] }));
    expect(labels().some(l => l?.includes("run c"))).toBe(true);
  });

  it("moves focus from an unmounting row to the next row, never to body", () => {
    const rows = [item("a"), item("b"), item("c")];
    const view = mount(stack({ items: rows }));
    focus(rowButtons()[1]!);
    view.render(stack({ items: [rows[0]!, rows[2]!] }));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Bash: run c, running, jump to its card");
  });

  it("moves focus to the fold control when the last row unmounts", () => {
    const rows = [item("a"), item("b")];
    const view = mount(stack({ items: rows }));
    focus(rowButtons()[1]!);
    view.render(stack({ items: [rows[0]!] }));
    expect(document.activeElement).not.toBe(document.body);
    view.render(stack({ items: [] }));
    expect(region()).toBeNull();
  });

  it("hands focus to the focusable ancestor when the whole stack unmounts", () => {
    const withParent = (items: RunningStackItem[]) => h("div", { tabIndex: -1, "data-parent": "" }, items.length === 0 ? null : stack({ items }));
    const view = mount(withParent([item("a")]));
    focus(rowButtons()[0]!);
    expect(document.activeElement?.closest("[data-parent]")).not.toBeNull();
    view.render(withParent([]));
    expect(document.activeElement).toBe(document.querySelector("[data-parent]"));
  });

  it("shows only the count chip in chip-only mode, which activates the first row", () => {
    const onActivate = vi.fn();
    mount(stack({ items: five(), chipOnly: true, onActivate }));
    expect(region()!.hasAttribute("data-chip-only")).toBe(true);
    const chip = document.querySelector<HTMLButtonElement>(".ak-runningstack__chip-only")!;
    expect(chip.getAttribute("aria-label")).toBe("5 running: run a, jump to its card");
    act(() => chip.click());
    expect(onActivate).toHaveBeenCalledWith("a", expect.objectContaining({ key: "a" }));
  });

  it("marks the chip-only chip as disabled when the first row cannot be activated", () => {
    const onActivate = vi.fn();
    mount(stack({ items: [item("a", { activatable: false }), item("b")], chipOnly: true, onActivate }));
    const chip = document.querySelector<HTMLButtonElement>(".ak-runningstack__chip-only")!;
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.getAttribute("aria-label")).toBe("2 running: run a");
    act(() => chip.click());
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("only rows open the stack: the foot never opens or moves it", () => {
    mount(stack({ items: five() }));
    const hide = document.querySelector<HTMLButtonElement>(".ak-runningstack__fold")!;
    over(hide);
    expect(region()!.hasAttribute("data-open")).toBe(false);
    over(rowButtons()[0]!);
    expect(region()!.hasAttribute("data-open")).toBe(true);
  });

  it("keeps decorative glyphs out of the accessibility tree", () => {
    mount(stack({ items: [item("a")] }));
    const glyphs = [...document.querySelectorAll(".ak-runningstack__glyph")];
    expect(glyphs.length).toBeGreaterThanOrEqual(2);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute("aria-hidden") === "true" || glyph.closest("[aria-hidden='true']") !== null).toBe(true);
    }
  });

  it("hands onActivate the item as the stack shows it, so a row that left `items` under the pointer still carries its own target", () => {
    const onActivate = vi.fn();
    const rows = [item("a", { target: "block-a" }), item("b", { target: "block-b" })];
    const { render } = mount(stack({ items: rows, onActivate }));
    over(rowButtons()[1]!);
    // b's work ended: the caller dropped it, but the pointer holds the list frozen and it can still be pressed.
    render(stack({ items: [rows[0]!], onActivate }));
    expect(labels()).toHaveLength(2);
    act(() => rowButtons()[1]!.click());
    expect(onActivate).toHaveBeenCalledWith("b", expect.objectContaining({ key: "b", target: "block-b" }));
  });

  it("leaves focus on the fold control when Escape comes from the foot, not from a row", () => {
    mount(stack({ items: five() }));
    over(rowButtons()[0]!);
    const fold = document.querySelector<HTMLButtonElement>(".ak-runningstack__fold")!;
    focus(fold);
    keyDown(fold, "Escape");
    expect(region()!.hasAttribute("data-open")).toBe(false);
    expect(document.activeElement).toBe(fold);
  });

});
