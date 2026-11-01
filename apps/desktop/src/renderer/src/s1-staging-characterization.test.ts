/**
 * Synthetic S1 prerequisites. The two expected failures exercise the real
 * renderer store and mark missing safety properties; they must be converted to
 * ordinary passing tests when immutable staging and the posture gate land.
 * They do not enable the future feature or assert that current loss is valid.
 */
import { describe, expect, it } from "vitest";
import type { HostToUiMessage } from "../../shared/protocol.js";
import { createCoreSessionTitlePersistence } from "../../host/session-title-persistence.js";
import { createDesktopStore } from "./store.js";

const ready: HostToUiMessage = { type: "host_ready", workspace: "/synthetic", sessionId: "synthetic", mode: "build", model: "synthetic", reasoningEffort: "off" };
const image = { name: "synthetic.png", sizeBytes: 1, attachment: { mediaType: "image/png" as const, data: "YQ==" } };

describe("S1 prerequisites: current renderer limitations", () => {
  it.fails("retains an ordinary unacknowledged direct payload and image as unknown after reconnect", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    store.getState().recordSentMessage("direct-draft", [image], "direct-id");
    store.getState().setPortClosed();
    store.getState().applyHostMessage(ready);
    expect(store.getState().orchestrationDeliveries).toMatchObject([{ requestId: "direct-id", text: "direct-draft", images: [image], status: "unknown" }]);
  });

  it.fails("retains an unacknowledged steer payload and image as unknown after reconnect", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    store.getState().recordPendingSteer("steer-id", "steer-draft", [image.attachment], { text: "steer-draft", images: [image] });
    store.getState().setPortClosed();
    store.getState().applyHostMessage(ready);
    expect(store.getState().orchestrationDeliveries).toMatchObject([{ requestId: "steer-id", text: "steer-draft", images: [image], status: "unknown" }]);
  });

  it("a paused queue does not act as a posture gate for a system report", () => {
    const store = createDesktopStore({ schedule: () => {} });
    store.getState().applyHostMessage(ready);
    store.getState().enqueuePrompt({ text: "synthetic-report", images: [], origin: "system", originId: "child-report" });
    store.setState({ queuePaused: true, queuePauseReason: "error" });
    expect(store.getState().takeQueueHead("synthetic-run")).toMatchObject({ text: "synthetic-report", origin: "system", originId: "child-report" });
    expect(store.getState().queueInFlight?.requestId).toBe("synthetic-run");
  });

  it("the real fail-soft mode touch resolves even when its backing write fails", async () => {
    let failures = 0;
    const persistence = createCoreSessionTitlePersistence({
      adapter: () => ({ touchSession: async () => { throw new Error("synthetic write failure"); } }),
      sessionId: "synthetic",
      onError: () => { failures++; },
    });
    await expect(persistence.touch({ mode: "plan" })).resolves.toBeUndefined();
    expect(failures).toBe(1);
  });
});
