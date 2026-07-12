import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyToolDefinition } from "../types/tools.js";
import { createDefaultToolRegistry, ToolRegistry } from "./registry.js";

function fakeTool(name: string): AnyToolDefinition {
  return {
    metadata: {
      name,
      description: "fake tool for registry tests",
      readOnly: true,
      destructive: false,
      concurrentSafe: true,
      riskLevel: "low",
      sideEffectScope: "none",
      needsApproval: false,
      timeoutMs: 1000,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: {} as any,
    handler: async () => ({ ok: true, output: undefined }),
  };
}

describe("ToolRegistry", () => {
  it("register/get/has/list/all/getMetadata/unregister round-trip", () => {
    const registry = new ToolRegistry();
    const tool = fakeTool("Fake");

    expect(registry.has("Fake")).toBe(false);
    registry.register(tool);
    expect(registry.has("Fake")).toBe(true);
    expect(registry.get("Fake")).toBe(tool);
    expect(registry.list()).toEqual(["Fake"]);
    expect(registry.all()).toEqual([tool]);
    expect(registry.getMetadata("Fake")).toEqual(tool.metadata);

    registry.unregister("Fake");
    expect(registry.has("Fake")).toBe(false);
    expect(registry.get("Fake")).toBeUndefined();
  });

  describe("duplicate registration", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("warns on duplicate registration by default", () => {
      const registry = new ToolRegistry();
      registry.register(fakeTool("Dup"));
      registry.register(fakeTool("Dup"));
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("stays silent when silentDuplicateWarning is set", () => {
      const registry = new ToolRegistry();
      registry.register(fakeTool("Dup"));
      registry.register(fakeTool("Dup"), { silentDuplicateWarning: true });
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe("createDefaultToolRegistry", () => {
  it("registers exactly the twelve built-in tools (five Phase 0 + four Phase 1 + Agent + Skill + Workflow)", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.list().sort()).toEqual([
      "Agent",
      "Bash",
      "Edit",
      "Glob",
      "Grep",
      "Read",
      "Skill",
      "TodoRead",
      "TodoWrite",
      "WebFetch",
      "Workflow",
      "Write",
    ]);
  });
});
