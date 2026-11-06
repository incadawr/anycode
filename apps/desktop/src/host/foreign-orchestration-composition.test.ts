import { describe, expect, it, vi } from "vitest";
import { PERSONAS, type AgentBridgeCallDeps, type SessionSubagentPort } from "@anycode/core";
import { cloneDefaults } from "../settings/schema.js";
import { createForeignOrchestrationComposition, selectedCodexPreset } from "./foreign-orchestration-composition.js";
import { createRoutedChildComposition } from "./routed-child-composition.js";
import { entryKey, RoleHealthCache } from "./role-route.js";
import { claudeAgentPermissionMode } from "./engines/child-permission-map.js";
import { CodexDynamicToolBridge } from "./engines/codex/dynamic-tool-bridge.js";

function setup() {
  const settings = cloneDefaults();
  settings.provider.connections = [{ id: "api", providerId: "custom", model: "api-model" }, { id: "other", providerId: "other", model: "other-model" }];
  settings.provider.activeConnectionId = "api";
  let preset = "read-only";
  let profiles: typeof PERSONAS.executor[] = [];
  const health = new RoleHealthCache();
  const routed = createRoutedChildComposition({ health, describeError: String, resolve: () => null, prepare: req => req, record: () => {}, deliver: () => {}, report: () => {} });
  const snapshot = vi.spyOn(routed, "snapshot");
  const composition = createForeignOrchestrationComposition({ settings: () => settings, profiles: async () => ({ profiles, problems: [] }), projectRoot: "/project", preset: () => preset, health, routed });
  const run = vi.fn<SessionSubagentPort["run"]>().mockImplementation(async req => ({ status: "completed", finalText: "done", turns: 1, toolCalls: 0, truncated: false, durationMs: 1, childSessionId: "child", parentSessionId: "parent", spawnToolCallId: req.spawnToolCallId }));
  const port: SessionSubagentPort = { run, send: async () => ({ ok: false, reason: "unavailable", message: "unused" }) };
  async function invoke(name: string, extra: { model?: string; detach?: boolean; continue_session?: string } = {}) {
    const catalog = await composition.catalog();
    const deps: AgentBridgeCallDeps = { catalog, port, spawnToolCallId: "call" };
    return composition.call({ agent_type: name, description: "task", prompt: "work", ...extra }, deps);
  }
  return { settings, composition, port, run, snapshot, health, invoke, setPreset: (p: string) => { preset = p; }, setProfiles: (p: typeof profiles) => { profiles = p; } };
}

