/**
 * Pure-logic tests for WorkspaceTrustDialog (Taskana 4736). Same no-jsdom
 * rationale as the other component tests: the copy and the decision payload
 * are pure, the native <dialog> is not rendered here.
 */
import { describe, expect, it } from "vitest";
import { describeWorkspaceTrust, workspaceTrustDecisionRequest } from "./WorkspaceTrustDialog.js";
import type { WorkspaceTrustRequest } from "../store.js";

const ITEMS: WorkspaceTrustRequest["items"] = [
  { kind: "mcp", name: "lint", commandLine: "node lint.js", source: "/proj/.anycode/config.json", envKeys: ["TOKEN"] },
  { kind: "hook", name: "PreToolUse", commandLine: "echo guard", source: "/proj/.anycode/config.json", envKeys: [] },
];

describe("describeWorkspaceTrust", () => {
  it("names the folder, counts the declarations, and lists each command line", () => {
    const copy = describeWorkspaceTrust({ state: "unknown", workspace: "/proj", items: ITEMS });
    expect(copy.title).toBe("Trust this project's configuration?");
    expect(copy.intro).toContain("2 process");
    expect(copy.intro).toContain("/proj");
    expect(copy.rows).toEqual([
      "[mcp] lint: node lint.js (env: TOKEN)",
      "[hook] PreToolUse: echo guard",
    ]);
    expect(copy.changedLine).toBeNull();
  });

  it("says plainly when the configuration changed since the last decision", () => {
    const copy = describeWorkspaceTrust({ state: "changed", workspace: "/proj", items: ITEMS });
    expect(copy.changedLine).toContain("changed since you last decided");
  });

  it("never renders env values, only KEY names", () => {
    const copy = describeWorkspaceTrust({
      state: "unknown",
      workspace: "/proj",
      items: [{ ...ITEMS[0]!, envKeys: ["TOKEN", "REGION"] }],
    });
    expect(copy.rows[0]).toBe("[mcp] lint: node lint.js (env: TOKEN, REGION)");
  });

  it("offers Trust, Trust once and Don't trust, in that order", () => {
    const copy = describeWorkspaceTrust({ state: "unknown", workspace: "/proj", items: ITEMS });
    expect(copy.buttons).toEqual(["Trust", "Trust once", "Don't trust"]);
  });
});

describe("workspaceTrustDecisionRequest", () => {
  it("carries the tab id and the decision ONLY — never a path or a hash", () => {
    const request = workspaceTrustDecisionRequest("tab-7", "once");
    expect(request).toEqual({ tabId: "tab-7", decision: "once" });
    expect(Object.keys(request).sort()).toEqual(["decision", "tabId"]);
    expect(JSON.stringify(request)).not.toMatch(/\//);
  });
});
