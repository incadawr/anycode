/**
 * Pure-logic tests for the turn-completion notification gate (design
 * slice-R8-cut §1.2/§5.2). `.test.ts` under a node (no-jsdom) vitest env: no
 * `localStorage`/`Notification` globals are stubbed — the exports here fail
 * open / stay pure without them.
 */
import { describe, expect, it } from "vitest";
import { notificationBody, readTurnNotifyEnabled, shouldNotifyTurnEnd, TURN_NOTIFY_KEY } from "./notifications.js";

describe("shouldNotifyTurnEnd", () => {
  it("fires on a running->idle transition while hidden or blurred", () => {
    expect(shouldNotifyTurnEnd("running", "idle", true, true, true)).toBe(true);
    expect(shouldNotifyTurnEnd("running", "idle", false, false, true)).toBe(true);
  });

  it("does not fire when visible and focused", () => {
    expect(shouldNotifyTurnEnd("running", "idle", false, true, true)).toBe(false);
  });

  it("does not fire without a running->idle transition", () => {
    expect(shouldNotifyTurnEnd("idle", "idle", true, false, true)).toBe(false);
    expect(shouldNotifyTurnEnd("running", "running", true, false, true)).toBe(false);
    expect(shouldNotifyTurnEnd("idle", "running", true, false, true)).toBe(false);
  });

  it("does not fire when disabled", () => {
    expect(shouldNotifyTurnEnd("running", "idle", true, false, false)).toBe(false);
  });
});

describe("notificationBody", () => {
  it("prefers a non-blank title over the workspace", () => {
    expect(notificationBody("Fix bug", "/a/b")).toBe("Fix bug");
  });

  it("falls through a blank/whitespace title to the workspace", () => {
    expect(notificationBody("", "/a/b")).toBe("b");
    expect(notificationBody("   ", "/a/b")).toBe("b");
  });

  it("derives the workspace leaf name, stripping trailing separators", () => {
    expect(notificationBody(undefined, "/Users/x/proj")).toBe("proj");
    expect(notificationBody(undefined, "/a/b/")).toBe("b");
    expect(notificationBody(undefined, "C:\\repo\\app")).toBe("app");
  });

  it("falls back to the neutral constant with no title or workspace", () => {
    expect(notificationBody(undefined, null)).toBe("Agent task");
    expect(notificationBody(undefined, "///")).toBe("Agent task");
  });
});

describe("TURN_NOTIFY_KEY", () => {
  it("is the namespaced localStorage key", () => {
    expect(TURN_NOTIFY_KEY).toBe("anycode.notifications.turnComplete");
  });
});

describe("readTurnNotifyEnabled", () => {
  it("fails open to true when localStorage is unavailable", () => {
    expect(readTurnNotifyEnabled()).toBe(true);
  });
});
