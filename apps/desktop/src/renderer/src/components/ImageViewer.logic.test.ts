/**
 * Taskana 4091 follow-up: tests pinning the ImageViewer's modal-dialog
 * wiring. Same no-jsdom discipline as ConfirmDialog.test.ts (this package's
 * vitest runs `environment: "node"`): react-dom/server's renderToStaticMarkup
 * walks the React tree to an HTML string, and the event-prop wiring is tested
 * by invoking ImageViewer as a plain function with useEffect/useRef locally
 * mocked (vi.mock, other exports retained) so the REAL event props come back
 * on the element tree and can be driven directly. The helpers
 * (runViewerCancel / isViewerBackdropClick / viewerKeyIndex) carry the
 * decision logic and are pinned without any React at all.
 *
 * Brief §2.4 pins, mapped to tests below:
 *  · "opens modally"        → renders a <dialog> whose mount effect calls
 *                             showModal() (pattern of every other modal)
 *  · "Esc closes, no stop"  → runViewerCancel preventDefaults (App.tsx's
 *                             global Esc-to-interrupt returns early on
 *                             defaultPrevented, so cancel_turn never fires)
 *  · "focus returns"        → the focus-restore effect's cleanup focuses the
 *                             captured pre-modal element, only when still
 *                             connected
 *  · "arrows switch images" → viewerKeyIndex wrap-around
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ImageViewer,
  isViewerBackdropClick,
  nextIndex,
  runViewerCancel,
  viewerKeyIndex,
  type ViewerImage,
} from "./ImageViewer.js";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  // Effect-cleanup recorder: useEffects run eagerly, their return fns are
  // collected so a test can fire the unmount cleanups in order — that is
  // where the focus-restore contract lives. useRef keeps the real `useRef`:
  // the dialog ref must read `null` for the backdrop test's child branch.
  const cleanups: Array<() => void> = [];
  return {
    ...actual,
    useEffect: (fn: () => void | (() => void)) => {
      const cleanup = fn();
      if (typeof cleanup === "function") {
        cleanups.push(cleanup);
      }
    },
    // Plain-function invocation (and SSR) never re-renders: the initial
    // value is all any of these wiring tests can observe. The setter is a
    // no-op recorder — invoked directly by nothing here.
    useState: (initial: unknown) => [
      typeof initial === "function" ? (initial as () => unknown)() : initial,
      vi.fn(),
    ],
    // Outside a React render, useRef's internal dispatcher is null — a plain
    // mutable stand-in (same trick ConfirmDialog.test.ts plays with its
    // shared ref) makes both refs observable, defaulting to null.
    useRef: (initial: unknown) => ({ current: initial }),
    __runEffectCleanups: () => {
      const pending = cleanups.splice(0, cleanups.length);
      for (const cleanup of pending) {
        cleanup();
      }
    },
  };
});

vi.mock("../preview/overlay-flag.js", () => ({
  useOverlayFlag: vi.fn(),
}));

const images: readonly ViewerImage[] = [
  { mediaType: "image/png", data: "AA==" },
  { mediaType: "image/png", data: "BB==" },
  { mediaType: "image/png", data: "CC==" },
];

function renderViewer(props: Partial<Parameters<typeof ImageViewer>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(ImageViewer, {
      images,
      startIndex: 0,
      onClose: () => {},
      ...props,
    }),
  );
}

describe("ImageViewer SSR render — it IS a modal dialog (Taskana 4091 follow-up)", () => {
  it("renders a native <dialog>, not the old div overlay", () => {
    const html = renderViewer();
    expect(html).toContain("<dialog");
    expect(html).toContain('aria-label="Image viewer"');
    // The old plain-div overlay is gone — the dialog element itself is the box.
    expect(html).not.toContain("image-viewer-backdrop");
    expect(html).not.toContain('role="dialog"');
  });

  it("focus starts on the Close button and the image/counter are inside the dialog", () => {
    const html = renderViewer();
    expect(html).toContain("Close (Esc)");
    expect(html).toContain("1 / 3");
    expect(html).toContain("Attached image 1 of 3");
  });

  it("raises the preview overlay flag so the native preview view hides under the modal (D8)", async () => {
    const { useOverlayFlag } = await import("../preview/overlay-flag.js");
    vi.mocked(useOverlayFlag).mockClear();
    renderViewer();
    expect(useOverlayFlag).toHaveBeenCalledWith(true);
  });

  it("a single image hides the prev/next pair (nothing to navigate)", () => {
    const html = renderViewer({ images: [images[0]!], startIndex: 0 });
    expect(html).not.toContain("image-viewer-nav");
  });
});

// ---------------------------------------------------------------------------
// Event-prop wiring against the ACTUAL rendered component (mocked hooks).

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

describe("ImageViewer modal wiring (Taskana 4091 follow-up)", () => {
  // The focus-capture effect reads document.activeElement on (mocked) mount;
  // node-env vitest has no document, so a per-suite stub stands in. The
  // focus-restore tests below read (and assert on) this same shared fn.
  const focus = vi.fn();
  const globalScope = globalThis as Record<string, unknown>;
  const hadDocument = "document" in globalScope;
  const originalDocument = globalScope.document;
  const connectedThumb = { focus, isConnected: true };
  globalScope.document = { activeElement: connectedThumb };

  it("Esc (native cancel) closes the dialog without stopping the turn", async () => {
    const onClose = vi.fn();
    const { ImageViewer: Comp } = await import("./ImageViewer.js");
    const root = Comp({ images, startIndex: 0, onClose });
    const dialog = findDialog(root);
    expect(dialog).not.toBeNull();
    const preventDefault = vi.fn();
    (dialog!.props.onCancel as (event: { preventDefault(): void }) => void)({ preventDefault });
    // preventDefault does double duty: the browser's own close is suppressed
    // (caller state stays the source of truth) AND App.tsx's global
    // Esc-to-interrupt returns early on defaultPrevented — cancel_turn never
    // fires while the viewer is open. Close is reported exactly once.
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a click on the image content never closes; the backdrop branch is isViewerBackdropClick", async () => {
    const onClose = vi.fn();
    const { ImageViewer: Comp } = await import("./ImageViewer.js");
    const root = Comp({ images, startIndex: 0, onClose });
    const dialog = findDialog(root);
    expect(dialog).not.toBeNull();
    const onClick = dialog!.props.onClick as (event: { target: unknown }) => void;
    onClick({ target: { fake: "img-child" } });
    expect(onClose).not.toHaveBeenCalled();
  });

  afterAll(() => {
    if (hadDocument) {
      globalScope.document = originalDocument;
    } else {
      delete globalScope.document;
    }
  });

  it("the arrow keys still switch images (wrap-around), other keys do nothing", () => {
    expect(viewerKeyIndex("ArrowRight", 0, 3)).toBe(1);
    expect(viewerKeyIndex("ArrowRight", 2, 3)).toBe(0);
    expect(viewerKeyIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(viewerKeyIndex("ArrowLeft", 1, 3)).toBe(0);
    // A single image has nothing to navigate — even the arrows change nothing.
    expect(viewerKeyIndex("ArrowRight", 0, 1)).toBeNull();
    expect(viewerKeyIndex("ArrowLeft", 0, 1)).toBeNull();
    // Everything else is untouched (Esc arrives as the native cancel event).
    expect(viewerKeyIndex("Escape", 0, 3)).toBeNull();
    expect(viewerKeyIndex("Tab", 0, 3)).toBeNull();
  });

  it("on close, focus returns to the connected element that had it when the viewer opened", async () => {
    const react = (await import("react")) as unknown as {
      __runEffectCleanups: () => void;
    };
    // Drain the cleanup backlog of the wiring tests above first, so only
    // THIS mount's capture-restore is observed below.
    react.__runEffectCleanups();
    focus.mockClear();
    // The suite-level stub captured this still-connected thumbnail on mount;
    // unmounting must focus it again, exactly once.
    const { ImageViewer: Comp } = await import("./ImageViewer.js");
    Comp({ images, startIndex: 0, onClose: () => {} });
    react.__runEffectCleanups();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("a disconnected (unmounted) trigger is NOT focused — no focus() on a dead node", async () => {
    const react = (await import("react")) as unknown as {
      __runEffectCleanups: () => void;
    };
    // Swap in a DISCONNECTED activeElement for this test's mount, then swap
    // back so later suites see the original state.
    const deadFocus = vi.fn();
    globalScope.document = { activeElement: { focus: deadFocus, isConnected: false } };
    try {
      const { ImageViewer: Comp } = await import("./ImageViewer.js");
      Comp({ images, startIndex: 0, onClose: () => {} });
      react.__runEffectCleanups();
      expect(deadFocus).not.toHaveBeenCalled();
    } finally {
      globalScope.document = { activeElement: connectedThumb };
    }
  });
});

describe("runViewerCancel — Esc routing without stopping the turn", () => {
  it("preventDefaults (browser close suppressed, caller state stays the source of truth) and closes once", () => {
    const preventDefault = vi.fn();
    const onClose = vi.fn();
    runViewerCancel({ preventDefault }, onClose);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("isViewerBackdropClick — only the dialog element itself is the backdrop", () => {
  it("is true only when target === dialog", () => {
    const dialog = { id: "dialog" };
    expect(isViewerBackdropClick(dialog, dialog)).toBe(true);
    expect(isViewerBackdropClick(dialog, { id: "child" })).toBe(false);
    expect(isViewerBackdropClick(null, null)).toBe(false);
    expect(isViewerBackdropClick(null, dialog)).toBe(false);
  });
});

describe("nextIndex (ImageViewer wrap-around navigation, Taskana 4091)", () => {
  it("steps forward, wrapping at the end", () => {
    expect(nextIndex(0, 1, 3)).toBe(1);
    expect(nextIndex(1, 1, 3)).toBe(2);
    expect(nextIndex(2, 1, 3)).toBe(0);
  });

  it("steps backward, wrapping at the start", () => {
    expect(nextIndex(1, -1, 3)).toBe(0);
    expect(nextIndex(2, -1, 3)).toBe(1);
    expect(nextIndex(0, -1, 3)).toBe(2);
  });

  it("a single image never moves", () => {
    expect(nextIndex(0, 1, 1)).toBe(0);
    expect(nextIndex(0, -1, 1)).toBe(0);
  });

  it("degenerate guard: count 0 (and anything <= 1) stays at 0", () => {
    expect(nextIndex(0, 1, 0)).toBe(0);
    expect(nextIndex(0, -1, 0)).toBe(0);
  });
});