describe("foreign orchestration composition", () => {
  it("uses an explicit native authority adapter and captures an already verified mode", () => {
    const routed = createRoutedChildComposition({health:new RoleHealthCache(),describeError:String,resolve:() => null,prepare:r => r,record:() => {},deliver:() => {},report:() => {}});
    const mapping = vi.fn(() => "plan" as const);
    const composition = createForeignOrchestrationComposition({settings:() => undefined,profiles:async () => ({ profiles: [], problems: [] }),projectRoot:"/project",preset:() => "workspace",permissionMode:mapping,health:new RoleHealthCache(),routed});
    expect(composition.childMode()).toBe("plan"); expect(mapping).toHaveBeenCalledWith("workspace");
    composition.captureMode("edit"); expect(composition.childMode()).toBe("edit");
    composition.clearBaseAuthority(); expect(composition.childMode()).toBe("plan");
  });

  it("maps Claude pre-bind and captured authority through its own presets", () => {
    const health = new RoleHealthCache();
    const routed = createRoutedChildComposition({ health, describeError: String, resolve: () => null, prepare: req => req, record: () => {}, deliver: () => {}, report: () => {} });
    let preset: string | undefined;
    const composition = createForeignOrchestrationComposition({ settings: () => undefined, profiles: async () => ({ profiles: [], problems: [] }), projectRoot: "/project", preset: () => preset ?? "read-only", permissionMode: claudeAgentPermissionMode, health, routed });
    expect(composition.childMode()).toBe("plan");
    preset = "workspace";
    expect(composition.childMode()).toBe("build");
    preset = "read-only";
    composition.captureBaseAuthority(preset);
    expect(composition.childMode()).toBe("build");
    composition.clearBaseAuthority();
    expect(composition.childMode()).toBe("plan");
  });

  it.each([undefined, 0, -5, 200, 300])("stamps role budgets for setting %s", async budget => {
    const s = setup();
    s.settings.tools.subagentMaxTurns = budget;
    for (const [role, fallback] of [["planner", 30], ["executor", 80], ["reviewer", 40]] as const) {
      await s.invoke(role);
      expect(s.run.mock.calls.at(-1)![0].maxTurns).toBe(budget === undefined ? fallback : Math.max(1, Math.min(200, budget)));
    }
    s.setProfiles([{ ...PERSONAS.executor, turnBudget: 17 }]);
    await s.invoke("executor");
    expect(s.run.mock.calls.at(-1)![0].maxTurns).toBe(17);
    await s.invoke("executor", { continue_session: "previous" });
    expect(s.run.mock.calls.at(-1)![0]).not.toHaveProperty("maxTurns");
  });
  it("uses a pending ask selection over applied full-access when enabling", async () => {
    const s = setup();
    const engine = { snapshot: () => ({ activePresetId: "full-access" }), pendingSnapshot: () => ({ activePresetId: "ask" }) };
    s.composition.captureBaseAuthority(selectedCodexPreset(engine));
    expect(s.composition.childMode()).toBe("build");
  });
  it("declares roles without profiles and preserves base authority through an overlay", async () => {
    const s = setup();
    expect((await s.composition.catalog()).map(e => e.name)).toEqual(["planner", "executor", "reviewer", "explore"]);
    s.composition.captureBaseAuthority("read-only");
    expect(s.composition.childMode()).toBe("build");
    s.composition.clearBaseAuthority(); s.setPreset("full-access"); s.composition.captureBaseAuthority("full-access"); s.setPreset("read-only");
    expect(s.composition.childMode()).toBe("yolo");
    await s.invoke("executor");
    expect(s.run.mock.calls[0]![0]).toMatchObject({ connectionId: "api", model: "api-model", detach: true });
    s.composition.clearBaseAuthority(); expect(s.composition.childMode()).toBe("plan");
  });

  it.each(["planner", "reviewer", "explore"])("keeps %s core restrictions", async name => {
    const s = setup(); await s.invoke(name);
    expect(s.run.mock.calls[0]![0]).toMatchObject({ connectionId: "api", restrictions: { readOnly: true } });
  });

  it("uses role settings and snapshots the chosen fallback, keeping explicit detach false", async () => {
    const s = setup();
    s.settings.roles = { executor: { primary: { connection: "missing", model: "old" }, fallbacks: [{ connection: "other", model: "other-model", effort: "high" }] } };
    s.composition.captureBaseAuthority("read-only");
    const result = await s.invoke("executor");
    expect(s.run.mock.calls[0]![0]).toMatchObject({ connectionId: "other", model: "other-model", effort: "high", detach: true });
    expect(result.text).toContain("connection or model is unavailable");
    expect(s.snapshot.mock.calls[0]![1]).toMatchObject({ entries: [{ connection: "other" }], skipped: [{ reason: expect.stringContaining("unavailable") }] });
    s.run.mockClear(); await s.invoke("executor", { detach: false });
    expect(s.run.mock.calls[0]![0]).not.toHaveProperty("detach");
  });

  it("does not report an invalid later fallback as a primary failure", async () => {
    const s = setup();
    s.settings.roles = { executor: { primary: { connection: "api", model: "api-model" }, fallbacks: [{ connection: "missing" }] } };
    const result = await s.invoke("executor");
    expect(result.text).not.toContain("because");
  });

  it("skips an unhealthy primary and makes the fallback reason visible", async () => {
    const s = setup();
    s.settings.roles = { executor: { primary: { connection: "api", model: "api-model" }, fallbacks: [{ connection: "other", model: "other-model" }] } };
    s.health.markFailure(entryKey("executor", { connection: "api", model: "api-model" }), "quota", Date.now());
    const result = await s.invoke("executor");
    expect(s.run.mock.calls[0]![0]).toMatchObject({ connectionId: "other", model: "other-model" });
    expect(result.text).toContain("quota");
  });

  it("honours md precedence and continuation without re-routing", async () => {
    const s = setup();
    s.settings.roles = { executor: { primary: { connection: "other", model: "other-model" } } };
    s.setProfiles([{ ...PERSONAS.executor, model: "md-model", connection: "api", systemPrompt: "md body" }]);
    await s.invoke("executor");
    expect(s.run.mock.calls[0]![0]).toMatchObject({ connectionId: "api", model: "md-model", prompt: expect.stringContaining("md body") });
    s.run.mockClear(); await s.invoke("executor", { continue_session: "previous", model: "ignored" });
    expect(s.run.mock.calls[0]![0]).toMatchObject({ resumeChildSessionId: "previous" });
    expect(s.run.mock.calls[0]![0]).not.toHaveProperty("connectionId");
    expect(s.run.mock.calls[0]![0]).not.toHaveProperty("model");
  });

  it("uses the project-selected role profile and picks up later changes", async () => {
    const s = setup();
    s.settings.roleProfiles = { activeId: "global", profiles: [
      { id: "global", name: "Global", roles: { executor: { primary: { connection: "api", model: "api-model" } } } },
      { id: "project", name: "Project", roles: { executor: { primary: { connection: "other", model: "other-model" } } } },
    ], projects: [{ projectRoot: "/project", profileId: "project" }] };
    await s.invoke("executor");
    expect(s.run.mock.calls[0]![0]).toMatchObject({ connectionId: "other", model: "other-model" });
    s.settings.roleProfiles.projects = [];
    s.run.mockClear(); await s.invoke("executor");
    expect(s.run.mock.calls[0]![0]).toMatchObject({ connectionId: "api", model: "api-model" });
  });

  it("routes an actual Codex dynamic tool call through the composition", async () => {
    const s = setup();
    const bridge = new CodexDynamicToolBridge(await s.composition.catalog(), s.port, undefined, s.composition.catalog, undefined, s.composition.call);
    s.composition.captureBaseAuthority("ask");
    const response = { result: vi.fn(), error: vi.fn() };
    await bridge.handle({ id: 1, method: "item/tool/call", params: { threadId: "t", turnId: "u", callId: "c", tool: "anycode_agent", arguments: { agent_type: "executor", description: "task", prompt: "work" } } }, response, { threadId: "t", turnId: "u" }, () => {});
    expect(s.run.mock.calls[0]![0]).toMatchObject({ connectionId: "api", model: "api-model", detach: true });
    expect(response.result).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("refuses missing connections and native routes that cannot enforce restrictions", async () => {
    const s = setup(); s.settings.provider.connections = [];
    expect((await s.invoke("executor")).text).toMatch(/no usable route/);
    expect(s.run).not.toHaveBeenCalled();
    s.settings.roles = { reviewer: { primary: { engine: "codex" } } };
    const refusal = await s.invoke("reviewer");
    expect(refusal.isError).toBe(true);
    expect(refusal.text).toMatch(/cannot enforce/);
    expect(refusal.text).toContain("reviewer");
    expect(s.run).not.toHaveBeenCalled();
  });

  it("never routes a restricted role onto an engine fallback and names the fix", async () => {
    const s = setup();
    s.settings.roles = { planner: { primary: { connection: "api", model: "api-model" }, fallbacks: [{ engine: "codex" }] } };
    s.health.markFailure(entryKey("planner", { connection: "api", model: "api-model" }), "quota", Date.now());
    const result = await s.invoke("planner");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("planner");
    expect(result.text).toContain("quota");
    expect(result.text).toContain("Settings");
    expect(s.run).not.toHaveBeenCalled();
  });

  it("still reroutes an unrestricted role onto an engine fallback", async () => {
    const s = setup();
    s.settings.roles = { executor: { primary: { connection: "api", model: "api-model" }, fallbacks: [{ engine: "codex" }] } };
    s.health.markFailure(entryKey("executor", { connection: "api", model: "api-model" }), "quota", Date.now());
    const result = await s.invoke("executor");
    expect(result.isError).toBe(false);
    expect(s.run.mock.calls[0]![0]).toMatchObject({ engine: "codex" });
    expect(s.run.mock.calls[0]![0]).not.toHaveProperty("restrictions");
    expect(result.text).toContain("engine codex");
  });

  it("points an md-claimed role at its profile file instead of Settings", async () => {
    const s = setup();
    s.setProfiles([{ ...PERSONAS.planner, engine: "codex" }]);
    const result = await s.invoke("planner");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/cannot enforce/);
    expect(result.text).toContain("planner");
    expect(result.text).toContain("profile file");
    expect(result.text).not.toContain("Settings");
    expect(s.run).not.toHaveBeenCalled();
  });

  it("accepts an explicit model for a configured connection with no default model", async () => {
    const s = setup();
    delete s.settings.provider.connections[0]!.model;
    s.settings.roles = { executor: { primary: { connection: "api" } } };
    await s.invoke("executor", { model: "chosen" });
    expect(s.run.mock.calls[0]![0]).toMatchObject({ connectionId: "api", model: "chosen" });
    expect(s.run.mock.calls[0]![0]).not.toHaveProperty("routeStamped");
  });

  it("never inherits a native parent model for an unrouted core profile", async () => {
    const s = setup();
    s.setProfiles([{ ...PERSONAS.executor, name: "custom" }]);
    await s.invoke("custom");
    expect(s.run.mock.calls[0]![0]).toMatchObject({ connectionId: "api", model: "api-model" });
    s.run.mockClear(); s.settings.provider.connections = [];
    expect((await s.invoke("custom")).text).toContain("no usable API connection");
    expect(s.run).not.toHaveBeenCalled();
  });
});
