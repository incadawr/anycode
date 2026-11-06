import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { RuntimeSwitchCommit } from "../../ports/runtime-segments.js";
import { RuntimeHistorySink, SqlitePersistenceAdapter } from "./sqlite-persistence.js";

const roots: string[] = [];
function switchRecord(id="next",revision=0,source="legacy"): RuntimeSwitchCommit {
  return {expectedRevision:revision,sourceSegmentId:source,sourceItems:[{id:"live",createdAt:2,message:{role:"user",content:"latest complete text"}}],
    segment:{id,engine:"claude",accountScope:"",nativeRef:`native-${id}`,nativeState:"fresh",selected:{model:"chosen",mode:"read-only"},applied:{model:"chosen",mode:"read-only"},startedAt:3,coverage:"available_history"},
    boundary:{id,segmentId:id,afterItemId:`segment:${source}:live`,text:"Conversation text will be imported; native context was not transferred.",createdAt:3},
    handoff:{id,segmentId:id,sourceWatermark:`segment:${source}:live`,payload:"bounded excerpt",digest:createHash("sha256").update("bounded excerpt").digest("hex"),state:"pending"}};
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
async function legacyDatabase() {
  const root = mkdtempSync(join(tmpdir(),"runtime-segments-")); roots.push(root);
  const path = join(root,"db.sqlite");
  const store = new SqlitePersistenceAdapter(path);
  await store.createSession({id:"s",workspace:"/workspace",model:"old",mode:"plan",engineId:"codex",externalSessionRef:"old-thread",codexProfileId:"account"});
  await store.appendHistory("s",[{id:"original",createdAt:1,message:{role:"user",content:"available text"},turnId:"stable-turn"}]);
  await store.close();
  const db = new DatabaseSync(path);
  db.exec("DROP TABLE runtime_inputs; DROP TABLE runtime_handoffs; DROP TABLE runtime_boundaries; DROP TABLE runtime_transcript; DROP TABLE runtime_segments; ALTER TABLE sessions DROP COLUMN active_runtime_segment; ALTER TABLE sessions DROP COLUMN runtime_revision; DELETE FROM schema_migrations WHERE version>=33");
  db.close();
  return path;
}
describe("runtime segment schema", () => {
  it("rolls back both settings projections when the session mirror write fails", async () => {
    const path = await legacyDatabase();
    const store = new SqlitePersistenceAdapter(path);
    const before = store.ensureRuntimeSession("s");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TRIGGER settings_fault BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'settings fault'); END");
    expect(() => store.updateRuntimeSettings("s","legacy",{model:"chosen",mode:"ask",fast:true},{model:"old",mode:"read-only"})).toThrow("settings fault");
    expect(store.loadRuntimeSession("s")).toEqual(before);
    expect(await store.getRootSession("s")).toMatchObject({model:"old",mode:"plan"});
    raw.close(); await store.close();
  });

  it("retains selected versus applied settings across archive, clears unsupported values and rejects retired acknowledgements", async () => {
    const store = new SqlitePersistenceAdapter(":memory:");
    await store.createSession({id:"s",workspace:"/w",model:"old",mode:"plan",engineId:"codex"});
    store.ensureRuntimeSession("s");
    const selected = {model:"chosen",mode:"ask",effort:"high",fast:true};
    const applied = {model:"old",mode:"read-only",effort:"low",fast:false};
    store.updateRuntimeSettings("s","legacy",selected,applied);
    expect(await store.getRootSession("s")).toMatchObject({model:"chosen",mode:"ask",codexFast:true});
    store.commitRuntimeSwitch("s","codex",switchRecord());
    expect(store.loadRuntimeSession("s")!.segments[0]).toMatchObject({selected,applied});
    expect(() => store.updateRuntimeSettings("s","legacy",selected,selected)).toThrow("Stale");
    const target = {model:"next",mode:"read-only"};
    store.updateRuntimeSettings("s","next",target,target);
    expect(store.loadRuntimeSession("s")!.segments[1]).toMatchObject({selected:target,applied:target});
    expect((await store.getRootSession("s"))?.codexFast).toBeUndefined();
    await store.close();
  });

  it("migrates old identity and available transcript without changing native admission or model history", async () => {
    const path = await legacyDatabase();
    const store = new SqlitePersistenceAdapter(path);
    const snapshot = store.ensureRuntimeSession("s");
    expect(snapshot).toMatchObject({revision:0,activeSegmentId:"legacy",boundaries:[],handoff:null});
    expect(snapshot.segments).toEqual([expect.objectContaining({engine:"codex",profileId:"account",accountScope:"account",nativeRef:"old-thread",nativeState:"materialized",coverage:"available_history"})]);
    expect(snapshot.items).toEqual([expect.objectContaining({id:"segment:legacy:original",sourceItemId:"original",segmentId:"legacy",turnId:"stable-turn"})]);
    expect((await store.loadHistory("s"))[0]?.id).toBe("original");
    await expect(store.loadCliCoreRootSnapshot("s")).rejects.toThrow("another engine");
    await store.close();
    const reopened = new SqlitePersistenceAdapter(path);
    expect(reopened.ensureRuntimeSession("s")).toEqual(snapshot);
    await reopened.close();
  });

  it("rolls back all migration writes and metadata on a late DDL failure", async () => {
    const path = await legacyDatabase();
    const original = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype,"exec").mockImplementation(function(this: DatabaseSync,sql:string) {
      if (sql === "UPDATE sessions SET active_runtime_segment='legacy'") throw new Error("migration fault");
      return original.call(this,sql);
    });
    const failed = new SqlitePersistenceAdapter(path);
    expect(() => failed.ensureRuntimeSession("s")).toThrow("migration fault");
    spy.mockRestore();
    const db = new DatabaseSync(path);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version>=33").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='runtime_segments'").get()).toBeUndefined();
    expect((db.prepare("SELECT data FROM history_items").get() as {data:string}).data).toContain("available text");
    db.close();
    const recovered = new SqlitePersistenceAdapter(path);
    expect(recovered.ensureRuntimeSession("s").items).toHaveLength(1);
    await recovered.close();
  });

  it("initializes fresh logical sessions once and refuses a missing session", async () => {
    const store = new SqlitePersistenceAdapter(":memory:");
    await store.createSession({id:"fresh",workspace:"/w",model:"m",mode:"plan"});
    expect(store.ensureRuntimeSession("fresh").segments).toHaveLength(1);
    expect(store.ensureRuntimeSession("fresh").segments[0]).toMatchObject({engine:"core",nativeState:"fresh"});
    expect(() => store.ensureRuntimeSession("missing")).toThrow("missing");
    await store.close();
  });
});

