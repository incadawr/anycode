import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqlitePersistenceAdapter, WriteBehindHistorySink, type HistorySinkLogger } from "./sqlite-persistence.js";
import type { CheckpointRecord } from "../../ports/checkpoints.js";
import type { PersistencePort, SessionMeta } from "../../ports/persistence.js";
import type { HistoryItem } from "../../types/history.js";

function makeItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: "item-1",
    createdAt: 0,
    message: { role: "user", content: "hello" },
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
  return {
    id: "cp-1",
    sessionId: "s1",
    commitHash: "hash-1",
    createdAt: 1,
    reason: "auto",
    label: "a turn",
    historyJson: "[]",
    ...overrides,
  };
}

describe("SqlitePersistenceAdapter", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe("session CRUD", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("creates and fetches a session (:memory:)", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      const created = await adapter.createSession({
        id: "s1",
        workspace: "/workspace",
        model: "glm-5.2",
        mode: "build",
      });
      expect(created).toEqual({
        id: "s1",
        workspace: "/workspace",
        model: "glm-5.2",
        mode: "build",
        createdAt: 1_000,
        updatedAt: 1_000,
      });

      const fetched = await adapter.getSession("s1");
      expect(fetched).toEqual(created);
    });

    it("getSession returns null for an unknown id", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      expect(await adapter.getSession("missing")).toBeNull();
    });

    it("listSessions filters by workspace, respects limit, and orders by updatedAt desc", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.createSession({ id: "a", workspace: "/w1", model: "m", mode: "build" });
      vi.setSystemTime(2_000);
      await adapter.createSession({ id: "b", workspace: "/w1", model: "m", mode: "build" });
      vi.setSystemTime(3_000);
      await adapter.createSession({ id: "c", workspace: "/w2", model: "m", mode: "build" });

      const w1Sessions = await adapter.listSessions({ workspace: "/w1" });
      expect(w1Sessions.map((s) => s.id)).toEqual(["b", "a"]);

      const limited = await adapter.listSessions({ limit: 1 });
      expect(limited.map((s) => s.id)).toEqual(["c"]);
    });

    it("touchSession patches title/mode/model and bumps updatedAt", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.createSession({ id: "s1", workspace: "/w", model: "m1", mode: "build" });

      vi.setSystemTime(5_000);
      await adapter.touchSession("s1", { title: "My session", mode: "plan", model: "m2" });

      const updated = await adapter.getSession("s1");
      expect(updated).toEqual({
        id: "s1",
        workspace: "/w",
        model: "m2",
        mode: "plan",
        title: "My session",
        createdAt: 1_000,
        updatedAt: 5_000,
      });
    });

    it("touchSession with no patch still bumps updatedAt", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.createSession({ id: "s1", workspace: "/w", model: "m1", mode: "build" });
      vi.setSystemTime(9_000);
      await adapter.touchSession("s1");
      expect((await adapter.getSession("s1"))?.updatedAt).toBe(9_000);
    });

    it("persists generic external-engine metadata without interpreting it", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.createSession({
        id: "s1",
        workspace: "/w",
        model: "effective-model",
        mode: "build",
        engineId: "codex",
        externalSessionRef: "native-thread-opaque",
      });

      vi.setSystemTime(5_000);
      await adapter.touchSession("s1", { externalSessionRef: "native-thread-resumed" });

      expect(await adapter.getSession("s1")).toMatchObject({
        engineId: "codex",
        externalSessionRef: "native-thread-resumed",
        updatedAt: 5_000,
      });
    });
  });

  it("migrates a pre-engine database and preserves its implicit core metadata", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-sqlite-old-"));
    const dbPath = join(tmpDir, "anycode.sqlite");
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, 1), (2, 2);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT
      );
      INSERT INTO sessions VALUES ('legacy', '/w', 'm', 'build', 1, 1, NULL);
    `);
    old.close();

    const adapter = new SqlitePersistenceAdapter(dbPath);
    await expect(adapter.getSession("legacy")).resolves.toMatchObject({
      id: "legacy",
      workspace: "/w",
      model: "m",
      mode: "build",
    });
    const legacy = await adapter.getSession("legacy");
    expect(legacy?.engineId).toBeUndefined();
    expect(legacy?.externalSessionRef).toBeUndefined();
    await adapter.close();
  });

  it("round-trips appended HistoryItems exactly through JSON serialization (:memory:)", async () => {
    const adapter = new SqlitePersistenceAdapter(":memory:");
    const session = await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });

    const items: HistoryItem[] = [
      makeItem({ id: "u1", createdAt: 10, message: { role: "user", content: "hi there" } }),
      makeItem({
        id: "a1",
        createdAt: 11,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            {
              type: "tool_call",
              toolCallId: "tc1",
              toolName: "Read",
              input: { path: "/a.ts", nested: { n: 1, list: [1, 2, 3] } },
            },
          ],
        },
        tokenEstimate: 42,
      }),
      makeItem({
        id: "t1",
        createdAt: 12,
        message: {
          role: "tool",
          content: [{ type: "tool_result", toolCallId: "tc1", toolName: "Read", text: "file contents", status: "success" }],
        },
        kind: "normal",
      }),
    ];

    await adapter.appendHistory(session.id, items);
    const loaded = await adapter.loadHistory(session.id);

    expect(loaded).toEqual(items);
  });

  it("round-trips appended HistoryItems exactly through JSON serialization (tmp-file DB)", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-sqlite-"));
    const dbPath = join(tmpDir, "anycode.sqlite");
    const adapter = new SqlitePersistenceAdapter(dbPath);
    const session = await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });

    const items: HistoryItem[] = [
      makeItem({ id: "u1", createdAt: 1 }),
      makeItem({ id: "u2", createdAt: 2, message: { role: "user", content: "second" } }),
    ];
    await adapter.appendHistory(session.id, items);
    await adapter.close();

    // Re-open a fresh adapter instance against the same file to confirm durability.
    const reopened = new SqlitePersistenceAdapter(dbPath);
    const loaded = await reopened.loadHistory(session.id);
    expect(loaded).toEqual(items);
    await reopened.close();
  });

  it("preserves append order across multiple calls", async () => {
    const adapter = new SqlitePersistenceAdapter(":memory:");
    const session = await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });

    await adapter.appendHistory(session.id, [makeItem({ id: "1" })]);
    await adapter.appendHistory(session.id, [makeItem({ id: "2" }), makeItem({ id: "3" })]);

    const loaded = await adapter.loadHistory(session.id);
    expect(loaded.map((i) => i.id)).toEqual(["1", "2", "3"]);
  });

  it("replaceHistory atomically swaps the whole history", async () => {
    const adapter = new SqlitePersistenceAdapter(":memory:");
    const session = await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });
    await adapter.appendHistory(session.id, [makeItem({ id: "old-1" }), makeItem({ id: "old-2" })]);

    const replacement = [makeItem({ id: "new-1", kind: "compact_summary" })];
    await adapter.replaceHistory(session.id, replacement);

    const loaded = await adapter.loadHistory(session.id);
    expect(loaded).toEqual(replacement);
  });

  it("replaceHistory rolls back atomically on a mid-transaction error, leaving old history intact", async () => {
    const adapter = new SqlitePersistenceAdapter(":memory:");
    const session = await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });

    const original = [makeItem({ id: "keep" })];
    await adapter.appendHistory(session.id, original);

    // Two items sharing the same id violate the UNIQUE(session_id, item_id)
    // constraint on the *second* insert — after the DELETE and first INSERT
    // already ran inside the transaction — forcing a ROLLBACK.
    const dup = makeItem({ id: "dup" });
    await expect(adapter.replaceHistory(session.id, [dup, dup])).rejects.toThrow();

    const loaded = await adapter.loadHistory(session.id);
    expect(loaded).toEqual(original);
  });

  it("migrates a fresh database from empty and is idempotent across repeated opens", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "anycode-sqlite-"));
    const dbPath = join(tmpDir, "nested", "dir", "anycode.sqlite");

    const adapter = new SqlitePersistenceAdapter(dbPath);
    const session = await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });
    expect(session.id).toBe("s1");
    await adapter.close();

    // Reopening an already-migrated database must not fail or re-apply migration 1.
    const reopened = new SqlitePersistenceAdapter(dbPath);
    expect(await reopened.getSession("s1")).toEqual(session);
    await reopened.createSession({ id: "s2", workspace: "/w", model: "m", mode: "build" });
    expect((await reopened.listSessions()).map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    await reopened.close();
  });

  it("close() does not throw and is safe to call multiple times", async () => {
    const adapter = new SqlitePersistenceAdapter(":memory:");
    await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });
    await expect(adapter.close()).resolves.toBeUndefined();
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  describe("checkpoints (CheckpointStore, migration v2)", () => {
    it("saves, lists newest-first without historyJson, and gets a full record (:memory:)", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });

      await adapter.saveCheckpoint(
        makeCheckpoint({ id: "c1", commitHash: "h1", createdAt: 10, label: "first", historyJson: JSON.stringify([{ id: "x" }]) }),
      );
      await adapter.saveCheckpoint(
        makeCheckpoint({ id: "c2", commitHash: "h2", createdAt: 20, reason: "pre-rewind", label: "second" }),
      );

      const list = await adapter.listCheckpoints("s1");
      expect(list.map((c) => c.id)).toEqual(["c2", "c1"]);
      expect(list[0]).toEqual({
        id: "c2",
        sessionId: "s1",
        commitHash: "h2",
        createdAt: 20,
        reason: "pre-rewind",
        label: "second",
      });
      expect(list[0]).not.toHaveProperty("historyJson");

      const rec = await adapter.getCheckpoint("c1");
      expect(rec).toEqual({
        id: "c1",
        sessionId: "s1",
        commitHash: "h1",
        createdAt: 10,
        reason: "auto",
        label: "first",
        historyJson: JSON.stringify([{ id: "x" }]),
      });
      expect(await adapter.getCheckpoint("missing")).toBeNull();
    });

    it("listCheckpoints respects the limit", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });
      for (let i = 0; i < 4; i += 1) {
        await adapter.saveCheckpoint(makeCheckpoint({ id: `c${i}`, createdAt: i }));
      }
      const list = await adapter.listCheckpoints("s1", { limit: 2 });
      expect(list.map((c) => c.id)).toEqual(["c3", "c2"]);
    });

    it("prunes to keepPerSession within saveCheckpoint, retaining the newest", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });
      for (let i = 0; i < 5; i += 1) {
        await adapter.saveCheckpoint(makeCheckpoint({ id: `c${i}`, createdAt: i }), { keepPerSession: 3 });
      }
      const list = await adapter.listCheckpoints("s1");
      expect(list.map((c) => c.id)).toEqual(["c4", "c3", "c2"]);
      expect(await adapter.getCheckpoint("c0")).toBeNull();
      expect(await adapter.getCheckpoint("c1")).toBeNull();
    });

    it("prune only affects the target session", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });
      await adapter.createSession({ id: "s2", workspace: "/w", model: "m", mode: "build" });

      await adapter.saveCheckpoint(makeCheckpoint({ id: "a1", sessionId: "s1", createdAt: 1 }), { keepPerSession: 1 });
      await adapter.saveCheckpoint(makeCheckpoint({ id: "b1", sessionId: "s2", createdAt: 1 }), { keepPerSession: 1 });
      await adapter.saveCheckpoint(makeCheckpoint({ id: "a2", sessionId: "s1", createdAt: 2 }), { keepPerSession: 1 });

      expect((await adapter.listCheckpoints("s1")).map((c) => c.id)).toEqual(["a2"]);
      expect((await adapter.listCheckpoints("s2")).map((c) => c.id)).toEqual(["b1"]);
    });

    it("migration v2 runs on a fresh database", async () => {
      // Using the checkpoints table at all proves the v2 migration applied.
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.createSession({ id: "s1", workspace: "/w", model: "m", mode: "build" });
      await adapter.saveCheckpoint(makeCheckpoint({ id: "c1" }));
      expect((await adapter.getCheckpoint("c1"))?.id).toBe("c1");
    });

    it("applies the v2 checkpoints migration on top of an existing v1 database", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-sqlite-"));
      const dbPath = join(tmpDir, "v1.sqlite");

      // Seed a database at schema v1 ONLY (as an older build would have left it):
      // v1 tables + schema_migrations at version 1, no checkpoints table.
      const seed = new DatabaseSync(dbPath);
      seed.exec("PRAGMA journal_mode = WAL;");
      seed.exec(
        `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
      );
      seed.exec(
        `CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT)`,
      );
      seed.exec(
        `CREATE TABLE history_items (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), item_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE (session_id, item_id))`,
      );
      seed.exec("CREATE INDEX idx_history_items_session ON history_items (session_id, seq)");
      seed.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0)").run();
      seed
        .prepare(
          "INSERT INTO sessions (id, workspace, model, mode, created_at, updated_at, title) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("s1", "/w", "m", "build", 0, 0, null);
      seed.close();

      // Opening with the current adapter must apply v2 and make checkpoints usable,
      // while the pre-existing v1 session data survives untouched.
      const adapter = new SqlitePersistenceAdapter(dbPath);
      expect((await adapter.getSession("s1"))?.id).toBe("s1");
      await adapter.saveCheckpoint(makeCheckpoint({ id: "c1", sessionId: "s1", commitHash: "abc", createdAt: 5 }));
      expect(await adapter.getCheckpoint("c1")).toEqual(
        makeCheckpoint({ id: "c1", sessionId: "s1", commitHash: "abc", createdAt: 5 }),
      );
      await adapter.close();
    });
  });

  describe("codex shadow command log (migration v4 + v5)", () => {
    it("records and lists items ordered by (turnOrdinal, positionInTurn), not insertion order", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.recordCodexThreadItem("thread-1", {
        itemId: "exec-b",
        turnOrdinal: 0,
        positionInTurn: 2,
        seqInTurn: 3,
        command: "echo b",
      });
      await adapter.recordCodexThreadItem("thread-1", {
        itemId: "exec-a",
        turnOrdinal: 0,
        positionInTurn: 0,
        seqInTurn: 0,
        command: "echo a",
        cwd: "/repo",
        exitCode: 0,
        outputHead: "a\n",
      });
      await adapter.recordCodexThreadItem("thread-1", {
        itemId: "exec-c",
        turnOrdinal: 1,
        positionInTurn: 0,
        seqInTurn: 0,
        command: "echo c",
        exitCode: 1,
      });

      const items = await adapter.listCodexThreadItems("thread-1");
      expect(items.map((i) => i.itemId)).toEqual(["exec-a", "exec-b", "exec-c"]);
      expect(items[0]).toEqual({
        itemId: "exec-a",
        turnOrdinal: 0,
        positionInTurn: 0,
        seqInTurn: 0,
        command: "echo a",
        cwd: "/repo",
        exitCode: 0,
        outputHead: "a\n",
      });
      expect(items[1]).toEqual({ itemId: "exec-b", turnOrdinal: 0, positionInTurn: 2, seqInTurn: 3, command: "echo b" });
    });

    it("scopes items to their own thread", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.recordCodexThreadItem("thread-1", { itemId: "x", turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo x" });
      await adapter.recordCodexThreadItem("thread-2", { itemId: "y", turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo y" });

      expect((await adapter.listCodexThreadItems("thread-1")).map((i) => i.itemId)).toEqual(["x"]);
      expect((await adapter.listCodexThreadItems("thread-2")).map((i) => i.itemId)).toEqual(["y"]);
      expect(await adapter.listCodexThreadItems("thread-missing")).toEqual([]);
    });

    it("a repeated write for the same (threadId, itemId) replaces the row instead of duplicating it", async () => {
      const adapter = new SqlitePersistenceAdapter(":memory:");
      await adapter.recordCodexThreadItem("thread-1", { itemId: "exec-a", turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo a" });
      await adapter.recordCodexThreadItem("thread-1", {
        itemId: "exec-a",
        turnOrdinal: 0,
        positionInTurn: 0,
        seqInTurn: 0,
        command: "echo a",
        exitCode: 0,
        outputHead: "a\n",
      });

      const items = await adapter.listCodexThreadItems("thread-1");
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ exitCode: 0, outputHead: "a\n" });
    });

    it("migration v4 runs on top of an existing v3 database", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-sqlite-"));
      const dbPath = join(tmpDir, "v3.sqlite");

      const seed = new DatabaseSync(dbPath);
      seed.exec("PRAGMA journal_mode = WAL;");
      seed.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
      seed.exec(
        `CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT, engine_id TEXT, external_session_ref TEXT)`,
      );
      seed.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0), (2, 0), (3, 0)").run();
      seed.close();

      const adapter = new SqlitePersistenceAdapter(dbPath);
      // Using the table at all proves the v4 migration applied on top of v3
      // (v5 also runs in the same open() call — it is additive and this is a
      // fresh v3 database with no pre-existing codex_thread_items rows).
      await adapter.recordCodexThreadItem("thread-1", { itemId: "exec-a", turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo a" });
      expect((await adapter.listCodexThreadItems("thread-1")).map((i) => i.itemId)).toEqual(["exec-a"]);
      await adapter.close();
    });

    it("migration v5 runs on top of an existing v4 database and is idempotent across repeated opens", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-sqlite-"));
      const dbPath = join(tmpDir, "v4.sqlite");

      const seed = new DatabaseSync(dbPath);
      seed.exec("PRAGMA journal_mode = WAL;");
      seed.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
      seed.exec(
        `CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT, engine_id TEXT, external_session_ref TEXT)`,
      );
      seed.exec(`CREATE TABLE codex_thread_items (
        thread_id TEXT NOT NULL, turn_ordinal INTEGER NOT NULL, position_in_turn INTEGER NOT NULL,
        item_id TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT, exit_code INTEGER, output_head TEXT,
        created_at INTEGER NOT NULL, PRIMARY KEY (thread_id, item_id)
      )`);
      seed.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0), (2, 0), (3, 0), (4, 0)").run();
      seed.close();

      const adapter = new SqlitePersistenceAdapter(dbPath);
      // Using the table with a seqInTurn value at all proves the v5 migration
      // (ADD COLUMN seq_in_turn) applied on top of v4.
      await adapter.recordCodexThreadItem("thread-1", { itemId: "exec-a", turnOrdinal: 0, positionInTurn: 0, seqInTurn: 7, command: "echo a" });
      expect(await adapter.listCodexThreadItems("thread-1")).toEqual([
        { itemId: "exec-a", turnOrdinal: 0, positionInTurn: 0, seqInTurn: 7, command: "echo a" },
      ]);
      await adapter.close();

      // Reopening an already-v5-migrated database must not fail or re-apply v5.
      const reopened = new SqlitePersistenceAdapter(dbPath);
      expect((await reopened.listCodexThreadItems("thread-1")).map((i) => i.itemId)).toEqual(["exec-a"]);
      await reopened.close();
    });

    it("migration v5 DELETES every pre-existing codex_thread_items row (wrong-coordinate-space v4 data cannot be converted)", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-sqlite-"));
      const dbPath = join(tmpDir, "v4-with-rows.sqlite");

      const seed = new DatabaseSync(dbPath);
      seed.exec("PRAGMA journal_mode = WAL;");
      seed.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
      seed.exec(
        `CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT, engine_id TEXT, external_session_ref TEXT)`,
      );
      seed.exec(`CREATE TABLE codex_thread_items (
        thread_id TEXT NOT NULL, turn_ordinal INTEGER NOT NULL, position_in_turn INTEGER NOT NULL,
        item_id TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT, exit_code INTEGER, output_head TEXT,
        created_at INTEGER NOT NULL, PRIMARY KEY (thread_id, item_id)
      )`);
      seed
        .prepare(
          `INSERT INTO codex_thread_items (thread_id, turn_ordinal, position_in_turn, item_id, command, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("thread-1", 0, 3, "exec-old", "echo old", 0);
      seed.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0), (2, 0), (3, 0), (4, 0)").run();
      seed.close();

      const adapter = new SqlitePersistenceAdapter(dbPath);
      // migrate() (including v5's DELETE) runs lazily on this first call.
      expect(await adapter.listCodexThreadItems("thread-1")).toEqual([]);
      await adapter.close();
    });

    it("migration v5 rolls back atomically on a mid-migration error, leaving schema_migrations NOT claiming 5 and the earlier DELETE undone", async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "anycode-sqlite-"));
      const dbPath = join(tmpDir, "v5-poison.sqlite");

      const seed = new DatabaseSync(dbPath);
      seed.exec("PRAGMA journal_mode = WAL;");
      seed.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
      seed.exec(
        `CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT, engine_id TEXT, external_session_ref TEXT)`,
      );
      seed.exec(`CREATE TABLE codex_thread_items (
        thread_id TEXT NOT NULL, turn_ordinal INTEGER NOT NULL, position_in_turn INTEGER NOT NULL,
        item_id TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT, exit_code INTEGER, output_head TEXT,
        created_at INTEGER NOT NULL, PRIMARY KEY (thread_id, item_id)
      )`);
      seed
        .prepare(
          `INSERT INTO codex_thread_items (thread_id, turn_ordinal, position_in_turn, item_id, command, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("thread-1", 0, 0, "exec-a", "echo a", 0);
      seed.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 0), (2, 0), (3, 0), (4, 0)").run();
      // Poisons v5's SECOND statement (ALTER TABLE ... ADD COLUMN seq_in_turn)
      // by pre-creating that exact column — SQLite rejects a duplicate column
      // name. v5's FIRST statement (the DELETE) still runs, inside the SAME
      // migration transaction, before the poisoned ALTER throws.
      seed.exec(`ALTER TABLE codex_thread_items ADD COLUMN seq_in_turn INTEGER`);
      seed.close();

      const adapter = new SqlitePersistenceAdapter(dbPath);
      // migrate() runs lazily on first use, inside this call.
      await expect(
        adapter.recordCodexThreadItem("thread-2", { itemId: "exec-z", turnOrdinal: 0, positionInTurn: 0, seqInTurn: 0, command: "echo z" }),
      ).rejects.toThrow();
      await adapter.close();

      const raw = new DatabaseSync(dbPath);
      const versions = (raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map(
        (row) => row.version,
      );
      expect(versions).toEqual([1, 2, 3, 4]); // v5 never committed
      // The DELETE that ran as v5's first statement was rolled back along
      // with the failed ALTER — the pre-existing row survives untouched.
      const rows = raw.prepare("SELECT item_id FROM codex_thread_items").all() as { item_id: string }[];
      expect(rows.map((row) => row.item_id)).toEqual(["exec-a"]);
      raw.close();
    });
  });
});

