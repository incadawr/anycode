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

async function scenario(childSurface: boolean, supported: boolean, image = false) {
  Object.defineProperty(window, "anycode", { configurable: true, value: { listSessions: async () => [] } });
  const store = createDesktopStore();
  store.setState({ connection: "ready", childSurface, steering: { supported, ready: true }, turn: { status: "running", turnId: "turn", requestId: "original" } });
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
    const message = send.mock.calls.map(call => call[1]).find(m => m.type === "steer_message" || m.type === "user_message");
    expect(message?.type).toBe(supported && !image ? "steer_message" : "user_message");
    expect(store.getState().pendingSteers).toHaveLength(1);
    expect(store.getState().transcript.filter(b => b.kind === "user_text")).toHaveLength(0);
    expect(container.textContent).toContain(supported && !image ? "Queued — next safe boundary" : "Queued — delivered after this turn");
  } finally { await act(async () => root.unmount()); }
}
it("routes a running Core child at the seam", async () => scenario(true, true));
it("keeps root seam routing", async () => scenario(false, true));
it("queues an unsupported child for the next turn", async () => scenario(true, false));
it("queues a child image for the next turn", async () => scenario(true, true, true));
