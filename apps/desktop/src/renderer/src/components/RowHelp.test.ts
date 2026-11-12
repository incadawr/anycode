// @vitest-environment jsdom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentMenuRow } from "./EnvironmentMenuRow.js";
import { RowHelp } from "./RowHelp.js";
import { mount } from "../ui/ui.test-utils.js";

const EXPLANATION = "Whoever holds the Sessions API token can allow or deny this session's tool requests.";

function helpButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(".row-help-button");
  if (!button) throw new Error("no help button");
  return button;
}

function tooltip(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[role="tooltip"]');
  if (!found) throw new Error("no tooltip");
  return found;
}

function hover(element: HTMLElement, enter: boolean): void {
  act(() => {
    element.dispatchEvent(new MouseEvent(enter ? "mouseover" : "mouseout", { bubbles: true }));
  });
}

describe("RowHelp", () => {
  it("focus shows the tooltip", () => {
    const { container } = mount(createElement(RowHelp, { text: EXPLANATION }));
    expect(tooltip(container).dataset.open).toBe("false");
    act(() => {
      helpButton(container).focus();
    });
    expect(tooltip(container).dataset.open).toBe("true");
  });

  it("the button points at the explanation with aria-describedby", () => {
    const { container } = mount(createElement(RowHelp, { text: EXPLANATION }));
    const button = helpButton(container);
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const target = document.getElementById(describedBy!);
    expect(target).not.toBeNull();
    expect(target!.getAttribute("role")).toBe("tooltip");
    expect(target!.textContent).toContain(EXPLANATION);
    expect(button.getAttribute("aria-label")).toBeTruthy();
  });

  it("Escape closes the tooltip only, not the menu around it", () => {
    const { container } = mount(createElement(RowHelp, { text: EXPLANATION }));
    const button = helpButton(container);
    act(() => {
      button.focus();
    });
    expect(tooltip(container).dataset.open).toBe("true");
    // The menu's own Escape handling is a window listener: it must not see it.
    const onEscape = vi.fn();
    window.addEventListener("keydown", onEscape);
    act(() => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    window.removeEventListener("keydown", onEscape);
    expect(onEscape).not.toHaveBeenCalled();
    expect(tooltip(container).dataset.open).toBe("false");
  });

  it("does not intercept Escape when hover is open and focus is elsewhere", () => {
    const onEscape = vi.fn();
    const { container } = mount(createElement("div", { onKeyDown: onEscape },
      createElement(RowHelp, { text: EXPLANATION }), createElement("button", null, "Other")));
    const other = container.querySelectorAll("button")[1]!;
    act(() => other.focus());
    hover(helpButton(container), true);
    act(() => other.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onEscape).toHaveBeenCalledTimes(1);
    act(() => helpButton(container).focus());
    act(() => helpButton(container).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(tooltip(container).dataset.open).toBe("false");
  });

  it("pointer hover shows the tooltip and leaving hides it", () => {
    const { container } = mount(createElement(RowHelp, { text: EXPLANATION }));
    hover(helpButton(container), true);
    expect(tooltip(container).dataset.open).toBe("true");
    hover(helpButton(container), false);
    expect(tooltip(container).dataset.open).toBe("false");
  });

  it("several rows get their own ids", () => {
    const { container } = mount(
      createElement(
        "div",
        null,
        createElement(RowHelp, { text: "first" }),
        createElement(RowHelp, { text: "second" }),
      ),
    );
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".row-help-button")];
    expect(buttons).toHaveLength(2);
    const ids = buttons.map((button) => button.getAttribute("aria-describedby"));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(document.getElementById(id!)).not.toBeNull();
    }
  });

  it("the tooltip holds nothing focusable, so it cannot trap the tab order", () => {
    const { container } = mount(createElement(RowHelp, { text: EXPLANATION }));
    expect(tooltip(container).querySelector("button, input, select, textarea, a[href], [tabindex]")).toBeNull();
  });
});

describe("EnvironmentMenuRow with a help slot", () => {
  it("shows the short detail and keeps the full explanation in the tooltip", () => {
    const { container } = mount(
      createElement(EnvironmentMenuRow, {
        icon: null,
        title: "External approvals on",
        detail: "Token holder can answer tool requests",
        help: EXPLANATION,
        ariaLabel: "External approvals",
      }),
    );
    expect(container.querySelector(".environment-menu-row-detail")?.textContent).toBe("Token holder can answer tool requests");
    expect(tooltip(container).textContent).toContain(EXPLANATION);
    const describedBy = helpButton(container).getAttribute("aria-describedby");
    expect(document.getElementById(describedBy!)?.textContent).toContain(EXPLANATION);
  });

  it("keeps an error line visible next to the help", () => {
    const { container } = mount(
      createElement(EnvironmentMenuRow, {
        icon: null,
        title: "Handle (optional)",
        detail: "Shown in the session list for agents",
        help: EXPLANATION,
        ariaLabel: "Session handle",
        error: "Another live session already uses this handle.",
      }),
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Another live session already uses this handle.");
    expect(container.querySelector(".environment-menu-row-error")?.textContent).toContain("Another live session already uses this handle.");
  });

  it("keeps the tooltip in the row's flow so it never covers the rows below, and caps its width by the row", () => {
    const css = readFileSync(resolve(import.meta.dirname, "..", "app.css"), "utf8");
    const rule = css.match(/\.row-help-tooltip \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("max-width: min(20rem, calc(100% - 2 * var(--sp-2)))");
    expect(rule).not.toContain("100vw");
    expect(rule).not.toContain("position: absolute");
    expect(rule).toContain("display: none");
    expect(css.match(/\.row-help-tooltip\[data-open="true"\] \{([^}]*)\}/)?.[1]).toContain("display: block");
  });
});
