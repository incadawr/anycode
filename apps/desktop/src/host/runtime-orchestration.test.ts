import type { ChildRunEvent } from "../shared/child-sessions.js";
import { describe,expect,it,vi } from "vitest";
import { createForeignOrchestrationComposition } from "./foreign-orchestration-composition.js";
import { createRoutedChildComposition } from "./routed-child-composition.js";
import { RoleHealthCache } from "./role-route.js";
import { claudeAgentPermissionMode } from "./engines/child-permission-map.js";
import { createBridgePresentationStamp } from "./engines/claude/bridge-presentation-stamp.js";
import { cloneDefaults } from "../settings/schema.js";
import { createChildStatusStore } from "@anycode/core";
import { bindRuntimeOrchestration } from "./runtime-orchestration.js";
import { createHarness } from "./test-harness.js";
import { createChildSessionPort } from "./child-session-port.js";
import { ClaudeShadowTranscriptEngine } from "./engines/claude/shadow-transcript.js";

describe("runtime routing custody", () => {
  it("forwards future native policy and composition through the transcript wrapper and cleans once", async () => {
    const h = createHarness({steps:[]});
    const capture = vi.fn(); const cleanup = vi.fn(); const cancel = vi.fn();
    const apply = vi.fn(async (enabled: boolean,baseAuthority: unknown) => ({enabled,baseAuthority}));
    const verify = vi.fn(async function(this: unknown) { expect(this).toBe(h.engine); });
    Object.assign(h.engine,{verifyOrchestrationOff:verify});
    Object.assign(h.engine,{orchestrationPolicy:{availability:() => ({supported:true as const}),apply}});
    const composition = bindRuntimeOrchestration(h.engine,{ownerSessionId:"logical",port:{hasRunningChildren:() => false,cancelAllBackgroundChildren:cancel},baseMode:() => "edit",capture,cleanup});
    const wrapper = new ClaudeShadowTranscriptEngine(h.engine,{record:() => {},list:async () => []},"native",[]);
    try {
      expect(wrapper.orchestrationPolicy?.apply).toBe(apply);
      await wrapper.verifyOrchestrationOff?.();
      expect(verify).toHaveBeenCalledTimes(1);
      expect(wrapper.orchestrationComposition).toBe(composition);
      expect(wrapper.orchestrationCompositionReady).toBe(true);
      expect(composition.baseMode()).toBe("edit");
      composition.capture("auto"); expect(capture).toHaveBeenCalledWith("auto");
      await wrapper.dispose("session-close"); await wrapper.dispose("session-close");
      expect(cleanup).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
      expect(wrapper.orchestrationCompositionReady).toBe(false);
      expect(() => composition.capture("yolo")).toThrow("disposed");
    } finally { h.close(); }
  });

  it("counts pending foreground admission and rejects calls from an inactive runtime", async () => {
    const controller = new AbortController();
    let active = false;
    const send = vi.fn();
    let notify: (event:ChildRunEvent) => void = () => {};
    const port = createChildSessionPort({parentSessionId:"logical",getPermissionMode:() => "plan",canRun:() => active,send,subscribe:listener => { notify = listener; return () => {}; }});
    const request = {agentType:"executor",description:"work",prompt:"work",spawnToolCallId:"call"};
    expect(await port.run(request,{signal:controller.signal})).toMatchObject({status:"error",finalText:expect.stringContaining("unavailable")});
    expect(send).not.toHaveBeenCalled();
    active = true;
    const pending = port.run(request,{signal:controller.signal});
    expect(port.hasRunningChildren()).toBe(true);
    const spawn = send.mock.calls[0]![0];
    notify({type:"anycode:child-run-event",kind:"rejected",requestId:spawn.requestId,reason:"limit_parent",message:"fixture refusal"});
    await pending;
    expect(port.hasRunningChildren()).toBe(false);
  });

  it("routes Claude calls through admission, refuses before bind, and retires its subscription", async () => {
    const h = createHarness({ steps: [] });
    const settings = cloneDefaults();
    settings.provider.connections = [{ id: "api", providerId: "custom", model: "model" }];
    settings.provider.activeConnectionId = "api";
    const health = new RoleHealthCache();
    const routed = createRoutedChildComposition({ health, describeError: String, resolve: () => null, prepare: req => req, record: () => {}, deliver: () => {}, report: () => {} });
    let bound = false;
    let disposed = false;
    let notify: (event: ChildRunEvent) => void = () => {};
    const unsubscribe = vi.fn();
    const send = vi.fn();
    const foreign = createForeignOrchestrationComposition({ settings: () => settings, profiles: async () => ({ profiles: [], problems: [] }), projectRoot: "/project", preset: () => bound ? "workspace" : "read-only", permissionMode: claudeAgentPermissionMode, health, routed });
    const port = createChildSessionPort({ parentSessionId: "logical", getPermissionMode: foreign.childMode, canRun: () => bound && !disposed, send, subscribe: listener => { notify = listener; return unsubscribe; } });
    routed.attach(port);
    const catalog = await foreign.catalog();
    const stamp = createBridgePresentationStamp({ catalog, resolveCallCatalog: foreign.catalog, callAgent: foreign.call, restricted: foreign.isEnabled, port, onEvent: () => {} });
    const call = (id: string) => stamp.callTool("agent", { agent_type: "executor", description: "work", prompt: "work" }, new AbortController().signal, { toolUseId: id });
    const composition = bindRuntimeOrchestration(h.engine, { ownerSessionId: "logical", port, baseMode: foreign.childMode, capture: foreign.captureMode, clear: foreign.clearBaseAuthority, cleanup: () => { disposed = true; unsubscribe(); } });
    try {
      expect(foreign.childMode()).toBe("plan");
      expect(await call("before")).toMatchObject({ isError: true, text: expect.stringContaining("unavailable") });
      expect(send).not.toHaveBeenCalled();
      bound = true;
      const pending = call("rejected");
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      const spawn = send.mock.calls[0]![0];
      expect(spawn.permissionMode).toBe("build");
      notify({ type: "anycode:child-run-event", kind: "rejected", requestId: spawn.requestId, reason: "limit_parent", message: "fixture refusal" });
      expect(await pending).toMatchObject({ isError: true, text: expect.stringContaining("fixture refusal") });
      expect(port.hasRunningChildren()).toBe(false);
      composition.cleanup(); composition.cleanup();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(await call("after")).toMatchObject({ isError: true });
      expect(send).toHaveBeenCalledTimes(1);
    } finally { composition.cleanup(); h.close(); }
  });

  it("keeps completed child status in the session ledger across replacement ports", () => {
    const statusStore = createChildStatusStore();
    statusStore.start("completed","finished task","spawn");
    statusStore.update("completed",{state:"completed",endedAt:Date.now()});
    const make = () => createChildSessionPort({parentSessionId:"logical",statusStore,getPermissionMode:() => "plan",send:() => {},subscribe:() => () => {}});
    const before = make(); const after = make();
    expect(after.getStatus!("completed")).toEqual(before.getStatus!("completed"));
    expect(after.listStatus!()).toHaveLength(1);
    expect(after.hasRunningChildren()).toBe(false);
  });
});
