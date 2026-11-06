import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { discoverAgentProfiles, NodeFileSystemAdapter, type SessionSubagentPort } from "@anycode/core";
import { buildAgentProfileRoots } from "@anycode/core/subagents-admin";
import { cloneDefaults } from "../settings/schema.js";
import { createBridgePresentationStamp } from "./engines/claude/bridge-presentation-stamp.js";
import { claudeAgentPermissionMode } from "./engines/child-permission-map.js";
import { createForeignOrchestrationComposition } from "./foreign-orchestration-composition.js";
import { bridgeCallableCatalog } from "./role-catalog.js";
import { CodexDynamicToolBridge } from "./engines/codex/dynamic-tool-bridge.js";
import { RoleHealthCache } from "./role-route.js";
import { createRoutedChildComposition } from "./routed-child-composition.js";

const validProfile = "---\ndescription: Restricted executor\ntools: Read\n---\nRead the source.";

describe.each(["boot", "candidate", "codex"] as const)("Native %s catalog discovery", path => {
  it.for(["read", "stat", "directory", "parse", "ancestor-access"] as const)("refuses %s failures before builtin substitution and recovers after repair", async (failure, context) => {
    if (failure === "ancestor-access") {
      if (process.getuid?.() === 0) context.skip("Root bypasses directory permission checks");
      if (process.platform === "win32") context.skip("Requires POSIX directory permissions");
    }
    const root = await mkdtemp(join(tmpdir(), "catalog-discovery-"));
    const workspace = join(root, "workspace"), home = join(root, "home");
    const fs = new NodeFileSystemAdapter();
    const file = join(workspace, ".anycode", "agents", "executor.md");
    const roots = buildAgentProfileRoots(workspace, home, []);
    await fs.writeFile(file, validProfile);
    const health = new RoleHealthCache();
    const routed = createRoutedChildComposition({ health, describeError: String, resolve: () => null, prepare: req => req, record: () => {}, deliver: () => {}, report: () => {} });
    const settings = cloneDefaults();
    settings.provider.connections = [{ id: "api", providerId: "custom", model: "model" }];
    settings.provider.activeConnectionId = "api";
    const composition = createForeignOrchestrationComposition({
      settings: () => settings, profiles: () => discoverAgentProfiles(fs, roots),
      projectRoot: workspace, health, routed, preset: () => "workspace", permissionMode: claudeAgentPermissionMode, restrictedCatalog: () => true,
    });
    const run = vi.fn<SessionSubagentPort["run"]>().mockImplementation(async req => ({ status: "completed", finalText: "done", turns: 1, toolCalls: 0, durationMs: 1, truncated: false, childSessionId: "child", parentSessionId: "parent", spawnToolCallId: req.spawnToolCallId }));
    const port: SessionSubagentPort = { run, send: async () => ({ ok: false, reason: "unavailable", message: "unused" }) };
    await fs.writeFile(join(home, ".anycode", "agents", "notes.md"), "---\nname: notes\n---\nNotes");
    // Boot accepts valid profiles while discovery still reports the broken one.
    expect((await discoverAgentProfiles(fs, roots)).problems.length).toBeGreaterThan(0);
    const catalog = await composition.catalog();
    if (path === "codex") {
      const bridge = new CodexDynamicToolBridge(catalog, port, undefined, composition.catalog, undefined, composition.call);
      const response = { result: vi.fn(), error: vi.fn() };
      await bridge.handle({ id: 1, method: "item/tool/call", params: { threadId: "t", turnId: "u", callId: "c", tool: "anycode_agent", arguments: { agent_type: "executor", description: "task", prompt: "work" } } }, response, { threadId: "t", turnId: "u" }, () => {});
      expect(response.result).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    } else {
      expect(await composition.call({ agent_type: "executor", description: "task", prompt: "work" }, { catalog, port, spawnToolCallId: "ordinary" })).toMatchObject({ isError: false });
    }
    run.mockClear();
    await rm(join(home, ".anycode", "agents", "notes.md"));
    expect(catalog.find(entry => entry.name === "executor")?.restrictions?.tools).toEqual(["Read", "ListConnections"]);
    const stamp = createBridgePresentationStamp({
      catalog, port, callAgent: composition.call, restricted: composition.isEnabled, onEvent: () => {},
      resolveCallCatalog: path === "candidate" ? composition.catalog : async () => bridgeCallableCatalog(catalog, await composition.catalog()),
    });
    const call = () => stamp.callTool("agent", { agent_type: "executor", description: "Read source", prompt: "Read source", detach: false }, new AbortController().signal, { toolUseId: "call" });
    composition.captureMode("build");
    let restore: () => void | Promise<void> = () => {};
    try {
      if (failure === "ancestor-access") {
        const parent = join(workspace, ".anycode");
        const mode = (await stat(parent)).mode & 0o777;
        restore = () => chmod(parent, mode);
        await chmod(parent, 0o000);
        await expect(fs.readdir(join(parent, "agents"))).rejects.toMatchObject({ code: "EACCES" });
        expect(await fs.exists(join(parent, "agents"))).toBe(false);
      } else if (failure === "parse") {
        await fs.writeFile(file, "---\ndescription: Broken executor\nengine: claude\ntools: Read\n---\nBody");
      } else {
        const operation = failure === "read" ? "readFile" : failure === "stat" ? "stat" : "readdir";
        const spy = vi.spyOn(fs, operation).mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
        restore = () => spy.mockRestore();
      }
      // Real discovery records the error and omits executor. The catalog must
      // reject that result both during initial construction and on a live call.
      const discovered = await discoverAgentProfiles(fs, roots);
      expect(discovered.problems.length).toBeGreaterThan(0);
      expect(discovered.profiles.find(profile => profile.name === "executor")).toBeUndefined();
      await expect(composition.catalog()).rejects.toThrow("Could not read or validate");
      expect(await call()).toMatchObject({ isError: true, text: expect.stringContaining("delegation was refused") });
      expect(run).not.toHaveBeenCalled();

      await restore();
      await fs.writeFile(file, validProfile);
      expect(await call()).toMatchObject({ isError: false });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]![0]).toMatchObject({ connectionId: "api", restrictions: { tools: ["Read", "ListConnections"] } });
    } finally {
      await restore();
      await rm(root, { recursive: true, force: true });
    }
  });
});


