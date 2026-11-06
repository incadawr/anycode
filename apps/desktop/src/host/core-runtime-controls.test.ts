import { describe, expect, it } from "vitest";
import { type AgentLoopConfig } from "@anycode/core";
import { createCoreRuntimeControls } from "./core-runtime-controls.js";
import { createConnectionModelSettings } from "./connection-model-settings.js";
import { CoreEngine } from "./engines/core-engine.js";
import { createHarness, ScriptedModelPort, finishStep } from "./test-harness.js";

describe("replacement core model controls", () => {
  it("replaces model, effort, context and image gates without changing connection defaults", async () => {
    const baseline = createHarness({steps:[]});
    const connection = {model:"a",modelOverrides:{a:{contextWindowTokens:128000,reasoningSupported:true,reasoningEffort:"high" as const},b:{contextWindowTokens:32000,reasoningSupported:false}}};
    const settings = createConnectionModelSettings({connection,liveCapabilitiesFor:() => undefined});
    const a = new ScriptedModelPort([finishStep()]);
    const b = new ScriptedModelPort([finishStep()]);
    const config: AgentLoopConfig = {...baseline.config,modelPort:a};
    const controls = createCoreRuntimeControls({config,model:"a",settings,modelPortFor:id => id === "a" ? a : b,imageInputFor:id => id === "a",systemPromptFor:id => `current model ${id}`});
    const engine = new CoreEngine(controls.options);
    try {
      expect(controls.presentation.imageInputEnabled()).toBe(true);
      expect(engine.reasoningEffort()).toBe("high");
      const firstBudget = engine.importBudgetBytes();
      const switched = engine.switchModel!("b","high");
      expect(switched).toMatchObject({model:"b",reasoningEffort:"off",contextUsage:{budgetTokens:8000}});
      expect(controls.presentation.imageInputEnabled()).toBe(false);
      expect(engine.importBudgetBytes()).toBeLessThan(firstBudget);
      expect(controls.callbacks.effortResolution.levels("b")).toBeUndefined();
      for await (const _ of engine.runTurn("target turn",{signal:new AbortController().signal})) { /* drain */ }
      expect(a.requests).toHaveLength(0);
      expect(b.requests).toHaveLength(1);
      expect(config.systemPrompt).toBe("current model b");
      engine.switchModel!("a","off");
      expect(engine.reasoningEffort()).toBe("high");
      expect(connection.model).toBe("a");
    } finally { baseline.close(); await engine.dispose("session-close"); }
  });
});
