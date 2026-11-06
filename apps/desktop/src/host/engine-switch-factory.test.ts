import { materializeMcpForwardFile } from "./engines/claude/mcp-forward-file.js";
import { ClaudeEngine } from "./engines/claude/claude-engine.js";
import { orchestrationAvailability } from "./orchestration-policy.js";
import type { SessionEngine } from "./engines/session-engine.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop, ConversationHistory, SessionPermissionRules, SqlitePersistenceAdapter, type HistoryItem } from "@anycode/core";
import { createSwitchEngineFactory, type SwitchEngineFactoryContext } from "./engine-switch-factory.js";
import { buildClaudeLaunchOptions, buildCodexLaunchOptions, buildCoreLaunchOptions } from "./engine-launch-options.js";
import type { EngineProcessRegistrationMessage } from "../shared/engines.js";
import { readHostProcessOwnership } from "./engines/codex/process-ownership.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { createHarness, finishStep, textStep, MemFs, ScriptedModelPort } from "./test-harness.js";
import { createCoreRuntimeMedia } from "./core-runtime-services.js";
import { RoleHealthCache, entryKey } from "./role-route.js";
import type { SwitchRuntime } from "./session.js";

const executable = fileURLToPath(new URL("./engine-switch-fixtures/native-double.mjs", import.meta.url));
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function context(orchestrationFeatureEnabled = false) {
  const dir = mkdtempSync(join(tmpdir(), "engine-switch-"));
  directories.push(dir);
  const broker = new IpcPermissionBroker(() => {});
  const registrations: EngineProcessRegistrationMessage[] = [];
  const common = {
    workspace: dir, binaryPath: process.execPath, sourceEnv: { HOME: dir },
    binaryTrust: () => null, broker,
    processOwnership: readHostProcessOwnership({ ANYCODE_HOST_GENERATION: "9" }, process.pid, message => registrations.push(message)) ?? undefined,
  };
  const cleanup = vi.fn();
  const ctx: SwitchEngineFactoryContext = {
    engineSwitchEnabled: true, workspace: dir, sessionId: "logical-session",
    resolveCore: vi.fn(async () => undefined),
    resolveCodex: vi.fn(async () => ({ options: {
      ...buildCodexLaunchOptions({ ...common, fs: new MemFs(), rules: new SessionPermissionRules(), profile: null, forwardOptions: {} }),
      binaryArgs: [executable, `--double-log=${join(dir, "codex.log")}`],
      selection: { presetId: "read-only", origin: "draft" as const },
    }, cleanup })),
    resolveClaude: vi.fn(async () => ({ options: {
      ...buildClaudeLaunchOptions({ ...common, orchestrationFeatureEnabled, projectTrusted: false, mcpConfigPath: null, bootNotices: [], agentCatalogNonEmpty: false }),
      binaryArgs: [executable, "--double-claude", `--double-log=${join(dir, "claude.log")}`],
      selection: { presetId: "read-only", origin: "draft" as const },
    }, cleanup })),
  };
  return { ctx, dir, cleanup, registrations };
}

