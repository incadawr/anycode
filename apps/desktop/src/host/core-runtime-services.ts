import { AskCache, createInspectImageTool, generateSessionTitle, type AgentLoopConfig, type ModelPort, type RecognizerEndpoint, type SqlitePersistenceAdapter } from "@anycode/core";
import type { RoleConfig } from "../shared/settings.js";
import { PROVIDER_HEALTH_EVENT_TYPE, type ProviderHealthEvent } from "../shared/provider-health.js";
import { PROVIDER_QUOTA_EVENT_TYPE, type ProviderQuotaEvent } from "../shared/provider-quota.js";
import { createCompactionRecordLog } from "./compaction-records.js";
import { recognizerLiveWindow } from "./recognizer-env.js";
import { pickEntry, toCoreEntry, type HealthSnapshot } from "./role-route.js";
import { createCoreSessionTitlePersistence } from "./session-title-persistence.js";
import type { SwitchRuntime } from "./session.js";
import { summarizeWithChildren } from "./usage-summary.js";
import { sessionUsageRow, type StepPricing } from "./usage-recording.js";

export interface CoreRuntimeMedia {
  imageInputEnabled(): boolean;
  recognizerConfigured(): boolean;
  recognizer: NonNullable<AgentLoopConfig["recognizer"]>;
  recompute(): boolean;
  applyRecognizerConfig(next: RecognizerEndpoint | null): void;
}

/** One cache and one tool identity per core runtime, including a switched candidate. */
export function createCoreRuntimeMedia(deps: {
  registry: AgentLoopConfig["registry"];
  imageInputEnabled(): boolean;
  endpoint: RecognizerEndpoint | null;
  env: NodeJS.ProcessEnv;
  reserveRef(): Promise<number>;
  portFactory(endpoint: RecognizerEndpoint): ModelPort;
  allowInspectImage?: boolean;
  onRegistrationChanged(): void;
}): CoreRuntimeMedia {
  let configured = deps.endpoint !== null;
  const endpoint: RecognizerEndpoint = deps.endpoint ?? {transport:"anthropic-messages",baseUrl:"",model:""};
  const cache = new AskCache();
  let tool: ReturnType<typeof createInspectImageTool> | undefined;
  const recognizer: NonNullable<AgentLoopConfig["recognizer"]> = {
    reserveRef:deps.reserveRef,endpoint:configured ? endpoint : undefined,cache,portFactory:deps.portFactory,
  };
  const recompute = () => {
    const enabled = configured && !deps.imageInputEnabled() && deps.allowInspectImage !== false;
    if (enabled === deps.registry.has("InspectImage")) return false;
    if (enabled) {
      tool ??= createInspectImageTool({recognizer:{endpoint,cache,portFactory:deps.portFactory}});
      deps.registry.register(tool);
    } else deps.registry.unregister("InspectImage");
    return true;
  };
  return {
    imageInputEnabled:deps.imageInputEnabled,
    recognizerConfigured:() => configured,
    recognizer,recompute,
    applyRecognizerConfig(next: RecognizerEndpoint | null) {
      configured = next !== null;
      if (next) Object.assign(endpoint,next,{contextWindowTokens:recognizerLiveWindow(deps.env,next),
        apiKey:next.apiKey,providerName:next.providerName,
        goModelPolicy:next.goModelPolicy,modelMetadata:next.modelMetadata,pricingRaw:next.pricingRaw});
      recognizer.endpoint = configured ? endpoint : undefined;
      if (recompute()) deps.onRegistrationChanged();
    },
  };
}

export interface CoreRuntimeServicesDependencies {
  config: AgentLoopConfig;
  checkpoints?: NonNullable<SwitchRuntime["callbacks"]>["checkpoints"];
  adapter(): SqlitePersistenceAdapter | null;
  sessionId: string;
  media: ReturnType<typeof createCoreRuntimeMedia>;
  flushHistory(): Promise<void>;
  readOrchestrator(): RoleConfig | undefined;
  health(): HealthSnapshot;
  sendProviderEvent(event: ProviderHealthEvent | ProviderQuotaEvent): void;
  pricing(): Pick<StepPricing,"catalogEntry" | "baseUrl" | "pricingRaw">;
  usageTail?: {read(): Promise<void> | undefined; write(tail: Promise<void>): void};
}

