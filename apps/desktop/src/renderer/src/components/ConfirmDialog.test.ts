/**
 * TASK.126 — tests for the presentational ConfirmDialog. Same jsdom-free
 * discipline as ToolCallStack.test.ts: `react-dom/server`'s
 * `renderToStaticMarkup` walks the React tree to an HTML string, so it works
 * under this package's plain "node" vitest environment. For the event-prop
 * wiring (Confirm/Cancel/Esc/backdrop), React's useEffect/useRef and
 * useOverlayFlag are locally mocked (vi.mock, other exports retained) so
 * invoking ConfirmDialog as a plain function returns its element tree with
 * the real event props attached — they are then invoked directly. No DOM
 * dependency is introduced.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmDialog, isBackdropClick, runDialogCancel, type ConfirmDialogRequest } from "./ConfirmDialog.js";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  // ONE shared ref holder for the module, pointed at a per-test value via
  // __setRefValue — ConfirmDialog's useRef calls observe it, so a test can
  // make the dialog ref equal a known element and drive the backdrop branch.
  const sharedRef = { current: null as unknown };
  return {
    ...actual,
    useEffect: () => {},
    useRef: () => sharedRef,
    __setRefValue: (value: unknown) => {
      sharedRef.current = value;
    },
  };
});

vi.mock("../preview/overlay-flag.js", () => ({
  useOverlayFlag: vi.fn(),
}));

const request: ConfirmDialogRequest = {
  title: "Delete task",
  body: "Delete “Fix login” permanently? This cannot be undone.",
  confirmLabel: "Delete",
};

function renderDialog(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ConfirmDialog, {
      request,
      onConfirm: () => {},
      onCancel: () => {},
      ...props,
    }),
  );
}

describe("ConfirmDialog (SSR render)", () => {
  it("renders nothing for a null request", () => {
    expect(renderDialog({ request: null })).toBe("");
  });

  it("renders the native dialog with aria-label, git-confirm classes, copy and both buttons", () => {
    const html = renderDialog();
    expect(html).toContain("git-confirm-dialog");
    expect(html).toContain('aria-label="Delete task"');
    expect(html).toContain("git-confirm-header");
    expect(html).toContain("git-confirm-title");
    expect(html).toContain("git-confirm-body");
    expect(html).toContain("git-confirm-actions");
    expect(html).toContain("Delete “Fix login” permanently? This cannot be undone.");
    expect(html).toContain('class="git-confirm-cancel"');
    expect(html).toContain(">Cancel<");
    expect(html).toContain('class="git-confirm-confirm"');
    expect(html).toContain(">Delete<");
  });
});

describe("runDialogCancel", () => {
  it("prevents default and reports cancel exactly once", () => {
    const preventDefault = vi.fn();
    const onCancel = vi.fn();
    runDialogCancel({ preventDefault }, onCancel);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("isBackdropClick", () => {
  it("is true only when the target is the dialog itself", () => {
    const dialog = { id: "dialog" };
    expect(isBackdropClick(dialog, dialog)).toBe(true);
    expect(isBackdropClick(dialog, { id: "child" })).toBe(false);
    expect(isBackdropClick(null, null)).toBe(false);
    expect(isBackdropClick(null, dialog)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Event-prop wiring against the ACTUAL rendered component (mocked hooks).
// ConfirmDialog is invoked as a plain function and its returned element tree
// traversed, so the REAL event props are invoked — not just the helpers.

type AnyProps = Record<string, unknown> & { children?: unknown };
type TestElement = { type: unknown; props: AnyProps };

function findElements(element: unknown, visit: (el: TestElement) => void): void {
  if (!element || typeof element !== "object") {
    return;
  }
  const candidate = element as { type?: unknown; props?: AnyProps };
  if (typeof candidate.type === "string" || typeof candidate.type === "function") {
    visit(candidate as TestElement);
  }
  const children = candidate.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      findElements(child, visit);
    }
  } else if (children !== undefined && children !== null && typeof children === "object") {
    findElements(children, visit);
  }
}

function findDialog(root: unknown): TestElement | null {
  let found: TestElement | null = null;
  findElements(root, (el) => {
    if (found === null && el.type === "dialog") {
      found = el;
    }
  });
  return found;
}

function findButton(root: unknown, className: string): TestElement | null {
  let found: TestElement | null = null;
  findElements(root, (el) => {
    if (found === null && el.type === "button" && el.props.className === className) {
      found = el;
    }
  });
  return found;
}

describe("ConfirmDialog event wiring (mocked hooks, real event props)", () => {
  it("Confirm button fires onConfirm once and never onCancel", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const react = (await import("react")) as unknown as { __setRefValue: (value: unknown) => void };
    const { ConfirmDialog: Comp } = await import("./ConfirmDialog.js");
    react.__setRefValue(null);
    const root = Comp({ request, onConfirm, onCancel });
    const confirmBtn = findButton(root, "git-confirm-confirm");
    expect(confirmBtn).not.toBeNull();
    (confirmBtn!.props.onClick as () => void)();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Cancel button fires onCancel once and never onConfirm", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const react = (await import("react")) as unknown as { __setRefValue: (value: unknown) => void };
    const { ConfirmDialog: Comp } = await import("./ConfirmDialog.js");
    react.__setRefValue(null);
    const root = Comp({ request, onConfirm, onCancel });
    const cancelBtn = findButton(root, "git-confirm-cancel");
    expect(cancelBtn).not.toBeNull();
    (cancelBtn!.props.onClick as () => void)();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("dialog onCancel prevents default and reports cancel once", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const react = (await import("react")) as unknown as { __setRefValue: (value: unknown) => void };
    const { ConfirmDialog: Comp } = await import("./ConfirmDialog.js");
    react.__setRefValue(null);
    const root = Comp({ request, onConfirm, onCancel });
    const dialog = findDialog(root);
    expect(dialog).not.toBeNull();
    const preventDefault = vi.fn();
    (dialog!.props.onCancel as (event: { preventDefault(): void }) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("dialog onClick cancels for a backdrop target and not for a child target", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const react = (await import("react")) as unknown as { __setRefValue: (value: unknown) => void };
    const { ConfirmDialog: Comp } = await import("./ConfirmDialog.js");
    const dialogElement = { fake: "dialog-element" };
    // Point the (shared) dialog ref at a known element: the dialog's own
    // onClick then sees isBackdropClick(ref.current, event.target).
    react.__setRefValue(dialogElement);
    const root = Comp({ request, onConfirm, onCancel });
    const dialog = findDialog(root);
    expect(dialog).not.toBeNull();
    const onClick = dialog!.props.onClick as (event: { target: unknown }) => void;

    // Child target — a click that bubbled up from dialog content: no cancel.
    onClick({ target: { fake: "child-element" } });
    expect(onCancel).not.toHaveBeenCalled();

    // Backdrop target — the click's target IS the dialog element: cancel.
    onClick({ target: dialogElement });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