it.each(["toggle", "runtime"] as const)("keeps Codex Orchestrate discovery fail-soft after %s capture", async capture => {
  const root = await mkdtemp(join(tmpdir(), "codex-catalog-"));
  try {
    const workspace = join(root, "workspace"), home = join(root, "home");
    const fs = new NodeFileSystemAdapter();
    const roots = buildAgentProfileRoots(workspace, home, []);
    await fs.writeFile(join(workspace, ".anycode", "agents", "executor.md"), validProfile);
    await fs.writeFile(join(home, ".anycode", "agents", "notes.md"), "---\nname: notes\n---\nNotes");
    expect((await discoverAgentProfiles(fs, roots)).problems.length).toBeGreaterThan(0);
    const settings = cloneDefaults();
    settings.provider.connections = [{ id: "api", providerId: "custom", model: "model" }];
    settings.provider.activeConnectionId = "api";
    const health = new RoleHealthCache();
    const routed = createRoutedChildComposition({ health, describeError: String, resolve: () => null, prepare: req => req, record: () => {}, deliver: () => {}, report: () => {} });
    const composition = createForeignOrchestrationComposition({
      settings: () => settings, profiles: () => discoverAgentProfiles(fs, roots),
      projectRoot: workspace, health, routed, preset: () => "workspace",
    });
    const run = vi.fn<SessionSubagentPort["run"]>().mockImplementation(async req => ({ status: "completed", finalText: "done", turns: 1, toolCalls: 0, durationMs: 1, truncated: false, childSessionId: "child", parentSessionId: "parent", spawnToolCallId: req.spawnToolCallId }));
    const port: SessionSubagentPort = { run, send: async () => ({ ok: false, reason: "unavailable", message: "unused" }) };
    const bridge = new CodexDynamicToolBridge(await composition.catalog(), port, undefined, composition.catalog, undefined, composition.call);
    if (capture === "toggle") composition.captureBaseAuthority("workspace");
    else composition.captureMode("build");
    expect(composition.isEnabled()).toBe(true);
    const response = { result: vi.fn(), error: vi.fn() };
    await bridge.handle({ id: 1, method: "item/tool/call", params: { threadId: "t", turnId: "u", callId: "c", tool: "anycode_agent", arguments: { agent_type: "executor", description: "task", prompt: "work", detach: false } } }, response, { threadId: "t", turnId: "u" }, () => {});
    expect(response.result).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentType: "executor", connectionId: "api", restrictions: expect.objectContaining({ tools: ["Read", "ListConnections"] }) }), expect.anything());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
