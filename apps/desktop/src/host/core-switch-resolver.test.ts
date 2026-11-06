import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe,it,expect,vi } from "vitest";
import { SqlitePersistenceAdapter,SessionPermissionRules,executeToolCall,type AgentLoopConfig,type PreviewPort } from "@anycode/core";
import { createProductionCoreResolver } from "./core-switch-resolver.js";
import { createSwitchEngineFactory } from "./engine-switch-factory.js";
import { IpcPermissionBroker } from "./permission-broker.js";
import { createChildSessionPort } from "./child-session-port.js";
import { bindRuntimeOrchestration } from "./runtime-orchestration.js";
import { RoleHealthCache } from "./role-route.js";
import { ScriptedModelPort,textStep } from "./test-harness.js";

describe("production core switch resolver",() => {
  it("loads workspace instructions and extensions, browser tools and model-specific inline children",async () => {
    const dir=await mkdtemp(join(tmpdir(),"core-resolver-"));
    const workspace=join(dir,"workspace"),home=join(dir,"home"),settingsPath=join(dir,"settings.json");
    const database=new SqlitePersistenceAdapter(":memory:");
    const broker=new IpcPermissionBroker(() => {});
    const routing=createChildSessionPort({parentSessionId:"logical",send:() => {},subscribe:() => () => {},getPermissionMode:() => "plan"});
    const cleanup=vi.fn();
    const preview:PreviewPort={open:vi.fn(async () => ({ok:false as const,error:"unused"})),screenshot:vi.fn(async () => ({ok:false as const,error:"unused"})),
      read:vi.fn(async () => ({ok:true as const,value:{previewId:"preview",url:"http://localhost",text:"browser from candidate"}}))};
    const ports=new Map<string,ScriptedModelPort>();
    let config:AgentLoopConfig | undefined;
    let runtime:import("./session.js").SwitchRuntime | import("./engines/session-engine.js").SessionEngine | undefined;
    try {
      await mkdir(join(workspace,".anycode","skills","project-skill"),{recursive:true});
      await mkdir(join(workspace,".anycode","workflows"),{recursive:true});
      await mkdir(join(workspace,".anycode","agents"),{recursive:true});
      await mkdir(join(home,".anycode"),{recursive:true});
      await writeFile(join(workspace,"AGENTS.md"),"Project instruction: always keep the lighthouse marker.\n");
      await writeFile(join(home,"AGENTS.md"),"User instruction: preserve the compass marker.\n");
      await writeFile(join(workspace,".anycode","skills","project-skill","SKILL.md"),"---\nname: project-skill\ndescription: Project skill for this workspace\n---\nProject skill body from disk.\n");
      await writeFile(join(workspace,".anycode","agents","workspace-reader.md"),"---\nname: workspace-reader\ndescription: Read project details\ntools: [Read]\n---\nRead the lighthouse instructions.\n");
      await writeFile(join(workspace,".anycode","workflows","project-flow.json"),JSON.stringify({name:"project-flow",description:"Project workflow",steps:[{id:"read",agentType:"general-purpose",promptTemplate:"Read ${input}"}]}));
      await writeFile(settingsPath,JSON.stringify({version:2,provider:{activeConnectionId:"pinned",connections:[{id:"pinned",providerId:"",model:"parent-model",models:["parent-model","child-model"],
        modelOverrides:{"parent-model":{contextWindowTokens:64000},"child-model":{contextWindowTokens:32000,reasoningSupported:true,effortLevels:["low","high"]}}}]},
        tools:{},permissions:{alwaysAllow:[]},ui:{theme:"system"},security:{allowWeakSecretStorage:false}}));
      await database.createSession({id:"logical",workspace,model:"parent-model",mode:"plan"});
      const runtimeId=database.ensureRuntimeSession("logical").activeSegmentId;
      const resolver=createProductionCoreResolver({workspace,home,sessionId:"logical",runtimeId,connectionId:"pinned",database,broker,rules:new SessionPermissionRules(),
        sourceEnv:{ANYCODE_MODEL:"parent-model",ANYCODE_API_KEY:"fixture-key",ANYCODE_BASE_URL:"http://fixture",ANYCODE_SETTINGS_PATH:settingsPath,
          ANYCODE_CHILD_MODELS:JSON.stringify(["parent-model","child-model"]),ANYCODE_REASONING_EFFORT:"high"},
        projectTrusted:true,health:new RoleHealthCache(),preview,fullBrowserAccess:() => false,mcpSecrets:() => undefined,
        createRouting:async () => ({port:routing,cleanup,configure:next => {bindRuntimeOrchestration(next.engine,{ownerSessionId:"logical",port:routing,baseMode:() => next.engine.mode()});}}),
        ownsRuntime:() => true,notifyModeChanged:() => {},refreshModelSettings:() => {},sendProviderEvent:() => {},
        createModelPort:endpoint => {const port=new ScriptedModelPort([textStep("candidate answer"),textStep("workflow answer"),textStep("other answer")]);ports.set(endpoint.model,port);return port;},
      });
      const factory=createSwitchEngineFactory({engineSwitchEnabled:true,workspace,sessionId:"logical",resolveCore:async request => {
        const resolved=await resolver(request);config=resolved?.options.config;return resolved;
      },resolveCodex:async () => undefined,resolveClaude:async () => undefined})!;
      runtime=await factory("core","parent-model");
      if (!("engine" in runtime) || !config) throw new Error("Core resolver did not prepare a runtime");
      for await (const _ of runtime.engine.runTurn("verify project context",{signal:new AbortController().signal})) { /* drain */ }
      const request=ports.get("parent-model")!.requests[0]!;
      for (const marker of ["lighthouse marker","compass marker","project-skill","project-flow","workspace-reader","BrowserRead"]) expect(request.system).toContain(marker);
      const dispatch={...config,askClassifier:undefined};
      const skill=await executeToolCall(dispatch,{id:"skill",name:"Skill",input:{name:"project-skill"}});
      expect(skill.status).toBe("success");expect(skill.modelText).toContain("Project skill body from disk");
      const browser=await executeToolCall(dispatch,{id:"browser",name:"BrowserRead",input:{}});
      expect(browser.status).toBe("success");expect(browser.modelText).toContain("browser from candidate");expect(preview.read).toHaveBeenCalledOnce();
      expect(config.workflows!.list().some(flow => flow.name === "project-flow")).toBe(true);
      const workflow=await executeToolCall(dispatch,{id:"workflow",name:"Workflow",input:{name:"project-flow",input:"workspace"}});
      expect(workflow.status).toBe("success");
      const child=await config.subagents!.run({agentType:"general-purpose",description:"Use explicit child model",prompt:"read instructions",model:"child-model"},{});
      expect(child.status).toBe("completed");
      const childRequest=ports.get("child-model")!.requests[0]!;
      expect(childRequest.system).toContain("lighthouse marker");
      expect(childRequest.reasoningEffort).toBe("high");
      expect(config.registry.list()).toEqual(expect.arrayContaining(["BrowserOpen","BrowserRead","BrowserScreenshot","BrowserClick","BrowserEval","Skill","Workflow","ListConnections"]));
      await expect(config.subagents!.run({agentType:"general-purpose",description:"Unknown child model",prompt:"read",model:"foreign-model"},{})).resolves.toMatchObject({status:"error"});
    } finally {
      if (runtime && "engine" in runtime) await runtime.engine.dispose("session-close");
      await database.close();await rm(dir,{recursive:true,force:true});
    }
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
