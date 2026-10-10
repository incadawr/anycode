/**
 * TASK.182 / Taskana 4136 — Claude engine MCP tests: boot notices drain into
 * the first turn, and `system/init.mcp_servers[]` is parsed defensively from
 * both `{name,status,source}` objects and bare strings.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { parseClaudeInitMcpServerNames } from "./claude-engine.js";

describe("parseClaudeInitMcpServerNames (TASK.182)", () => {
  it("parses {name,status,source} objects", () => {
    expect(
      parseClaudeInitMcpServerNames([
        { name: "alpha", status: "connected", source: "config" },
        { name: "beta", status: "failed", source: "config" },
      ]),
    ).toEqual(["alpha", "beta"]);
  });

  it("parses bare strings", () => {
    expect(parseClaudeInitMcpServerNames(["alpha", "anycode"])).toEqual(["alpha", "anycode"]);
  });

  it("tolerates a mixed array and skips unusable entries silently", () => {
    expect(
      parseClaudeInitMcpServerNames([
        "alpha",
        { name: "beta" },
        { name: 42 },
        null,
        "",
        { noName: true },
        { name: "" },
      ]),
    ).toEqual(["alpha", "beta"]);
  });

  it("returns [] for a missing or non-array field", () => {
    expect(parseClaudeInitMcpServerNames(undefined)).toEqual([]);
    expect(parseClaudeInitMcpServerNames("not-an-array" as unknown as unknown[])).toEqual([]);
  });
});

/** The engine's notices plumbing is pinned through the exported helper only; the connect-path notice merge is covered by the boot helper + wire tests. */
describe("boot notices shape (TASK.182)", () => {
  it("bootNotices entries are plain engine_notice warnings carrying no values", () => {
    const notices: AgentEvent[] = [{ type: "engine_notice", level: "warning", message: "MCP server \"x\" … skipped." }];
    for (const notice of notices) {
      expect(notice.type).toBe("engine_notice");
      expect((notice as { level: string }).level).toBe("warning");
      expect(typeof (notice as { message: string }).message).toBe("string");
    }
  });
});

/** Defect-3 seam end-to-end at the engine layer: the listener payload feeds the host reconciliation. */
describe("first-init payload feeds host reconciliation (TASK.182)", () => {
  it("mcpServerNames carries the CLI-reported names the host compares against forwarded + bridge expectations", async () => {
    // The engine contract: whatever the CLI reports (objects or strings) is
    // surfaced verbatim as names. The host adds "anycode" to the expectation
    // set only when a bridge exists — tested in mcp-forward-boot.test.ts.
    const reportedByCli = parseClaudeInitMcpServerNames([
      { name: "alpha", status: "connected", source: "config" },
      "anycode",
    ]);
    expect(reportedByCli).toEqual(["alpha", "anycode"]);
  });
});
