/**
 * Mirrors codex/draft-args.test.ts, for the same reason the module itself is a
 * deliberate duplicate: argv is UNTRUSTED renderer input, and the two readers
 * must be held to the same bounds independently.
 */

import { describe, expect, it } from "vitest";
import { parseClaudeEngineArgs } from "./draft-args.js";

describe("parseClaudeEngineArgs", () => {
  it("reads both flag forms", () => {
    expect(parseClaudeEngineArgs(["--session", "s1", "--engine-model", "opus[1m]", "--engine-preset=read-only"])).toEqual({
      model: "opus[1m]",
      preset: "read-only",
    });
  });

  it("is absent when the flags are not passed (the core host argv is unchanged)", () => {
    expect(parseClaudeEngineArgs(["--resume", "s1"])).toEqual({});
    expect(parseClaudeEngineArgs([])).toEqual({});
  });

  it("drops values that cannot be an id, rather than forwarding junk to the engine", () => {
    expect(parseClaudeEngineArgs(["--engine-model", ""])).toEqual({});
    expect(parseClaudeEngineArgs(["--engine-model", "   "])).toEqual({});
    expect(parseClaudeEngineArgs(["--engine-model", "a b"])).toEqual({});
    expect(parseClaudeEngineArgs(["--engine-model", "x".repeat(129)])).toEqual({});
    // A flag with no value must not swallow the next flag as its value.
    expect(parseClaudeEngineArgs(["--engine-model"])).toEqual({});
  });

  it("accepts the bracketed model ids the live catalog actually ships (`opus[1m]`) — they carry no whitespace", () => {
    expect(parseClaudeEngineArgs(["--engine-model=claude-fable-5[1m]"])).toEqual({ model: "claude-fable-5[1m]" });
  });

  it("never accepts a policy/config payload — only the two id flags exist", () => {
    const args = parseClaudeEngineArgs([
      "--engine-preset=workspace",
      "--permission-mode",
      "bypassPermissions",
      "--engine-config",
      '{"permissionMode":"dontAsk"}',
    ]);
    expect(args).toEqual({ preset: "workspace" });
  });

  it("takes the FIRST occurrence of a repeated flag (a later duplicate cannot override the earlier one)", () => {
    expect(parseClaudeEngineArgs(["--engine-preset", "read-only", "--engine-preset", "workspace"])).toEqual({
      preset: "read-only",
    });
  });
});
