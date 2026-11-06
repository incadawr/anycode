import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { release } from "node:os";
import { AiSdkModelPort, ConversationHistory, InMemoryHookRunner, InMemoryTodoStore, McpManager, NodeExecutionAdapter, NodeFileSystemAdapter,
  NodeHttpAdapter, NodeGitReadAdapter, NodeMcpTransportFactory, RuleAwarePermissionEngine, SafeCommandPermissionEngine, ModePermissionEngine,
  PERSONAS, RuntimeHistorySink, createCommandHook, createDefaultToolRegistry, loadEnvConfig, loadHookConfigs, loadMcpServerSpecs, matchCatalogEntryByBaseUrl,
  resolveImageInput, buildSystemPrompt, buildChildModelSettingsResolver, createDefaultTokenizer,
  loadRepoMapConfig, buildRepoMapPromptSection, DEFAULT_CONTEXT_WINDOW_TOKENS, REPO_MAP_MIN_TOKENS, REPO_MAP_MAX_TOKENS, REPO_MAP_WINDOW_FRACTION,
  createListConnectionsTool, createWebSearchTool, loadWebSearchConfig,
  isRoleRouteName, buildMcpInstructionsSection, InProcessTaskManager,
  type AgentLoopConfig, type ModelPort, type McpSecretResolver, type SqlitePersistenceAdapter, type SessionPermissionRules,
} from "@anycode/core";
import { getBuiltinCatalog } from "@anycode/core/catalog";
import { parseSettings } from "../settings/schema.js";
import { defaultSettingsPath } from "../settings/files.js";
import { resolveProfileRoles } from "../shared/role-profiles.js";
import type { ProviderHealthEvent } from "../shared/provider-health.js";
import type { ProviderQuotaEvent } from "../shared/provider-quota.js";
import { listConnectionTargets } from "./list-connections.js";
import { persistedCoreMode } from "./engine-switch-runtime.js";
import { buildCoreLaunchOptions } from "./engine-launch-options.js";
import { buildCheckpointService } from "./checkpoints.js";
import { createConnectionModelSettings } from "./connection-model-settings.js";
import { createCoreRuntimeMedia } from "./core-runtime-services.js";
import { createCoreRuntimeControls } from "./core-runtime-controls.js";
import { createCoreRuntimeComposition, loadCoreRuntimeExtensions, registerCoreBrowserTools, registerCoreTaskTools } from "./core-runtime-composition.js";
import { buildHostBuiltinSkills } from "./builtin-skills.js";
import { anycodeSetupDocsForHost } from "./anycode-setup-docs.js";
import { pluginsDiscoveryWiring } from "./plugin-wiring.js";
import { parseRecognizerEnv } from "./recognizer-env.js";
import { pricingSnapshotWithKeyDefault } from "./usage-recording.js";
import { RoleHealthCache, resolveRoleRouteChain } from "./role-route.js";
import { wirePlanExit } from "./plan-exit.js";
import type { IpcPermissionBroker } from "./permission-broker.js";
import type { SwitchRuntime } from "./session.js";
import type { SessionEngine } from "./engines/session-engine.js";
import type { SwitchEngineFactoryContext } from "./engine-switch-factory.js";

export interface ProductionCoreResolverContext {
  workspace:string; sessionId:string; runtimeId:string; connectionId:string; sourceEnv:NodeJS.ProcessEnv; home:string;
  database:SqlitePersistenceAdapter; broker:IpcPermissionBroker; rules:SessionPermissionRules; mcpSecrets:McpSecretResolver;
  projectTrusted:boolean; health:RoleHealthCache; preview:NonNullable<AgentLoopConfig["preview"]>; fullBrowserAccess():boolean;
  createRouting():Promise<{port:NonNullable<AgentLoopConfig["sessionSubagents"]>;configure(runtime:SwitchRuntime):void;cleanup():void}>;
  resolveApiKey?:ConstructorParameters<typeof AiSdkModelPort>[0]["resolveApiKey"];
  diagnosticSink?:ConstructorParameters<typeof AiSdkModelPort>[1];
  createModelPort?(endpoint:ConstructorParameters<typeof AiSdkModelPort>[0]):ModelPort;
  ownsRuntime(engine:SessionEngine):boolean; notifyModeChanged(mode:import("@anycode/core").PermissionMode):void; refreshModelSettings():void;
  sendProviderEvent(event:ProviderHealthEvent | ProviderQuotaEvent):void;
}