describe("segment model history custody", () => {
  it("retains complete display coverage when core compaction replaces model context", async () => {
    const store = new SqlitePersistenceAdapter(":memory:");
    await store.createSession({id:"s",workspace:"/w",model:"m",mode:"plan"});
    store.ensureRuntimeSession("s");
    const sink = new RuntimeHistorySink(store,"s","legacy");
    sink.append([{id:"original",createdAt:1,message:{role:"user",content:"full original"}}]);
    sink.replaceAll([{id:"summary",createdAt:2,kind:"compact_summary",message:{role:"user",content:"available summary"}}]);
    await sink.flushChecked();
    expect((await store.loadHistory("s")).map(item => item.id)).toEqual(["summary"]);
    expect(store.loadRuntimeSession("s")?.items.map(item => item.sourceItemId)).toEqual(["original","summary"]);
    store.mergeRuntimeTranscript("s","legacy",await store.loadHistory("s"));
    expect(store.loadRuntimeSession("s")?.items).toHaveLength(2);
    await store.close();
  });
  it("rejects stale segment writers and surfaces checked write failures", async () => {
    const store = new SqlitePersistenceAdapter(":memory:");
    await store.createSession({id:"s",workspace:"/w",model:"m",mode:"plan"});
    store.ensureRuntimeSession("s");
    const log = {error:vi.fn()};
    const sink = new RuntimeHistorySink(store,"s","retired",{logger:log});
    sink.append([{id:"lost",createdAt:1,message:{role:"user",content:"text"}}]);
    await expect(sink.flushChecked()).rejects.toThrow("persistence failed");
    expect(store.loadRuntimeSession("s")?.items).toEqual([]);
    expect(() => store.mergeRuntimeTranscript("s","retired",[])).toThrow("Stale");
    await store.close();
  });
});

