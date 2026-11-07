import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ClaudeApprovalBridge } from "./approval-bridge.js";
import type { ClaudeMcpBridge } from "./mcp-bridge.js";
import { buildClaudeSpawnArgs } from "./claude-client.js";
import { permissionModeToFlag } from "./protocol.js";
import { assertClaudeOrchestrationReadback, claudeOrchestrationAvailability, prepareClaudeOrchestrationSpawn } from "./orchestration-policy.js";

const fixture = JSON.parse(readFileSync(new URL("../../../../scripts/claude-orchestrate-fixture.json", import.meta.url), "utf8"));

describe("Claude orchestration admission", () => {
  it("keeps synthetic and unknown versions unavailable even with complete fixture facts", () => {
    for (const version of [fixture.version, "999.0.0"]) {
      expect(claudeOrchestrationAvailability(true, version, fixture.facts)).toMatchObject({ supported: false, reason: expect.stringContaining("No live") });
      expect(() => prepareClaudeOrchestrationSpawn(true, version, fixture.facts)).toThrow("No live");
    }
    expect(claudeOrchestrationAvailability(false, fixture.version, fixture.facts)).toMatchObject({ reason: expect.stringContaining("disabled") });
  });
  it.each(["authSource", "provider", "baseUrl", "model", "env", "apiKeyHelper"])("rejects changed or missing %s equivalence", key => {
    for (const value of ["changed", undefined]) {
      const facts = { ...fixture.facts, equivalence: { ...fixture.facts.equivalence, [key]: value } };
      expect(claudeOrchestrationAvailability(true, fixture.version, facts)).toMatchObject({ reason: expect.stringContaining(`unchanged ${key}`) });
    }
  });
  it.each([{ state: "unknown" }, { state: "safe-verified", hooks: true, permissions: false }, { state: "absent", hooks: false, permissions: true }])("rejects unsafe managed policy %j", managed => {
    expect(claudeOrchestrationAvailability(true, fixture.version, { ...fixture.facts, managed })).toMatchObject({ reason: expect.stringContaining("Managed policy") });
  });
  it.each(["user", "project", "local", "plugins"])("requires %s suppression", key => {
    expect(claudeOrchestrationAvailability(true, fixture.version, { ...fixture.facts, suppression: { ...fixture.facts.suppression, [key]: "unknown" } })).toMatchObject({ reason: expect.stringContaining(`suppression of ${key}`) });
  });
  it("refuses fabricated spawn authorization, including resume", () => {
    expect(permissionModeToFlag("default")).toBe("manual");
    expect(() => buildClaudeSpawnArgs({ resume: "synthetic-session", orchestrationSpawn: { version: fixture.version, permissionMode: "default" } })).toThrow("Unverified");
  });
  it("checks exact inventory, default mode, suppressed execution and owned server readback", () => {
    const snapshot = { version: fixture.version, permissionMode: "default" as const };
    const init = fixture.frames.init;
    expect(() => assertClaudeOrchestrationReadback(init, snapshot)).not.toThrow();
    const peerNames = new Set(["mcp__anycode__sessions_list", "mcp__anycode__session_send"]);
    const withPeers = { ...init, tools: [...init.tools, ...peerNames] };
    expect(() => assertClaudeOrchestrationReadback(withPeers, snapshot, peerNames)).not.toThrow();
    expect(() => assertClaudeOrchestrationReadback(withPeers, snapshot)).toThrow("drift");
    expect(() => assertClaudeOrchestrationReadback({ ...withPeers, tools: [...withPeers.tools, "Bash"] }, snapshot, peerNames)).toThrow("drift");
    for (const patch of [{ permissionMode: "plan" }, { tools: [...init.tools, "Bash"] }, { tools: init.tools.slice(1) }, { skills: ["execute"] }, { slash_commands: ["run"] }, { mcp_servers: [{ name: "external" }] }, { claude_code_version: "unknown" }]) {
      expect(() => assertClaudeOrchestrationReadback({ ...init, ...patch }, snapshot)).toThrow("drift");
    }
  });
});

describe("early approval denial", () => {
  it.each(["UnknownTool", "Read", "Bash", "Write", "ExitPlanMode", "mcp__anycode__browser_eval", "mcp__anycode__agent_spoof"])("denies %s before even an always-allow broker", async tool => {
    const requestPermission = vi.fn().mockResolvedValue({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker: { requestPermission, denyAll: vi.fn(), isUnattended: false, isAwaitingApproval: false }, activePresetId: () => "workspace", orchestrationRestricted: () => true,
      workspace: "/workspace", bridge: {} as ClaudeMcpBridge, browserToolNames: new Set(["mcp__anycode__browser_eval"]) });
    const success = vi.fn();
    await bridge.handle({ requestId: "request", subtype: "can_use_tool", request: { tool_name: tool, tool_use_id: "use", input: { file_path: "/outside/private.txt", command: "echo allowed" } }, signal: new AbortController().signal }, { success, error: vi.fn() });
    expect(success).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny", toolUseID: "use" }));
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it.each(["mcp__anycode__agent", "mcp__anycode__agent_status", "mcp__anycode__list_connections"])("allows only exact owned %s", async tool => {
    const requestPermission = vi.fn();
    const bridge = new ClaudeApprovalBridge({ broker: { requestPermission, denyAll: vi.fn(), isUnattended: false, isAwaitingApproval: false }, activePresetId: () => "ask", orchestrationRestricted: () => true, bridge: {} as ClaudeMcpBridge });
    const success = vi.fn();
    await bridge.handle({ requestId: "request", subtype: "can_use_tool", request: { tool_name: tool, tool_use_id: "use", input: {} }, signal: new AbortController().signal }, { success, error: vi.fn() });
    expect(success).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }));
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it("preserves legacy OFF approvals and spawn argv", async () => {
    const requestPermission = vi.fn().mockResolvedValue({ behavior: "allow" });
    const bridge = new ClaudeApprovalBridge({ broker: { requestPermission, denyAll: vi.fn(), isUnattended: false, isAwaitingApproval: false }, activePresetId: () => "ask", orchestrationRestricted: () => false });
    const success = vi.fn();
    await bridge.handle({ requestId: "request", subtype: "can_use_tool", request: { tool_name: "Read", tool_use_id: "use", input: {} }, signal: new AbortController().signal }, { success, error: vi.fn() });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith(expect.objectContaining({ behavior: "allow" }));
    const args = buildClaudeSpawnArgs({ resume: "synthetic-session", enableSlashPassthrough: true });
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--permission-mode");
    expect(args).toContain("project,local");
  });
});