/** Production resolver; only external adapters/control-plane callbacks are injected. */
export function createProductionCoreResolver(ctx:ProductionCoreResolverContext):SwitchEngineFactoryContext["resolveCore"] {
  const {workspace,sessionId,runtimeId,sourceEnv,home,database,broker,rules,mcpSecrets,projectTrusted,health:roleHealth} = ctx;
  const settingsPath = sourceEnv.ANYCODE_SETTINGS_PATH;
  const platform = process.platform;
  const fs = new NodeFileSystemAdapter();
  const readSettings = () => {try {const parsed=parseSettings(JSON.parse(readFileSync(settingsPath ?? defaultSettingsPath(),"utf8")));return parsed.status === "ok" ? parsed.settings : undefined;}catch{return undefined;}};
  const makePort = ctx.createModelPort ?? (endpoint => new AiSdkModelPort(endpoint,ctx.diagnosticSink));
  return async ({model}) => {

      const envConfig = loadEnvConfig(sourceEnv);
      if (envConfig.model !== model) return undefined;
      const routing = await ctx.createRouting();
      const exec = new NodeExecutionAdapter();
      const tasks = new InProcessTaskManager(exec);
      const registry = createDefaultToolRegistry({ agent: { sessionTier: true } });
      registerCoreBrowserTools(registry,ctx.fullBrowserAccess);
      registerCoreTaskTools(registry);
      registry.register(createListConnectionsTool(() => {const settings=readSettings();if(!settings) throw new Error("Invalid settings");return listConnectionTargets(settings,ctx.connectionId,model,sourceEnv.ANYCODE_ROUTING_ENV_OVERRIDE === "1");}));
      let candidate: SwitchRuntime | undefined;
      const planExit = wirePlanExit(registry,mode => { if (candidate && ctx.ownsRuntime(candidate.engine)) ctx.notifyModeChanged(mode); });
      const hooks = new InMemoryHookRunner();
      const manager = new McpManager({ registry, transports: new NodeMcpTransportFactory() });
      try {
        for (const declaration of await loadHookConfigs(fs, workspace, home, { projectTrusted }).catch(() => [])) hooks.register(createCommandHook(exec, declaration, workspace));
        const loaded = await loadMcpServerSpecs(fs, workspace, home, { projectTrusted, loginPath: sourceEnv.PATH, secrets: mcpSecrets });
        const builtinSkills = buildHostBuiltinSkills({worktreeAvailable:false,previewAvailable:true,anycodeSetupDocs:anycodeSetupDocsForHost()});
        const repoMapConfig = (await loadRepoMapConfig(fs,workspace,home,sourceEnv,{projectTrusted})).repoMap;
        let ext = await loadCoreRuntimeExtensions(fs,{workspace,home,projectTrusted,repoMapConfig,loginPath:sourceEnv.PATH,secrets:mcpSecrets,
          claimedMcpNames:new Set(loaded.specs.map(spec => spec.name)),builtinSkills,appVersion:sourceEnv.ANYCODE_APP_VERSION,
          ...pluginsDiscoveryWiring({home,pluginsSettings:readSettings()?.plugins,builtinSkillNames:builtinSkills.map(skill => skill.name),builtinPersonaNames:Object.keys(PERSONAS)})});
        await manager.start([...loaded.specs,...ext.pluginMcpServerSpecs]);
        const entry = getBuiltinCatalog().providers.find(item => item.id === envConfig.providerId) ?? matchCatalogEntryByBaseUrl(getBuiltinCatalog(), envConfig.baseUrl);
        const resolveApiKey = ctx.resolveApiKey;
        const connectionId = ctx.connectionId;
        const readConnection = () => {
          try { const parsed = parseSettings(JSON.parse(readFileSync(settingsPath ?? defaultSettingsPath(),"utf8"))); return parsed.status === "ok" ? parsed.settings.provider.connections.find(connection => connection.id === connectionId) : null; }
          catch { return null; }
        };
        const modelSettings = createConnectionModelSettings({connection:readConnection() ?? undefined,readConnection,catalogEntry:entry,
          envReasoningEffort:envConfig.reasoningEffort,envReasoningEffortModel:sourceEnv.ANYCODE_REASONING_EFFORT_MODEL,envReasoningEffortFromSettings:!!sourceEnv.ANYCODE_REASONING_EFFORT_MODEL,
          envContextWindow:envConfig.contextWindowTokens,envContextWindowModel:envConfig.contextWindowModel,envContextWindowFromSettings:sourceEnv.ANYCODE_CONTEXT_WINDOW_FROM_SETTINGS === "1",liveCapabilitiesFor:id => readConnection()?.modelCapabilities?.[id]});
        const portFor = (id: string) => {
          const connection = readConnection();
          if (id !== model && !connection?.models?.includes(id) && !modelSettings.entryFor(id)?.models.some(row => row.id === id)) throw new Error("The selected model is unavailable on this connection");
          return makePort({ transport: envConfig.providerTransport ?? entry?.defaultTransport ?? "anthropic-messages", baseUrl: envConfig.baseUrl, apiKey: envConfig.apiKey, model:id, providerId: envConfig.providerId, ...(resolveApiKey ? { resolveApiKey } : {}) });
        };
        const modelPort = portFor(model);
        const candidateHistorySink = new RuntimeHistorySink(database,sessionId,runtimeId!);
        const candidateDbPath = envConfig.dbPath ?? join(home,".anycode","anycode.sqlite");
        const candidateCheckpoints = buildCheckpointService({exec,fs,store:database,workspace,sessionId,
          checkpointsRoot:candidateDbPath === ":memory:" ? join(home,".anycode","checkpoints") : join(dirname(candidateDbPath),"checkpoints")});
        const config: AgentLoopConfig = { modelPort, registry, hooks,
          permissionEngine: new RuleAwarePermissionEngine(new SafeCommandPermissionEngine(new ModePermissionEngine()), rules), permissionBroker: broker,
          ...planExit, mode: persistedCoreMode(database.loadRuntimeSession(sessionId)), cwd: workspace, ports: { fs, exec, gitRead:new NodeGitReadAdapter(exec), http: new NodeHttpAdapter(), todos: new InMemoryTodoStore() },
          sessionSubagents: routing.port, tasks, history: new ConversationHistory({ sink: candidateHistorySink }),
          ...(candidateCheckpoints ? {checkpoints:candidateCheckpoints} : {}),
          systemPrompt: buildSystemPrompt({ toolNames: registry.list(), env: { workingDirectory: workspace, platform, date: new Date().toISOString().slice(0, 10), modelId: model } }),
          ...(envConfig.maxOutputTokens ? { maxOutputTokens: envConfig.maxOutputTokens } : {}),
        };
        let candidateModel = model;
        const imageInputFor = (id:string) => resolveImageInput(id,modelSettings.entryFor(id),envConfig.imageInput ?? modelSettings.imageInputFor(id));
        const tokenizer = await createDefaultTokenizer();
        const systemPromptEnv = {workingDirectory:workspace,platform,osVersion:release(),date:new Date().toISOString().slice(0,10),modelId:model,isGitRepo:await fs.exists(join(workspace,".git"))};
        const settingsForChild = buildChildModelSettingsResolver({catalogEntry:entry,catalogEntryFor:id => modelSettings.entryFor(id),
          envMaxOutputTokens:envConfig.maxOutputTokens,envContextWindow:envConfig.contextWindowTokens,envContextWindowModel:envConfig.contextWindowModel,
          liveCapabilitiesFor:id => modelSettings.capabilitiesFor(id),effortLevelsFor:id => modelSettings.effortLevelsFor(id),contextWindowFor:id => modelSettings.contextFor(id).tokens});
        const composition = createCoreRuntimeComposition({registry,extensions:() => ext,env:systemPromptEnv,sourceEnv,bootModel:model,providerId:envConfig.providerId,exploreModel:envConfig.exploreModel,
          modelPortFor:portFor,settingsForChild,selectedEffort:() => controls.selectedEffort(),roles:() => {const settings=readSettings();return settings ? resolveProfileRoles(settings,workspace) : undefined;},
          mcpInstructions:() => buildMcpInstructionsSection(manager.instructions()),preview:ctx.preview,
          renderRepoMap:() => {
            if (!repoMapConfig) return "";
            const window=modelSettings.contextFor(candidateModel).tokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
            const maxTokens=repoMapConfig.maxTokens ?? Math.max(REPO_MAP_MIN_TOKENS,Math.min(REPO_MAP_MAX_TOKENS,Math.floor(REPO_MAP_WINDOW_FRACTION*window)));
            return buildRepoMapPromptSection(ext.repoMapFiles,{maxTokens,tokenizer,workspace}).section;
          }});
        const promptFor = (id:string) => {systemPromptEnv.modelId=id;config.systemPromptComponents=composition.components();return composition.prompt(config.systemPromptComponents);};
        const media = createCoreRuntimeMedia({registry,imageInputEnabled:() => imageInputFor(candidateModel),
          endpoint:parseRecognizerEnv(sourceEnv),env:sourceEnv,reserveRef:() => database.reserveImageRef(sessionId),
          portFactory:makePort,
          onRegistrationChanged:() => {config.systemPrompt=promptFor(candidateModel);}});
        config.media = media;
        config.recognizer = media.recognizer;
        media.recompute();
        const webSearch = (await loadWebSearchConfig(fs,workspace,home,sourceEnv,{projectTrusted})).backend;
        const webSearchTool = webSearch ? createWebSearchTool(webSearch) : undefined;
        if (webSearchTool) registry.register(webSearchTool);
        const controls = createCoreRuntimeControls({config,model,settings:modelSettings,modelPortFor:portFor,maxOutputTokens:envConfig.maxOutputTokens,
          imageInputFor,imageFallbackAvailable:media.recognizerConfigured,
          systemPromptFor:id => {candidateModel=id;media.recompute();return promptFor(id);},
          createLoop:config => composition.loop(config,{...(webSearchTool ? {webSearchTool} : {}),
            readConnectionTargets:() => {const settings=readSettings();if(!settings) throw new Error("Invalid settings");return listConnectionTargets(settings,ctx.connectionId,candidateModel,sourceEnv.ANYCODE_ROUTING_ENV_OVERRIDE === "1");},
            resolveRoleRoute:role => {const settings=readSettings();const route=settings && isRoleRouteName(role) ? resolveProfileRoles(settings,workspace)?.[role] : undefined;
              return route ? resolveRoleRouteChain({role,config:route,claimedByMdProfile:ext.profiles.some(profile => profile.name === role),health:roleHealth.snapshot(),now:Date.now()}) : null;}}),
          onRefresh: () => { if (candidate && ctx.ownsRuntime(candidate.engine)) ctx.refreshModelSettings(); },
        });
        const options = {...controls.options,onBeforeTurn:async () => {
          await controls.options.onBeforeTurn?.();
          const rescanned=await ext.rescanProfiles();
          if (rescanned && rescanned.promptSection !== ext.profilesPromptSection) {
            ext={...ext,profiles:rescanned.profiles,profilesPromptSection:rescanned.promptSection};config.systemPrompt=promptFor(candidateModel);
          }
        }};
        return { model, options: buildCoreLaunchOptions(options),
          services:{adapter:() => database,sessionId,media,checkpoints:candidateCheckpoints ?? undefined,flushHistory:() => candidateHistorySink.flushChecked(),
            readOrchestrator:() => {try {const parsed=parseSettings(JSON.parse(readFileSync(settingsPath ?? defaultSettingsPath(),"utf8")));return parsed.status === "ok" ? resolveProfileRoles(parsed.settings,workspace)?.orchestrator : undefined;}catch{return undefined;}},
            health:() => roleHealth.snapshot(),sendProviderEvent:event => ctx.sendProviderEvent(event),
            pricing:() => ({catalogEntry:entry,baseUrl:envConfig.baseUrl,pricingRaw:pricingSnapshotWithKeyDefault(JSON.stringify(modelSettings.pricingSnapshot()),entry,envConfig.apiKey)})},
          configure: runtime => { routing.configure(runtime); runtime.presentation = { ...runtime.presentation,
            pinnedConnection: { connectionId: connectionId, providerId: envConfig.providerId ?? "custom" },
            modelSettingsConnectionId: connectionId,
            ...controls.presentation,
          }; runtime.callbacks = {...runtime.callbacks,...controls.callbacks}; candidate = runtime; }, cleanup: async () => { routing.cleanup(); await tasks.disposeAll(); await manager.dispose(); } };
      } catch (error) { routing.cleanup(); await tasks.disposeAll(); await manager.dispose(); throw error; }
      };
}
