import { describe, expect, it, vi } from "vitest";
import { AgentLoop, SessionPermissionRules } from "@anycode/core";
import { buildClaudeLaunchOptions, buildCodexLaunchOptions, buildCoreLaunchOptions } from "./engine-launch-options.js";
import { createBridgePresentationStamp } from "./engines/claude/bridge-presentation-stamp.js";
import { ClaudeMcpBridge } from "./engines/claude/mcp-bridge.js";
import { CodexDynamicToolBridge } from "./engines/codex/dynamic-tool-bridge.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { createHarness, MemFs } from "./test-harness.js";

function inputs() {
  return {
    workspace: "/workspace", binaryPath: "/validated/engine", sourceEnv: { PATH: "/login/bin" },
    broker: new IpcPermissionBroker(() => {}), binaryTrust: vi.fn(() => null),
  };
}

describe("shared engine launch options", () => {
  it("preserves Codex boot services, profile guards, MCP and child posture", () => {
    const common = inputs();
    const rules = new SessionPermissionRules();
    const fs = new MemFs();
    const homeTrust = vi.fn(() => null);
    const agentBridge = new CodexDynamicToolBridge([], undefined);
    const servers = { local: { command: "tool" } };
    const ownership = { hostPid: 10, generation: 2, report: vi.fn() };
    const options = buildCodexLaunchOptions({
      ...common, rules, fs, agentBridge, processOwnership: ownership,
      profile: { home: "/profile", homeTrust }, tempDir: "/private/child-temp",
      child: { parentSessionId: "parent", spawnToolCallId: "call", initialMode: "edit", maxTurns: 12 },
      forwardOptions: { mcpForward: { servers } },
    });
    expect(options.broker).toBe(common.broker);
    expect(options.agentBridge).toBe(agentBridge);
    expect(options.processOwnership).toBe(ownership);
    expect(options.patchAutoApproval).toEqual({ fs, rules, workspaceWritesAllowed: true });
    expect(options.cwd).toBe(common.workspace);
    expect(options.codexHome).toBe("/profile");
    expect(options.homeTrust).toBe(homeTrust);
    expect(options.binaryTrust).toBe(common.binaryTrust);
    expect(options.mcpForward?.servers).toBe(servers);
    expect(options.tempDir).toBe("/private/child-temp");
    expect(options.bootNotices).toEqual([expect.objectContaining({ message: expect.stringContaining("maxTurns (12) is not enforced") })]);
    expect(homeTrust).not.toHaveBeenCalled();
    common.sourceEnv.PATH = "/changed";
    expect(options.sourceEnv.PATH).toBe("/login/bin");
  });

  it("keeps a root Codex boot without child write grants, temp or profile overrides", () => {
    const options = buildCodexLaunchOptions({ ...inputs(), fs: new MemFs(), rules: new SessionPermissionRules(), profile: null, forwardOptions: {} });
    expect(options.patchAutoApproval?.workspaceWritesAllowed).toBe(false);
    expect(options).not.toHaveProperty("tempDir");
    expect(options).not.toHaveProperty("codexHome");
    expect(options).not.toHaveProperty("bootNotices");
  });

  it("preserves Claude's bridge presentation lifecycle and root-only slash handling", () => {
    const common = inputs();
    const stamp = createBridgePresentationStamp({ catalog: [], resolveCallCatalog: async () => [], onEvent: () => {} });
    const mcpBridge = new ClaudeMcpBridge({ serverName: "anycode", version: "1", listTools: stamp.listTools, callTool: stamp.callTool });
    const ctx = { ...common, projectTrusted: false, profileDir: "/profile", mcpConfigPath: "/mcp.json", bootNotices: [], mcpBridge, stamp, agentCatalogNonEmpty: true };
    const root = buildClaudeLaunchOptions(ctx);
    expect(root.broker).toBe(common.broker);
    expect(root.mcpBridge).toBe(mcpBridge);
    expect(root.takePresentation).toBe(stamp.takePresentation);
    expect(root.dropPresentations).toBe(stamp.dropPresentations);
    expect(root.projectTrusted).toBe(false);
    expect(root.mcpConfigPath).toBe("/mcp.json");
    expect(root.agentBridgePrompt).toBeDefined();
    expect(root.enableSlashPassthrough).toBe(true);
    const child = buildClaudeLaunchOptions({ ...ctx, child: { parentSessionId: "parent", spawnToolCallId: "call", initialMode: "plan", maxTurns: 7 } });
    expect(child.enableSlashPassthrough).toBe(false);
    expect(child.maxTurns).toBe(7);
    common.sourceEnv.PATH = "/changed";
    expect(root.sourceEnv.PATH).toBe("/login/bin");
  });

  it("keeps the core loop, mutable config and control hooks shared exactly as at boot", () => {
    const h = createHarness({ steps: [] });
    try {
      const hook = vi.fn();
      const loop = new AgentLoop(h.config);
      const options = buildCoreLaunchOptions({ config: h.config, loop }, { onReasoningEffortSet: hook });
      expect(options.loop).toBe(loop);
      expect(options.config).toBe(h.config);
      expect(options.onReasoningEffortSet).toBe(hook);
    } finally { h.close(); }
  });
});
