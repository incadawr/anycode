import { describe, expect, it } from "vitest";
import type { LspServerStatus } from "@anycode/core";
import { hasCrashedLspServer } from "./lsp-status.js";

function server(overrides: Partial<LspServerStatus> = {}): LspServerStatus {
  return { name: "typescript", state: "ready", extensions: [".ts"], stderrTail: "", ...overrides };
}

describe("hasCrashedLspServer", () => {
  it("is false for an empty list", () => {
    expect(hasCrashedLspServer([])).toBe(false);
  });

  it("is false when every server is healthy (ready + initializing)", () => {
    expect(
      hasCrashedLspServer([server({ state: "ready" }), server({ name: "py", state: "initializing" })]),
    ).toBe(false);
  });

  it("is true only when at least one server crashed", () => {
    expect(hasCrashedLspServer([server({ state: "ready" }), server({ name: "py", state: "crashed" })])).toBe(true);
  });
});
