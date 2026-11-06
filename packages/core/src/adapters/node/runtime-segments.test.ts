import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeHistorySink, SqlitePersistenceAdapter } from "./sqlite-persistence.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
async function legacyDatabase() {
  const root = mkdtempSync(join(tmpdir(),"runtime-segments-")); roots.push(root);
  const path = join(root,"db.sqlite");
  const store = new SqlitePersistenceAdapter(path);
  await store.createSession({id:"s",workspace:"/workspace",model:"old",mode:"plan",engineId:"codex",externalSessionRef:"old-thread",codexProfileId:"account"});
  await store.appendHistory("s",[{id:"original",createdAt:1,message:{role:"user",content:"available text"},turnId:"stable-turn"}]);
  await store.close();
  const db = new DatabaseSync(path);
  db.exec("DROP TABLE runtime_handoffs; DROP TABLE runtime_boundaries; DROP TABLE runtime_transcript; DROP TABLE runtime_segments; ALTER TABLE sessions DROP COLUMN active_runtime_segment; ALTER TABLE sessions DROP COLUMN runtime_revision; DELETE FROM schema_migrations WHERE version=33");
  db.close();
  return path;
}
describe("runtime segment schema", () => {
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
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version=33").get()).toBeUndefined();
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
