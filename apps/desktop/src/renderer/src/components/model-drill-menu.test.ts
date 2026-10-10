/**
 * Taskana 4237 — the shared model popover's empty-root "Add connection"
 * affordance. Same jsdom-free discipline as ConfirmDialog.test.ts: the
 * component is presentational (no hooks), so `renderToStaticMarkup` renders its
 * HTML under this package's plain "node" vitest environment, and calling it
 * directly returns its element tree so the button's real `onClick`, `onKeyDown`
 * and `ref` props can be invoked — no DOM needed.
 */
import { describe, expect, it, vi } from "vitest";
import { Fragment, createElement, type MutableRefObject, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelDrillRow } from "./model-drill-rows.js";
import { ModelDrillMenu, type ModelDrillMenuProps } from "./model-drill-menu.js";

function baseProps(overrides: Partial<ModelDrillMenuProps> = {}): ModelDrillMenuProps {
  return {
    rows: [],
    page: { kind: "root" },
    placement: null,
    backLabel: null,
    focusIndex: 0,
    emptyText: "No connected providers yet.",
    itemRefs: { current: [] } as MutableRefObject<(HTMLButtonElement | null)[]>,
    onKeyDown: () => {},
    onActivateRow: () => {},
    onBack: () => {},
    onAddConnection: () => {},
    isCurrentConnection: () => false,
    ...overrides,
  };
}

const GROUP_ROW: ModelDrillRow = {
  kind: "group",
  connectionId: "conn-a",
  label: "Connection A",
  subtitle: undefined,
  count: 2,
};

/** Flatten an element subtree's text content, tolerating the `false`/`null` slots a `&&` renders. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

/** Find the first <button> whose flattened text contains `needle`. */
type ButtonProps = {
  children?: ReactNode;
  onClick?: () => void;
  onKeyDown?: (event: unknown) => void;
  ref?: unknown;
  disabled?: boolean;
};

function findButton(node: ReactNode, needle: string): ReactElement<ButtonProps> | undefined {
  if (node === null || node === undefined || typeof node === "boolean") {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, needle);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof node === "string" || typeof node === "number") {
    return undefined;
  }
  const element = node as ReactElement<ButtonProps>;
  if (element.type === "button" && textOf(element.props.children).includes(needle)) {
    return element;
  }
  // Fragment and host/element wrappers both carry their children on props.
  const recurseInto = element.type === Fragment || typeof element.type === "string" ? element.props.children : undefined;
  return recurseInto === undefined ? undefined : findButton(recurseInto as ReactNode, needle);
}

describe("ModelDrillMenu — empty-root 'Add connection' (Taskana 4237)", () => {
  it("renders the empty text AND an enabled 'Add connection' menuitem button on an empty root", () => {
    const html = renderToStaticMarkup(createElement(ModelDrillMenu, baseProps()));
    expect(html).toContain("No connected providers yet.");
    expect(html).toContain("Add connection");
    expect(html).toContain('class="start-model-item"');
    expect(html).toContain('role="menuitem"');
    expect(html).not.toContain("disabled");
  });

  it("wires the button's click to onAddConnection", () => {
    const onAddConnection = vi.fn();
    const tree = ModelDrillMenu(baseProps({ onAddConnection }));
    const button = findButton(tree, "Add connection");
    expect(button).toBeDefined();
    button!.props.onClick?.();
    expect(onAddConnection).toHaveBeenCalledTimes(1);
  });

  it("does NOT render it alongside populated rows", () => {
    const html = renderToStaticMarkup(createElement(ModelDrillMenu, baseProps({ rows: [GROUP_ROW] })));
    expect(html).not.toContain("Add connection");
  });

  it("does NOT render it on an empty NON-root level (an empty group is no place to add a connection)", () => {
    const html = renderToStaticMarkup(
      createElement(ModelDrillMenu, baseProps({ page: { kind: "group", connectionId: "conn-a" } })),
    );
    expect(html).not.toContain("Add connection");
    // The empty text still shows — unchanged behavior for an empty group.
    expect(html).toContain("No connected providers yet.");
  });
});

describe("ModelDrillMenu — empty-root action focus + keyboard (Taskana 4237)", () => {
  it("joins the owner's roving-focus registry, so opening and ArrowDown/ArrowUp land on the level's only action", () => {
    // Both hosts seed the menu on index 0 (an empty row list makes their
    // `findIndex` fall back to 0) and their focus effect is
    // `rowRefs.current[focusIndex]?.focus()`. Registering there is what makes
    // that effect focus this button instead of nothing.
    const itemRefs = { current: [] as (HTMLButtonElement | null)[] };
    const tree = ModelDrillMenu(baseProps({ itemRefs }));
    const button = findButton(tree, "Add connection")!;
    const focus = vi.fn();
    (button.props.ref as (element: HTMLButtonElement | null) => void)({ focus } as unknown as HTMLButtonElement);
    expect(itemRefs.current[0]).toEqual({ focus });

    // A populated level has no such slot: index 0 belongs to the first row.
    const populatedRefs = { current: [] as (HTMLButtonElement | null)[] };
    expect(findButton(ModelDrillMenu(baseProps({ rows: [GROUP_ROW], itemRefs: populatedRefs })), "Add connection")).toBeUndefined();
  });

  it("activates on Enter and Space itself, consuming the key so the host's menu handler cannot swallow it", () => {
    const onAddConnection = vi.fn();
    const button = findButton(ModelDrillMenu(baseProps({ onAddConnection })), "Add connection")!;
    for (const key of ["Enter", " "]) {
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      button.props.onKeyDown!({ key, preventDefault, stopPropagation });
      // Without the preventDefault the host cancels native activation and then
      // finds no row to activate — the keystroke did nothing (and ModelPill ran
      // it twice through its nested handlers); without stopPropagation the host
      // handler still gets the key.
      expect(preventDefault, key).toHaveBeenCalledTimes(1);
      expect(stopPropagation, key).toHaveBeenCalledTimes(1);
    }
    expect(onAddConnection).toHaveBeenCalledTimes(2);
  });

  it("leaves every other key — Escape above all — to the host, so closing/backing out is unchanged", () => {
    const onAddConnection = vi.fn();
    const button = findButton(ModelDrillMenu(baseProps({ onAddConnection })), "Add connection")!;
    for (const key of ["Escape", "ArrowDown", "ArrowUp", "Tab"]) {
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      button.props.onKeyDown!({ key, preventDefault, stopPropagation });
      expect(preventDefault, key).not.toHaveBeenCalled();
      expect(stopPropagation, key).not.toHaveBeenCalled();
    }
    expect(onAddConnection).not.toHaveBeenCalled();
  });

  it("keeps Enter/Space away from a host container handler that preventDefaults them (StartScreen and ModelPill both mount this same menu)", () => {
    // Both hosts' container onKeyDown preventDefault Enter/Space and then look
    // for a row to activate; with no rows that would swallow the keystroke.
    // Simulate the bubble: the button handler runs first, the host handler
    // only if propagation was not stopped.
    const onAddConnection = vi.fn();
    const hostSwallowed: string[] = [];
    const host = (key: string) => hostSwallowed.push(key);
    const button = findButton(ModelDrillMenu(baseProps({ onAddConnection })), "Add connection")!;
    for (const key of ["Enter", " "]) {
      let stopped = false;
      button.props.onKeyDown!({ key, preventDefault: () => {}, stopPropagation: () => { stopped = true; } });
      if (!stopped) {
        host(key);
      }
    }
    expect(hostSwallowed).toEqual([]);
    expect(onAddConnection).toHaveBeenCalledTimes(2);
  });
});