/** Boot and switch share the complete set of core-owned Session services. */
export async function createCoreRuntimeServices(deps: CoreRuntimeServicesDependencies) {
  const {config,sessionId,media} = deps;
  const database = () => { const adapter = deps.adapter(); if (!adapter) throw new Error("Core persistence is unavailable"); return adapter; };
  let writes = Promise.resolve();
  const tail = () => deps.usageTail?.read() ?? writes;
  const compactionRecords = await createCompactionRecordLog(deps.adapter,sessionId).catch(error => {
    console.error("[host] compaction records unavailable",error); return undefined;
  });
  if (config.checkpoints) {
    config.compactionBoundary = () => compactionRecords?.sequence() ?? 0;
    config.turnErrorBoundary = async () => (await database().loadTurnErrors(sessionId)).map(record => record.id);
  }
  const callbacks: NonNullable<SwitchRuntime["callbacks"]> = {
    checkpoints:deps.checkpoints,
    persistence:createCoreSessionTitlePersistence({adapter:deps.adapter,sessionId,onError:error => console.error("[host] touchSession failed",error)}),
    compactionRecords,
    saveTurnError:record => database().appendTurnError(sessionId,record),
    saveContextUsage:snapshot => database().saveContextUsage(sessionId,snapshot ? JSON.stringify(snapshot) : null),
    currentTurnErrorIds:async () => (await database().loadTurnErrors(sessionId)).map(record => record.id),
    restoreHistoryAndTurnErrors:async (items,errorIds,boundary) => {
      await deps.flushHistory();
      return database().restoreHistoryAndTurnErrors(sessionId,items,errorIds,boundary);
    },
    reportProviderHealth:event => deps.sendProviderEvent(event.kind === "success"
      ? {type:PROVIDER_HEALTH_EVENT_TYPE,kind:"success"}
      : {type:PROVIDER_HEALTH_EVENT_TYPE,kind:"failure",code:event.code}),
    reportProviderQuota:(quota,source) => deps.sendProviderEvent({type:PROVIDER_QUOTA_EVENT_TYPE,quota,source}),
    refineTitle:text => generateSessionTitle({modelPort:config.modelPort,text}),
    applyRecognizerConfig:media.applyRecognizerConfig,
    orchestratorRouteCheck:() => {
      const orchestrator = deps.readOrchestrator();
      if (!orchestrator) return undefined;
      const picked = pickEntry([orchestrator.primary,...(orchestrator.fallbacks ?? [])].map(toCoreEntry),deps.health(),Date.now(),"orchestrator");
      if (!picked || picked.index === 0) return undefined;
      const reason = picked.skipped[0]?.reason ?? "unhealthy";
      const model = picked.entry.model;
      if (!model || picked.entry.engine !== undefined || picked.entry.connection !== undefined || picked.entry.provider !== undefined) {
        return `Orchestrator: primary route unhealthy (${reason}); configure a model fallback to switch automatically.`;
      }
      const effort = picked.entry.effort === "xhigh" ? undefined : picked.entry.effort;
      return {notice:`Orchestrator: primary route unhealthy (${reason}), running on ${model}.`,model,...(effort !== undefined ? {effort} : {})};
    },
    usageAudit:{sink:{
      record:(record,finishedAt,endpointSnapshot) => {
        const row = sessionUsageRow(record,{...deps.pricing(),model:record.model,endpointSnapshot,finishedAt,now:Date.now},sessionId);
        writes = tail().then(() => database().recordProviderUsage(row)).catch(error => console.error("[host] usage audit write failed",error));
        deps.usageTail?.write(writes);
      },flush:tail,
    },summary:{summary:async () => { await tail(); return summarizeWithChildren(database(),sessionId); }}},
  };
  return {callbacks,presentation:{imageInputEnabled:media.imageInputEnabled,imageFallbackAvailable:media.recognizerConfigured}};
}
