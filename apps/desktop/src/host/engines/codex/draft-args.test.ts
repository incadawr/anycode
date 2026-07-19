import { describe, expect, it } from "vitest";
import { parseCodexEngineArgs } from "./draft-args.js";

describe("parseCodexEngineArgs", () => {
  it("reads both flag forms", () => {
    expect(parseCodexEngineArgs(["--session", "s1", "--engine-model", "gpt-5.6-sol", "--engine-preset=approve-for-me"])).toEqual({
      model: "gpt-5.6-sol",
      preset: "approve-for-me",
    });
  });

  it("is absent when the flags are not passed (the core host argv is unchanged)", () => {
    expect(parseCodexEngineArgs(["--resume", "s1"])).toEqual({});
    expect(parseCodexEngineArgs([])).toEqual({});
  });

  it("drops values that cannot be an id, rather than forwarding junk to the engine", () => {
    expect(parseCodexEngineArgs(["--engine-model", ""])).toEqual({});
    expect(parseCodexEngineArgs(["--engine-model", "   "])).toEqual({});
    expect(parseCodexEngineArgs(["--engine-model", "a b"])).toEqual({});
    expect(parseCodexEngineArgs(["--engine-model", "x".repeat(129)])).toEqual({});
    // A flag with no value must not swallow the next flag as its value.
    expect(parseCodexEngineArgs(["--engine-model"])).toEqual({});
  });

  it("never accepts a policy/config payload — only the two id flags exist", () => {
    const args = parseCodexEngineArgs([
      "--engine-preset=ask",
      "--engine-sandbox",
      "danger-full-access",
      "--engine-config",
      '{"approvalPolicy":"never"}',
    ]);
    expect(args).toEqual({ preset: "ask" });
  });
});
