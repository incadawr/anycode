// @vitest-environment jsdom
/**
 * GitHub #31 regression gate (mounted, jsdom): the dock resize handle must
 * be a DIRECT child of the `.session-content-split-open` grid — the 8px
 * column `computeSessionContentColumns` reserves for it — NOT a child of the
 * dock <aside>. When the handle lived inside the column-flex `.dock-panel`
 * it rendered a full-width 0px-tall strip: the separator existed in the DOM
 * and `beginDockResize` was wired, but there was no hit area to grab, so the
 * dock could not be resized at all.
 *
 * Mounts the REAL `ActiveTabBody` (App.tsx) — the component that owns the
 * grid — with a desktop store (BackgroundAgents.mounted.test.ts pattern),
 * opens a `git` dock tab through the same store path a real git-panel open
 * takes, and drives the handle's pointer events through the store writes +
 * persistence the drag performs.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveTabBody, SessionSurface } from "../App.js";
import { createDesktopStore } from "../store.js";
import { createTabRegistry, tabRegistry, type DesktopStoreApi } from "../tab-registry.js";
import { createTabsStore } from "../tabs-store.js";
import { TabContext } from "../tab-context.js";
import { childLayoutStore } from "../child-layout.js";
import { useDockStore } from "../dock/dock-store.js";
import { DOCK_SPLIT_MIN_PX, DOCK_WIDTH_STORAGE_KEY, DOCK_WIDTH_MAX, DOCK_WIDTH_MIN, dockMinWidth } from "../dock/dock-layout.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The renderer reads the preload bridge off `window.anycode` at render time
// (SessionHeader's browser-access chip, ModelPill's session list, Composer's
// skills list, the preview hydration pull, …). jsdom has no preload, and
// ActiveTabBody mounts the whole chat shell — so instead of enumerating every
// bridge facet, satisfy them all with ONE recursive proxy: every property is
// itself callable and resolves to the same proxy. `.then` chains therefore
// never run their callbacks (fine — no assertion depends on bridge data),
// and unsubscribers (`onChanged` → `off()`) are callable too.
const anyBridge: unknown = new Proxy(function () {}, {
  get: (_target, prop) => {
    if (prop === Symbol.toPrimitive || prop === "toString") {
      return () => "[preload-stub]";
    }
    return anyBridge;
  },
  apply: () => anyBridge,
});
(window as { anycode?: unknown }).anycode = anyBridge;

// jsdom has no ResizeObserver; ActiveTabBody's available-width tracker
// needs one (observe → no-op is fine: the test's width comes from the
// store, never from a measurement).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;

describe("dock resize handle placement (GitHub #31)", () => {
  let store: DesktopStoreApi;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // The dock store singleton is global across tests in this file — reset
    // the triple App.tsx reads (owner-scoped tabs) and the persisted width
    // so one test's dock state never leaks into the next mount.
    useDockStore.getState().mergeSplit();
    useDockStore.setState({ tabs: [], activeTabId: null, ownerTabId: null, hidden: false });
    useDockStore.setState({ width: 640 });
    localStorage.clear();
    // jsdom's getBoundingClientRect is always 0x0 and its window is 1024px —
    // pin BOTH to a wide window BEFORE mounting so the available-width
    // tracker (initial state + measure effect + drag clamp) sees 1600px and
    // the drag expectations below are deterministic.
    window.innerWidth = 1600;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1600, height: 900, top: 0, left: 0, right: 1600, bottom: 900, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    store = createDesktopStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.className = "";
    vi.restoreAllMocks();
  });

  async function mountBody(): Promise<void> {
    await act(async () =>
      root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(ActiveTabBody, { tabId: "tab", sidebarCollapsed: false, onToggleSidebar: () => {}, onToast: () => {} }))),
    );
  }

  /** Opens the subagents dock tab: layout B's child view, then Split (the
      same reducer chain the breadcrumb's "Split" button drives). */
  async function openDockTab(): Promise<void> {
    await act(async () => {
      childLayoutStore.getState().open("tab", "row-1");
      childLayoutStore.getState().enterSplit("tab");
    });
  }

  it("keeps distinct recovered drafts in their owning tab across real session-surface switches", async () => {
    const other = createDesktopStore();
    const imageA = {name:"a.png",sizeBytes:1,attachment:{mediaType:"image/png" as const,data:"YQ=="}};
    const imageB = {name:"b.png",sizeBytes:1,attachment:{mediaType:"image/png" as const,data:"Yg=="}};
    store.setState({restoredComposerDraft:{text:"draft A",images:[imageA],orchestrate:"enable"}});
    other.setState({restoredComposerDraft:{text:"draft B",images:[imageB]}});
    const renderTab = async (tabId: string, target: DesktopStoreApi) => {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId,store:target}}, createElement(SessionSurface, {tabId,onToast:() => {}}))));
    };
    const type = async (value: string) => {
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,value); textarea.dispatchEvent(new Event("input",{bubbles:true})); });
    };
    await renderTab("a",store);
    await type("edited A");
    await renderTab("b",other);
    expect(container.querySelector<HTMLTextAreaElement>(".composer-textarea")!.value).toBe("draft B");
    expect(container.querySelector(".composer-image-pill-name")?.textContent).toBe("b.png");
    expect(other.getState().restoredComposerDraft).toMatchObject({text:"draft B",images:[imageB]});
    await type("edited B");
    await renderTab("a",store);
    expect(container.querySelector<HTMLTextAreaElement>(".composer-textarea")!.value).toBe("edited A");
    expect(container.querySelector(".composer-image-pill-name")?.textContent).toBe("a.png");
    expect(container.textContent).toContain("Orchestration intent retained");
    expect(other.getState().restoredComposerDraft).toMatchObject({text:"edited B",images:[imageB]});
    await renderTab("b",other);
    expect(container.querySelector<HTMLTextAreaElement>(".composer-textarea")!.value).toBe("edited B");
    expect(container.querySelector(".composer-image-pill-name")?.textContent).toBe("b.png");
  });

  it("finishes an image read for its original tab after a surface switch", async () => {
    const other = createDesktopStore();
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    const ready = (sessionId: string) => ({type:"host_ready" as const, workspace:"/ws", sessionId, mode:"build" as const, model:"m1", imageInput:true});
    store.getState().applyHostMessage(ready("a"));
    other.getState().applyHostMessage(ready("b"));
    const renderTab = async (tabId: string, target: DesktopStoreApi) => {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId,store:target}}, createElement(SessionSurface, {tabId,onToast:() => {}}))));
    };
    let finish!: (bytes: ArrayBuffer) => void;
    const file = new File(["ignored"], "delayed.png", {type:"image/png"});
    Object.defineProperty(file, "arrayBuffer", {value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; })});
    store.setState({restoredComposerDraft:{text:"A edit",images:[{name:"old.png",sizeBytes:1,attachment:{mediaType:"image/png",data:"YQ=="}}]}});
    await renderTab("a",store);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input,"files",{configurable:true,value:[file]});
    await act(async () => input.dispatchEvent(new Event("change", {bubbles:true})));
    expect(finish).toBeTypeOf("function");
    expect(container.textContent).toContain("Loading attachments: delayed.png");
    expect(container.querySelector<HTMLButtonElement>(".composer-send")!.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove old.png"]')!.click());
    await renderTab("b",other);
    expect(container.textContent).not.toContain("delayed.png");
    await renderTab("a",store);
    expect(container.textContent).toContain("Loading attachments: delayed.png");
    expect(container.querySelector<HTMLButtonElement>(".composer-send")!.disabled).toBe(true);
    await renderTab("b",other);
    const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"B edit"); textarea.dispatchEvent(new Event("input",{bubbles:true})); });
    await act(async () => finish(new Uint8Array([137,80,78,71,13,10,26,10]).buffer));
    expect(container.querySelector(".composer-image-pill-name")).toBeNull();
    expect(other.getState().restoredComposerDraft).toMatchObject({text:"B edit",images:[]});
    await renderTab("a",store);
    expect(container.querySelector(".composer-image-pill-name")?.textContent).toBe("delayed.png");
    expect(store.getState().restoredComposerDraft).toMatchObject({text:"A edit",images:[{name:"delayed.png"}]});
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).toHaveBeenCalledWith("a",expect.objectContaining({type:"user_message",text:"A edit",images:[expect.objectContaining({mediaType:"image/png"})]}));
    await renderTab("b",other);
    expect(container.querySelector<HTMLTextAreaElement>(".composer-textarea")!.value).toBe("B edit");
    expect(container.querySelector(".composer-image-pill-name")).toBeNull();
  });

  it("retains a completed image when the active orchestrator slash command is selected", async () => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});
    store.setState({orchestrateActive:true});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    let finish!: (bytes: ArrayBuffer) => void;
    const file = new File(["ignored"], "task.png", {type:"image/png"});
    Object.defineProperty(file,"arrayBuffer",{value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; })});
    await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"a",store}}, createElement(SessionSurface, {tabId:"a",onToast:() => {}}))));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input,"files",{configurable:true,value:[file]});
    await act(async () => input.dispatchEvent(new Event("change",{bubbles:true})));
    const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"/orchestrate inspect image");
      textarea.setSelectionRange(12,12);
      textarea.dispatchEvent(new Event("input",{bubbles:true}));
      textarea.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true,key:"e"}));
    });
    const option = () => [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent?.includes("Orchestrate"))!;
    expect(option()).toBeTruthy();
    await act(async () => option().click());
    expect(store.getState().notice?.text).toContain("Wait for attachments");
    expect(textarea.value).toBe("/orchestrate inspect image");
    await act(async () => finish(new Uint8Array([137,80,78,71,13,10,26,10]).buffer));
    expect(container.querySelector(".composer-image-pill-name")?.textContent).toBe("task.png");
    await act(async () => option().click());
    expect(store.getState().notice?.text).toContain("Remove attachments before using /orchestrate");
    expect(textarea.value).toBe("/orchestrate inspect image");
    expect(store.getState().restoredComposerDraft).toMatchObject({text:"/orchestrate inspect image",images:[{name:"task.png"}]});
    expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"user_message"}));
    expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"set_orchestrate"}));
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(textarea.value).toBe("/orchestrate inspect image");
    expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"user_message"}));
  });

  it("hides the mounted Codex steer when a file read begins", async () => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true,engine:{id:"codex",capabilities:{supportsCorePermissions:false,supportsRewind:false,supportsWorkflow:false,supportsGitMutations:false,supportsContextUsage:false,supportsContextBreakdown:false,supportsInteractiveApprovals:true,costAccounting:false,supportsModelSelection:false,supportsReasoningEffort:false,supportsImages:true,supportsTasks:false,supportsFileSnapshots:false,supportsManualCompact:false}}});
    store.setState({turn:{status:"running",turnId:"turn",requestId:"request"}});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    let finish!: (bytes:ArrayBuffer) => void;
    const file = new File(["ignored"],"pending.png",{type:"image/png"});
    Object.defineProperty(file,"arrayBuffer",{value:() => new Promise<ArrayBuffer>(resolve => {finish=resolve;})});
    await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"a",store}}, createElement(SessionSurface, {tabId:"a",onToast:() => {}}))));
    const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"keep this"); textarea.dispatchEvent(new Event("input",{bubbles:true})); });
    const steer = container.querySelector<HTMLButtonElement>('[aria-label="Steer active Codex turn"]')!;
    expect(steer).toBeTruthy();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input,"files",{configurable:true,value:[file]});
    await act(async () => { input.dispatchEvent(new Event("change",{bubbles:true})); steer.click(); });
    expect(store.getState().pendingComposerImages).toHaveLength(1);
    expect(container.querySelector('[aria-label="Steer active Codex turn"]')).toBeNull();
    expect(textarea.value).toBe("keep this");
    expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"steer_message"}));
    expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"user_message"}));
    await act(async () => finish(new Uint8Array([137,80,78,71,13,10,26,10]).buffer));
    expect(container.querySelector(".composer-image-pill-name")?.textContent).toBe("pending.png");
  });

  it("requires explicit cancellation before sending without a pending file", async () => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    let finish!: (bytes: ArrayBuffer) => void;
    const file = new File(["ignored"], "late.png", {type:"image/png"});
    Object.defineProperty(file, "arrayBuffer", {value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; })});
    await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"a",store}}, createElement(SessionSurface, {tabId:"a",onToast:() => {}}))));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input,"files",{configurable:true,value:[file]});
    await act(async () => input.dispatchEvent(new Event("change", {bubbles:true})));
    const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"send now"); textarea.dispatchEvent(new Event("input",{bubbles:true})); });
    expect(container.querySelector<HTMLButtonElement>(".composer-send")!.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"user_message"}));
    const cancel = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Cancel loading and exclude pending files")!;
    await act(async () => cancel.click());
    expect(container.querySelector<HTMLButtonElement>(".composer-send")!.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).toHaveBeenCalledWith("a",expect.objectContaining({type:"user_message",text:"send now"}));
    await act(async () => finish(new Uint8Array([137,80,78,71,13,10,26,10]).buffer));
    expect(container.querySelector(".composer-image-pill-name")).toBeNull();
    expect(store.getState().completedComposerImages).toEqual([]);
    expect(store.getState().restoredComposerDraft?.images ?? []).toEqual([]);
  });

  it("refuses draft restore while an attachment is still loading", async () => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});
    store.getState().enqueuePrompt({text:"queued",images:[],requiresRestore:true});
    let finish!: (bytes: ArrayBuffer) => void;
    const file = new File(["ignored"], "pending.png", {type:"image/png"});
    Object.defineProperty(file, "arrayBuffer", {value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; })});
    await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"a",store}}, createElement(SessionSurface, {tabId:"a",onToast:() => {}}))));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input,"files",{configurable:true,value:[file]});
    await act(async () => input.dispatchEvent(new Event("change", {bubbles:true})));
    await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-restore")!.click());
    expect(store.getState().promptQueue).toMatchObject([{text:"queued"}]);
    expect(store.getState().notice?.text).toContain("Wait for attachments");
    const cancel = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Cancel loading and exclude pending files")!;
    await act(async () => cancel.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-restore")!.click());
    expect(container.querySelector<HTMLTextAreaElement>(".composer-textarea")!.value).toBe("queued");
    await act(async () => finish(new Uint8Array([137,80,78,71,13,10,26,10]).buffer));
    expect(container.querySelector(".composer-image-pill-name")).toBeNull();
  });

  it("releases the hold and displays a failure if reading fails", async () => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});
    let fail!: (error: Error) => void;
    const file = new File(["ignored"], "bad.png", {type:"image/png"});
    Object.defineProperty(file, "arrayBuffer", {value: () => new Promise<ArrayBuffer>((_resolve,reject) => { fail = reject; })});
    await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"a",store}}, createElement(SessionSurface, {tabId:"a",onToast:() => {}}))));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input,"files",{configurable:true,value:[file]});
    await act(async () => input.dispatchEvent(new Event("change", {bubbles:true})));
    expect(container.textContent).toContain("Loading attachments: bad.png");
    await act(async () => fail(new Error("read failed")));
    expect(store.getState().pendingComposerImages).toEqual([]);
    expect(store.getState().notice?.text).toBe("read failed");
    expect(container.textContent).not.toContain("Loading attachments: bad.png");
  });

  it("invalidates outstanding reads when their tab is closed", async () => {
    const registry = createTabRegistry(createTabsStore());
    const port = {onmessage:null,postMessage:()=>{},addEventListener:()=>{},removeEventListener:()=>{}} as unknown as MessagePort;
    registry.registerPort("closing-tab","/ws",port);
    const closing = registry.getStore("closing-tab")!;
    closing.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});
    let finish!: (bytes: ArrayBuffer) => void;
    const file = new File(["ignored"], "closing.png", {type:"image/png"});
    Object.defineProperty(file, "arrayBuffer", {value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; })});
    await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"closing-tab",store:closing}}, createElement(SessionSurface, {tabId:"closing-tab",onToast:() => {}}))));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input,"files",{configurable:true,value:[file]});
    await act(async () => input.dispatchEvent(new Event("change", {bubbles:true})));
    expect(closing.getState().pendingComposerImages).toHaveLength(1);
    await act(async () => { root.render(null); registry.disposeTab("closing-tab"); });
    await act(async () => finish(new Uint8Array([137,80,78,71,13,10,26,10]).buffer));
    expect(registry.getStore("closing-tab")).toBeUndefined();
    expect(closing.getState().pendingComposerImages).toEqual([]);
    expect(closing.getState().completedComposerImages).toEqual([]);
  });

  it("preserves newly typed ordinary drafts independently when switching surfaces", async () => {
    const other = createDesktopStore();
    const renderTab = async (tabId: string, target: DesktopStoreApi) => {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId,store:target}}, createElement(SessionSurface, {tabId,onToast:() => {}}))));
    };
    const type = async (value: string) => {
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,value); textarea.dispatchEvent(new Event("input",{bubbles:true})); });
    };
    await renderTab("a",store);
    await type("ordinary A");
    await renderTab("b",other);
    expect(container.querySelector<HTMLTextAreaElement>(".composer-textarea")!.value).toBe("");
    await type("ordinary B");
    await renderTab("a",store);
    expect(container.querySelector<HTMLTextAreaElement>(".composer-textarea")!.value).toBe("ordinary A");
    await renderTab("b",other);
    expect(container.querySelector<HTMLTextAreaElement>(".composer-textarea")!.value).toBe("ordinary B");
  });

  it("renders the separator as a direct child of the grid, before the dock aside — never inside it", async () => {
    await mountBody();
    await openDockTab();

    const grid = container.querySelector(".session-content-split-open");
    expect(grid).not.toBeNull();
    const dock = container.querySelector(".dock-panel");
    expect(dock).not.toBeNull();
    // The regression: the handle must not live inside the column-flex dock
    // (a 0px-tall strip there has no hit area).
    expect(dock!.querySelector(".review-resize-handle")).toBeNull();
    const handle = grid!.querySelector(":scope > .review-resize-handle") as HTMLElement | null;
    expect(handle).not.toBeNull();
    // It occupies the reserved 8px grid column: grid child #2 of 3, with the
    // dock <aside> the last.
    const children = Array.from(grid!.children);
    expect(children.indexOf(handle!)).toBe(children.length - 2);
    expect(children[children.length - 1]).toBe(dock);
    expect(handle!.getAttribute("role")).toBe("separator");
  });

  /** jsdom has no PointerEvent constructor — a MouseEvent dispatched under
      the pointer event types carries the clientX/pointerId the handlers
      read (0 for plain MouseEvents). */
  function pointerEvent(type: string, x: number, pointerId = 0): MouseEvent & { pointerId: number } {
    return Object.assign(new MouseEvent(type, { clientX: x, bubbles: true }), { pointerId });
  }

  it("dragging the separator changes the width (clamped) and persists anycode.dock.width on release", async () => {
    await mountBody();
    await openDockTab();

    const handle = container.querySelector(".session-content-split-open > .review-resize-handle") as HTMLElement;
    expect(handle).not.toBeNull();

    // 640 → drag 120px left → 760, persisted on pointerup.
    handle.dispatchEvent(pointerEvent("pointerdown", 800));
    expect(useDockStore.getState().width).toBe(640); // live during the drag
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 680)));
    expect(useDockStore.getState().width).toBe(760);
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 680)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe("760");

    // Beyond the max: clamped to DOCK_WIDTH_MAX, never 2000.
    handle.dispatchEvent(pointerEvent("pointerdown", 680));
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", -1320)));
    expect(useDockStore.getState().width).toBe(DOCK_WIDTH_MAX);
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", -1320)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe(String(DOCK_WIDTH_MAX));

    // Below the min: clamped to DOCK_WIDTH_MIN.
    handle.dispatchEvent(pointerEvent("pointerdown", 800));
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 2400)));
    expect(useDockStore.getState().width).toBe(DOCK_WIDTH_MIN);
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 2400)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe(String(DOCK_WIDTH_MIN));
  });

  it("pointercancel ends the drag, and a foreign pointer's moves never resize", async () => {
    await mountBody();
    await openDockTab();

    const handle = container.querySelector(".session-content-split-open > .review-resize-handle") as HTMLElement;
    expect(handle).not.toBeNull();

    // The drag starts with pointer 1.
    handle.dispatchEvent(pointerEvent("pointerdown", 900, 1));
    expect(useDockStore.getState().width).toBe(640);
    // A SECOND pointer's moves (pointer 2) must be ignored entirely.
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 100, 2)));
    expect(useDockStore.getState().width).toBe(640);
    // The initiating pointer resizes.
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 700, 1)));
    expect(useDockStore.getState().width).toBe(840);
    // A FOREIGN pointer's release/cancel must NOT end the drag (it once
    // burned the once-listeners, persisted the width mid-drag and left the
    // initiating pointer dead)…
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 100, 2)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBeNull();
    await act(async () => window.dispatchEvent(pointerEvent("pointercancel", 100, 2)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBeNull();
    // …the initiating pointer still resizes afterwards…
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 600, 1)));
    expect(useDockStore.getState().width).toBe(940);
    // …and ITS pointerup ends the drag and persists.
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 600, 1)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe("940");
    // …so later moves — from ANY pointer — no longer resize.
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 200, 1)));
    expect(useDockStore.getState().width).toBe(940);
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 200, 2)));
    expect(useDockStore.getState().width).toBe(940);
  });

  it("pointercancel from the INITIATING pointer ends the drag and persists", async () => {
    await mountBody();
    await openDockTab();

    const handle = container.querySelector(".session-content-split-open > .review-resize-handle") as HTMLElement;
    expect(handle).not.toBeNull();

    handle.dispatchEvent(pointerEvent("pointerdown", 900, 1));
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 700, 1)));
    expect(useDockStore.getState().width).toBe(840);
    await act(async () => window.dispatchEvent(pointerEvent("pointercancel", 700, 1)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe("840");
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 200, 1)));
    expect(useDockStore.getState().width).toBe(840);
  });

  it("with a pane pinned (split), the drag floor leaves the active pane visible — never DOCK_WIDTH_MIN", async () => {
    await mountBody();
    await openDockTab();

    // Pin a second pane (the dock store's splitRight — the split button's path).
    // A 1600px window is past the 1076px canSplit gate, so the pin sticks.
    await act(async () => {
      useDockStore.getState().open({ id: "git", kind: "git", title: "Review" });
      useDockStore.getState().splitRight("git", true);
    });
    expect(useDockStore.getState().splitTabId).toBe("git");

    const handle = container.querySelector(".session-content-split-open > .review-resize-handle") as HTMLElement;
    expect(handle).not.toBeNull();

    // Drag far right: with the pane pinned the dock may not shrink under
    // DOCK_WIDTH_MIN + DOCK_SPLIT_MIN_PX (the pinned 320px pane is an
    // absolute overlay of the dock body — at the plain min it would cover
    // the active pane entirely).
    handle.dispatchEvent(pointerEvent("pointerdown", 800));
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 2400)));
    expect(useDockStore.getState().width).toBe(DOCK_WIDTH_MIN + DOCK_SPLIT_MIN_PX);
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 2400)));
    expect(localStorage.getItem(DOCK_WIDTH_STORAGE_KEY)).toBe(String(DOCK_WIDTH_MIN + DOCK_SPLIT_MIN_PX));

    // Unpinning restores the plain floor (the original single-pane min).
    await act(async () => useDockStore.getState().mergeSplit());
    handle.dispatchEvent(pointerEvent("pointerdown", 800));
    await act(async () => window.dispatchEvent(pointerEvent("pointermove", 2400)));
    expect(useDockStore.getState().width).toBe(DOCK_WIDTH_MIN);
    await act(async () => window.dispatchEvent(pointerEvent("pointerup", 2400)));
  });

  // Audit C10: the per-tab split affordance must read as an icon, not as a
  // stray divider glyph sitting between the title and the close button.
  it("renders the split affordance as an icon with no text glyph (C10)", async () => {
    await mountBody();
    await act(async () => useDockStore.getState().open({ id: "git", kind: "git", title: "Review" }));

    const split = container.querySelector(".dock-tab-split");
    expect(split).not.toBeNull();
    expect(split!.querySelector("svg")).not.toBeNull();
    expect(split!.textContent).toBe("");
  });

  // Audit C11: the background-tasks and terminal header toggles must not share
  // one glyph — they were indistinguishable without their tooltips.
  it("gives the background-tasks and terminal toggles distinct glyphs (C11)", async () => {
    await mountBody();

    const tasks = container.querySelector('[aria-label="Toggle background tasks"]');
    const terminal = container.querySelector('[aria-label="Toggle terminal"]');
    expect(tasks).not.toBeNull();
    expect(terminal).not.toBeNull();
    expect(tasks!.querySelector("svg")).not.toBeNull();
    expect(tasks!.innerHTML).not.toBe(terminal!.innerHTML);
  });
});
