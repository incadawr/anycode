import { bindRuntimeOrchestration } from "./runtime-orchestration.js";
import { describe,expect,it,vi } from "vitest";
import { createHash } from "node:crypto";
import { SqlitePersistenceAdapter,type RuntimeSwitchCommit } from "@anycode/core";
import { RuntimeSessionHistory, createRuntimeSessionHistory } from "./runtime-session-history.js";
import { createHarness,finishStep } from "./test-harness.js";
import { createDesktopStore } from "../renderer/src/store.js";

async function switchedStore() {
  const store = new SqlitePersistenceAdapter(":memory:");
  await store.createSession({id:"test-session",workspace:"/workspace",model:"scripted-model",mode:"build"});
  store.ensureRuntimeSession("test-session");
  for (const [index,engine] of (["claude","codex","core"] as const).entries()) {
    const state = store.loadRuntimeSession("test-session")!;
    const id = `runtime-${index}`;
    const record: RuntimeSwitchCommit = {expectedRevision:state.revision,sourceSegmentId:state.activeSegmentId,
      sourceItems:[{id:"same-id",turnId:`turn-${index}`,createdAt:index+1,message:{role:"user",content:`original ${index}`}}],
      segment:{id,engine,accountScope:"",nativeState:"fresh",selected:{model:"scripted-model",mode:"build"},applied:{model:"scripted-model",mode:"build"},startedAt:index+2,coverage:"available_history"},
      boundary:{id,segmentId:id,text:`Engine switched to ${engine}`,afterItemId:`segment:${state.activeSegmentId}:same-id`,createdAt:index+2},
      handoff:{id,segmentId:id,sourceWatermark:null,payload:"available excerpt",digest:createHash("sha256").update("available excerpt").digest("hex"),state:"pending"}};
    store.commitRuntimeSwitch("test-session",state.segments.at(-1)!.engine,record);
  }
  return store;
}
describe("canonical reconnect hydration", () => {
  it("rejects a legacy readiness flag without enabling orchestration during restore", async () => {
    const store = await switchedStore();
    const state = store.loadRuntimeSession("test-session")!;
    const saved = {model:"scripted-model",mode:"plan",orchestration:{enabled:true as const,baseMode:"edit" as const}};
    store.updateRuntimeSettings("test-session",state.activeSegmentId,saved,saved);
    const h = createHarness({steps:[],runtimeHistory:new RuntimeSessionHistory(store,"test-session")});
    Object.defineProperty(h.engine,"orchestrationCompositionReady",{value:true});
    const apply = vi.spyOn(h.engine,"setCoreOrchestrate");
    const log = vi.spyOn(console,"warn").mockImplementation(() => {});
    try {
      h.send({type:"ui_ready",orchestrationProtocol:1});
      expect(await h.waitFor(m => m.type === "host_ready")).toMatchObject({orchestration:{enabled:false}});
      expect(apply).not.toHaveBeenCalledWith(true);
      expect(log).toHaveBeenCalledWith("[host] saved orchestration could not be restored",expect.objectContaining({message:"Saved orchestration requires a verified runtime policy and routing"}));
      expect(store.loadRuntimeSession("test-session")!.segments.at(-1)!.applied.orchestration).toBeUndefined();
      expect(h.received.some(m => m.type === "fatal")).toBe(false);
    } finally {apply.mockRestore();log.mockRestore();await h.session.shutdown();h.close();await store.close();}
  });

  it("turns a failed saved orchestration restore off, hydrates, and serves the next turn across restart", async () => {
    const store = await switchedStore();
    const state = store.loadRuntimeSession("test-session")!;
    const saved = {model:"scripted-model",mode:"plan",orchestration:{enabled:true as const,baseMode:"edit" as const}};
    store.updateRuntimeSettings("test-session",state.activeSegmentId,saved,saved);
    const h = createHarness({steps:[finishStep()],runtimeHistory:new RuntimeSessionHistory(store,"test-session")});
    bindRuntimeOrchestration(h.engine,{ownerSessionId:"test-session",port:{hasRunningChildren:() => false,cancelAllBackgroundChildren:() => {}},baseMode:() => h.engine.mode()});
    h.engine.setCoreOrchestrate = enabled => { h.config.orchestrate = enabled; return !enabled; };
    const log = vi.spyOn(console,"warn").mockImplementation(() => {});
    try {
      h.send({type:"ui_ready",orchestrationProtocol:1});
      const ready = await h.waitFor(m => m.type === "host_ready");
      expect(ready).toMatchObject({orchestration:{enabled:false}});
      expect(h.config.orchestrate).toBe(false); expect(h.engine.mode()).toBe("edit");
      await h.waitFor(m => m.type === "session_history");
      expect(h.received.some(m => m.type === "fatal")).toBe(false);
      expect(h.received.some(m => m.type === "agent_event" && m.event.type === "engine_notice" && m.event.message.includes("turned off"))).toBe(true);
      expect(log).toHaveBeenCalled();
      const active = store.loadRuntimeSession("test-session")!.segments.at(-1)!;
      expect(active.selected.orchestration).toBeUndefined(); expect(active.applied.orchestration).toBeUndefined();
      h.send({type:"user_message",requestId:"after-restore-failure",text:"continue"});
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
    } finally { await h.session.shutdown(); h.close(); log.mockRestore(); }
    const reopened = createHarness({steps:[],runtimeHistory:new RuntimeSessionHistory(store,"test-session")});
    try {
      reopened.send({type:"ui_ready"});
      expect(await reopened.waitFor(m => m.type === "host_ready")).toMatchObject({orchestration:{enabled:false}});
      expect(reopened.received.some(m => m.type === "fatal")).toBe(false);
    } finally { await reopened.session.shutdown(); reopened.close(); await store.close(); }
  });
  it("does not fence the next ordinary turn behind an unrelated uncertain delivery", async () => {
    const store = await switchedStore();
    const history = new RuntimeSessionHistory(store,"test-session");
    const first = history.prepare("imported","imported","imported",true);
    first.hooks.onInputDispatched!(); first.hooks.onInputAccepted!("imported");
    history.snapshot([{id:"imported",turnId:"imported",createdAt:10,message:{role:"user",content:first.text}}]);
    history.prepare("lost-ordinary","unconfirmed original","unconfirmed original",true).hooks.onInputDispatched!();
    const h = createHarness({steps:[finishStep()],runtimeHistory:history});
    try {
      h.send({type:"ui_ready"}); await h.waitFor(m => m.type === "host_ready");
      expect(history.requiresRecovery()).toBe(false);
      h.send({type:"user_message",requestId:"next-ordinary",text:"continue serving"});
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      await h.flush();
      expect(history.recoveries()).toMatchObject([{turnId:"lost-ordinary",text:"unconfirmed original",state:"uncertain"}]);
      expect(history.state().items.some(item => item.message.content === "continue serving")).toBe(true);
      expect(h.received.some(m => m.type === "fatal")).toBe(false);
    } finally { await h.session.shutdown(); h.close(); await store.close(); }
  });
  it("returns a core input cancelled before append to pending and acknowledges an actual append", async () => {
    const store = await switchedStore();
    const history = new RuntimeSessionHistory(store,"test-session");
    const h = createHarness({steps:[finishStep()]});
    try {
      const cancelled = history.prepare("before-append","draft","draft",true);
      const stop = new AbortController(); stop.abort();
      for await (const _event of h.engine.runTurn(cancelled.text,{signal:stop.signal,turnId:"before-append",...cancelled.hooks})) { /* drain */ }
      expect(history.state().handoff?.state).toBe("pending");
      expect(history.recoveries()).toMatchObject([{turnId:"before-append",state:"pending"}]);
      history.discard("before-append");
      const next = history.prepare("appended","new draft","new draft",true);
      for await (const _event of h.engine.runTurn(next.text,{signal:new AbortController().signal,turnId:"appended",...next.hooks})) { /* drain */ }
      expect(history.state().handoff?.state).toBe("accepted");
      await history.hydrate(h.engine);
      expect(history.recoveries()).toEqual([]);
    } finally { await h.session.shutdown(); h.close(); await store.close(); }
  });
  it("serializes an inbound turn behind a delayed reconnect history read", async () => {
    const store = await switchedStore();
    const source = createHarness({steps:[finishStep()]});
    let release!: (items:readonly import("@anycode/core").HistoryItem[]) => void;
    let started = false;
    source.engine.readTranscript = () => { started = true; return new Promise(resolve => { release = resolve; }); };
    const h = createHarness({steps:[],engine:source.engine,runtimeHistory:new RuntimeSessionHistory(store,"test-session")});
    try {
      h.send({type:"ui_ready"}); await h.flush();
      expect(started).toBe(true);
      h.send({type:"user_message",requestId:"during-read",text:"newer input"}); await h.flush();
      expect(h.received.some(message => message.type === "turn_started")).toBe(false);
      source.engine.readTranscript = async () => source.engine.historyItems();
      release([]);
      await h.waitUntil(() => h.received.some(message => message.type === "agent_event" && message.event.type === "loop_end"));
      await h.flush();
      expect(store.loadRuntimeSession("test-session")!.items.filter(item => item.message.content === "newer input")).toHaveLength(1);
      const readyIndex = h.received.findIndex(message => message.type === "host_ready");
      expect(h.received.findIndex(message => message.type === "turn_started")).toBeGreaterThan(readyIndex);
    } finally { release?.([]); await h.session.shutdown(); h.close(); source.close(); await store.close(); }
  });
  it("does not resurrect a rewound canonical turn after renderer reload or host restart", async () => {
    const store = await switchedStore();
    const history = new RuntimeSessionHistory(store,"test-session");
    const kept = {id:"kept",turnId:"kept-turn",createdAt:10,message:{role:"user" as const,content:"kept text"}};
    const removed = {id:"removed",turnId:"removed-turn",createdAt:11,message:{role:"user" as const,content:"removed text"}};
    history.snapshot([kept]);
    await store.saveCheckpoint({id:"cp",sessionId:"test-session",commitHash:"hash",createdAt:12,reason:"auto",label:"rewind",historyJson:JSON.stringify([kept])});
    const checkpoint = JSON.parse((await store.getCheckpoint("cp"))!.historyJson) as {runtimeBoundary:import("@anycode/core").RuntimeCheckpointBoundary};
    history.snapshot([kept,removed]);
    const h = createHarness({steps:[],bootHistory:[kept,removed],runtimeHistory:history,
      restoreHistoryAndTurnErrors:(items,errors,boundary) => store.restoreHistoryAndTurnErrors("test-session",items,errors,boundary),
      checkpointsSeam:{list:async () => [],rewind:async () => ({ok:true,safetyCheckpointId:"safety",restoredPaths:0,historyItems:[kept],runtimeBoundary:checkpoint.runtimeBoundary})},
    });
    try {
      h.send({type:"ui_ready"}); await h.waitFor(m => m.type === "host_ready");
      h.send({type:"rewind_request",requestId:"rewind",checkpointId:"cp",scope:"conversation"});
      await h.waitUntil(() => h.received.some(m => m.type === "rewind_result" && m.ok));
      h.send({type:"ui_ready"}); await h.flush();
      expect(history.state().items.some(item => item.sourceItemId === "removed")).toBe(false);
    } finally { await h.session.shutdown(); h.close(); }
    const reopened = createHarness({steps:[],bootHistory:await store.loadHistory("test-session"),runtimeHistory:new RuntimeSessionHistory(store,"test-session")});
    try {
      reopened.send({type:"ui_ready"}); await reopened.waitFor(m => m.type === "host_ready");
      await reopened.flush();
      expect(history.state().items.filter(item => item.sourceItemId === "kept")).toHaveLength(1);
      expect(reopened.received.some(m => m.type === "session_history" && m.items.some(item => item.message.content === "removed text"))).toBe(false);
    } finally { await reopened.session.shutdown(); reopened.close(); await store.close(); }
  });
  it("announces a pending input once after restart without a not-sent report", async () => {
    const db = await switchedStore();
    new RuntimeSessionHistory(db, "test-session").prepare("crash", "saved draft", "saved draft", true);
    const h = createHarness({ steps: [], runtimeHistory: new RuntimeSessionHistory(db, "test-session") });
    try {
      h.send({ type: "ui_ready" }); await h.waitFor(m => m.type === "host_ready"); await h.flush();
      const renderer = createDesktopStore({ schedule: fn => fn() });
      for (const m of h.received) renderer.getState().applyHostMessage(m);
      expect(h.received.filter(m => m.type === "runtime_input_recovery")).toMatchObject([{ turnId: "crash", status: "pending" }]);
      expect(renderer.getState().promptQueue).toMatchObject([{ text: "saved draft", requiresRestore: true }]);
    } finally { await h.session.shutdown(); h.close(); await db.close(); }
  });

  it("recovers a lost acceptance signal after a checked absence and serves the next turn", async () => {
    const store = await switchedStore();
    const history = new RuntimeSessionHistory(store,"test-session");
    history.prepare("lost","keep my draft","keep my draft",true).hooks.onInputDispatched!();
    const source = createHarness({steps:[finishStep()]});
    source.engine.verifyInputAbsent = async () => true;
    const h = createHarness({steps:[],engine:source.engine,runtimeHistory:history});
    try {
      h.send({type:"ui_ready"});
      await h.waitUntil(() => h.received.some(m => m.type === "runtime_input_recovery" && m.turnId === "lost" && m.status === "pending"));
      expect(history.state().handoff?.state).toBe("pending");
      const renderer = createDesktopStore({schedule:fn => fn()});
      for (const message of h.received) renderer.getState().applyHostMessage(message);
      expect(renderer.getState().promptQueue).toContainEqual(expect.objectContaining({text:"keep my draft",requiresRestore:true}));
      h.send({type:"runtime_input_discard",turnId:"lost"});
      await h.flush();
      expect(history.recoveries()).toEqual([]);
      h.send({type:"user_message",requestId:"next",text:"next input"});
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "loop_end"));
      await h.flush();
      expect(history.state().handoff?.state,JSON.stringify(h.received.slice(-8))).toBe("accepted");
      expect(h.received.some(m => m.type === "fatal")).toBe(false);
      expect(history.state().items.some(item => item.message.content === "next input")).toBe(true);
    } finally { await h.session.shutdown(); h.close(); source.close(); await store.close(); }
  });

  it("keeps an unavailable acceptance check visible without killing reconnect", async () => {
    const store = await switchedStore();
    const history = new RuntimeSessionHistory(store,"test-session");
    history.prepare("lost","typed","typed",true).hooks.onInputDispatched!();
    const source = createHarness({steps:[]});
    source.engine.readTranscript = async () => { throw new Error("app-server closed"); };
    const h = createHarness({steps:[],engine:source.engine,runtimeHistory:history});
    try {
      h.send({type:"ui_ready"}); await h.waitFor(m => m.type === "host_ready");
      await h.waitUntil(() => h.received.some(m => m.type === "runtime_input_recovery" && m.status === "uncertain"));
      expect(h.received.some(m => m.type === "fatal")).toBe(false);
      h.send({type:"user_message",requestId:"held",text:"do not duplicate"});
      await h.waitUntil(() => h.received.some(m => m.type === "turn_rejected" && m.requestId === "held"));
      expect(history.state().handoff?.state).toBe("uncertain");
    } finally { await h.session.shutdown(); h.close(); source.close(); await store.close(); }
  });
  it("restores only a verified orchestration overlay with its captured base authority", async () => {
    const store = await switchedStore();
    const state = store.loadRuntimeSession("test-session")!;
    store.updateRuntimeSettings("test-session",state.activeSegmentId,{model:"scripted-model",mode:"plan",orchestration:{enabled:true,baseMode:"edit"}},{model:"scripted-model",mode:"plan",orchestration:{enabled:true,baseMode:"edit"}});
    const h = createHarness({steps:[finishStep()],runtimeHistory:new RuntimeSessionHistory(store,"test-session")});
    bindRuntimeOrchestration(h.engine,{ownerSessionId:"test-session",port:{hasRunningChildren:() => false,cancelAllBackgroundChildren:() => {}},baseMode:() => h.engine.mode()});
    try {
      h.send({type:"ui_ready",orchestrationProtocol:1});
      const ready = await h.waitFor(m => m.type === "host_ready");
      expect(ready).toMatchObject({orchestration:{enabled:true,available:true}});
      expect(h.config.orchestrate).toBe(true); expect(h.engine.mode()).toBe("plan");
      expect(h.session.childSpawnMode()).toBe("edit");
      h.send({type:"set_orchestrate",enabled:false});
      await h.waitUntil(() => h.received.some(m => m.type === "orchestrate_changed" && !m.enabled));
      expect(h.engine.mode()).toBe("edit");
      expect(store.loadRuntimeSession("test-session")!.segments.at(-1)!.applied.orchestration).toBeUndefined();
    } finally { h.close(); await store.close(); }
  });

  it("republishes peer authority after a saved overlay restores", async () => {
    const store = await switchedStore();
    const state = store.loadRuntimeSession("test-session")!;
    const saved = {model:"scripted-model",mode:"plan",orchestration:{enabled:true as const,baseMode:"edit" as const}};
    store.updateRuntimeSettings("test-session",state.activeSegmentId,saved,saved);
    const h = createHarness({steps:[finishStep()],runtimeHistory:new RuntimeSessionHistory(store,"test-session")});
    bindRuntimeOrchestration(h.engine,{ownerSessionId:"test-session",port:{hasRunningChildren:() => false,cancelAllBackgroundChildren:() => {}},baseMode:() => h.engine.mode()});
    const orchestrate: Array<[boolean,string,boolean]> = [];
    const flag = () => (h.session as unknown as {orchestrate:boolean}).orchestrate;
    h.session.observePermissionMode(() => {},(enabled,engine) => orchestrate.push([enabled,engine,flag()]));
    try {
      expect(orchestrate).toEqual([[false,"core",false]]);
      h.send({type:"ui_ready",orchestrationProtocol:1});
      expect(await h.waitFor(m => m.type === "host_ready")).toMatchObject({orchestration:{enabled:true}});
      await h.waitUntil(() => orchestrate.length > 1);
      expect(orchestrate.slice(1)).toEqual([[true,"core",true]]);
    } finally { h.close(); await store.close(); }
  });

  it("republishes peer authority when a failed restore recovers to off", async () => {
    const store = await switchedStore();
    const state = store.loadRuntimeSession("test-session")!;
    const saved = {model:"scripted-model",mode:"plan",orchestration:{enabled:true as const,baseMode:"edit" as const}};
    store.updateRuntimeSettings("test-session",state.activeSegmentId,saved,saved);
    const h = createHarness({steps:[finishStep()],runtimeHistory:new RuntimeSessionHistory(store,"test-session")});
    bindRuntimeOrchestration(h.engine,{ownerSessionId:"test-session",port:{hasRunningChildren:() => false,cancelAllBackgroundChildren:() => {}},baseMode:() => h.engine.mode()});
    h.engine.setCoreOrchestrate = enabled => { h.config.orchestrate = enabled; return !enabled; };
    const log = vi.spyOn(console,"warn").mockImplementation(() => {});
    const orchestrate: Array<[boolean,string,boolean]> = [];
    const flag = () => (h.session as unknown as {orchestrate:boolean}).orchestrate;
    h.session.observePermissionMode(() => {},(enabled,engine) => orchestrate.push([enabled,engine,flag()]));
    try {
      h.send({type:"ui_ready",orchestrationProtocol:1});
      await h.waitFor(m => m.type === "host_ready");
      await h.waitUntil(() => h.received.some(m => m.type === "agent_event" && m.event.type === "engine_notice" && m.event.message.includes("turned off")));
      expect(orchestrate).toEqual([[false,"core",false],[false,"core",false]]);
    } finally { await h.session.shutdown(); h.close(); log.mockRestore(); await store.close(); }
  });

  it("re-budgets a pending handoff durably before dispatch and preserves it when the input cannot fit", async () => {
    const store = await switchedStore();
    const state = store.loadRuntimeSession("test-session")!;
    const record: RuntimeSwitchCommit = {expectedRevision:state.revision,sourceSegmentId:state.activeSegmentId,sourceItems:[],
      segment:{id:"budgeted",engine:"core",accountScope:"",nativeState:"fresh",selected:{model:"small",mode:"plan"},applied:{model:"small",mode:"plan"},startedAt:5,coverage:"available_history"},
      boundary:{id:"budgeted",segmentId:"budgeted",text:"Switched",createdAt:5},
      handoff:{id:"budgeted",segmentId:"budgeted",sourceWatermark:null,payload:"large excerpt "+"🌊".repeat(1000),digest:"",state:"pending"}};
    record.handoff.digest = createHash("sha256").update(record.handoff.payload).digest("hex");
    store.commitRuntimeSwitch("test-session","core",record);
    const history = new RuntimeSessionHistory(store,"test-session");
    expect(() => history.prepare("no-space","original","too large",true,0)).toThrow("too little input space");
    expect(history.state().handoff?.payload).toBe(record.handoff.payload);
    const input = history.prepare("bounded","original","original",true,512);
    expect(Buffer.byteLength(input.text)).toBeLessThanOrEqual(512);
    const handoff = history.state().handoff!;
    expect(handoff.state).toBe("pending");
    expect(handoff.payload).toContain("earlier content was omitted");
    expect(handoff.digest).toBe(createHash("sha256").update(handoff.payload).digest("hex"));
    expect(handoff.injectedText).toBe(input.text);
    await store.close();
  });

  it("rebuilds every committed segment and marker after replay loss and another host boot", async () => {
    const store = await switchedStore();
    for (let boot=0;boot<2;boot++) {
      const h = createHarness({steps:[],runtimeHistory:new RuntimeSessionHistory(store,"test-session")});
      try {
        for (let reconnect=0;reconnect<2;reconnect++) {
          h.outbound.clear();
          const before = h.received.length;
          h.send({type:"ui_ready"});
          await h.waitUntil(() => h.received.slice(before).filter(m => m.type === "agent_event" && m.boundaryId !== undefined).length === 3);
          const renderer = createDesktopStore({schedule:fn => fn()});
          for (const message of h.received.slice(before)) renderer.getState().applyHostMessage(message);
          const transcript = renderer.getState().transcript;
          expect(transcript.filter(block => block.kind === "engine_boundary")).toHaveLength(3);
          expect(transcript.filter(block => block.kind === "user_text")).toHaveLength(3);
          expect(new Set(transcript.map(block => block.id)).size).toBe(transcript.length);
          const history = h.received.slice(before).find(m => m.type === "session_history");
          expect(history?.type === "session_history" && history.items.map(item => item.id)).toEqual(["segment:legacy:same-id","segment:runtime-0:same-id","segment:runtime-1:same-id"]);
        }
      } finally { await h.session.shutdown(); h.close(); }
    }
    await store.close();
  });
  it("persists the first imported turn with its original user text and sends later turns cleanly", async () => {
    const store = await switchedStore();
    const h = createHarness({steps:[finishStep(),finishStep()],runtimeHistory:new RuntimeSessionHistory(store,"test-session")});
    try {
      h.send({type:"ui_ready"}); await h.waitUntil(() => h.received.some(m => m.type === "host_ready"));
      h.send({type:"user_message",requestId:"first",text:"first real text"});
      await h.waitUntil(() => store.loadRuntimeSession("test-session")?.handoff?.state === "accepted");
      await h.flush();
      h.send({type:"user_message",requestId:"second",text:"second real text"});
      await h.waitUntil(() => store.loadRuntimeSession("test-session")!.items.some(item => item.message.role === "user" && item.message.content === "second real text"));
      const user = store.loadRuntimeSession("test-session")!.items.filter(item => item.message.role === "user");
      expect(user.map(item => item.message.content)).toEqual(["original 0","original 1","original 2","first real text","second real text"]);
      expect(store.loadRuntimeSession("test-session")!.boundaries).toHaveLength(3);
    } finally { await h.session.shutdown(); h.close(); await store.close(); }
  });
});

