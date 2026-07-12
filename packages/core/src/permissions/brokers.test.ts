/** Permission brokers: fail-closed DenyPermissionBroker and test-only AllowAll. */

import { describe, expect, it } from "vitest";
import { AllowAllPermissionBroker, DenyPermissionBroker } from "./brokers.js";
import type { PermissionRequest } from "../types/permissions.js";
import type { ToolMetadata } from "../types/tools.js";

const metadata: ToolMetadata = {
  name: "Bash",
  description: "fake",
  readOnly: false,
  destructive: true,
  concurrentSafe: false,
  riskLevel: "high",
  sideEffectScope: "process",
  needsApproval: true,
  timeoutMs: 120_000,
};

function request(toolName: string): PermissionRequest {
  return { toolName, input: {}, metadata: { ...metadata, name: toolName }, mode: "build" };
}

describe("DenyPermissionBroker", () => {
  const broker = new DenyPermissionBroker();

  it("always denies with a reason naming the tool", async () => {
    for (const toolName of ["Bash", "Write", "Edit"]) {
      const decision = await broker.requestPermission(request(toolName));
      expect(decision.behavior).toBe("deny");
      if (decision.behavior === "deny") {
        expect(decision.reason).toContain(toolName);
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("AllowAllPermissionBroker", () => {
  it("always allows", async () => {
    const decision = await new AllowAllPermissionBroker().requestPermission(request("Write"));
    expect(decision).toEqual({ behavior: "allow" });
  });
});
