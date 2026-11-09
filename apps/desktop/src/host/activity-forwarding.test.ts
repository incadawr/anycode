import { describe, expect, it, vi } from "vitest";
import { forwardSessionActivity } from "./activity-forwarding.js";

describe("activity forwarding", () => {
  it("forwards snapshots and supports state-only notifications", () => {
    const post = vi.fn();
    forwardSessionActivity({ observeActivity(listener) {
      listener("running");
      listener("waiting_network", { state: "waiting_network", networkWait: { source: "parent" } });
    } }, post);
    expect(post).toHaveBeenNthCalledWith(1, { type: "session_activity", state: "running" });
    expect(post).toHaveBeenNthCalledWith(2, { type: "session_activity", state: "waiting_network", snapshot: { state: "waiting_network", networkWait: { source: "parent" } } });
  });
});
