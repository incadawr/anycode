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
  it("leaves flag-off history un-copied on migration and backfills only on explicit runtime access", async () => {
    const path = await legacyDatabase();
    const store = new SqlitePersistenceAdapter(path);
    await store.getRootSession("s");
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT count(*) AS n FROM runtime_transcript").get()!.n).toBe(0);
    expect(store.loadRuntimeSession("s")).toBeNull();
    expect((await store.loadHistory("s"))).toHaveLength(1);
    expect(store.ensureRuntimeSession("s").items).toHaveLength(1);
    expect(store.ensureRuntimeSession("s").items).toHaveLength(1);
    raw.close(); await store.close();
  });

  it("reaps reproducible eager copies on upgrade but preserves canonical compaction coverage", async () => {
    const path = await legacyDatabase();
    const store = new SqlitePersistenceAdapter(path);
    store.ensureRuntimeSession("s");
    await store.createSession({id:"covered",workspace:"/w",model:"m",mode:"build"});
    store.ensureRuntimeSession("covered");
    const sink = new RuntimeHistorySink(store,"covered","legacy");
    sink.append([{id:"full",createdAt:1,message:{role:"user",content:"full text"}}]);
    sink.replaceAll([{id:"summary",createdAt:2,kind:"compact_summary",message:{role:"user",content:"summary"}}]);
    await sink.flushChecked();
    await store.createSession({id:"checkpoint-owned",workspace:"/w",model:"m",mode:"build"});
    await store.appendHistory("checkpoint-owned",[{id:"kept",createdAt:1,message:{role:"user",content:"kept"}}]);
    store.ensureRuntimeSession("checkpoint-owned");
    await store.saveCheckpoint({id:"owned",sessionId:"checkpoint-owned",commitHash:"hash",createdAt:1,reason:"auto",label:"owned watermark",historyJson:JSON.stringify(await store.loadHistory("checkpoint-owned"))});
    await store.close();
    const raw = new DatabaseSync(path);
    raw.exec("DELETE FROM schema_migrations WHERE version=35; DROP INDEX idx_runtime_transcript_turn; DROP INDEX idx_runtime_transcript_native_turn");
    raw.close();
    const upgraded = new SqlitePersistenceAdapter(path);
    await upgraded.getRootSession("s");
    expect(upgraded.loadRuntimeSession("s")).toBeNull();
    expect(upgraded.loadRuntimeSession("covered")!.items.map(item => item.sourceItemId)).toEqual(["full","summary"]);
    expect(upgraded.loadRuntimeSession("checkpoint-owned")!.items).toHaveLength(1);
    expect(upgraded.ensureRuntimeSession("s").items).toHaveLength(1);
    await upgraded.close();
  });

  it("rolls back the backfill cleanup and version marker if upgrade deletion fails", async () => {
    const path = await legacyDatabase();
    const store = new SqlitePersistenceAdapter(path);
    store.ensureRuntimeSession("s"); await store.close();
    const raw = new DatabaseSync(path);
    raw.exec("DELETE FROM schema_migrations WHERE version=35; DROP INDEX idx_runtime_transcript_turn; DROP INDEX idx_runtime_transcript_native_turn; CREATE TRIGGER upgrade_fault BEFORE DELETE ON runtime_transcript BEGIN SELECT RAISE(ABORT,'upgrade fault'); END");
    const failed = new SqlitePersistenceAdapter(path);
    await expect(failed.getRootSession("s")).rejects.toThrow("upgrade fault");
    expect(raw.prepare("SELECT 1 FROM schema_migrations WHERE version=35").get()).toBeUndefined();
    expect(raw.prepare("SELECT count(*) AS n FROM runtime_transcript").get()!.n).toBe(1);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='idx_runtime_transcript_turn'").get()).toBeUndefined();
    raw.exec("DROP TRIGGER upgrade_fault"); raw.close();
    const recovered = new SqlitePersistenceAdapter(path);
    await recovered.getRootSession("s");
    expect(recovered.loadRuntimeSession("s")).toBeNull();
    expect(recovered.ensureRuntimeSession("s").items).toHaveLength(1);
    await recovered.close();
  });
  it("keeps the provider connection pin through native switches and changes it only on an explicit core target", async () => {
    const store = new SqlitePersistenceAdapter(":memory:");
    await store.createSession({id:"s",workspace:"/w",model:"m",mode:"build",connectionId:"pinned"});
    store.ensureRuntimeSession("s");
    for (const engine of ["codex","claude","core"] as const) {
      const state = store.loadRuntimeSession("s")!;
      const record = switchRecord(engine,state.revision,state.activeSegmentId);
      record.segment = {...record.segment,engine,...(engine === "core" ? {connectionId:"explicit"} : {})};
      store.commitRuntimeSwitch("s",state.segments.at(-1)!.engine,record);
      expect((await store.getRootSession("s"))?.connectionId).toBe(engine === "core" ? "explicit" : "pinned");
      // Native execution has no core connection of its own, while the logical
      // session retains its pin for child forks and a later core return.
      expect(store.loadRuntimeSession("s")!.segments.at(-1)?.connectionId).toBe(engine === "core" ? "explicit" : undefined);
    }
    await store.close();
  });
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
  it("restores a pending handoff when a lazy checkpoint rewinds before its first imported turn", async () => {
    const store = new SqlitePersistenceAdapter(":memory:");
    await store.createSession({id:"s",workspace:"/w",model:"m",mode:"build"});
    store.ensureRuntimeSession("s");
    const record = switchRecord(); record.segment.engine = "core";
    store.commitRuntimeSwitch("s","core",record);
    const input = store.prepareRuntimeInput("s","first","typed","typed",true);
    store.transitionRuntimeInput("s","next","first","dispatching");
    store.transitionRuntimeInput("s","next","first","accepted","first");
    store.mergeRuntimeTranscript("s","next",[{id:"first",turnId:"first",createdAt:4,message:{role:"user",content:input}}]);
    // Capture is lazy, but its model snapshot belongs to the turn's start.
    await store.saveCheckpoint({id:"cp",sessionId:"s",commitHash:"hash",createdAt:5,reason:"auto",label:"before first turn",historyJson:"[]"});
    const checkpoint = JSON.parse((await store.getCheckpoint("cp"))!.historyJson) as {runtimeBoundary:import("../../ports/checkpoints.js").RuntimeCheckpointBoundary};
    await store.restoreHistoryAndTurnErrors("s",[],undefined,checkpoint.runtimeBoundary);
    expect(store.loadRuntimeSession("s")!.handoff).toMatchObject({state:"pending",payload:"bounded excerpt"});
    expect(store.loadRuntimeSession("s")!.boundaries).toHaveLength(1);
    expect(store.loadRuntimeSession("s")!.items.some(item => item.turnId === "first")).toBe(false);
    expect(store.prepareRuntimeInput("s","retry","retry","retry",true)).toContain("bounded excerpt");
    await store.close();
  });
  it("atomically rewinds canonical rows and boundaries and never restores them on reopen", async () => {
    const path = await legacyDatabase();
    const store = new SqlitePersistenceAdapter(path);
    const initial = store.ensureRuntimeSession("s");
    const kept = (await store.loadHistory("s"))[0]!;
    await store.saveCheckpoint({id:"cp",sessionId:"s",commitHash:"hash",createdAt:2,reason:"auto",label:"before switch",historyJson:JSON.stringify([kept])});
    const snapshot = JSON.parse((await store.getCheckpoint("cp"))!.historyJson) as {runtimeBoundary:import("../../ports/checkpoints.js").RuntimeCheckpointBoundary};
    store.commitRuntimeSwitch("s","codex",switchRecord());
    store.mergeRuntimeTranscript("s","next",[{id:"discarded",createdAt:4,message:{role:"user",content:"discard"}}]);
    const before = store.loadRuntimeSession("s");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TRIGGER rewind_fault BEFORE DELETE ON runtime_boundaries BEGIN SELECT RAISE(ABORT,'rewind fault'); END");
    await expect(store.restoreHistoryAndTurnErrors("s",[kept],undefined,snapshot.runtimeBoundary)).rejects.toThrow("rewind fault");
    expect(store.loadRuntimeSession("s")).toEqual(before);
    expect(await store.loadHistory("s")).toEqual([]);
    raw.exec("DROP TRIGGER rewind_fault"); raw.close();
    await store.restoreHistoryAndTurnErrors("s",[kept],undefined,snapshot.runtimeBoundary);
    expect(store.loadRuntimeSession("s")!.items).toEqual(initial.items);
    expect(store.loadRuntimeSession("s")!.boundaries).toEqual([]);
    store.mergeRuntimeTranscript("s","next",await store.loadHistory("s"));
    await store.close();
    const reopened = new SqlitePersistenceAdapter(path);
    expect(reopened.loadRuntimeSession("s")!.items).toEqual(initial.items);
    expect(reopened.loadRuntimeSession("s")!.boundaries).toEqual([]);
    await reopened.close();
  });
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
  it("prunes core inputs augmented by prompt hooks without restoring hook text into the user's display", async () => {
    const {store,path} = await target("core");
    const text = store.prepareRuntimeInput("s","hooked","original","original",true);
    store.transitionRuntimeInput("s","next","hooked","dispatching");
    store.transitionRuntimeInput("s","next","hooked","accepted","hooked");
    const user = {id:"hooked-user",turnId:"hooked",step:0,createdAt:4,message:{role:"user" as const,content:`${text}\n<hook-context>private host context</hook-context>`}};
    store.mergeRuntimeTranscript("s","next",[user]);
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT count(*) AS n FROM runtime_inputs").get()!.n).toBe(0);
    raw.close(); await store.close();
    const reopened = new SqlitePersistenceAdapter(path);
    reopened.mergeRuntimeTranscript("s","next",[user]);
    expect(reopened.loadRuntimeSession("s")!.items.at(-1)?.message.content).toBe("original");
    await reopened.close();
  });
  it("prunes resolved input text after canonical custody and retains replay normalization across restart", async () => {
    const {store,path} = await target();
    const live:import("../../types/history.js").HistoryItem[] = [];
    for (let turn=0;turn<128;turn++) {
      const original = `typed ${turn}`;
      const input = store.prepareRuntimeInput("s",`logical-${turn}`,original,`${original}\n<host reminder>`,true);
      store.transitionRuntimeInput("s","next",`logical-${turn}`,"dispatching");
      store.transitionRuntimeInput("s","next",`logical-${turn}`,"accepted",`native-${turn}`);
      const user = {id:`native-${turn}:user`,turnId:`native-${turn}`,createdAt:turn+4,message:{role:"user" as const,content:input}};
      live.push(user);
      store.mergeRuntimeTranscript("s","next",[user]);
    }
    const raw = new DatabaseSync(path);
    expect(raw.prepare("SELECT count(*) AS n FROM runtime_inputs").get()!.n).toBe(0);
    expect(store.loadRuntimeSession("s")!.handoff?.injectedText).toBeUndefined();
    const unresolved = store.prepareRuntimeInput("s","unresolved","keep","keep",true);
    store.transitionRuntimeInput("s","next","unresolved","dispatching");
    expect(unresolved).toBe("keep");
    raw.close(); await store.close();
    const reopened = new SqlitePersistenceAdapter(path);
    reopened.mergeRuntimeTranscript("s","next",[...live,{id:"native-0:late",turnId:"native-0",createdAt:200,message:{role:"assistant",content:[{type:"text",text:"late native record"}]}}]);
    const items = reopened.loadRuntimeSession("s")!.items;
    expect(items.filter(item => item.message.role === "user").slice(1).map(item => item.message.content)).toEqual(Array.from({length:128},(_,i) => `typed ${i}`));
    expect(items.at(-1)?.turnId).toBe("logical-0");
    expect(reopened.runtimeInputRecoveries("s","next")).toMatchObject([{turnId:"unresolved"}]);
    await reopened.close();
  });

  it("rolls back canonical writes if pruning the resolved journal fails", async () => {
    const {store,path} = await target();
    const input = store.prepareRuntimeInput("s","logical","typed","typed",true);
    store.transitionRuntimeInput("s","next","logical","dispatching");
    store.transitionRuntimeInput("s","next","logical","accepted","native");
    const before = store.loadRuntimeSession("s");
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TRIGGER prune_fault BEFORE DELETE ON runtime_inputs BEGIN SELECT RAISE(ABORT,'prune fault'); END");
    const user = {id:"native:user",turnId:"native",createdAt:4,message:{role:"user" as const,content:input}};
    expect(() => store.mergeRuntimeTranscript("s","next",[user])).toThrow("prune fault");
    expect(store.loadRuntimeSession("s")).toEqual(before);
    raw.exec("DROP TRIGGER prune_fault"); raw.close();
    store.mergeRuntimeTranscript("s","next",[user]);
    expect(store.loadRuntimeSession("s")!.items.at(-1)?.message.content).toBe("typed");
    await store.close();
  });
  it("persists verified absence as pending and fences discard of an unknown delivery", async () => {
    const {store,path} = await target();
    store.prepareRuntimeInput("s","lost","draft","draft",true);
    store.transitionRuntimeInput("s","next","lost","dispatching");
    store.resetRuntimeInput("s","next","lost",true);
    expect(store.runtimeInputRecoveryNeeded("s","next")).toBe(true);
    store.resetRuntimeInput("s","next","lost");
    await store.close();
    const reopened = new SqlitePersistenceAdapter(path);
    expect(reopened.loadRuntimeSession("s")?.handoff).toMatchObject({state:"pending"});
    expect(reopened.runtimeInputRecoveries("s","next")).toMatchObject([{turnId:"lost",state:"pending",text:"draft"}]);
    reopened.resetRuntimeInput("s","next","lost",true);
    expect(reopened.runtimeInputRecoveries("s","next")).toEqual([]);
    expect(reopened.prepareRuntimeInput("s","next","new text","new text",true)).toContain("bounded excerpt");
    await reopened.close();
  });
  async function target(engine: "core" | "claude" = "claude") {
    const root = mkdtempSync(join(tmpdir(),"runtime-delivery-")); roots.push(root);
    const path = join(root,"db.sqlite");
    const store = new SqlitePersistenceAdapter(path);
    await store.createSession({id:"s",workspace:"/w",model:"m",mode:"plan"});
    const record = switchRecord(); record.segment.engine = engine;
    store.ensureRuntimeSession("s"); store.commitRuntimeSwitch("s","core",record);
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
    expect(store.loadRuntimeSession("s")!.segments[0]).toMatchObject({engine:"codex",accountScope:"account",nativeRef:"archived"});
    const deleted = await store.deleteSessionTree("s");
    expect(deleted.externalSessionRefs.sort()).toEqual(["archived","native-next"]);
    expect(await store.listCodexThreadItems("archived")).toEqual([]);
    expect(await store.listClaudeTranscriptItems("native-next")).toEqual([]);
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
    expect(store.loadRuntimeSession("surviving")!.segments[0]).toMatchObject({engine:"claude",accountScope:"b",nativeRef:"shared"});
    await store.deleteSessionTree("surviving");
    expect(await store.listClaudeTranscriptItems("shared")).toEqual([]);
    await store.close();
  });
});