describe("host switch engine factory", () => {
  it("restores core services through the real factory on a core → codex → core round trip", async () => {
    const {ctx} = context();
    const database = new SqlitePersistenceAdapter(":memory:");
    await database.createSession({id:ctx.sessionId,workspace:ctx.workspace,model:"model-chosen",mode:"build"});
    const base = createHarness({steps:[]});
    const health = new RoleHealthCache();
    health.markFailure(entryKey("orchestrator",{model:"primary"}),"quota",Date.now());
    const providerEvents: unknown[] = [];
    const configurations: typeof base.config[] = [];
    const ports: ScriptedModelPort[] = [];
    const kept: HistoryItem = {id:"kept",turnId:"kept-turn",createdAt:1,message:{role:"user",content:"retained"}};
    const rewind = vi.fn(async () => ({ok:true as const,safetyCheckpointId:"safety",restoredPaths:0,historyItems:[kept],turnErrorIds:["kept-error"],compactionSeq:0}));
    ctx.resolveCore = async ({model}) => {
      const modelPort = new ScriptedModelPort([finishStep(),textStep("A restored title")]);
      ports.push(modelPort);
      const config = {...base.config,modelPort,history:new ConversationHistory()};
      const media = createCoreRuntimeMedia({registry:config.registry,imageInputEnabled:() => false,endpoint:null,env:{},
        reserveRef:() => database.reserveImageRef(ctx.sessionId),portFactory:() => modelPort,
        onRegistrationChanged:() => {config.systemPrompt=config.registry.list().join(",");}});
      config.media=media; config.recognizer=media.recognizer;
      configurations.push(config);
      return {model,options:buildCoreLaunchOptions({config,loop:new AgentLoop(config)}),
        services:{adapter:() => database,sessionId:ctx.sessionId,media,flushHistory:async () => {},
          checkpoints:{list:async () => [],rewind},readOrchestrator:() => ({primary:{model:"primary"},fallbacks:[{model:"model-chosen",effort:"low"}]}),
          health:() => health.snapshot(),sendProviderEvent:event => providerEvents.push(event),pricing:() => ({pricingRaw:undefined})}};
    };
    const productionFactory = createSwitchEngineFactory(ctx)!;
    let core: SwitchRuntime | undefined;
    const factory: typeof productionFactory = async (...args) => {
      const runtime = await productionFactory(...args);
      if ("engine" in runtime && runtime.engine.id === "core") core=runtime;
      return runtime;
    };
    const source = await factory("core","model-chosen");
    if (!("engine" in source)) throw new Error("missing runtime");
    const h = createHarness({steps:[],engine:source.engine,switchEngineFactory:factory});
    try {
      h.send({type:"ui_ready"}); await h.waitFor(m => m.type === "host_ready");
      for (const engine of ["codex","core"] as const) {
        h.send({type:"engine_switch_request",requestId:`to-${engine}`,engine,model:"model-chosen"});
        await h.waitUntil(() => h.received.some(m => m.type === "engine_switched" && m.requestId === `to-${engine}`));
      }
      const services = core!.callbacks!;
      expect(services.orchestratorRouteCheck!()).toMatchObject({model:"model-chosen",effort:"low",notice:expect.stringContaining("quota")});
      h.session.applyRecognizerConfig({transport:"openai-chat-completions",baseUrl:"http://local",model:"vision",apiKey:"first"});
      expect(configurations.at(-1)!.registry.has("InspectImage")).toBe(true);
      expect(configurations.at(-1)!.recognizer!.endpoint).toMatchObject({model:"vision",apiKey:"first"});
      h.session.applyRecognizerConfig({transport:"openai-chat-completions",baseUrl:"http://local",model:"other"});
      expect(configurations.at(-1)!.recognizer!.endpoint!.apiKey).toBeUndefined();
      h.send({type:"user_message",requestId:"after-round-trip",text:"continue"});
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      await (h.session as unknown as {currentTurn:Promise<void> | null}).currentTurn;
      expect(providerEvents).toContainEqual({type:"anycode:provider-health",kind:"success"});
      await vi.waitFor(() => expect(ports.at(-1)!.requests.some(request => request.maxOutputTokens === 32)).toBe(true));
      await services.persistence!.commitTitle!("Restored core title");
      expect((await database.getRootSession(ctx.sessionId))!.title).toBe("Restored core title");
      services.reportProviderQuota!({usedPercent:50},"fixture");
      expect(providerEvents).toContainEqual({type:"anycode:provider-quota",quota:{usedPercent:50},source:"fixture"});
      const error = (id:string,turnId:string) => ({kind:"turn_error" as const,id,turnId,createdAt:4,engine:"core",model:"model-chosen",error:{name:"Error",message:id}});
      await services.saveTurnError!(error("kept-error","kept-turn"));
      await services.saveTurnError!(error("discarded-error","discarded-turn"));
      services.compactionRecords!.record({id:"discarded-compaction",createdAt:4,ok:true});
      await services.compactionRecords!.flush();
      expect(await database.listCompactionRecords(ctx.sessionId)).toHaveLength(1);
      h.send({type:"rewind_request",requestId:"after-round-trip-rewind",checkpointId:"checkpoint",scope:"conversation"});
      await h.waitUntil(() => h.received.some(m => m.type === "rewind_result" && m.ok));
      await services.compactionRecords!.flush();
      expect(rewind).toHaveBeenCalledWith("checkpoint",expect.objectContaining({compactionSeq:1,turnErrorIds:["kept-error","discarded-error"]}));
      expect((await database.loadTurnErrors(ctx.sessionId)).map(record => record.id)).toEqual(["kept-error"]);
      expect(await database.listCompactionRecords(ctx.sessionId)).toEqual([]);
      expect(core!.engine.historyItems()).toEqual([kept]);
      h.session.applyRecognizerConfig(null);
      expect(configurations.at(-1)!.registry.has("InspectImage")).toBe(false);
    } finally {await h.session.shutdown();h.close();base.close();await database.close();}
  });

  it.each(["codex", "claude"] as const)("starts %s through the real transport with the selected model", async engine => {
    const { ctx, dir, cleanup } = context();
    const factory = createSwitchEngineFactory(ctx)!;
    const runtime = await factory(engine, "model-chosen");
    expect("engine" in runtime).toBe(true);
    if (!("engine" in runtime)) throw new Error("missing runtime");
    try {
      expect(runtime.engine.id).toBe(engine);
      expect(runtime.engineSettings?.snapshot().model).toBe("model-chosen");
      const messages = readFileSync(join(dir, `${engine}.log`), "utf8").trim().split("\n").map(line => JSON.parse(line));
      if (engine === "codex") expect(messages.find(message => message.method === "thread/start").params.model).toBe("model-chosen");
      else expect(messages.find(message => message.request?.subtype === "set_model").request.model).toBe("model-chosen");
      expect(engine === "codex" ? ctx.resolveCodex : ctx.resolveClaude).toHaveBeenCalledWith({ workspace: dir, sessionId: "logical-session", model: "model-chosen" });
      expect(cleanup).not.toHaveBeenCalled();
    } finally { await runtime.engine.dispose("session-close"); }
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("receives the chosen model from Session and leaves the source usable after rejection", async () => {
    const { ctx } = context();
    const h = createHarness({ steps: [finishStep()], switchEngineFactory: createSwitchEngineFactory(ctx) });
    try {
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
      h.send({ type: "engine_switch_request", requestId: "bad-model", engine: "codex", model: "unsupported" });
      await h.waitUntil(() => h.received.some(m => m.type === "engine_switch_failed" && m.requestId === "bad-model"));
      h.send({ type: "user_message", requestId: "source-turn", text: "still here" });
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      h.send({ type: "engine_switch_request", requestId: "chosen", engine: "codex", model: "model-chosen" });
      await h.waitUntil(() => h.received.some(m => m.type === "engine_switched" && m.requestId === "chosen"));
      expect(ctx.resolveCodex).toHaveBeenLastCalledWith(expect.objectContaining({ model: "model-chosen" }));
    } finally { await h.session.shutdown(); h.close(); }
  });

  it("builds a fresh core loop using only the resolved connection's model port", async () => {
    const { ctx } = context();
    const h = createHarness({ steps: [] });
    const port = new ScriptedModelPort([finishStep()]);
    ctx.resolveCore = async ({ model }) => {
      if (model !== "model-chosen") return undefined;
      const config = { ...h.config, modelPort: port, history: new ConversationHistory(), mode: "plan" as const };
      return { model, options: buildCoreLaunchOptions({ config, loop: new AgentLoop(config) }) };
    };
    const runtime = await createSwitchEngineFactory(ctx)!("core", "model-chosen");
    if (!("engine" in runtime)) throw new Error("missing runtime");
    try {
      expect(runtime.engine.id).toBe("core");
      expect(runtime.engine.historyItems()).toEqual([]);
      for await (const _ of runtime.engine.runTurn("hello", { signal: new AbortController().signal })) { /* drain */ }
      expect(port.requests).toHaveLength(1);
      expect(h.engine.historyItems()).toEqual([]);
    } finally { await runtime.engine.dispose("session-close"); h.close(); }
  });

  it.each([undefined, false])("keeps the unavailable-host refusal when enabled=%s", async enabled => {
    const { ctx } = context();
    ctx.engineSwitchEnabled = enabled;
    const factory = createSwitchEngineFactory(ctx);
    expect(factory).toBeUndefined();
    const h = createHarness({ steps: [], switchEngineFactory: factory });
    try {
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
      h.send({ type: "engine_switch_request", requestId: "off", engine: "codex", model: "model-chosen" });
      await h.waitUntil(() => h.received.some(m => m.type === "engine_switch_failed"));
      expect(h.received).toContainEqual({ type: "engine_switch_failed", requestId: "off", reason: "engine switch is not available in this host" });
      expect(ctx.resolveCodex).not.toHaveBeenCalled();
    } finally { h.close(); }
  });

  it.each(["core", "codex", "claude"] as const)("rejects unsupported %s models and releases candidate resources", async engine => {
    const { ctx, cleanup } = context();
    await expect(createSwitchEngineFactory(ctx)!(engine, "unsupported")).rejects.toThrow(/unavailable/);
    expect(cleanup).toHaveBeenCalledTimes(engine === "core" ? 0 : 1);
  });

  const engines = ["core", "codex", "claude"] as const;
  it.each(engines.flatMap(source => engines.filter(target => source !== target).map(target => ({ source, target }))))("production transports: $source → $target runs the imported turn and the next clean turn", async ({ source, target }) => {
    const { ctx, dir, registrations } = context();
    const base = createHarness({ steps: [] });
    const ports: ScriptedModelPort[] = [];
    ctx.resolveCore = async ({ model }) => {
      const modelPort = new ScriptedModelPort([finishStep(), finishStep(), finishStep()]);
      ports.push(modelPort);
      const config = { ...base.config, modelPort, history: new ConversationHistory() };
      return { model, options: buildCoreLaunchOptions({ config, loop: new AgentLoop(config) }) };
    };
    const factory = createSwitchEngineFactory(ctx)!;
    const sourceRuntime = await factory(source, "model-chosen");
    if (!("engine" in sourceRuntime)) throw new Error("missing runtime");
    const sourceDispose = vi.spyOn(sourceRuntime.engine, "dispose");
    const h = createHarness({ steps: [], engine: sourceRuntime.engine, switchEngineFactory: factory });
    try {
      h.send({ type: "ui_ready" });
      await h.waitUntil(() => h.received.some(message => message.type === "host_ready"));
      h.send({ type: "user_message", requestId: "source", text: "source text" });
      await h.waitUntil(() => h.received.filter(message => message.type === "agent_event" && message.event.type === "loop_end").length === 1);
      await (h.session as unknown as { currentTurn: Promise<void> | null }).currentTurn;
      h.send({ type: "engine_switch_request", requestId: "switch", engine: target, model: "model-chosen" });
      await h.waitUntil(() => h.received.some(message => message.type === "engine_switched"));
      expect(sourceDispose).toHaveBeenCalledTimes(1);
      h.send({ type: "user_message", requestId: "import", text: "first candidate turn" });
      await h.waitUntil(() => h.received.filter(message => message.type === "agent_event" && message.event.type === "loop_end").length === 2);
      await (h.session as unknown as { currentTurn: Promise<void> | null }).currentTurn;
      h.send({ type: "user_message", requestId: "clean", text: "clean candidate turn" });
      await h.waitUntil(() => h.received.filter(message => message.type === "agent_event" && message.event.type === "loop_end").length === 3);
      expect(h.received.filter(message => message.type === "engine_switched")).toHaveLength(1);
      expect(registrations.filter(message => !message.exited)).toHaveLength(2 * ((source === "core" ? 0 : 1) + (target === "core" ? 0 : 1)));
      for (const registration of registrations) expect(registration).toMatchObject({ hostPid: process.pid, generation: 9 });
      if (target !== "core") {
        const messages = readFileSync(join(dir, `${target}.log`), "utf8").trim().split("\n").map(line => JSON.parse(line));
        const inputs = target === "codex" ? messages.filter(message => message.method === "turn/start").map(message => message.params.input[0].text) : messages.filter(message => message.type === "user").map(message => message.message.content);
        expect(inputs.at(-1)).toBe("clean candidate turn");
        expect(inputs.at(-2)).toContain("first candidate turn");
      } else expect(ports.at(-1)?.requests).toHaveLength(2);
    } finally { await h.session.shutdown(); h.close(); base.close(); }
    await vi.waitFor(() => {
      for (const registration of registrations.filter(message => !message.exited)) {
        expect(registrations.some(message => message.exited && message.enginePid === registration.enginePid)).toBe(true);
      }
    });
  });

  it("rejects malformed selections before privileged resolution", async () => {
    const { ctx } = context();
    await expect(createSwitchEngineFactory(ctx)!("codex", "")).rejects.toThrow("Invalid engine switch selection");
    expect(ctx.resolveCodex).not.toHaveBeenCalled();
  });

  it("does not infer a core connection when the host cannot resolve one", async () => {
    const { ctx } = context();
    await expect(createSwitchEngineFactory(ctx)!("core", "model-chosen")).rejects.toThrow("unavailable for core");
  });
});


describe("Claude orchestration candidate carrier", () => {
  it.each([false, true])("gates candidate resolution on engine switch (%s)", enabled => {
    const { ctx } = context();
    ctx.engineSwitchEnabled = enabled;
    expect(typeof createSwitchEngineFactory(ctx)).toBe(enabled ? "function" : "undefined");
    expect(ctx.resolveClaude).not.toHaveBeenCalled();
  });

  it.each([undefined, "0", "1", "unknown"])("carries candidate launch intent: %s (policy readiness placeholder)", async flag => {
    const { claudeOrchestrationEnabled } = await import("../main/claude-orchestration-feature.js");
    const launch = { claudeOrchestrateEnabled: claudeOrchestrationEnabled({ ANYCODE_CLAUDE_ORCHESTRATE_ENABLED: flag }) };
    const { ctx } = context(launch.claudeOrchestrateEnabled === true);
    const factory = createSwitchEngineFactory(ctx);
    const runtime = await factory!("claude", "model-chosen");
    if (!("engine" in runtime)) throw new Error("missing runtime");
    try {
      expect(runtime.engine).toBeInstanceOf(ClaudeEngine);
      expect((runtime.engine as ClaudeEngine).orchestrationFeatureEnabled).toBe(flag === "1");
      expect(runtime.engine.orchestrationPolicy?.availability().supported ?? false).toBe(false);
    } finally { await runtime.engine.dispose("session-close"); }
  });
});


it.each([false, true])("carries Claude boot launch intent %s (policy readiness placeholder)", async enabled => {
  const { beginEngineBootstrap } = await import("./engines/bootstrap.js");
  const { getEnginePlugin } = await import("./engines/registry.js");
  const { buildClaudeRuntime } = await import("./engine-switch-runtime.js");
  const { ctx } = context(enabled);
  const resolved = await ctx.resolveClaude({ workspace: ctx.workspace, sessionId: ctx.sessionId, model: "model-chosen" });
  const bootstrap = await beginEngineBootstrap(getEnginePlugin("claude")!);
  const runtime = await buildClaudeRuntime({ ...resolved!.options, bootstrap });
  try {
    expect(runtime.engine.orchestrationFeatureEnabled).toBe(enabled);
    expect(orchestrationAvailability((runtime.engine as SessionEngine).orchestrationPolicy).supported).toBe(false);
  } finally { await runtime.engine.dispose("session-close"); }
});

it.each([false, true])("owns candidate external MCP across a real switch abort=%s", async abort => {
  const { ctx, dir, registrations } = context();
  const resolve = ctx.resolveClaude;
  let path = "";
  ctx.resolveClaude = async request => {
    const resolved = (await resolve(request))!;
    resolved.options.resolveMcpForward = async () => {
      const file = materializeMcpForwardFile('{"mcpServers":{"sample":{"command":"node"}}}', { tmpDir: dir, pid: process.pid });
      path = file.path;
      return { claudeConfigPath: path, notices: [], cleanupFile: () => rmSync(file.path, { force: true }) };
    };
    return resolved;
  };
  const factory = createSwitchEngineFactory(ctx)!;
  const h = createHarness({ steps: [], switchEngineFactory: factory, engineSwitchCoordinator: {
    generation: 7, prepare: async () => factory,
    commit: async () => { expect(existsSync(path)).toBe(true); if (abort) throw new Error("commit refused"); },
    abort: async () => {}, retire: async () => {},
  } });
  try {
    h.send({ type: "ui_ready" });
    await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
    h.send({ type: "engine_switch_request", requestId: "file-owner", generation: 7, engine: "claude", model: "model-chosen" });
    await h.waitUntil(() => h.received.some(m => m.type === (abort ? "engine_switch_failed" : "engine_switched")), 5000);
    expect(path).not.toBe("");
    expect(existsSync(path)).toBe(!abort);
    expect(JSON.stringify(h.received)).not.toContain(path);
  } finally { await h.session.shutdown(); h.close(); }
  expect(existsSync(path)).toBe(false);
  await vi.waitFor(() => {
    for (const process of registrations.filter(item => !item.exited)) {
      expect(registrations.some(item => item.exited && item.enginePid === process.enginePid)).toBe(true);
    }
  });
});