it("does not read a nonexistent native artifact before dispatch, but requires checked recovery afterward", async () => {
  const store = await switchedStore();
  const state = store.loadRuntimeSession("test-session")!;
  const record: RuntimeSwitchCommit = {expectedRevision:state.revision,sourceSegmentId:state.activeSegmentId,sourceItems:[],
    segment:{id:"fresh-native",engine:"codex",accountScope:"",nativeRef:"allocated",nativeState:"fresh",selected:{model:"m",mode:"read-only"},applied:{model:"m",mode:"read-only"},startedAt:5,coverage:"available_history"},
    boundary:{id:"fresh-native",segmentId:"fresh-native",text:"Switched",createdAt:5},
    handoff:{id:"fresh-native",segmentId:"fresh-native",sourceWatermark:null,payload:"excerpt",digest:createHash("sha256").update("excerpt").digest("hex"),state:"pending"}};
  store.commitRuntimeSwitch("test-session","core",record);
  const h = createHarness({steps:[]});
  let reads = 0;
  const engine = Object.create(h.engine) as import("./engines/session-engine.js").SessionEngine;
  Object.defineProperty(engine,"id",{value:"codex"});
  engine.readTranscript = async () => { reads++; throw new Error("native artifact unavailable"); };
  const history = new RuntimeSessionHistory(store,"test-session");
  try {
    expect((await history.hydrate(engine)).items).toHaveLength(3);
    expect(reads).toBe(0);
    const turn = history.prepare("owner","typed","typed",true);
    turn.hooks.onInputDispatched!();
    await expect(history.hydrate(engine)).rejects.toThrow("artifact unavailable");
    expect(reads).toBe(1);
    expect(store.loadRuntimeSession("test-session")?.handoff?.state).toBe("uncertain");
    expect(() => history.prepare("another","typed","typed",true)).toThrow("uncertain");
  } finally { await h.session.shutdown(); h.close(); await store.close(); }
});

it("hydrates a committed session with new switches disabled", async () => {
  const store = await switchedStore();
  try {
    const history = createRuntimeSessionHistory(store,"test-session",false);
    expect(history?.state().revision).toBe(3);
    const first = history!.prepare("after-restart","original","original",true);
    expect(first.text).toContain("available excerpt");
    expect(createRuntimeSessionHistory(store,"test-session",false,true)).toBeUndefined();
    await store.createSession({id:"unexposed",workspace:"/w",model:"m",mode:"plan"});
    expect(createRuntimeSessionHistory(store,"unexposed",false)).toBeUndefined();
  } finally { await store.close(); }
});
