import { describe, expect, it } from "vitest";
import { worktreeExitControlState } from "./SessionHeader.js";

describe("worktreeExitControlState", () => {
  it("disables Exit with an accessible running-turn explanation", () => {
    expect(worktreeExitControlState("running", "ready")).toEqual({
      disabled: true,
      title: "Exit worktree is unavailable while a turn is running",
      ariaLabel: "Exit worktree unavailable while a turn is running",
    });
  });

  it.each(["awaiting_port", "awaiting_host_ready", "host_exited"] as const)(
    "disables Exit while the connection is %s",
    (connection) => {
      expect(worktreeExitControlState("idle", connection)).toEqual({
        disabled: true,
        title: "Exit worktree is unavailable until the host connection is ready",
        ariaLabel: "Exit worktree unavailable until the host connection is ready",
      });
    },
  );

  it("enables Exit only for an idle turn on a ready connection", () => {
    expect(worktreeExitControlState("idle", "ready")).toEqual({
      disabled: false,
      title: "Exit worktree; clean AnyCode-owned worktrees are removed automatically",
      ariaLabel: "Exit worktree",
    });
  });
});
