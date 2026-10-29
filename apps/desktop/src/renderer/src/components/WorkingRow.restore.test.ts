import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createDesktopStore } from "../store.js";
import { MessageList } from "./MessageList.js";

it("renders the host clock after reconnect and remount, including background time", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(35_000);
    const store = createDesktopStore();
    store.getState().applyHostMessage({ type: "host_ready", workspace: "/ws", mode: "build", model: "m", sessionId: "s" });
    store.getState().applyHostMessage({ type: "turn_started", requestId: "r", turnId: "t", startedAt: 10_000 });
    const render = () => renderToStaticMarkup(createElement(MessageList, {
      blocks: store.getState().transcript, turn: store.getState().turn, workspace: "/ws", connection: "ready",
      retry: null, onTryAgain: () => {}, continueOffer: null, onContinue: () => {}, promptQueueLength: 0,
    }));
    expect(render()).toContain("25s");
    vi.setSystemTime(45_000);
    store.getState().applyHostMessage({ type: "turn_started", requestId: "r", turnId: "t", startedAt: 10_000 });
    expect(render()).toContain("35s");
  } finally { vi.useRealTimers(); }
});
