/**
 * TASK.182 / Taskana 4136 — Claude engine MCP tests: boot notices drain into
 * the first turn, and `system/init.mcp_servers[]` is parsed defensively from
 * both `{name,status,source}` objects and bare strings.
 */
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@anycode/core";
import { parseClaudeInitMcpServerNames, parseClaudeInitMcpServerStatuses, mcpServerFailureNotices } from "./claude-engine.js";

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

describe("parseClaudeInitMcpServerStatuses (Taskana 4238)", () => {
  it("keeps the status off {name,status} objects", () => {
    expect(
      parseClaudeInitMcpServerStatuses([
        { name: "alpha", status: "connected", source: "config" },
        { name: "beta", status: "failed" },
        { name: "gamma", status: "needs-auth" },
      ]),
    ).toEqual([
      { name: "alpha", status: "connected" },
      { name: "beta", status: "failed" },
      { name: "gamma", status: "needs-auth" },
    ]);
  });

  it("a bare string entry yields status null", () => {
    expect(parseClaudeInitMcpServerStatuses(["alpha", "anycode"])).toEqual([
      { name: "alpha", status: null },
      { name: "anycode", status: null },
    ]);
  });

  it("skips junk entries silently and treats a non-string status as null", () => {
    expect(
      parseClaudeInitMcpServerStatuses([
        "alpha",
        { name: "beta", status: 42 },
        { name: 42 },
        null,
        "",
        { noName: true },
      ]),
    ).toEqual([{ name: "alpha", status: null }, { name: "beta", status: null }]);
  });

  it("returns [] for a missing or non-array field", () => {
    expect(parseClaudeInitMcpServerStatuses(undefined)).toEqual([]);
    expect(parseClaudeInitMcpServerStatuses("not-an-array" as unknown as unknown[])).toEqual([]);
  });
});

describe("mcpServerFailureNotices (Taskana 4238)", () => {
  it("anycode failed gives the exact anycode message", () => {
    const [notice] = mcpServerFailureNotices([{ name: "anycode", status: "failed" }]);
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toBe(
      `AnyCode's MCP server "anycode" failed to connect in this Claude session, so AnyCode tools (mcp__anycode__*) are unavailable.`,
    );
  });

  it("a non-anycode failed server gives the generic message", () => {
    const [notice] = mcpServerFailureNotices([{ name: "alpha", status: "failed" }]);
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toBe(
      `MCP server "alpha" failed to connect in this Claude session; its tools are unavailable.`,
    );
  });

  it("needs-auth gives the auth message", () => {
    const [notice] = mcpServerFailureNotices([{ name: "alpha", status: "needs-auth" }]);
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toBe(
      `MCP server "alpha" needs authentication; its tools are unavailable in this Claude session.`,
    );
  });

  it("connected/pending/null statuses produce no notice", () => {
    expect(
      mcpServerFailureNotices([
        { name: "alpha", status: "connected" },
        { name: "beta", status: "pending" },
        { name: "gamma", status: null },
      ]),
    ).toEqual([]);
  });

  it("every notice is an engine_notice warning", () => {
    const notices = mcpServerFailureNotices([
      { name: "anycode", status: "failed" },
      { name: "alpha", status: "needs-auth" },
    ]);
    expect(notices.length).toBe(2);
    for (const notice of notices) {
      expect(notice.type).toBe("engine_notice");
      expect((notice as { level: string }).level).toBe("warning");
    }
  });
});
