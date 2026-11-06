import { describe,expect,it } from "vitest";
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
