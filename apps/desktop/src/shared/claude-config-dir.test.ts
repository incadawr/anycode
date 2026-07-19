import { describe, expect, it } from "vitest";
import { resolveClaudeConfigDir } from "./claude-config-dir.js";

describe("resolveClaudeConfigDir", () => {
  it("no override -> undefined (ambient default: do not set CLAUDE_CONFIG_DIR at all)", () => {
    expect(resolveClaudeConfigDir()).toBeUndefined();
    expect(resolveClaudeConfigDir(undefined)).toBeUndefined();
  });

  it("a blank override is treated the same as no override", () => {
    expect(resolveClaudeConfigDir("")).toBeUndefined();
    expect(resolveClaudeConfigDir("   ")).toBeUndefined();
  });

  it("a non-blank override is returned verbatim, trimmed", () => {
    expect(resolveClaudeConfigDir("/tmp/some-profile")).toBe("/tmp/some-profile");
    expect(resolveClaudeConfigDir("  /tmp/some-profile  ")).toBe("/tmp/some-profile");
  });
});
