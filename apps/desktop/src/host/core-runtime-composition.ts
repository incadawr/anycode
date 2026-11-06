import {
  AgentLoop, PERSONAS, ROLE_TURN_BUDGETS, browserOpenTool, browserReadTool, browserScreenshotTool,
  buildSystemPrompt, createBrowserControlTools, createSkillPort, discoverExtensions, withSubagents, withWorkflows,
  type AgentLoopConfig, type ExtensionsBootstrap, type FileSystemPort, type ModelPort, type PersonaDefinition,
  type ReasoningEffort, type SystemPromptEnv, backgroundCapableBashTool, bashOutputTool, bashKillTool,
} from "@anycode/core";
import type { AnycodeSettings } from "../shared/settings.js";
import { assertChildModel, readAllowedChildModels } from "../shared/child-model.js";

export async function loadCoreRuntimeExtensions(fs:FileSystemPort,options:Parameters<typeof discoverExtensions>[1]):Promise<ExtensionsBootstrap> {
  try { return await discoverExtensions(fs,options); }
  catch (error) {
    console.error("[host] extensions discovery failed; continuing with zero skills/agent profiles/plugins",error);
    return {skills:createSkillPort(fs,[]),skillsPromptSection:"",profiles:[],profilesPromptSection:"",rescanProfiles:async () => null,
      pluginMcpServerSpecs:[],workflows:[],workflowsPromptSection:"",memorySection:"",repoMapFiles:[],problems:[]};
  }
}

export function registerCoreBrowserTools(registry:AgentLoopConfig["registry"],fullAccess:() => boolean):void {
  registry.register(browserOpenTool);registry.register(browserReadTool);registry.register(browserScreenshotTool);
  const control = createBrowserControlTools({fullAccess});
  for (const tool of [control.navigate,control.snapshot,control.click,control.type,control.waitFor,control.console,control.eval]) registry.register(tool);
}

export function registerCoreTaskTools(registry:AgentLoopConfig["registry"]):void {
  registry.register(backgroundCapableBashTool,{silentDuplicateWarning:true});
  registry.register(bashOutputTool);registry.register(bashKillTool);
}

type SubagentOptions = NonNullable<Parameters<typeof withSubagents>[1]>;
type Components = NonNullable<AgentLoopConfig["systemPromptComponents"]>;

/** The same instruction, tool and child graph is applied at boot and replacement. */
export function createCoreRuntimeComposition(deps:{
  registry:AgentLoopConfig["registry"];
  extensions():ExtensionsBootstrap;
  env:SystemPromptEnv;
  sourceEnv:NodeJS.ProcessEnv;
  bootModel:string;
  providerId?:string;
  exploreModel?:string;
  modelPortFor(id:string):ModelPort;
  settingsForChild:NonNullable<SubagentOptions["resolveChildModelSettings"]>;
  selectedEffort():ReasoningEffort;
  roles?():AnycodeSettings["roles"];
  mcpInstructions():string;
  renderRepoMap():string;
  lspCoveredExtensions?():string[];
  preview?:AgentLoopConfig["preview"];
}) {
  const components = ():Components => {
    const ext = deps.extensions();
    return [{kind:"memory",text:ext.memorySection},{kind:"skills",text:ext.skillsPromptSection},
      {kind:"workflows",text:ext.workflowsPromptSection},{kind:"profiles",text:ext.profilesPromptSection},
      {kind:"mcp",text:deps.mcpInstructions()},{kind:"repoMap",text:deps.renderRepoMap()}];
  };
  const prompt = (parts:Components = components()) => buildSystemPrompt({toolNames:deps.registry.list(),env:deps.env,
    visionFallbackEnabled:deps.registry.has("InspectImage"),lspCoveredExtensions:deps.lspCoveredExtensions?.() ?? []})+parts.map(part => part.text).join("");
  const profiles = ():PersonaDefinition[] => {
    const ext = deps.extensions();
    const claimed = new Set(ext.profiles.map(profile => profile.name));
    const roles = deps.roles?.();
    const derived:PersonaDefinition[] = [];
    for (const role of ["planner","executor","reviewer"] as const) {
      const primary = roles?.[role]?.primary;
      if (claimed.has(role) || !primary) continue;
      const builtin = PERSONAS[role];
      derived.push({name:role,description:builtin.description,tools:builtin.tools,systemPrompt:builtin.systemPrompt,
        turnBudget:ROLE_TURN_BUDGETS[role],origin:"settings",...primary});
    }
    return derived.length ? [...ext.profiles,...derived] : ext.profiles;
  };
  return {
    components,prompt,profiles,
    loop(config:AgentLoopConfig,options:SubagentOptions = {},child = false):AgentLoop {
      config.skills = deps.extensions().skills;
      if (deps.preview) config.preview = deps.preview;
      if (!child) {
        withSubagents(config,{...options,profiles,env:deps.env,memorySection:deps.extensions().memorySection,
          exploreModel:deps.exploreModel,
          resolveChildModelPort:id => {
            assertChildModel(id,readAllowedChildModels(deps.sourceEnv.ANYCODE_CHILD_MODELS,deps.bootModel,deps.providerId === "opencode" || deps.providerId === "opencode-openai"));
            return deps.modelPortFor(id);
          },
          resolveChildModelSettings:(id,effort) => deps.settingsForChild(id,effort ?? deps.selectedEffort()),
        });
        withWorkflows(config,deps.extensions().workflows);
      }
      return new AgentLoop(config);
    },
  };
}
