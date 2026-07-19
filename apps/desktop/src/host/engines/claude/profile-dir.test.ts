/**
 * The anti-drift pin for the host plane's copy of the AnyCode Claude profile
 * path. The failure this guards against is not a wrong string in the abstract:
 * if the host spawned against a different `CLAUDE_CONFIG_DIR` than main's
 * doctor diagnosed, the doctor would report "ready" for a signed-in profile
 * while every turn ran against a signed-out one.
 */

import { describe, expect, it } from "vitest";
import { defaultClaudeProfileDir as mainAuthority } from "../../../main/claude-binary.js";
import { defaultClaudeProfileDir as hostCopy } from "./profile-dir.js";

describe("defaultClaudeProfileDir (host copy) matches main's authority", () => {
  it("agrees on both platform branches", () => {
    for (const [home, platform] of [
      ["/home/me", "linux"],
      ["/Users/me", "darwin"],
      ["C:\\Users\\me", "win32"],
    ] as const) {
      expect(hostCopy(home, platform)).toBe(mainAuthority(home, platform));
    }
  });

  it("is the fixed single AnyCode profile, never the ambient ~/.claude (cut invariant C1)", () => {
    expect(hostCopy("/home/me", "linux")).toBe("/home/me/.anycode/claude/profile-default");
    expect(hostCopy("/home/me", "linux")).not.toContain("/.claude/");
  });
});
