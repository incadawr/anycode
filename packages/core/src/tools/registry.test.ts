import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyToolDefinition } from "../types/tools.js";
import { renderToolDisciplineSection } from "../prompts/system.js";
import { createDefaultToolRegistry, ToolRegistry } from "./registry.js";
import { createWebSearchTool } from "./web-search.js";

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
  it("registers exactly the thirteen built-in tools by default", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.list().sort()).toEqual([
      "Agent",
      "AgentStatus",
      "Bash",
      "Edit",
      "Git",
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
    expect(registry.has("ArchMap")).toBe(false);
  });

  it("registers ArchMap as the fourteenth built-in when opts.archMap is true", () => {
    const registry = createDefaultToolRegistry({ archMap: true });
    expect(registry.list().sort()).toEqual([
      "Agent",
      "AgentStatus",
      "ArchMap",
      "Bash",
      "Edit",
      "Git",
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
    expect(registry.get("ArchMap")?.metadata.readOnly).toBe(true);
  });

  // Taskana 4162: with the flag off, the default tool list AND the system
  // prompt's tool-discipline section must be byte-identical to the
  // pre-ArchMap baseline (commit e89e3d76 — the v0.0.35 release). The twelve
  // names below are pinned in REGISTRATION ORDER; the tool-discipline section
  // is rendered by the real renderToolDisciplineSection over exactly that
  // snapshot, so any drift in either (a reordered registration, a renamed
  // tool, a thirteenth default) turns this red.
  it("flag off: default tool names match the system-prompt tool section", () => {
    const registry = createDefaultToolRegistry();
    const toolNames = registry.list();
    expect(toolNames).toEqual([
      "Read",
      "Git",
      "Write",
      "Edit",
      "Bash",
      "Grep",
      "Glob",
      "TodoRead",
      "TodoWrite",
      "WebFetch",
      "Agent",
      "AgentStatus",
      "Skill",
      "Workflow",
    ]);
    expect(renderToolDisciplineSection(toolNames)).toBe(
      [
        "The tools you may call are exactly those in the `tools` array of the CURRENT request; trust it over anything you remember — it can shrink between turns, e.g. when an MCP server reconnects.",
        "Do not call a tool absent from it or assume a capability exists because another product offers one; your only tools are those named to you, `mcp__*` included.",
        "If none of your tools cover a need, use Bash where that fits; otherwise tell the user plainly you cannot do it — never invent a tool name to paper over the gap.",
        "These are the tools available to you as this session begins:",
        "Agent, AgentStatus, Bash, Edit, Git, Glob, Grep, Read, Skill, TodoRead, TodoWrite, WebFetch, Workflow, Write",
      ].join("\n"),
    );
    // And the flag-on registry differs from the baseline ONLY by ArchMap.
    const flagOn = createDefaultToolRegistry({ archMap: true }).list();
    expect(flagOn).toEqual([...toolNames, "ArchMap"]);
  });

  it("without options WebSearch is absent (byte-compat pinned: no backend, no tool)", () => {
    const registry = createDefaultToolRegistry();
    expect(registry.get("WebSearch")).toBeUndefined();
    expect(registry.has("WebSearch")).toBe(false);
  });

  it("with webSearch the tool is registered after WebFetch and the other names are undisturbed", () => {
    const webSearch = createWebSearchTool({
      kind: "searxng",
      endpoint: "http://127.0.0.1:8888",
      headers: {},
      maxResults: 5,
    });
    const registry = createDefaultToolRegistry({ webSearch });

    expect(registry.get("WebSearch")).toBe(webSearch);
    expect(registry.has("WebFetch")).toBe(true);
    // Same order as the no-backend registry, with WebSearch spliced in right
    // after WebFetch — registration order of the other names is undisturbed.
    expect(registry.list()).toEqual([
      "Read",
      "Git",
      "Write",
      "Edit",
      "Bash",
      "Grep",
      "Glob",
      "TodoRead",
      "TodoWrite",
      "WebFetch",
      "WebSearch",
      "Agent",
      "AgentStatus",
      "Skill",
      "Workflow",
    ]);
  });
});
