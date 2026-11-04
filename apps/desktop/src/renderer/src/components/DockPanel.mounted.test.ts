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
import { useSettingsStore } from "../settings-store.js";
import { cloneDefaults } from "../../../settings/schema.js";
import { TabContext } from "../tab-context.js";
import { childLayoutStore } from "../child-layout.js";
import { useDockStore } from "../dock/dock-store.js";
import { DOCK_SPLIT_MIN_PX, DOCK_WIDTH_STORAGE_KEY, DOCK_WIDTH_MAX, DOCK_WIDTH_MIN, dockMinWidth } from "../dock/dock-layout.js";
import { usePreviewStore } from "../preview/preview-store.js";
import { Markdown } from "./Markdown.js";
import { DockPanel } from "./DockPanel.js";
import { ModeMenu, FOCUS_MODE_MENU_EVENT } from "./ModeMenu.js";
import { isOverlayOpen } from "../preview/overlay-flag.js";

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
    const connection = {};
    vi.spyOn(tabRegistry, "getLiveHostConnection").mockImplementation((_id, target) => target.getState().connection === "ready" ? connection : null);
    // The dock store singleton is global across tests in this file — reset
    // the triple App.tsx reads (owner-scoped tabs) and the persisted width
    // so one test's dock state never leaks into the next mount.
    useDockStore.getState().mergeSplit();
    useDockStore.setState({ tabs: [], activeTabId: null, ownerTabId: null, hidden: false, activityByConversation: {} });
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
    usePreviewStore.setState({ byTab: {} });
    container.remove();
    document.body.className = "";
    vi.restoreAllMocks();
  });

  async function mountBody(): Promise<void> {
    await act(async () =>
      root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(ActiveTabBody, { tabId: "tab", sidebarCollapsed: false, onToggleSidebar: () => {}, onToast: () => {} }))),
    );
  }

  it.each(["direct", "child-steer"] as const)("restores an unknown %s with attachment only after the current edit is cleared", async (kind) => {
    const ready = { type: "host_ready" as const, workspace: "/ws", sessionId: "a", mode: "build" as const, model: "m1", imageInput: true };
    const image = { name: "saved.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } };
    store.getState().applyHostMessage(ready);
    if (kind === "direct") store.getState().recordSentMessage("original", [image], "attempt", undefined, undefined, undefined, undefined, true);
    else store.getState().recordPendingSteer("attempt", "original", [image.attachment], { text: "original", images: [image] });
    store.getState().setPortClosed();
    store.getState().applyHostMessage(ready);
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    await mountBody();
    const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
    const type = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await type("new edit");
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    expect(textarea.value).toBe("new edit");
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ requestId: "attempt", status: "unknown", images: [image] });
    await type("");
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    expect(textarea.value).toBe("original");
    expect(store.getState().restoredComposerDraft).toMatchObject({ text: "original", images: [image], deliveryRequestId: "attempt" });
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).not.toHaveBeenCalledWith("tab", expect.objectContaining({ type: "user_message" }));
  });

  it("keeps the direct attempt linked to the draft if send throws after possible delivery", async () => {
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", sessionId: "a", mode: "build", model: "m1", imageInput: true });
    const image = { name: "saved.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } };
    store.setState({ restoredComposerDraft: { text: "direct", images: [image] } });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation((_tab, message) => { if (message.type === "user_message") throw new Error("synthetic possible delivery"); });
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(store.getState().orchestrationDeliveries).toMatchObject([{ text: "direct", images: [image], status: "unknown" }]);
    expect(store.getState().restoredComposerDraft?.deliveryRequestId).toBe(store.getState().orchestrationDeliveries[0]?.requestId);
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send.mock.calls.filter(([, message]) => message.type === "user_message")).toHaveLength(1);
  });

  it("stages a real Composer direct send before disconnect and restores its attachment", async () => {
    const ready = { type: "host_ready" as const, workspace: "/ws", sessionId: "a", mode: "build" as const, model: "m1", imageInput: true };
    const image = { name: "sent.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } };
    store.getState().applyHostMessage(ready);
    store.setState({ restoredComposerDraft: { text: "actual send", images: [image] } });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    const sent = send.mock.calls.find(([, message]) => message.type === "user_message")?.[1];
    expect(sent).toMatchObject({ type: "user_message", text: "actual send", images: [image.attachment] });
    await act(async () => { store.getState().setPortClosed(); store.getState().applyHostMessage(ready); });
    expect(store.getState().orchestrationDeliveries).toMatchObject([{ requestId: (sent as { requestId: string }).requestId, text: "actual send", images: [image], status: "unknown" }]);
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    expect(store.getState().restoredComposerDraft).toMatchObject({ text: "actual send", images: [image], deliveryRequestId: (sent as { requestId: string }).requestId });
    expect(send.mock.calls.filter(([, message]) => message.type === "user_message")).toHaveLength(1);
  });

  it("stages a real child Composer steer with attachment before disconnect", async () => {
    const ready = { type: "host_ready" as const, workspace: "/ws", sessionId: "child", mode: "build" as const, model: "m1", imageInput: true };
    const image = { name: "steer.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } };
    store.getState().applyHostMessage(ready);
    store.getState().setChildSurface();
    store.getState().applyHostMessage({ type: "turn_started", requestId: "running", turnId: "turn" });
    store.setState({ restoredComposerDraft: { text: "child steer", images: [image] } });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    const sent = send.mock.calls.find(([, message]) => message.type === "user_message")?.[1];
    expect(sent).toMatchObject({ type: "user_message", text: "child steer", images: [image.attachment] });
    await act(async () => { store.getState().setPortClosed(); store.getState().applyHostMessage(ready); });
    expect(store.getState().orchestrationDeliveries).toMatchObject([{ requestId: (sent as { requestId: string }).requestId, text: "child steer", images: [image], status: "unknown" }]);
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    expect(store.getState().restoredComposerDraft).toMatchObject({ text: "child steer", images: [image] });
    expect(send.mock.calls.filter(([, message]) => message.type === "user_message")).toHaveLength(1);
  });

  it("holds an explicitly rejected child steer with attachment for manual review", async () => {
    const ready = { type: "host_ready" as const, workspace: "/ws", sessionId: "child", mode: "build" as const, model: "m1", imageInput: true };
    const image = { name: "rejected.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } };
    store.getState().applyHostMessage(ready);
    store.getState().setChildSurface();
    store.getState().applyHostMessage({ type: "turn_started", requestId: "running", turnId: "turn" });
    store.setState({ restoredComposerDraft: { text: "child rejected", images: [image] } });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    const sent = send.mock.calls.find(([, message]) => message.type === "user_message")?.[1] as { requestId: string };
    await act(async () => store.getState().applyHostMessage({ type: "turn_rejected", requestId: sent.requestId, reason: "unsupported_images" }));
    expect(store.getState().orchestrationDeliveries).toMatchObject([{ requestId: sent.requestId, text: "child rejected", images: [image], status: "rejected" }]);
    expect(store.getState().promptQueue).toEqual([]);
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    expect(store.getState().restoredComposerDraft).toMatchObject({ text: "child rejected", images: [image], deliveryRequestId: sent.requestId });
    expect(send.mock.calls.filter(([, message]) => message.type === "user_message")).toHaveLength(1);
  });

  it("dismisses rejected payload only after its restored draft is discarded and reports a late start", async () => {
    const ready = { type: "host_ready" as const, workspace: "/ws", sessionId: "child", mode: "build" as const, model: "m1", imageInput: true };
    const image = { name: "rejected.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } };
    store.getState().applyHostMessage(ready);
    store.getState().recordPendingSteer("rejected-steer", "keep until dismissed", [image.attachment], { text: "keep until dismissed", images: [image] });
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "rejected-steer", reason: "busy" });
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-dismiss")!.click());
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "rejected", images: [image] });
    expect(store.getState().restoredComposerDraft?.deliveryRequestId).toBe("rejected-steer");
    const discard = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Discard this draft and start a new message")!;
    await act(async () => discard.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-dismiss")!.click());
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "rejected", dismissed: true, payloadOmitted: true, text: "", images: [] });
    expect(container.querySelector(".orchestration-delivery-dismiss")).toBeNull();
    await act(async () => store.getState().applyHostMessage({ type: "turn_started", requestId: "rejected-steer", turnId: "late" }));
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({ status: "conflict", payloadOmitted: true });
    expect(container.textContent).toContain("Conflicting delivery reports");
    expect(container.querySelector(".orchestration-delivery-restore")).toBeNull();
  });

  it("dismisses a rejected parent after its rejected retry was discarded and dismissed, retaining late-event fences", async () => {
    const ready = { type: "host_ready" as const, workspace: "/ws", sessionId: "a", mode: "build" as const, model: "m1", imageInput: true };
    const image = { name: "parent.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } };
    store.getState().applyHostMessage(ready);
    store.getState().recordSentMessage("parent payload", [image], "parent", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "parent", reason: "busy" });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "retry payload"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    const sent = send.mock.calls.find(([, message]) => message.type === "user_message")?.[1] as { requestId: string };
    expect(sent.requestId).toBeTruthy();
    await act(async () => store.getState().applyHostMessage({ type: "turn_rejected", requestId: sent.requestId, reason: "busy" }));
    const row = (text: string) => [...container.querySelectorAll<HTMLElement>('[role="status"]')].find(element => element.textContent?.includes(text))!;
    await act(async () => row("retry payload").querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    const discard = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Discard this draft and start a new message")!;
    await act(async () => discard.click());
    await act(async () => row("retry payload").querySelector<HTMLButtonElement>(".orchestration-delivery-dismiss")!.click());
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === sent.requestId)).toMatchObject({ dismissed: true, payloadOmitted: true, status: "rejected" });
    await act(async () => row("parent payload").querySelector<HTMLButtonElement>(".orchestration-delivery-dismiss")!.click());
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "parent")).toMatchObject({ dismissed: true, payloadOmitted: true, images: [] });
    await act(async () => store.getState().applyHostMessage({ type: "turn_started", requestId: sent.requestId, turnId: "late-child" }));
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === sent.requestId)).toMatchObject({ status: "conflict", payloadOmitted: true });
    expect(container.textContent).toContain("Conflicting delivery reports");
    await act(async () => store.getState().applyHostMessage({ type: "turn_started", requestId: "parent", turnId: "late-parent" }));
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "parent")).toMatchObject({ status: "conflict", payloadOmitted: true });
    expect(store.getState().claimRecoveryAttempt("parent", "unsafe-retry", "retry", [image], undefined)).toBe(false);
    expect(send.mock.calls.filter(([, message]) => message.type === "user_message")).toHaveLength(1);
  });

  it.each([ ["completed", "Turn completed"], ["error", "Turn failed"], ["cancelled", "Turn cancelled"], ["max_turns", "Turn reached its turn limit"] ] as const)("retains a recovery payload after %s and allows explicit dismissal", async (reason, label) => {
    const image = { name: "parent.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } };
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", sessionId: "a", mode: "build", model: "m1", imageInput: true });
    store.getState().recordSentMessage("parent payload", [image], "parent", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "parent", reason: "busy" });
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "retry payload"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    const sent = send.mock.calls.find(([, message]) => message.type === "user_message")?.[1] as { requestId: string };
    await act(async () => {
      store.getState().applyHostMessage({ type: "turn_started", requestId: sent.requestId, turnId: "retry-turn" });
      store.getState().applyHostMessage({ type: "agent_event", turnId: "retry-turn", event: { type: "loop_end", reason, turns: 1 } });
    });
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === sent.requestId)).toMatchObject({ status: "finished", terminalReason: reason, text: "retry payload", images: [image] });
    const row = (text: string) => [...container.querySelectorAll<HTMLElement>('[role="status"]')].find(element => element.textContent?.includes(text))!;
    await act(async () => row("parent payload").querySelector<HTMLButtonElement>(".orchestration-delivery-dismiss")!.click());
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === "parent")).toMatchObject({ dismissed: true, images: [] });
    expect(row("retry payload").textContent).toContain(label);
    await act(async () => row("retry payload").querySelector<HTMLButtonElement>(".orchestration-delivery-dismiss")!.click());
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === sent.requestId)).toMatchObject({ status: "finished", terminalReason: reason, dismissed: true, payloadOmitted: true, images: [] });
    await act(async () => store.getState().applyHostMessage({ type: "turn_rejected", requestId: sent.requestId, reason: "busy" }));
    expect(store.getState().orchestrationDeliveries.find(item => item.requestId === sent.requestId)).toMatchObject({ status: "conflict", payloadOmitted: true });
    expect(store.getState().claimRecoveryAttempt("parent", "unsafe", "retry", [image], undefined)).toBe(false);
    expect(send.mock.calls.filter(([, message]) => message.type === "user_message")).toHaveLength(1);
  });

  it("shows a late conflict for a compacted direct delivery without offering a missing payload", async () => {
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", sessionId: "a", mode: "build", model: "m1" });
    const image = { name: "done.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } };
    store.getState().recordSentMessage("completed message", [image], "done", undefined, undefined, undefined, undefined, true);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "done", turnId: "turn-done" });
    store.getState().applyHostMessage({ type: "agent_event", turnId: "turn-done", event: { type: "loop_end", reason: "completed", turns: 1 } });
    store.getState().applyHostMessage({ type: "turn_rejected", requestId: "done", reason: "busy" });
    await mountBody();
    expect(container.textContent).toContain("Earlier completed message (payload released)");
    expect(container.textContent).toContain("Conflicting delivery reports");
    expect(container.querySelector(".orchestration-delivery-restore")).toBeNull();
  });

  /** Opens the subagents dock tab: layout B's child view, then Split (the
      same reducer chain the breadcrumb's "Split" button drives). */
  async function openDockTab(): Promise<void> {
    await act(async () => {
      childLayoutStore.getState().open("tab", "row-1");
      childLayoutStore.getState().enterSplit("tab");
    });
  }

  it.each(["button", "shortcut"])("closes Review using the %s", async (method) => {
    await mountBody();
    await act(async () => {
      store.getState().gitSetPanelOpen(true);
      useDockStore.getState().open({ id: "git", kind: "git", title: "Review" });
    });
    await act(async () => {
      if (method === "button") container.querySelector<HTMLButtonElement>('[aria-label="Close Review"]')!.click();
      else container.querySelector<HTMLElement>(".dock-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true }));
    });
    expect(store.getState().git.panelOpen).toBe(false);
  });

  it("refreshes repository status when Review becomes visible again", async () => {
    vi.useFakeTimers();
    const status = { head: { branch: "main", detached: false, sha: "abc1234", ahead: 0, behind: 0 }, staged: [], unstaged: [], untracked: [] as string[], dirtyCount: 0, filesTruncated: false };
    let files: string[] = [];
    const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation((_tab, message) => {
      if (message.type !== "git_command") return;
      if (message.command.op === "refresh") store.getState().applyHostMessage({ type: "git_status", status: { ...status, untracked: files, dirtyCount: files.length } });
      store.getState().applyHostMessage({ type: "git_result", requestId: message.requestId, outcome: { ok: true, kind: "unit" } });
    });
    try {
      await mountBody();
      await act(async () => {
        store.getState().gitSetPanelOpen(true);
        useDockStore.getState().open({ id: "git", kind: "git", title: "Review" });
        usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "md", previews: [{ previewId: "md", tabId: "tab", url: "file:///doc.md", sourcePath: "/doc.md", title: "doc.md", status: "ready", container: "panel", viewKind: "dom-md" }] });
      });
      await act(async () => { useDockStore.getState().focus("git"); vi.advanceTimersByTime(150); });
      await act(async () => vi.advanceTimersByTime(150));
      expect(container.textContent).toContain("No untracked files.");
      await act(async () => useDockStore.getState().focus("preview:md"));
      files = ["new-file.txt"];
      await act(async () => useDockStore.getState().focus("git"));
      await act(async () => vi.advanceTimersByTime(150));
      expect(container.textContent).toContain("new-file.txt");
      expect(send).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves Markdown view mode and scroll when switching dock tabs", async () => {
    await mountBody();
    await act(async () => {
      usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "md", previews: [{ previewId: "md", tabId: "tab", url: "file:///doc.md", sourcePath: "/doc.md", title: "doc.md", status: "ready", container: "panel", viewKind: "dom-md" }] });
    });
    await act(async () => useDockStore.getState().open({ id: "git", kind: "git", title: "Review" }));
    await act(async () => useDockStore.getState().focus("preview:md"));
    const source = container.querySelector<HTMLButtonElement>('[aria-label="Source"]')!;
    await act(async () => source.click());
    const body = container.querySelector<HTMLElement>(".md-preview-view-body")!;
    body.scrollTop = 120;
    await act(async () => useDockStore.getState().focus("git"));
    await act(async () => useDockStore.getState().focus("preview:md"));
    expect(container.querySelector('[aria-label="Source"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector<HTMLElement>(".md-preview-view-body")).toBe(body);
    expect(body.scrollTop).toBe(120);
    await act(async () => useDockStore.getState().focus("git"));
    await act(async () => useDockStore.getState().splitRight("preview:md", true));
    expect(container.querySelector<HTMLElement>(".md-preview-view-body")).toBe(body);
    await act(async () => useDockStore.getState().focus("preview:md"));
    expect(container.querySelector<HTMLElement>(".md-preview-view-body")).toBe(body);
  });

  it("updates a preview tab title without changing focus", async () => {
    await mountBody();
    const preview = { previewId: "web", tabId: "tab", url: "http://localhost/", title: "First", status: "ready" as const, container: "panel" as const, viewKind: "web" as const };
    await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "web", previews: [preview] }));
    await act(async () => useDockStore.getState().open({ id: "git", kind: "git", title: "Review" }));
    await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "web", previews: [{ ...preview, title: "Second" }] }));
    expect(container.querySelector('[data-tab-id="preview:web"] .dock-tab-title')?.textContent).toBe("Second");
    expect(useDockStore.getState().activeTabId).toBe("git");
  });

  it("focuses an existing preview when its artifact link is clicked", async () => {
    const preview = vi.fn().mockResolvedValue({ ok: true, value: { previewId: "md" } });
    const artifacts = new Proxy({ preview }, { get(target, key) { return Reflect.get(target, key) ?? anyBridge; } });
    (window as { anycode?: unknown }).anycode = new Proxy(anyBridge as object, { get(target, key) { return key === "artifacts" ? artifacts : Reflect.get(target, key); } });
    try {
      useDockStore.setState({ ownerTabId: "tab", tabs: [{ id: "preview:md", kind: "preview", title: "doc.md" }, { id: "git", kind: "git", title: "Review" }], activeTabId: "git" });
      await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(Markdown, { text: "[doc](/doc.md)" }))));
      await act(async () => container.querySelector<HTMLAnchorElement>("a.md-link")!.click());
      expect(preview).toHaveBeenCalledWith("tab", "/doc.md");
      expect(useDockStore.getState().activeTabId).toBe("preview:md");
    } finally {
      (window as { anycode?: unknown }).anycode = anyBridge;
    }
  });

  it("remembers acknowledged outcomes across dock remounts and prioritizes permission", async () => {
    const card = { agentType: "worker", description: "", model: null, engine: null, turns: 0, toolCalls: 0, lastTool: null, activity: [], activityDropped: 0, final: null };
    const rows = [{ spawnToolCallId: "child", badge: "done" as const, card }];
    useDockStore.setState({ ownerTabId: "tab", tabs: [{ id: "subagents", kind: "subagents", title: "Subagents" }, { id: "git", kind: "git", title: "Review" }], activeTabId: "git" });
    const panel = (childRows: typeof rows | { spawnToolCallId: string; badge: "waiting_permission"; card: typeof card }[]) => createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(DockPanel, { mode: "column", width: 640, canSplitNow: true, splitTabId: null, onToast: () => {}, subagents: { rows: childRows, expandedId: "child", surface: null } }));
    await act(async () => root.render(panel(rows)));
    expect(container.querySelector(".dock-activity-done")).not.toBeNull();
    await act(async () => useDockStore.getState().focus("subagents"));
    await act(async () => useDockStore.getState().focus("git"));
    await act(async () => root.render(null));
    await act(async () => root.render(panel(rows)));
    expect(container.querySelector(".dock-activity-done")).toBeNull();
    await act(async () => root.render(panel([{ spawnToolCallId: "child", badge: "waiting_permission", card }])));
    expect(container.querySelector(".dock-activity-waiting")).not.toBeNull();
    expect(container.querySelector(".dock-activity-running")).toBeNull();
    expect(container.querySelector('[role="tab"][aria-label="Subagents — 1 waiting for permission"]')).not.toBeNull();
  });

  it("clears the hidden subagent menu and ignores its shortcut", async () => {
    const menu = () => createElement(ModeMenu, { mode: "build", disabled: false, onChange: () => {} });
    const child = createDesktopStore();
    child.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", sessionId: "child", mode: "build", model: "m1" });
    const surface = createElement(TabContext.Provider, { value: { tabId: "child", store: child } }, createElement(SessionSurface, { tabId: "child", onToast: () => {} }));
    useDockStore.setState({ ownerTabId: "tab", tabs: [{ id: "subagents", kind: "subagents", title: "Subagents" }, { id: "git", kind: "git", title: "Review" }], activeTabId: "subagents" });
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } },
      menu(), createElement(DockPanel, { mode: "column", width: 640, canSplitNow: true, splitTabId: null, onToast: () => {}, subagents: { rows: [{ spawnToolCallId: "child", badge: "running", card: { agentType: "worker", description: "", model: null, engine: null, turns: 0, toolCalls: 0, lastTool: null, activity: [], activityDropped: 0, final: null } }], expandedId: "child", surface } }))));
    await act(async () => window.dispatchEvent(new Event(FOCUS_MODE_MENU_EVENT)));
    expect(container.querySelectorAll(".mode-menu-popover")).toHaveLength(2);
    expect(isOverlayOpen()).toBe(true);
    await act(async () => useDockStore.getState().focus("git"));
    await act(async () => container.querySelector<HTMLElement>(".mode-menu-popover")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(isOverlayOpen()).toBe(false);
    await act(async () => window.dispatchEvent(new Event(FOCUS_MODE_MENU_EVENT)));
    expect(container.querySelectorAll(".mode-menu-popover")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLElement>(".mode-menu-popover")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(isOverlayOpen()).toBe(false);
  });

  it("selects the right neighbour when the active preview closes", async () => {
    const select = vi.fn().mockResolvedValue({ ok: true });
    const previewPanel = new Proxy({ select, close: vi.fn().mockResolvedValue({ ok: true }) }, { get(target, key) { return Reflect.get(target, key) ?? anyBridge; } });
    (window as { anycode?: unknown }).anycode = new Proxy(anyBridge as object, { get(target, key) { return key === "previewPanel" ? previewPanel : Reflect.get(target, key); } });
    try {
      await mountBody();
      const previews = ["a", "b", "c"].map((id) => ({ previewId: id, tabId: "tab", url: `http://localhost/${id}`, title: id, status: "ready" as const, container: "panel" as const, viewKind: "web" as const }));
      await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "b", previews }));
      await act(async () => useDockStore.getState().open({ id: "git", kind: "git", title: "Review" }));
      await act(async () => useDockStore.getState().focus("preview:b"));
      const order = useDockStore.getState().tabs.map(tab => tab.id);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close b"]')!.click());
      expect(useDockStore.getState().activeTabId).toBe("preview:b");
      expect(useDockStore.getState().tabs.map(tab => tab.id)).toEqual(order);
      await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "a", previews: [previews[0]!, previews[2]!] }));
      expect(useDockStore.getState().activeTabId).toBe("preview:c");
      expect(select).toHaveBeenCalledWith("tab", "c");
    } finally {
      (window as { anycode?: unknown }).anycode = anyBridge;
    }
  });


  it("restores an unfinished role picker and task in its original tab", async () => {
    const originalSnapshot = useSettingsStore.getState().snapshot;
    useSettingsStore.setState({snapshot:{settings:cloneDefaults(),secrets:[],providerReady:true,envOverrides:[],readOnly:false,catalog:[]}});
    const originalShow = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    const other = createDesktopStore();
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",orchestration:{enabled:false,available:true,posture:"off"},orchestrationProtocol:{version:1,hostIncarnation:"host",connectionId:"conn",atomicSubmit:true,correlatedToggle:true},imageInput:true});
    other.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"b",mode:"build",model:"m1",imageInput:true});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    const renderTab = async (tabId: string, target: DesktopStoreApi) => {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId,store:target}}, createElement(SessionSurface, {tabId,onToast:() => {}}))));
    };
    try {
      await renderTab("a",store);
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"/orchestrate plan task");
        textarea.setSelectionRange(12,12);
        textarea.dispatchEvent(new Event("input",{bubbles:true}));
        textarea.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true,key:"e"}));
      });
      const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent?.includes("Orchestrate"))!;
      await act(async () => option.click());
      expect(container.querySelector('[data-testid="role-picker-skip"]')).not.toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-add-fallback-planner"]')!.click());
      expect(store.getState().composerRolePicker?.task).toBe("plan task");
      expect(store.getState().composerRolePicker?.draft?.planner.fallbacks).toHaveLength(1);
      await renderTab("b",other);
      expect(container.querySelector('[data-testid="role-picker-skip"]')).toBeNull();
      expect(other.getState().composerRolePicker).toBeNull();
      await renderTab("a",store);
      expect(container.querySelector('[data-testid="role-picker-skip"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="role-picker-role-planner"]')?.textContent).toContain("Fallback 1");
      expect(store.getState().composerRolePicker?.task).toBe("plan task");
      expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"user_message"}));
    } finally {
      HTMLDialogElement.prototype.showModal = originalShow;
      useSettingsStore.setState({snapshot:originalSnapshot});
    }
  });

  it("does not send an orchestration toggle when a role save finishes after tab switch", async () => {
    const previous = useSettingsStore.getState();
    let resolve!: (value:Awaited<ReturnType<typeof previous.setPatch>>) => void;
    const save = vi.fn(() => new Promise<Awaited<ReturnType<typeof previous.setPatch>>>(done => {resolve = done;}));
    useSettingsStore.setState({snapshot:{settings:cloneDefaults(),secrets:[],providerReady:true,envOverrides:[],readOnly:false,catalog:[]},setPatch:save as typeof previous.setPatch});
    const originalShow = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    const other = createDesktopStore();
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",orchestration:{enabled:false,available:true,posture:"off" as const},orchestrationProtocol:{version:1 as const,hostIncarnation:"host",connectionId:"conn",atomicSubmit:true,correlatedToggle:true}});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    const renderTab = async (tabId: string, target: DesktopStoreApi) => {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId,store:target}}, createElement(SessionSurface, {tabId,onToast:() => {}}))));
    };
    try {
      await renderTab("a",store);
      await act(async () => container.querySelector<HTMLButtonElement>(".mode-chip")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mode-menu-orchestrate"]')!.click());
      const saveButton = container.querySelector<HTMLButtonElement>('[data-testid="role-picker-save"]')!;
      const skipButton = container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]')!;
      await act(async () => { saveButton.click(); saveButton.click(); skipButton.click(); });
      expect(save).toHaveBeenCalledOnce();
      expect(container.querySelector<HTMLButtonElement>('[data-testid="role-picker-save"]')!.disabled).toBe(true);
      expect(container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]')!.disabled).toBe(true);
      expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"set_orchestrate"}));
      await renderTab("b",other);
      await renderTab("a",store);
      expect(container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]')!.disabled).toBe(true);
      await act(async () => resolve({ok:true,snapshot:useSettingsStore.getState().snapshot!}));
      expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"set_orchestrate"}));
      expect(store.getState().composerRolePicker).not.toBeNull();
      expect(store.getState().composerRolePicker?.saveOperation).toBeUndefined();
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]')!.click());
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("a",expect.objectContaining({type:"set_orchestrate"}));
    } finally {
      HTMLDialogElement.prototype.showModal = originalShow;
      useSettingsStore.setState({snapshot:previous.snapshot,setPatch:previous.setPatch});
    }
  });

  it("sends a role-picker task exactly once after a delayed save despite repeated actions", async () => {
    const previous = useSettingsStore.getState();
    let resolve!: (value:Awaited<ReturnType<typeof previous.setPatch>>) => void;
    const save = vi.fn(() => new Promise<Awaited<ReturnType<typeof previous.setPatch>>>(done => {resolve = done;}));
    useSettingsStore.setState({snapshot:{settings:cloneDefaults(),secrets:[],providerReady:true,envOverrides:[],readOnly:false,catalog:[]},setPatch:save as typeof previous.setPatch});
    const originalShow = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",orchestration:{enabled:false,available:true,posture:"off" as const},orchestrationProtocol:{version:1 as const,hostIncarnation:"host",connectionId:"conn",atomicSubmit:true,correlatedToggle:true}});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"a",store}}, createElement(SessionSurface, {tabId:"a",onToast:() => {}}))));
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"/orchestrate plan task");
        textarea.setSelectionRange(12,12);
        textarea.dispatchEvent(new Event("input",{bubbles:true}));
        textarea.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true,key:"e"}));
      });
      const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent?.includes("Orchestrate"))!;
      await act(async () => option.click());
      let dialog = container.querySelector<HTMLDialogElement>('[aria-label="Choose orchestration roles"]')!;
      const idleCancel = new Event("cancel", {cancelable:true});
      await act(async () => dialog.dispatchEvent(idleCancel));
      expect(idleCancel.defaultPrevented).toBe(true);
      expect(store.getState().composerRolePicker).toBeNull();
      expect(send).not.toHaveBeenCalledWith("a", expect.objectContaining({type:"user_message"}));
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      dialog = container.querySelector<HTMLDialogElement>('[aria-label="Choose orchestration roles"]')!;
      expect(dialog).not.toBeNull();
      const pickerId = store.getState().composerRolePicker!.id;
      const saveButton = container.querySelector<HTMLButtonElement>('[data-testid="role-picker-save"]')!;
      const skipButton = container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]')!;
      await act(async () => { saveButton.click(); saveButton.click(); skipButton.click(); });
      expect(save).toHaveBeenCalledOnce();
      const savingCancel = new Event("cancel",{cancelable:true});
      await act(async () => dialog.dispatchEvent(savingCancel));
      expect(savingCancel.defaultPrevented).toBe(true);
      expect(dialog.open).toBe(true);
      expect(store.getState().composerRolePicker?.id).toBe(pickerId);
      await act(async () => { dialog.open = false; dialog.dispatchEvent(new Event("close")); });
      expect(dialog.open).toBe(true);
      expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"user_message"}));
      await act(async () => resolve({ok:true,snapshot:useSettingsStore.getState().snapshot!}));
      const messages = send.mock.calls.filter(([,message]) => message.type === "user_message");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.[1]).toMatchObject({type:"user_message",text:"plan task",orchestrate:"enable",connectionId:"conn"});
      expect(send.mock.calls.filter(([,message]) => message.type === "set_orchestrate")).toHaveLength(0);
    } finally {
      HTMLDialogElement.prototype.showModal = originalShow;
      useSettingsStore.setState({snapshot:previous.snapshot,setPatch:previous.setPatch});
    }
  });

  it("allows an independent message with the same text while guarding the restored unknown request", async () => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});
    const priorImage = {name:"prior.png",sizeBytes:1,attachment:{mediaType:"image/png" as const,data:"YQ=="}};
    const newImage = {name:"new.png",sizeBytes:1,attachment:{mediaType:"image/png" as const,data:"Yg=="}};
    store.getState().recordSentMessage("same text",[priorImage],"prior-request","enable");
    store.setState({restoredComposerDraft:{text:"same text",images:[newImage]}});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    await mountBody();
    expect(store.getState().orchestrationDeliveries[0]?.status).toBe("pending");
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).toHaveBeenCalledWith("tab",expect.objectContaining({type:"user_message",text:"same text",images:[newImage.attachment]}));
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({requestId:"prior-request",status:"pending",reviewed:false});
    await act(async () => {store.getState().setHostExited(); store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});});
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    expect(store.getState().restoredComposerDraft).toMatchObject({text:"same text",images:[priorImage],deliveryRequestId:"prior-request"});
    const removeIntent = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Remove orchestration intent")!;
    await act(async () => removeIntent.click());
    await act(async () => root.render(createElement("div")));
    await mountBody();
    expect(store.getState().restoredComposerDraft?.deliveryRequestId).toBe("prior-request");
    send.mockClear();
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).not.toHaveBeenCalledWith("tab",expect.objectContaining({type:"user_message"}));
    expect(store.getState().restoredComposerDraft?.deliveryRequestId).toBe("prior-request");
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-reviewed")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).toHaveBeenCalledWith("tab",expect.objectContaining({type:"user_message",text:"same text",images:[priorImage.attachment]}));
  });

  it("allows an independent text-only message with the same text as a pending delivery", async () => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"});
    store.getState().recordSentMessage("same text",[],"prior-request","enable");
    store.setState({restoredComposerDraft:{text:"same text",images:[]}});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).toHaveBeenCalledWith("tab",expect.objectContaining({type:"user_message",text:"same text"}));
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({requestId:"prior-request",status:"pending",reviewed:false});
  });

  it("lets the user discard a linked pending copy and write a separate message", async () => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"});
    store.getState().recordSentMessage("same text",[],"prior-request","enable");
    store.setState({restoredComposerDraft:{text:"same text",images:[],deliveryRequestId:"prior-request"}});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).not.toHaveBeenCalledWith("tab",expect.objectContaining({type:"user_message"}));
    const discard = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Discard this draft and start a new message")!;
    await act(async () => discard.click());
    const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
    await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"same text"); textarea.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).toHaveBeenCalledWith("tab",expect.objectContaining({type:"user_message",text:"same text"}));
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({requestId:"prior-request",status:"pending",reviewed:false});
  });

  it.each(["discard", "send"])("allows restoring again after %s of a copy and a late conflicting outcome", async (action) => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});
    const image = {name:"original.png",sizeBytes:1,attachment:{mediaType:"image/png" as const,data:"YQ=="}};
    store.getState().recordSentMessage("original",[image],"original-request","enable");
    store.getState().markOrchestrationDeliveryUnknown("original-request");
    vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    expect(store.getState().restoredComposerDraft?.deliveryRequestId).toBe("original-request");
    if (action === "discard") {
      const discard = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Discard this draft and start a new message")!;
      await act(async () => discard.click());
    } else {
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-reviewed")!.click());
      const removeIntent = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Remove orchestration intent")!;
      await act(async () => removeIntent.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    }
    expect(store.getState().orchestrationDeliveries[0]?.restored).toBe(true);
    expect(store.getState().restoredComposerDraft?.deliveryRequestId).toBeUndefined();
    await act(async () => {store.getState().applyHostMessage({type:"turn_started",requestId:"original-request",turnId:"late"}); store.getState().applyHostMessage({type:"turn_rejected",requestId:"original-request",reason:"busy"});});
    expect(store.getState().orchestrationDeliveries[0]).toMatchObject({status:"conflict",reviewed:false,restored:true});
    expect(container.querySelector(".orchestration-delivery-restore")).not.toBeNull();
    const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
    const type = async (value:string) => act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,value); textarea.dispatchEvent(new Event("input",{bubbles:true}));});
    await type("new edit");
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    expect(textarea.value).toBe("new edit");
    await type("");
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    expect(store.getState().restoredComposerDraft).toMatchObject({text:"original",images:[image],orchestrate:"enable",deliveryRequestId:"original-request"});
  });

  it("restores an unknown ordinary initial message with its attachment and settings", async () => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});
    const image = {name:"initial.png",sizeBytes:1,attachment:{mediaType:"image/png" as const,data:"YQ=="}};
    store.getState().recordSentMessage("initial",[image],"initial-request",undefined,{model:"m1",mode:"build"});
    store.getState().markOrchestrationDeliveryUnknown("initial-request");
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    expect(store.getState().restoredComposerDraft).toMatchObject({text:"initial",images:[image],initialPicks:{model:"m1",mode:"build"},deliveryRequestId:"initial-request"});
    expect(store.getState().restoredComposerDraft?.orchestrate).toBeUndefined();
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).not.toHaveBeenCalledWith("tab",expect.objectContaining({type:"user_message"}));
    expect(store.getState().orchestrationDeliveries[0]?.status).toBe("unknown");
  });

  it("keeps a restored queued draft from sending after its original turn_started arrives", async () => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});
    const image = {name:"queued.png",sizeBytes:1,attachment:{mediaType:"image/png" as const,data:"YQ=="}};
    store.getState().enqueuePrompt({text:"queued task",images:[image]});
    store.getState().takeQueueHead("original-wire-id");
    store.getState().setPortClosed();
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    await mountBody();
    await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
    expect(store.getState().restoredComposerDraft).toMatchObject({text:"queued task",images:[image],deliveryRequestId:"original-wire-id"});
    await act(async () => store.getState().applyHostMessage({type:"turn_started",requestId:"original-wire-id",turnId:"late"}));
    expect(container.textContent).toContain("Turn started; a restored copy remains");
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    expect(send).not.toHaveBeenCalledWith("tab",expect.objectContaining({type:"user_message"}));
    expect(send).not.toHaveBeenCalledWith("tab",expect.objectContaining({type:"steer_message"}));
    expect(store.getState().restoredComposerDraft?.images).toEqual([image]);
  });

  it("shows an unknown system report without offering to resend it as a user draft", async () => {
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"});
    store.getState().enqueuePrompt({text:"system report",images:[],origin:"system",originId:"report-id"});
    store.getState().takeQueueHead("system-wire-id");
    store.getState().setPortClosed();
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"});
    await mountBody();
    expect(container.textContent).toContain("system report");
    expect(container.textContent).toContain("System report — check session history");
    expect(container.querySelector(".orchestration-delivery-restore")).toBeNull();
    expect(store.getState().orchestrationDeliveries).toMatchObject([{requestId:"system-wire-id",originId:"report-id",status:"unknown"}]);
  });

  it("retains a newly edited recovery send and its attachment when the port closes", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    class Port {
      onmessage: ((event:MessageEvent) => void) | null = null;
      postMessage = vi.fn();
      listeners = new Set<() => void>();
      addEventListener(type:string, listener:() => void) { if (type === "close") this.listeners.add(listener); }
      removeEventListener(type:string, listener:() => void) { if (type === "close") this.listeners.delete(listener); }
      close() { for (const listener of this.listeners) listener(); }
      emit(data:unknown) { this.onmessage!({data} as MessageEvent); }
    }
    const tabId = "edited-recovery-delivery"; const first = new Port();
    tabRegistry.registerPort(tabId,"/ws",first as unknown as MessagePort);
    const target = tabRegistry.getStore(tabId)!;
    const ready = {type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true};
    first.emit(ready);
    const image = {name:"recover.png",sizeBytes:1,attachment:{mediaType:"image/png" as const,data:"YQ=="}};
    target.getState().recordSentMessage("original",[image],"old-request",undefined,{});
    target.getState().markOrchestrationDeliveryUnknown("old-request");
    try {
      await act(async () => root.render(createElement(TabContext.Provider,{value:{tabId,store:target}},createElement(SessionSurface,{tabId,onToast:()=>{}}))));
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-reviewed")!.click());
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"edited retry"); textarea.dispatchEvent(new Event("input",{bubbles:true}));});
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      const sent = first.postMessage.mock.calls.map(([message]) => message as {type:string;requestId?:string;text?:string}).find(message => message.type === "user_message" && message.text === "edited retry")!;
      expect(sent.requestId).toBeTruthy(); expect(sent.requestId).not.toBe("old-request");
      expect(target.getState().orchestrationDeliveries).toMatchObject([{requestId:"old-request",status:"unknown"},{requestId:sent.requestId,text:"edited retry",images:[image],status:"pending"}]);
      await act(async () => first.close());
      expect(target.getState().orchestrationDeliveries[1]).toMatchObject({requestId:sent.requestId,text:"edited retry",images:[image],status:"unknown"});
      const replacement = new Port();
      await act(async () => {tabRegistry.registerPort(tabId,"/ws",replacement as unknown as MessagePort); replacement.emit(ready);});
      expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message"}));
      const row = [...container.querySelectorAll<HTMLElement>('[role="status"]')].find(element => element.textContent?.includes("edited retry"))!;
      await act(async () => row.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
      expect(target.getState().restoredComposerDraft).toMatchObject({text:"edited retry",images:[image],deliveryRequestId:sent.requestId});
    } finally { tabRegistry.disposeTab(tabId); }
  });

  it("binds a recovery draft to the new unknown attempt before a possibly delivered send throws", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    const tabId = "recovery-send-throws";
    const port = {onmessage:null as ((event:MessageEvent) => void) | null,postMessage:vi.fn((message:{type:string}) => {if (message.type === "user_message") throw new Error("synthetic after delivery");}),addEventListener:()=>{},removeEventListener:()=>{}};
    tabRegistry.registerPort(tabId,"/ws",port as unknown as MessagePort);
    const target = tabRegistry.getStore(tabId)!;
    port.onmessage!({data:{type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true}} as MessageEvent);
    const image = {name:"saved.png",sizeBytes:1,attachment:{mediaType:"image/png" as const,data:"YQ=="}};
    target.getState().recordSentMessage("original",[image],"old-request",undefined,{});
    target.getState().markOrchestrationDeliveryUnknown("old-request");
    try {
      await act(async () => root.render(createElement(TabContext.Provider,{value:{tabId,store:target}},createElement(SessionSurface,{tabId,onToast:()=>{}}))));
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-reviewed")!.click());
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      await act(async () => {Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"edited"); textarea.dispatchEvent(new Event("input",{bubbles:true}));});
      await act(async () => {const button=container.querySelector<HTMLButtonElement>(".composer-send")!; button.click(); button.click();});
      const sends = port.postMessage.mock.calls.map(([message]) => message as {type:string;requestId?:string;text?:string}).filter(message => message.type === "user_message");
      expect(sends).toHaveLength(1);
      const attempt = target.getState().orchestrationDeliveries.find(item => item.requestId === sends[0]?.requestId)!;
      expect(attempt).toMatchObject({text:"edited",images:[image],parentRequestId:"old-request",status:"unknown",reviewed:false});
      expect(target.getState().restoredComposerDraft).toMatchObject({text:"edited",images:[image],deliveryRequestId:attempt.requestId});
      expect(textarea.value).toBe("edited");
    } finally {tabRegistry.disposeTab(tabId);}
  });

  it("blocks restoring an ancestor into a second direct retry while its descendant is pending", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    const tabId = "recovery-tree-direct";
    let reentrantClaim: boolean | undefined; let reentrantQueue: boolean | undefined;
    let target!: DesktopStoreApi;
    const port = {onmessage:null as ((event:MessageEvent) => void) | null,postMessage:vi.fn((message:{type:string}) => {
      if (message.type === "user_message") {
        reentrantClaim = target.getState().claimRecoveryAttempt("original","reentrant","same",[],{},{});
        reentrantQueue = target.getState().enqueueRecoveryPrompt("original",{text:"same",images:[]});
      }
    }),addEventListener:()=>{},removeEventListener:()=>{}};
    tabRegistry.registerPort(tabId,"/ws",port as unknown as MessagePort); target = tabRegistry.getStore(tabId)!;
    port.onmessage!({data:{type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"}} as MessageEvent);
    target.getState().recordSentMessage("same",[],"original",undefined,{}); target.getState().markOrchestrationDeliveryUnknown("original");
    target.setState((state) => ({orchestrationDeliveries:state.orchestrationDeliveries.map(item => ({...item,reviewed:true}))}));
    try {
      await act(async () => root.render(createElement(TabContext.Provider,{value:{tabId,store:target}},createElement(SessionSurface,{tabId,onToast:()=>{}}))));
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      const sends = () => port.postMessage.mock.calls.map(([message]) => message as {type:string}).filter(message => message.type === "user_message");
      expect(sends()).toHaveLength(1); expect(reentrantClaim).toBe(false); expect(reentrantQueue).toBe(false);
      expect(target.getState().orchestrationDeliveries).toMatchObject([{requestId:"original",status:"unknown",reviewed:true},{parentRequestId:"original",status:"pending"}]);
      const original = [...container.querySelectorAll<HTMLElement>('[role="status"]')].find(element => element.textContent?.includes("Delivery unknown"))!;
      await act(async () => original.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
      expect(target.getState().restoredComposerDraft).toMatchObject({text:"same",deliveryRequestId:"original"});
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(sends()).toHaveLength(1);
      expect(target.getState().restoredComposerDraft).toMatchObject({text:"same",deliveryRequestId:"original"});
    } finally {tabRegistry.disposeTab(tabId);}
  });

  it("blocks a second mounted recovery while an earlier retry is queued or draining", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    const tabId = "recovery-tree-queued";
    const port = {onmessage:null as ((event:MessageEvent) => void) | null,postMessage:vi.fn(),addEventListener:()=>{},removeEventListener:()=>{}};
    tabRegistry.registerPort(tabId,"/ws",port as unknown as MessagePort); const target = tabRegistry.getStore(tabId)!;
    const emit = (data:unknown) => port.onmessage!({data} as MessageEvent);
    emit({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"});
    target.getState().recordSentMessage("same",[],"original",undefined,{}); target.getState().markOrchestrationDeliveryUnknown("original");
    target.setState((state) => ({orchestrationDeliveries:state.orchestrationDeliveries.map(item => ({...item,reviewed:true}))}));
    let duringDrain: boolean | undefined;
    let attempted = false;
    const unsubscribe = target.subscribe(state => {
      if (!attempted && state.queueInFlight?.item.recoverySourceId === "original") {
        attempted = true; duringDrain = target.getState().claimRecoveryAttempt("original","reentrant-queued","same",[],{},{});
      }
    });
    try {
      await act(async () => root.render(createElement(TabContext.Provider,{value:{tabId,store:target}},createElement(SessionSurface,{tabId,onToast:()=>{}}))));
      await act(async () => emit({type:"turn_started",requestId:"other",turnId:"t1"}));
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(target.getState().promptQueue).toMatchObject([{text:"same",recoverySourceId:"original"}]);
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(target.getState().promptQueue).toHaveLength(1);
      expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message",text:"same"}));
      await act(async () => emit({type:"agent_event",turnId:"t1",event:{type:"loop_end",reason:"completed",turns:1}}));
      const sends = () => port.postMessage.mock.calls.map(([message]) => message as {type:string;text?:string}).filter(message => message.type === "user_message" && message.text === "same");
      expect(sends()).toHaveLength(1); expect(duringDrain).toBe(false);
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(sends()).toHaveLength(1);
      expect(target.getState().restoredComposerDraft).toMatchObject({text:"same",deliveryRequestId:"original"});
    } finally {unsubscribe(); tabRegistry.disposeTab(tabId);}
  });

  it("rechecks the full recovery tree immediately before posting a claimed attempt", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    const tabId = "recovery-tree-prepost";
    const port = {onmessage:null as ((event:MessageEvent) => void) | null,postMessage:vi.fn(),addEventListener:()=>{},removeEventListener:()=>{}};
    tabRegistry.registerPort(tabId,"/ws",port as unknown as MessagePort); const target = tabRegistry.getStore(tabId)!;
    port.onmessage!({data:{type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"}} as MessageEvent);
    target.getState().recordSentMessage("same",[],"original",undefined,{}); target.getState().markOrchestrationDeliveryUnknown("original");
    target.setState((state) => ({orchestrationDeliveries:state.orchestrationDeliveries.map(item => ({...item,reviewed:true}))}));
    let injected = false;
    const unsubscribe = target.subscribe(state => {
      if (!injected && state.orchestrationDeliveries.some(item => item.parentRequestId === "original" && item.status === "pending")) {
        injected = true; target.getState().recordSentMessage("sibling",[],"synthetic-sibling",undefined,{},"original");
      }
    });
    try {
      await act(async () => root.render(createElement(TabContext.Provider,{value:{tabId,store:target}},createElement(SessionSurface,{tabId,onToast:()=>{}}))));
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(injected).toBe(true);
      expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message",text:"same"}));
      expect(target.getState().restoredComposerDraft?.text).toBe("same");
      expect(target.getState().orchestrationDeliveries).toEqual(expect.arrayContaining([expect.objectContaining({requestId:"synthetic-sibling",status:"pending"}),expect.objectContaining({text:"same",parentRequestId:"original",status:"unknown"})]));
    } finally {unsubscribe(); tabRegistry.disposeTab(tabId);}
  });

  it("holds a queued recovery when an ancestor starts after the retry was queued", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    const tabId = "recovery-ancestor-mounted";
    const port = {onmessage:null as ((event:MessageEvent) => void) | null,postMessage:vi.fn(),addEventListener:()=>{},removeEventListener:()=>{}};
    tabRegistry.registerPort(tabId,"/ws",port as unknown as MessagePort);
    const target = tabRegistry.getStore(tabId)!;
    const emit = (data:unknown) => port.onmessage!({data} as MessageEvent);
    emit({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",imageInput:true});
    const image = {name:"saved.png",sizeBytes:1,attachment:{mediaType:"image/png" as const,data:"YQ=="}};
    target.setState({orchestrationDeliveries:[{requestId:"ancestor",text:"original",images:[image],status:"unknown",restored:false,reviewed:true},{requestId:"source",parentRequestId:"ancestor",text:"retry draft",images:[image],status:"rejected",restored:false,reviewed:false}]});
    try {
      await act(async () => root.render(createElement(TabContext.Provider,{value:{tabId,store:target}},createElement(SessionSurface,{tabId,onToast:()=>{}}))));
      const sourceRow = [...container.querySelectorAll<HTMLElement>('[role="status"]')].find(element => element.textContent?.includes("retry draft"))!;
      await act(async () => sourceRow.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
      await act(async () => emit({type:"turn_started",requestId:"other",turnId:"other-turn"}));
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(target.getState().promptQueue).toMatchObject([{text:"retry draft",images:[image],recoverySourceId:"source"}]);
      await act(async () => target.getState().enqueuePrompt({text:"following task",images:[]}));
      await act(async () => emit({type:"turn_started",requestId:"ancestor",turnId:"late-ancestor"}));
      expect(target.getState().promptQueue[0]).toMatchObject({text:"retry draft",images:[image],recoverySourceId:"source",requiresRestore:true});
      await act(async () => emit({type:"agent_event",turnId:"late-ancestor",event:{type:"loop_end",reason:"completed",turns:1}}));
      expect(target.getState().turn).toMatchObject({status:"running",turnId:"other-turn"});
      expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message",text:"following task"}));
      await act(async () => emit({type:"agent_event",turnId:"other-turn",event:{type:"loop_end",reason:"completed",turns:1}}));
      expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message",text:"retry draft"}));
      expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:"user_message",text:"following task"}));
      await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-restore")!.click());
      expect(target.getState().restoredComposerDraft).toMatchObject({text:"retry draft",images:[image],deliveryRequestId:"source"});
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message",text:"retry draft"}));
    } finally {tabRegistry.disposeTab(tabId);}
  });

  it("blocks a system retry when an earlier attempt with the same origin conflicts", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    const tabId = "system-chain-mounted";
    const port = {onmessage:null as ((event:MessageEvent) => void) | null,postMessage:vi.fn(),addEventListener:()=>{},removeEventListener:()=>{}};
    tabRegistry.registerPort(tabId,"/ws",port as unknown as MessagePort);
    const target = tabRegistry.getStore(tabId)!; const emit = (data:unknown) => port.onmessage!({data} as MessageEvent);
    emit({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"});
    try {
      await act(async () => root.render(createElement(TabContext.Provider,{value:{tabId,store:target}},createElement(SessionSurface,{tabId,onToast:()=>{}}))));
      await act(async () => emit({type:"child_report",id:"report-id",text:"system report"}));
      const first = port.postMessage.mock.calls.map(([message]) => message as {type:string;requestId?:string}).find(message => message.type === "user_message")!;
      await act(async () => emit({type:"turn_rejected",requestId:first.requestId,reason:"busy"}));
      await act(async () => container.querySelector<HTMLButtonElement>(".system-delivery-retry")!.click());
      const sends = () => port.postMessage.mock.calls.map(([message]) => message as {type:string;requestId?:string}).filter(message => message.type === "user_message");
      const second = sends()[1]!;
      await act(async () => emit({type:"turn_rejected",requestId:second.requestId,reason:"busy"}));
      await act(async () => emit({type:"turn_started",requestId:first.requestId,turnId:"late-first"}));
      expect(target.getState().orchestrationDeliveries).toMatchObject([{status:"conflict",originId:"report-id"},{status:"rejected",originId:"report-id"}]);
      const button = container.querySelector<HTMLButtonElement>(".system-delivery-retry")!;
      expect(button.disabled).toBe(true);
      await act(async () => {button.click(); target.getState().retryRejectedSystemDelivery(second.requestId!);});
      expect(sends()).toHaveLength(2);
    } finally {tabRegistry.disposeTab(tabId);}
  });

  it("offers a system retry only after a late confirmed rejection", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    class Port {
      onmessage: ((event:MessageEvent) => void) | null = null; postMessage = vi.fn(); listeners = new Set<() => void>();
      addEventListener(type:string, listener:() => void) { if (type === "close") this.listeners.add(listener); }
      removeEventListener(type:string, listener:() => void) { if (type === "close") this.listeners.delete(listener); }
      close() { for (const listener of this.listeners) listener(); }
      emit(data:unknown) { this.onmessage!({data} as MessageEvent); }
    }
    const tabId = "system-retry-mounted"; const first = new Port();
    tabRegistry.registerPort(tabId,"/ws",first as unknown as MessagePort);
    const target = tabRegistry.getStore(tabId)!;
    const ready = {type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"}; first.emit(ready);
    try {
      await act(async () => root.render(createElement(TabContext.Provider,{value:{tabId,store:target}},createElement(SessionSurface,{tabId,onToast:()=>{}}))));
      await act(async () => first.emit({type:"child_report",id:"report-id",text:"system report"}));
      const sent = first.postMessage.mock.calls.map(([message]) => message as {type:string;requestId?:string}).find(message => message.type === "user_message")!;
      await act(async () => first.close());
      const replacement = new Port();
      await act(async () => {tabRegistry.registerPort(tabId,"/ws",replacement as unknown as MessagePort); replacement.emit(ready);});
      expect(container.querySelector(".system-delivery-retry")).toBeNull();
      await act(async () => replacement.emit({type:"turn_rejected",requestId:sent.requestId,reason:"busy"}));
      expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message"}));
      await act(async () => container.querySelector<HTMLButtonElement>(".system-delivery-retry")!.click());
      expect(replacement.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:"user_message",text:"system report",origin:"system"}));
      expect(target.getState().queueInFlight?.item.originId).toBe("report-id");
      expect(container.querySelector(".system-delivery-retry")).toBeNull();
    } finally {tabRegistry.disposeTab(tabId);}
  });

  it("renders the following queued message after a requeued steer is acknowledged", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    const tabId = "requeued-steer-mounted";
    const port = {onmessage:null as ((event:MessageEvent) => void) | null,postMessage:vi.fn(),addEventListener:()=>{},removeEventListener:()=>{}};
    tabRegistry.registerPort(tabId,"/ws",port as unknown as MessagePort);
    const target = tabRegistry.getStore(tabId)!;
    const emit = (data:unknown) => port.onmessage!({data} as MessageEvent);
    emit({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"});
    try {
      await act(async () => root.render(createElement(TabContext.Provider,{value:{tabId,store:target}},createElement(SessionSurface,{tabId,onToast:()=>{}}))));
      await act(async () => {
        emit({type:"turn_started",requestId:"running",turnId:"t1"});
        target.getState().recordPendingSteer("steer-id","steer task",undefined,{text:"steer task",images:[]});
        target.getState().markUiSteer("steer-id");
        emit({type:"steer_requeued",requestId:"steer-id",text:"steer task",reason:"stopped"});
        target.getState().enqueuePrompt({text:"next task",images:[]});
        emit({type:"agent_event",turnId:"t1",event:{type:"loop_end",reason:"completed",turns:1}});
      });
      expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:"user_message",requestId:"steer-id",text:"steer task"}));
      expect(container.textContent).toContain("next task");
      await act(async () => {emit({type:"turn_started",requestId:"steer-id",turnId:"t2"}); emit({type:"agent_event",turnId:"t2",event:{type:"loop_end",reason:"completed",turns:1}});});
      expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:"user_message",text:"next task"}));
    } finally { tabRegistry.disposeTab(tabId); }
  });

  it("holds a posted orchestration as delivery unknown across exit and reconciles late outcomes without overwriting edits", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    const previous = useSettingsStore.getState();
    useSettingsStore.setState({snapshot:{settings:cloneDefaults(),secrets:[],providerReady:true,envOverrides:[],readOnly:false,catalog:[]}});
    const originalShow = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    const makePort = () => ({onmessage:null as ((event:MessageEvent) => void) | null,postMessage:vi.fn(),addEventListener:()=>{},removeEventListener:()=>{}});
    const first = makePort();
    const tabId = "delivery-unknown-test";
    const ready = {type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",orchestration:{enabled:false,available:true,posture:"off" as const},orchestrationProtocol:{version:1 as const,hostIncarnation:"host",connectionId:"conn",atomicSubmit:true,correlatedToggle:true}};
    tabRegistry.registerPort(tabId,"/ws",first as unknown as MessagePort);
    const target = tabRegistry.getStore(tabId)!;
    first.onmessage!({data:ready} as MessageEvent);
    target.setState({composerRolePicker:{id:"picker",task:"original task",forToggle:false,sourceDraft:true},restoredComposerDraft:{text:"original task",images:[]}});
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId,store:target}}, createElement(SessionSurface, {tabId,onToast:() => {}}))));
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-skip"]')!.click());
      const sent = first.postMessage.mock.calls.map(([message]) => message as {type:string;requestId?:string;text?:string}).find(message => message.type === "user_message")!;
      expect(sent).toMatchObject({type:"user_message",text:"original task"});
      expect(target.getState().orchestrationDeliveries).toMatchObject([{requestId:sent.requestId,text:"original task",images:[],orchestrate:"enable",status:"pending"}]);
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(first.postMessage.mock.calls.filter(([message]) => (message as {type:string}).type === "user_message")).toHaveLength(1);
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      const type = async (value:string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,value); textarea.dispatchEvent(new Event("input",{bubbles:true})); }); };
      await type("/orchestrate original task");
      await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
      expect(first.postMessage.mock.calls.filter(([message]) => (message as {type:string}).type === "user_message")).toHaveLength(1);
      const discard = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Discard this draft and start a new message")!;
      await act(async () => discard.click());
      await type("new user edit");
      await act(async () => tabRegistry.markHostExited(tabId));
      expect(target.getState().orchestrationDeliveries[0]?.status).toBe("unknown");
      const replacement = makePort();
      await act(async () => { tabRegistry.registerPort(tabId,"/ws",replacement as unknown as MessagePort); replacement.onmessage!({data:ready} as MessageEvent); });
      expect(container.textContent).toContain("Delivery unknown");
      expect(textarea.value).toBe("new user edit");
      expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message"}));
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
      expect(textarea.value).toBe("new user edit");
      expect(target.getState().orchestrationDeliveries[0]?.restored).toBe(false);
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-reviewed")!.click());
      expect(target.getState().orchestrationDeliveries[0]).toMatchObject({status:"unknown",reviewed:true});
      expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message"}));
      await type("");
      await act(async () => container.querySelector<HTMLButtonElement>(".orchestration-delivery-restore")!.click());
      expect(textarea.value).toBe("original task");
      expect(target.getState().restoredComposerDraft?.orchestrate).toBe("enable");
      expect(target.getState().orchestrationDeliveries[0]?.restored).toBe(true);
      await act(async () => replacement.onmessage!({data:{type:"turn_started",requestId:sent.requestId,turnId:"late-turn"}} as MessageEvent));
      expect(target.getState().orchestrationDeliveries[0]).toMatchObject({status:"started",restored:true});
      expect(textarea.value).toBe("original task");
      expect(container.textContent).toContain("Turn started; a restored copy remains");
      await act(async () => replacement.onmessage!({data:{type:"turn_rejected",requestId:sent.requestId,reason:"busy"}} as MessageEvent));
      expect(target.getState().orchestrationDeliveries[0]?.status).toBe("conflict");
      expect(textarea.value).toBe("original task");
      expect(target.getState().promptQueue).toEqual([]);
      expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message"}));
    } finally {
      tabRegistry.disposeTab(tabId);
      HTMLDialogElement.prototype.showModal = originalShow;
      useSettingsStore.setState({snapshot:previous.snapshot});
    }
  });

  it("retains the task and intent when the host exits before role save resolves", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    const previous = useSettingsStore.getState();
    let resolve!: (value:Awaited<ReturnType<typeof previous.setPatch>>) => void;
    const save = vi.fn(() => new Promise<Awaited<ReturnType<typeof previous.setPatch>>>(done => {resolve = done;}));
    useSettingsStore.setState({snapshot:{settings:cloneDefaults(),secrets:[],providerReady:true,envOverrides:[],readOnly:false,catalog:[]},setPatch:save as typeof previous.setPatch});
    const originalShow = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    const port = {onmessage:null as ((event:MessageEvent) => void) | null,postMessage:vi.fn(),addEventListener:()=>{},removeEventListener:()=>{}};
    const tabId = "role-host-exit-test";
    tabRegistry.registerPort(tabId,"/ws",port as unknown as MessagePort);
    const target = tabRegistry.getStore(tabId)!;
    port.onmessage!({data:{type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",orchestration:{enabled:false,available:true,posture:"off"},orchestrationProtocol:{version:1,hostIncarnation:"host",connectionId:"conn",atomicSubmit:true,correlatedToggle:true}}} as MessageEvent);
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId,store:target}}, createElement(SessionSurface, {tabId,onToast:() => {}}))));
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(textarea,"/orchestrate preserve this task");
        textarea.setSelectionRange(12,12);
        textarea.dispatchEvent(new Event("input",{bubbles:true}));
        textarea.dispatchEvent(new KeyboardEvent("keyup",{bubbles:true,key:"e"}));
      });
      const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent?.includes("Orchestrate"))!;
      await act(async () => option.click());
      const picker = target.getState().composerRolePicker!;
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-save"]')!.click());
      expect(save).toHaveBeenCalledOnce();
      await act(async () => tabRegistry.markHostExited(tabId));
      await act(async () => resolve({ok:true,snapshot:useSettingsStore.getState().snapshot!}));
      expect(target.getState().composerRolePicker).toMatchObject({id:picker.id,task:"preserve this task",forToggle:false});
      expect(target.getState().composerRolePicker?.saveOperation).toBeUndefined();
      expect(target.getState().restoredComposerDraft?.text.trim()).toBe("preserve this task");
      expect(target.getState().restoredComposerDraft?.images).toEqual([]);
      expect(target.getState().notice?.text).toContain("intent are retained");
      expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"set_orchestrate"}));
      expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message"}));
      expect(target.getState().transcript.some(item => item.kind === "user_text")).toBe(false);
      const replacement = {onmessage:null as ((event:MessageEvent) => void) | null,postMessage:vi.fn(),addEventListener:()=>{},removeEventListener:()=>{}};
      await act(async () => { tabRegistry.registerPort(tabId,"/ws",replacement as unknown as MessagePort); replacement.onmessage!({data:{type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"}} as MessageEvent); });
      expect(target.getState().composerRolePicker?.task).toBe("preserve this task");
      expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message"}));
      expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"set_orchestrate"}));
    } finally {
      tabRegistry.disposeTab(tabId);
      HTMLDialogElement.prototype.showModal = originalShow;
      useSettingsStore.setState({snapshot:previous.snapshot,setPatch:previous.setPatch});
    }
  });

  it("retains the picker if the connection disappears during completion claiming", async () => {
    const previous = useSettingsStore.getState();
    const save = vi.fn(async () => ({ok:true as const,snapshot:useSettingsStore.getState().snapshot!}));
    useSettingsStore.setState({snapshot:{settings:cloneDefaults(),secrets:[],providerReady:true,envOverrides:[],readOnly:false,catalog:[]},setPatch:save as typeof previous.setPatch});
    const originalShow = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"});
    store.setState({composerRolePicker:{id:"picker",task:"held task",forToggle:false}});
    const connection = {};
    vi.mocked(tabRegistry.getLiveHostConnection).mockImplementation((_tabId,target) => target.getState().composerRolePicker?.completionClaim ? null : connection);
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"a",store}}, createElement(SessionSurface, {tabId:"a",onToast:() => {}}))));
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-save"]')!.click());
      expect(store.getState().composerRolePicker).toMatchObject({id:"picker",task:"held task",forToggle:false});
      expect(store.getState().composerRolePicker?.completionClaim).toBeUndefined();
      expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"set_orchestrate"}));
      expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"user_message"}));
      expect(store.getState().transcript.some(item => item.kind === "user_text")).toBe(false);
    } finally {
      HTMLDialogElement.prototype.showModal = originalShow;
      useSettingsStore.setState({snapshot:previous.snapshot,setPatch:previous.setPatch});
    }
  });

  it("does not auto-send a saved task onto a replacement host connection", async () => {
    vi.mocked(tabRegistry.getLiveHostConnection).mockRestore();
    const previous = useSettingsStore.getState();
    let resolve!: (value:Awaited<ReturnType<typeof previous.setPatch>>) => void;
    const save = vi.fn(() => new Promise<Awaited<ReturnType<typeof previous.setPatch>>>(done => {resolve = done;}));
    useSettingsStore.setState({snapshot:{settings:cloneDefaults(),secrets:[],providerReady:true,envOverrides:[],readOnly:false,catalog:[]},setPatch:save as typeof previous.setPatch});
    const originalShow = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    const makePort = () => ({onmessage:null as ((event:MessageEvent) => void) | null,postMessage:vi.fn(),addEventListener:()=>{},removeEventListener:()=>{}});
    const first = makePort();
    const tabId = "role-reconnect-test";
    const ready = {type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1"};
    tabRegistry.registerPort(tabId,"/ws",first as unknown as MessagePort);
    const target = tabRegistry.getStore(tabId)!;
    first.onmessage!({data:ready} as MessageEvent);
    target.setState({composerRolePicker:{id:"picker",task:"held task",forToggle:false}});
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId,store:target}}, createElement(SessionSurface, {tabId,onToast:() => {}}))));
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-save"]')!.click());
      const replacement = makePort();
      await act(async () => {
        tabRegistry.markHostExited(tabId);
        tabRegistry.registerPort(tabId,"/ws",replacement as unknown as MessagePort);
        replacement.onmessage!({data:ready} as MessageEvent);
      });
      await act(async () => resolve({ok:true,snapshot:useSettingsStore.getState().snapshot!}));
      expect(target.getState().composerRolePicker).toMatchObject({id:"picker",task:"held task",forToggle:false});
      expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"user_message"}));
      expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type:"set_orchestrate"}));
      expect(target.getState().notice?.text).toContain("intent are retained");
    } finally {
      tabRegistry.disposeTab(tabId);
      HTMLDialogElement.prototype.showModal = originalShow;
      useSettingsStore.setState({snapshot:previous.snapshot,setPatch:previous.setPatch});
    }
  });

  it("retains the role picker when a save outcome is not confirmed", async () => {
    const previous = useSettingsStore.getState();
    let reject!: (error:Error) => void;
    const save = vi.fn(() => new Promise<Awaited<ReturnType<typeof previous.setPatch>>>((_done,fail) => {reject = fail;}));
    useSettingsStore.setState({snapshot:{settings:cloneDefaults(),secrets:[],providerReady:true,envOverrides:[],readOnly:false,catalog:[]},setPatch:save as typeof previous.setPatch});
    const originalShow = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",orchestration:{enabled:false,available:true,posture:"off"},orchestrationProtocol:{version:1,hostIncarnation:"host",connectionId:"conn",atomicSubmit:true,correlatedToggle:true}});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    try {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId:"a",store}}, createElement(SessionSurface, {tabId:"a",onToast:() => {}}))));
      await act(async () => container.querySelector<HTMLButtonElement>(".mode-chip")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mode-menu-orchestrate"]')!.click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-save"]')!.click());
      await act(async () => reject(new Error("disconnected")));
      expect(store.getState().notice?.text).toContain("not confirmed");
      expect(store.getState().composerRolePicker?.saveOperation).toBeUndefined();
      expect(container.querySelector<HTMLButtonElement>('[data-testid="role-picker-save"]')!.disabled).toBe(false);
      expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"set_orchestrate"}));
      expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"user_message"}));
    } finally {
      HTMLDialogElement.prototype.showModal = originalShow;
      useSettingsStore.setState({snapshot:previous.snapshot,setPatch:previous.setPatch});
    }
  });

  it("ignores a delayed save result for an older picker after a replacement opens", async () => {
    const previous = useSettingsStore.getState();
    let resolve!: (value:Awaited<ReturnType<typeof previous.setPatch>>) => void;
    const save = vi.fn(() => new Promise<Awaited<ReturnType<typeof previous.setPatch>>>(done => {resolve = done;}));
    useSettingsStore.setState({snapshot:{settings:cloneDefaults(),secrets:[],providerReady:true,envOverrides:[],readOnly:false,catalog:[]},setPatch:save as typeof previous.setPatch});
    const originalShow = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    const other = createDesktopStore();
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",orchestration:{enabled:false,available:true,posture:"off"},orchestrationProtocol:{version:1,hostIncarnation:"host",connectionId:"conn",atomicSubmit:true,correlatedToggle:true}});
    const send = vi.spyOn(tabRegistry,"sendToTab").mockImplementation(() => {});
    const renderTab = async (tabId: string, target: DesktopStoreApi) => {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId,store:target}}, createElement(SessionSurface, {tabId,onToast:() => {}}))));
    };
    const openPicker = async () => {
      await act(async () => container.querySelector<HTMLButtonElement>(".mode-chip")!.click());
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mode-menu-orchestrate"]')!.click());
    };
    try {
      await renderTab("a",store);
      await openPicker();
      const oldId = store.getState().composerRolePicker!.id;
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="role-picker-save"]')!.click());
      await renderTab("b",other);
      // Simulate a host/session reset invalidating the old picker while its
      // non-cancellable settings write is still in flight.
      store.setState({composerRolePicker:null});
      await renderTab("a",store);
      await openPicker();
      const newId = store.getState().composerRolePicker!.id;
      expect(newId).not.toBe(oldId);
      await act(async () => resolve({ok:true,snapshot:useSettingsStore.getState().snapshot!}));
      expect(store.getState().composerRolePicker?.id).toBe(newId);
      expect(container.querySelector('[data-testid="role-picker-save"]')).not.toBeNull();
      expect(send).not.toHaveBeenCalledWith("a",expect.objectContaining({type:"set_orchestrate"}));
    } finally {
      HTMLDialogElement.prototype.showModal = originalShow;
      useSettingsStore.setState({snapshot:previous.snapshot,setPatch:previous.setPatch});
    }
  });

  it("restores an unfinished context window edit only in its owning tab", async () => {
    const originalSnapshot = useSettingsStore.getState().snapshot;
    useSettingsStore.setState({snapshot:{settings:cloneDefaults(),secrets:[],providerReady:true,envOverrides:[],readOnly:false,catalog:[]}});
    const originalShow = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    const other = createDesktopStore();
    const ready = (sessionId:string) => ({type:"host_ready" as const,workspace:"/ws",sessionId,mode:"build" as const,model:"m1",contextUsage:{estimatedTokens:25,budgetTokens:100,source:"provider" as const}});
    store.getState().applyHostMessage(ready("a"));
    other.getState().applyHostMessage(ready("b"));
    store.setState({contextWindowDraft:{id:"editor-a",connection:{id:"a-connection",providerId:"custom:a"},model:"m1"}});
    other.setState({contextWindowDraft:{id:"editor-b",connection:{id:"b-connection",providerId:"custom:b"},model:"m2",raw:"32000"}});
    const renderTab = async (tabId: string, target: DesktopStoreApi) => {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId,store:target}}, createElement(SessionSurface, {tabId,onToast:() => {}}))));
      await vi.waitFor(() => expect(container.querySelector('[aria-label="Context window (tokens)"]')).not.toBeNull(), {timeout:10000, interval:25});
    };
    try {
      await renderTab("a",store);
      const input = container.querySelector<HTMLInputElement>('[aria-label="Context window (tokens)"]')!;
      expect(input).toBeTruthy();
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"96000"); input.dispatchEvent(new Event("input",{bubbles:true})); });
      await renderTab("b",other);
      expect(container.querySelector<HTMLInputElement>('[aria-label="Context window (tokens)"]')!.value).toBe("32000");
      await renderTab("a",store);
      expect(container.querySelector<HTMLInputElement>('[aria-label="Context window (tokens)"]')!.value).toBe("96000");
      expect(other.getState().contextWindowDraft?.raw).toBe("32000");
    } finally {
      HTMLDialogElement.prototype.showModal = originalShow;
      useSettingsStore.setState({snapshot:originalSnapshot});
    }
  });

  it("preserves separate unsaved queue edits across tab switches, even with identical item IDs", async () => {
    const other = createDesktopStore();
    store.setState({queuePaused:true,promptQueue:[{id:"same-id",text:"queued A",images:[]}]});
    other.setState({queuePaused:true,promptQueue:[{id:"same-id",text:"queued B",images:[]}]});
    const renderTab = async (tabId: string, target: DesktopStoreApi) => {
      await act(async () => root.render(createElement(TabContext.Provider, {value:{tabId,store:target}}, createElement(SessionSurface, {tabId,onToast:() => {}}))));
    };
    const edit = async (value: string) => {
      const field = container.querySelector<HTMLTextAreaElement>(".prompt-queue-edit-textarea")!;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(field,value); field.dispatchEvent(new Event("input",{bubbles:true})); });
    };
    await renderTab("a",store);
    await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-edit-button")!.click());
    await edit("unsaved A");
    await renderTab("b",other);
    await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-edit-button")!.click());
    await edit("unsaved B");
    await renderTab("a",store);
    expect(container.querySelector<HTMLTextAreaElement>(".prompt-queue-edit-textarea")!.value).toBe("unsaved A");
    expect(store.getState().promptQueue[0]?.text).toBe("queued A");
    expect(other.getState().queueEditDraft).toEqual({id:"same-id",text:"unsaved B"});
    await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-save")!.click());
    expect(store.getState().promptQueue[0]?.text).toBe("unsaved A");
    await renderTab("b",other);
    expect(container.querySelector<HTMLTextAreaElement>(".prompt-queue-edit-textarea")!.value).toBe("unsaved B");
    await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-cancel")!.click());
    expect(other.getState().promptQueue[0]?.text).toBe("queued B");
    expect(other.getState().queueEditDraft).toBeNull();
  });

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
    store.getState().applyHostMessage({type:"host_ready",workspace:"/ws",sessionId:"a",mode:"build",model:"m1",orchestration:{enabled:false,available:true,posture:"off"},orchestrationProtocol:{version:1,hostIncarnation:"host",connectionId:"conn",atomicSubmit:true,correlatedToggle:true},imageInput:true});
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

  it.each(["button", "shortcut"])("closes Review using the %s", async (method) => {
    await mountBody();
    await act(async () => {
      store.getState().gitSetPanelOpen(true);
      useDockStore.getState().open({ id: "git", kind: "git", title: "Review" });
    });
    await act(async () => {
      if (method === "button") container.querySelector<HTMLButtonElement>('[aria-label="Close Review"]')!.click();
      else container.querySelector<HTMLElement>(".dock-panel")!.dispatchEvent(new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true }));
    });
    expect(store.getState().git.panelOpen).toBe(false);
  });

  it("preserves Markdown view mode and scroll when switching dock tabs", async () => {
    await mountBody();
    await act(async () => {
      usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "md", previews: [{ previewId: "md", tabId: "tab", url: "file:///doc.md", sourcePath: "/doc.md", title: "doc.md", status: "ready", container: "panel", viewKind: "dom-md" }] });
    });
    await act(async () => useDockStore.getState().open({ id: "git", kind: "git", title: "Review" }));
    await act(async () => useDockStore.getState().focus("preview:md"));
    const source = container.querySelector<HTMLButtonElement>('[aria-label="Source"]')!;
    await act(async () => source.click());
    const body = container.querySelector<HTMLElement>(".md-preview-view-body")!;
    body.scrollTop = 120;
    await act(async () => useDockStore.getState().focus("git"));
    await act(async () => useDockStore.getState().focus("preview:md"));
    expect(container.querySelector('[aria-label="Source"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector<HTMLElement>(".md-preview-view-body")).toBe(body);
    expect(body.scrollTop).toBe(120);
    await act(async () => useDockStore.getState().focus("git"));
    await act(async () => useDockStore.getState().splitRight("preview:md", true));
    expect(container.querySelector<HTMLElement>(".md-preview-view-body")).toBe(body);
    await act(async () => useDockStore.getState().focus("preview:md"));
    expect(container.querySelector<HTMLElement>(".md-preview-view-body")).toBe(body);
  });

  it("updates a preview tab title without changing focus", async () => {
    await mountBody();
    const preview = { previewId: "web", tabId: "tab", url: "http://localhost/", title: "First", status: "ready" as const, container: "panel" as const, viewKind: "web" as const };
    await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "web", previews: [preview] }));
    await act(async () => useDockStore.getState().open({ id: "git", kind: "git", title: "Review" }));
    await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "web", previews: [{ ...preview, title: "Second" }] }));
    expect(container.querySelector('[data-tab-id="preview:web"] .dock-tab-title')?.textContent).toBe("Second");
    expect(useDockStore.getState().activeTabId).toBe("git");
  });

  it("focuses an existing preview when its artifact link is clicked", async () => {
    const preview = vi.fn().mockResolvedValue({ ok: true, value: { previewId: "md" } });
    const artifacts = new Proxy({ preview }, { get(target, key) { return Reflect.get(target, key) ?? anyBridge; } });
    (window as { anycode?: unknown }).anycode = new Proxy(anyBridge as object, { get(target, key) { return key === "artifacts" ? artifacts : Reflect.get(target, key); } });
    try {
      useDockStore.setState({ ownerTabId: "tab", tabs: [{ id: "preview:md", kind: "preview", title: "doc.md" }, { id: "git", kind: "git", title: "Review" }], activeTabId: "git" });
      await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(Markdown, { text: "[doc](/doc.md)" }))));
      await act(async () => container.querySelector<HTMLAnchorElement>("a.md-link")!.click());
      expect(preview).toHaveBeenCalledWith("tab", "/doc.md");
      expect(useDockStore.getState().activeTabId).toBe("preview:md");
    } finally {
      (window as { anycode?: unknown }).anycode = anyBridge;
    }
  });

  it("clears the hidden subagent menu and ignores its shortcut", async () => {
    const menu = () => createElement(ModeMenu, { mode: "build", disabled: false, onChange: () => {} });
    const child = createDesktopStore();
    child.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", sessionId: "child", mode: "build", model: "m1" });
    const surface = createElement(TabContext.Provider, { value: { tabId: "child", store: child } }, createElement(SessionSurface, { tabId: "child", onToast: () => {} }));
    useDockStore.setState({ ownerTabId: "tab", tabs: [{ id: "subagents", kind: "subagents", title: "Subagents" }, { id: "git", kind: "git", title: "Review" }], activeTabId: "subagents" });
    await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } },
      menu(), createElement(DockPanel, { mode: "column", width: 640, canSplitNow: true, splitTabId: null, onToast: () => {}, subagents: { rows: [{ spawnToolCallId: "child", badge: "running", card: { agentType: "worker", description: "", model: null, engine: null, turns: 0, toolCalls: 0, lastTool: null, activity: [], activityDropped: 0, final: null } }], expandedId: "child", surface } }))));
    await act(async () => window.dispatchEvent(new Event(FOCUS_MODE_MENU_EVENT)));
    expect(container.querySelectorAll(".mode-menu-popover")).toHaveLength(2);
    expect(isOverlayOpen()).toBe(true);
    await act(async () => useDockStore.getState().focus("git"));
    await act(async () => container.querySelector<HTMLElement>(".mode-menu-popover")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(isOverlayOpen()).toBe(false);
    await act(async () => window.dispatchEvent(new Event(FOCUS_MODE_MENU_EVENT)));
    expect(container.querySelectorAll(".mode-menu-popover")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLElement>(".mode-menu-popover")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(isOverlayOpen()).toBe(false);
  });

  it("selects the right neighbour when the active preview closes", async () => {
    const select = vi.fn().mockResolvedValue({ ok: true });
    const previewPanel = new Proxy({ select, close: vi.fn().mockResolvedValue({ ok: true }) }, { get(target, key) { return Reflect.get(target, key) ?? anyBridge; } });
    (window as { anycode?: unknown }).anycode = new Proxy(anyBridge as object, { get(target, key) { return key === "previewPanel" ? previewPanel : Reflect.get(target, key); } });
    try {
      await mountBody();
      const previews = ["a", "b", "c"].map((id) => ({ previewId: id, tabId: "tab", url: `http://localhost/${id}`, title: id, status: "ready" as const, container: "panel" as const, viewKind: "web" as const }));
      await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "b", previews }));
      await act(async () => useDockStore.getState().open({ id: "git", kind: "git", title: "Review" }));
      await act(async () => useDockStore.getState().focus("preview:b"));
      const order = useDockStore.getState().tabs.map(tab => tab.id);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close b"]')!.click());
      expect(useDockStore.getState().activeTabId).toBe("preview:b");
      expect(useDockStore.getState().tabs.map(tab => tab.id)).toEqual(order);
      await act(async () => usePreviewStore.getState().applyChanged({ tabId: "tab", visiblePanelPreviewId: "a", previews: [previews[0]!, previews[2]!] }));
      expect(useDockStore.getState().activeTabId).toBe("preview:c");
      expect(select).toHaveBeenCalledWith("tab", "c");
    } finally {
      (window as { anycode?: unknown }).anycode = anyBridge;
    }
  });
});
