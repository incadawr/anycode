import { describe, expect, it } from "vitest";
import type { LspServerStatus } from "@anycode/core";
import { formatLspExtensions, formatLspState, formatLspSummary } from "./LspPanel.js";

describe("LspPanel pure helpers", () => {
  it("formats LSP states for compact badges", () => {
    expect(formatLspState("not_started")).toBe("Not started");
    expect(formatLspState("initializing")).toBe("Initializing");
    expect(formatLspState("ready")).toBe("Ready");
    expect(formatLspState("crashed")).toBe("Crashed");
    expect(formatLspState("disposed")).toBe("Disposed");
  });

  it("formats extension lists without overflowing empty state text", () => {
    expect(formatLspExtensions([".ts", ".tsx"])).toBe(".ts, .tsx");
    expect(formatLspExtensions([])).toBe("-");
  });
});

// ── header summary counts (P7.25/F3 W2, design §3 W2) ──

function server(overrides: Partial<LspServerStatus> = {}): LspServerStatus {
  return {
    name: "typescript",
    state: "ready",
    extensions: [".ts", ".tsx"],
    stderrTail: "",
    ...overrides,
  };
}

describe("formatLspSummary", () => {
  it("returns an empty string for no servers — the one honest reading shared by an absent seam and an empty config", () => {
    expect(formatLspSummary([])).toBe("");
  });

  it("counts a single state, reusing the formatLspState vocabulary (lowercased)", () => {
    expect(formatLspSummary([server({ state: "ready" })])).toBe("1 ready");
    expect(formatLspSummary([server({ state: "crashed" })])).toBe("1 crashed");
  });

  it("orders multiple states ready-first regardless of input order, separated by middot", () => {
    const servers = [
      server({ name: "a", state: "crashed" }),
      server({ name: "b", state: "ready" }),
      server({ name: "c", state: "ready" }),
    ];
    expect(formatLspSummary(servers)).toBe("2 ready · 1 crashed");
  });

  it("includes every present state in the fixed order, skipping absent ones", () => {
    const servers = [
      server({ name: "a", state: "not_started" }),
      server({ name: "b", state: "initializing" }),
      server({ name: "c", state: "crashed" }),
      server({ name: "d", state: "disposed" }),
    ];
    expect(formatLspSummary(servers)).toBe("1 initializing · 1 crashed · 1 disposed · 1 not started");
  });
});
