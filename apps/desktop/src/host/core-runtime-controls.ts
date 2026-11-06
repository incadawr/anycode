import { AgentLoop, SwitchableModelPort, createMediaProjectionPort, resolveEffortLevels, resolveMaxOutputTokens, resolveReasoningEffort, type AgentLoopConfig, type ModelPort, type ReasoningEffort } from "@anycode/core";
import { createConnectionModelSettings } from "./connection-model-settings.js";
import type { CoreEngineOptions } from "./engines/core-engine.js";
import type { SwitchRuntime } from "./session.js";

/** A replacement core owns its model cell, budget and capability resolvers. */
export function createCoreRuntimeControls(deps: {
  config: AgentLoopConfig;
  model: string;
  settings: ReturnType<typeof createConnectionModelSettings>;
  modelPortFor(model: string): ModelPort;
  imageInputFor(model: string): boolean;
  imageFallbackAvailable?(): boolean;
  systemPromptFor(model: string): string;
  initialEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  onRefresh?(): void;
  createLoop?(config:AgentLoopConfig):AgentLoop;
}) {
  const { config, settings } = deps;
  let model = deps.model;
  let selected = settings.normalize(model,deps.initialEffort ?? settings.effortFor(model) ?? resolveReasoningEffort(model,settings.entryFor(model),undefined,settings.capabilitiesFor(model),settings.effortLevelsFor(model)) ?? "off");
  const port = new SwitchableModelPort(config.modelPort);
  config.modelPort = createMediaProjectionPort(port, () => deps.imageInputFor(model));
  const effective = (id: string, tier: ReasoningEffort) => resolveReasoningEffort(id,settings.entryFor(id),tier,settings.capabilitiesFor(id),settings.effortLevelsFor(id));
  const levels = (id: string) => resolveEffortLevels(id,settings.entryFor(id),settings.capabilitiesFor(id),settings.effortLevelsFor(id));
  const budget = () => {
    config.context = {...config.context,contextWindowTokens:settings.contextFor(model).tokens};
    config.maxOutputTokens = resolveMaxOutputTokens(model,settings.entryFor(model),deps.maxOutputTokens);
    config.reasoningEffort = effective(model,selected);
    config.systemPrompt = deps.systemPromptFor(model);
  };
  budget();
  const loop = deps.createLoop?.(config) ?? new AgentLoop(config);
  const options: CoreEngineOptions = {
    config,loop,
    resolveSelectedEffort: effort => effective(model,effort),
    onReasoningEffortSet: effort => { selected = effort ?? "off"; settings.remember(model,selected); },
    onBeforeTurn: async () => { if (settings.refresh()) deps.onRefresh?.(); },
    switchModelImpl(id,effort,explicit) {
      // Resolve before mutating the running model, so an unavailable model is a no-op.
      const next = deps.modelPortFor(id);
      selected = settings.switchEffort(model,id,effort,explicit);
      const previousModel = model;
      port.setPort(next);
      model = id;
      budget();
      loop.setContextWindow(settings.contextFor(model).tokens);
      if (previousModel !== model) loop.invalidateProviderAnchor();
      const context = loop.contextInfo();
      return {model,previousModel,selectedReasoningEffort:selected,reasoningEffort:config.reasoningEffort ?? "off",availableEffortLevels:levels(model),
        contextUsage:{estimatedTokens:context.estimatedTokens,budgetTokens:context.effectiveWindowTokens,source:context.source},
        effortAdjustment:settings.takeAdjustment()};
    },
  };
  return {
    selectedEffort:() => selected,
    options,
    callbacks: {effortResolution:{levels,effective}} satisfies SwitchRuntime["callbacks"],
    presentation: {imageInputEnabled:() => deps.imageInputFor(model),imageFallbackAvailable:deps.imageFallbackAvailable ?? (() => false),contextWindowAssumed:() => settings.contextFor(model).source === "assumed"} satisfies SwitchRuntime["presentation"],
  };
}
