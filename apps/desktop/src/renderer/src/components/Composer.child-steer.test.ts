// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";
import { TabContext } from "../tab-context.js";
import { createDesktopStore } from "../store.js";
import { tabRegistry } from "../tab-registry.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

async function scenario(childSurface: boolean, supported: boolean, image = false, ready = true) {
  const seam = supported && !image && (!childSurface || ready);
  Object.defineProperty(window, "anycode", { configurable: true, value: { listSessions: async () => [] } });
  const store = createDesktopStore();
  store.setState({ connection: "ready", childSurface, steering: { supported, ready }, turn: { status: "running", turnId: "turn", requestId: "original" } });
  const connection = {};
  vi.spyOn(tabRegistry, "getLiveHostConnection").mockReturnValue(connection as never);
  const send = vi.spyOn(tabRegistry, "sendToTab").mockImplementation(() => {});
  if (image) store.getState().enqueuePrompt({ text: "hello", images: [{ name: "a.png", sizeBytes: 3, attachment: { mediaType: "image/png", data: "YWJj" } }], requiresRestore: true });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(TabContext.Provider, { value: { tabId: "tab", store } }, createElement(Composer))));
  try {
    if (image) await act(async () => container.querySelector<HTMLButtonElement>(".prompt-queue-restore")!.click());
    else {
      const textarea = container.querySelector<HTMLTextAreaElement>(".composer-textarea")!;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "hello"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    }
    await act(async () => container.querySelector<HTMLButtonElement>(".composer-send")!.click());
    const sent = send.mock.calls.map(call => call[1]).filter(m => m.type === "steer_message" || m.type === "user_message");
    expect(sent).toHaveLength(1);
    const message = sent[0]!;
    expect(message.type).toBe(seam ? "steer_message" : "user_message");
    if (image && message.type === "user_message") expect(message.images).toEqual([{ mediaType: "image/png", data: "YWJj" }]);
    expect(store.getState().pendingSteers).toHaveLength(1);
    expect(store.getState().transcript.filter(b => b.kind === "user_text")).toHaveLength(0);
    expect(container.textContent).toContain(seam ? "Queued — next safe boundary" : "Queued — delivered after this turn");
  } finally { await act(async () => root.unmount()); }
}
it("routes a running Core child at the seam", async () => scenario(true, true));
it("keeps root seam routing", async () => scenario(false, true));
it("queues an unsupported child for the next turn", async () => scenario(true, false));
it("queues a child image for the next turn", async () => scenario(true, true, true));
it("sends a not-ready child as a host-owned user message, not a seam steer", async () => scenario(true, true, false, false));
it("keeps a root steer on the seam even before the loop reports ready", async () => scenario(false, true, false, false));