describe("atomic runtime switch transaction", () => {
  it("commits canonical history, archived identity, marker and handoff together with a fresh context", async () => {
    const path = await legacyDatabase();
    const store = new SqlitePersistenceAdapter(path);
    store.ensureRuntimeSession("s");
    store.commitRuntimeSwitch("s","codex",switchRecord());
    const state = store.loadRuntimeSession("s")!;
    expect(state).toMatchObject({revision:1,activeSegmentId:"next",handoff:{state:"pending",id:"next"}});
    expect(state.segments[0]).toMatchObject({nativeRef:"old-thread",profileId:"account",endedAt:3});
    expect(state.segments[1]).toMatchObject({nativeRef:"native-next",nativeState:"fresh"});
    expect(state.items.map(item => item.sourceItemId)).toEqual(["original","live"]);
    expect(state.boundaries).toHaveLength(1);
    expect(await store.getRootSession("s")).toMatchObject({engineId:"claude",externalSessionRef:"native-next",model:"chosen"});
    expect(await store.loadHistory("s")).toEqual([]);
    await store.close();
    const reopened = new SqlitePersistenceAdapter(path);
    expect(reopened.loadRuntimeSession("s")).toEqual(state);
    await reopened.close();
  });
  it.each(["runtime_segments","runtime_boundaries","runtime_handoffs","sessions","history_items"])("rolls back every fact when %s fails", async table => {
    const path = await legacyDatabase();
    const store = new SqlitePersistenceAdapter(path);
    const before = store.ensureRuntimeSession("s");
    const raw = new DatabaseSync(path);
    const operation = table === "sessions" ? "UPDATE" : table === "history_items" ? "DELETE" : "INSERT";
    raw.exec(`CREATE TRIGGER switch_fault BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'injected switch fault'); END`);
    expect(() => store.commitRuntimeSwitch("s","codex",switchRecord())).toThrow("injected switch fault");
    expect(store.loadRuntimeSession("s")).toEqual(before);
    expect((await store.getRootSession("s"))?.externalSessionRef).toBe("old-thread");
    expect((await store.loadHistory("s"))[0]?.id).toBe("original");
    raw.close();await store.close();
  });
  it("rejects stale revision, duplicate id and invalid digest without adding history", async () => {
    const path = await legacyDatabase();const store = new SqlitePersistenceAdapter(path);
    store.ensureRuntimeSession("s");
    expect(() => store.commitRuntimeSwitch("s","codex",switchRecord("bad",1))).toThrow("revision changed");
    const bad = switchRecord();bad.handoff.digest="0".repeat(64);
    expect(() => store.commitRuntimeSwitch("s","codex",bad)).toThrow("handoff payload");
    store.commitRuntimeSwitch("s","codex",switchRecord());
    const before=store.loadRuntimeSession("s");
    expect(() => store.commitRuntimeSwitch("s","codex",switchRecord())).toThrow("revision changed");
    expect(store.loadRuntimeSession("s")).toEqual(before);
    await store.close();
  });
  it("repeated switches without turns keep each marker once without synthetic-message growth", async () => {
    const path=await legacyDatabase();const store=new SqlitePersistenceAdapter(path);store.ensureRuntimeSession("s");
    store.commitRuntimeSwitch("s","codex",switchRecord());
    const back=switchRecord("back",1,"next");back.segment.engine="core";delete back.segment.nativeRef;back.sourceItems=[];
    store.commitRuntimeSwitch("s","claude",back);
    const state=store.loadRuntimeSession("s")!;
    expect(state.items.map(item=>item.sourceItemId)).toEqual(["original","live"]);
    expect(state.segments).toHaveLength(3);expect(state.boundaries).toHaveLength(2);
    expect(state.handoff?.id).toBe("back");expect(await store.loadHistory("s")).toEqual([]);
    await store.close();
  });
});