describe("WriteBehindHistorySink", () => {
  class RecordingPersistence implements PersistencePort {
    readonly calls: { op: "append" | "replaceHistory"; items: readonly HistoryItem[] }[] = [];
    rejectNextAppend = false;
    private readonly delaysMs: number[];

    constructor(delaysMs: number[] = []) {
      this.delaysMs = [...delaysMs];
    }

    private async settle(): Promise<void> {
      const ms = this.delaysMs.shift() ?? 0;
      if (ms > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
      }
    }

    async appendHistory(_sessionId: string, items: readonly HistoryItem[]): Promise<void> {
      await this.settle();
      this.calls.push({ op: "append", items });
      if (this.rejectNextAppend) {
        this.rejectNextAppend = false;
        throw new Error("boom: append failed");
      }
    }

    async replaceHistory(_sessionId: string, items: readonly HistoryItem[]): Promise<void> {
      await this.settle();
      this.calls.push({ op: "replaceHistory", items });
    }

    createSession(): Promise<SessionMeta> {
      throw new Error("not used in this test");
    }
    getSession(): Promise<SessionMeta | null> {
      throw new Error("not used in this test");
    }
    listSessions(): Promise<SessionMeta[]> {
      throw new Error("not used in this test");
    }
    touchSession(): Promise<void> {
      throw new Error("not used in this test");
    }
    loadHistory(): Promise<HistoryItem[]> {
      throw new Error("not used in this test");
    }
    close(): Promise<void> {
      throw new Error("not used in this test");
    }
  }

  it("preserves operation order across interleaved append/replaceAll calls", async () => {
    const persistence = new RecordingPersistence([15, 5, 0]);
    const sink = new WriteBehindHistorySink(persistence, "s1");
    const item1 = makeItem({ id: "1" });
    const item2 = makeItem({ id: "2" });
    const item3 = makeItem({ id: "3" });

    sink.append([item1]);
    sink.replaceAll([item2]);
    sink.append([item3]);

    await sink.flush();

    expect(persistence.calls).toEqual([
      { op: "append", items: [item1] },
      { op: "replaceHistory", items: [item2] },
      { op: "append", items: [item3] },
    ]);
  });

  it("replaceAll cannot overtake a queued append even when append is slower", async () => {
    const persistence = new RecordingPersistence([50, 0]);
    const sink = new WriteBehindHistorySink(persistence, "s1");
    const appended = makeItem({ id: "slow-append" });
    const replaced = makeItem({ id: "fast-replace" });

    sink.append([appended]);
    sink.replaceAll([replaced]);

    await sink.flush();

    expect(persistence.calls.map((c) => c.op)).toEqual(["append", "replaceHistory"]);
  });

  it("does not throw outward and logs the error when the adapter rejects", async () => {
    const persistence = new RecordingPersistence();
    persistence.rejectNextAppend = true;
    const errors: unknown[] = [];
    const logger: HistorySinkLogger = { error: (_message, error) => errors.push(error) };
    const sink = new WriteBehindHistorySink(persistence, "s1", { logger });

    expect(() => sink.append([makeItem({ id: "fail" })])).not.toThrow();
    await expect(sink.flush()).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom: append failed");
  });

  it("continues processing subsequent operations after a prior failure", async () => {
    const persistence = new RecordingPersistence();
    persistence.rejectNextAppend = true;
    const sink = new WriteBehindHistorySink(persistence, "s1", { logger: { error: () => {} } });

    sink.append([makeItem({ id: "fails" })]);
    sink.append([makeItem({ id: "still-runs" })]);

    await sink.flush();

    expect(persistence.calls.map((c) => c.items[0]?.id)).toEqual(["fails", "still-runs"]);
  });

  it("a broken logger does not poison the queue for subsequent writes", async () => {
    const persistence = new RecordingPersistence();
    persistence.rejectNextAppend = true;
    const throwingLogger: HistorySinkLogger = {
      error: () => {
        throw new Error("logger is broken");
      },
    };
    const sink = new WriteBehindHistorySink(persistence, "s1", { logger: throwingLogger });

    sink.append([makeItem({ id: "fails" })]);
    sink.append([makeItem({ id: "still-runs" })]);

    await sink.flush();

    expect(persistence.calls.map((c) => c.items[0]?.id)).toEqual(["fails", "still-runs"]);
  });

  it("flush() resolves only after all queued writes have settled", async () => {
    const persistence = new RecordingPersistence([20]);
    const sink = new WriteBehindHistorySink(persistence, "s1");

    sink.append([makeItem()]);
    expect(persistence.calls).toHaveLength(0);

    await sink.flush();
    expect(persistence.calls).toHaveLength(1);
  });

  it("flush() on an idle sink resolves immediately", async () => {
    const persistence = new RecordingPersistence();
    const sink = new WriteBehindHistorySink(persistence, "s1");
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});