describe("durable input delivery", () => {
  async function target() {
    const root = mkdtempSync(join(tmpdir(),"runtime-delivery-")); roots.push(root);
    const path = join(root,"db.sqlite");
    const store = new SqlitePersistenceAdapter(path);
    await store.createSession({id:"s",workspace:"/w",model:"m",mode:"plan"});
    store.ensureRuntimeSession("s"); store.commitRuntimeSwitch("s","core",switchRecord());
    return {store,path};
  }
  it("retries a pre-dispatch failure after reopening and normalizes the exact delivered input once", async () => {
    const {store,path} = await target();
    store.prepareRuntimeInput("s","failed","original","original",true);
    expect(store.loadRuntimeSession("s")?.handoff?.state).toBe("pending");
    await store.close();
    const resumed = new SqlitePersistenceAdapter(path);
    const injected = resumed.prepareRuntimeInput("s","retry","original","original",true);
    expect(injected).toContain("bounded excerpt");
    resumed.transitionRuntimeInput("s","next","retry","dispatching");
    resumed.reconcileRuntimeInputs("s","next",[{id:"native:user",turnId:"native",createdAt:4,message:{role:"user",content:injected}}]);
    resumed.mergeRuntimeTranscript("s","next",[{id:"native:user",turnId:"native",createdAt:4,message:{role:"user",content:injected}},{id:"native:answer",turnId:"native",createdAt:5,message:{role:"assistant",content:[{type:"text",text:"answer"}]}}]);
    expect(resumed.loadRuntimeSession("s")?.handoff?.state).toBe("accepted");
    expect(resumed.loadRuntimeSession("s")?.items.slice(-2)).toMatchObject([{turnId:"retry",message:{content:"original"}},{turnId:"retry"}]);
    expect(resumed.prepareRuntimeInput("s","second","clean","clean",true)).toBe("clean");
    await resumed.close();
  });
  it("stops rather than silently resending when acceptance cannot be reconciled", async () => {
    const {store,path} = await target();
    store.prepareRuntimeInput("s","turn","typed","typed",true);
    store.transitionRuntimeInput("s","next","turn","dispatching");
    await store.close();
    const resumed = new SqlitePersistenceAdapter(path);
    resumed.reconcileRuntimeInputs("s","next",[]);
    expect(resumed.loadRuntimeSession("s")?.handoff?.state).toBe("uncertain");
    expect(() => resumed.prepareRuntimeInput("s","another","typed","typed",true)).toThrow("uncertain");
    await resumed.close();
  });
  it("does not consume the import on a system turn and fences stale native acknowledgements", async () => {
    const {store} = await target();
    expect(store.prepareRuntimeInput("s","report","report","report",false)).toBe("report");
    store.transitionRuntimeInput("s","next","report","dispatching");
    store.transitionRuntimeInput("s","next","report","accepted");
    expect(store.loadRuntimeSession("s")?.handoff?.state).toBe("pending");
    store.setRuntimeNativeReference("s","next",1,"fresh-ref");
    expect(store.loadRuntimeSession("s")?.segments.at(-1)).toMatchObject({nativeRef:"fresh-ref",nativeState:"fresh"});
    expect(() => store.setRuntimeNativeReference("s","legacy",0,"wrong")).toThrow("Stale");
    store.prepareRuntimeInput("s","user","typed","typed",true);
    store.transitionRuntimeInput("s","next","user","dispatching");
    store.transitionRuntimeInput("s","next","user","accepted","native-turn");
    expect(store.loadRuntimeSession("s")?.segments.at(-1)?.nativeState).toBe("materialized");
    await store.close();
  });
});

describe("archived reference ownership and deletion", () => {
  it("removes every segment, delivery record and archived shadow row in one cascade", async () => {
    const store = new SqlitePersistenceAdapter(":memory:");
    await store.createSession({id:"s",workspace:"/w",model:"m",mode:"plan",engineId:"codex",externalSessionRef:"archived",codexProfileId:"account"});
    store.ensureRuntimeSession("s");
    await store.recordCodexThreadItem("archived",{turnOrdinal:0,positionInTurn:0,seqInTurn:0,itemId:"item",command:"echo fixture",outputHead:"fixture"});
    store.commitRuntimeSwitch("s","codex",switchRecord());
    store.prepareRuntimeInput("s","turn","text","text",true);
    await store.recordClaudeTranscriptItem("native-next",{turnOrdinal:0,positionInTurn:0,itemId:"item",data:{id:"item",createdAt:1,message:{role:"user",content:"text"}}});
    expect(store.runtimeNativeReferenceOwners("codex","account","archived")).toEqual(["s"]);
    expect(store.runtimeNativeReferenceOwners("codex","another-account","archived")).toEqual([]);
    const deleted = await store.deleteSessionTree("s");
    expect(deleted.externalSessionRefs.sort()).toEqual(["archived","native-next"]);
    expect(await store.listCodexThreadItems("archived")).toEqual([]);
    expect(await store.listClaudeTranscriptItems("native-next")).toEqual([]);
    expect(store.listRuntimeNativeReferences()).toEqual([]);
    expect(store.loadRuntimeSession("s")).toBeNull();
    await store.close();
  });
  it("retains an archived reference shared by another session, including another account", async () => {
    const store = new SqlitePersistenceAdapter(":memory:");
    for (const [id,profile] of [["deleted","a"],["surviving","b"]] as const) {
      await store.createSession({id,workspace:"/w",model:"m",mode:"plan",engineId:"claude",externalSessionRef:"shared",codexProfileId:profile});
      store.ensureRuntimeSession(id);
      store.commitRuntimeSwitch(id,"claude",{...switchRecord(),segment:{...switchRecord().segment,engine:"core",nativeRef:undefined}});
    }
    await store.recordClaudeTranscriptItem("shared",{turnOrdinal:0,positionInTurn:0,itemId:"item",data:{id:"item",createdAt:1,message:{role:"user",content:"shared"}}});
    await store.deleteSessionTree("deleted");
    expect(await store.listClaudeTranscriptItems("shared")).toHaveLength(1);
    expect(store.runtimeNativeReferenceOwners("claude","b","shared")).toEqual(["surviving"]);
    await store.deleteSessionTree("surviving");
    expect(await store.listClaudeTranscriptItems("shared")).toEqual([]);
    await store.close();
  });
});
