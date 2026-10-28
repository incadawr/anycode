/**
 * cut §1.5 hazard (а) — native-first row ordering.
 *
 * The failure being prevented: a session row written at connect time names a
 * native session Claude has never materialized. `--session-id <uuid>` rides the
 * spawn argv, so the id LOOKS real immediately, but a handshake-only process
 * emits no `system` frame and writes no session file (probe #13). Open a Claude
 * tab, close it without asking anything, and the pre-fix ordering leaves a row
 * pointing at nothing — which then fails every `--resume` against a dead
 * reference, with no way for the user to tell why.
 */

import { describe, expect, it } from "vitest";
import {
  ClaudeSessionRowWriter,
  type ClaudePendingChildReportsPort,
  type ClaudeSessionRowPatch,
  type ClaudeSessionRowPort,
} from "./session-row.js";

interface Recorder {
  port: ClaudeSessionRowPort;
  pendingChildReportsPort: ClaudePendingChildReportsPort;
  creates: { id: string; row: Record<string, unknown> }[];
  touches: { id: string; patch: ClaudeSessionRowPatch }[];
  /** Every pending-reports write with its payload, for snapshot-staleness assertions. */
  reportSaves: { id: string; json: string | null }[];
  /** Ordered log of every write, for the serialization assertions. */
  order: string[];
}

function recorder(options: { failCreate?: boolean; failPendingReports?: boolean } = {}): Recorder {
  const creates: { id: string; row: Record<string, unknown> }[] = [];
  const touches: { id: string; patch: ClaudeSessionRowPatch }[] = [];
  const reportSaves: { id: string; json: string | null }[] = [];
  const order: string[] = [];
  return {
    creates,
    touches,
    reportSaves,
    order,
    port: {
      create: async (id, row) => {
        if (options.failCreate === true) {
          order.push("create:failed");
          throw new Error("db is gone");
        }
        creates.push({ id, row });
        order.push("create");
        return undefined;
      },
      touch: async (id, patch) => {
        touches.push({ id, patch });
        order.push(`touch:${Object.keys(patch).join(",")}`);
        return undefined;
      },
    },
    pendingChildReportsPort: {
      savePendingChildReports: async (id, json) => {
        reportSaves.push({ id, json });
        order.push(`pending_reports:${json === null ? "null" : "json"}`);
        if (options.failPendingReports === true) {
          throw new Error("SQLITE_BUSY");
        }
        return undefined;
      },
    },
  };
}

const IDENTITY = { workspace: "/work", engineId: "claude", externalSessionRef: "native-ref-1" };

/** One macrotask — enough for the fire-and-forget save chains to settle. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function fresh(rec: Recorder): ClaudeSessionRowWriter {
  return new ClaudeSessionRowWriter({
    rowId: "row-1",
    identity: IDENTITY,
    rowExists: false,
    port: rec.port,
    onError: () => {},
  });
}

describe("ClaudeSessionRowWriter — a fresh session writes nothing until the native session exists", () => {
  it("writes NO row for a tab that never ran a turn (the dead-reference scenario)", async () => {
    const rec = recorder();
    const writer = fresh(rec);

    // The tab is opened and closed. No `system/init` ever arrives, because no
    // turn ever ran.
    await writer.settled();

    expect(rec.creates).toEqual([]);
    expect(rec.touches).toEqual([]);
    expect(writer.materialized).toBe(false);
  });

  it("creates the row on the first system/init, carrying the settled posture", async () => {
    const rec = recorder();
    const writer = fresh(rec);

    writer.materialize({ model: "opus[1m]", mode: "workspace" });
    await writer.settled();

    expect(rec.creates).toEqual([
      { id: "row-1", row: { ...IDENTITY, model: "opus[1m]", mode: "workspace" } },
    ]);
  });

  it("buffers a patch that arrives BEFORE the init, then flushes it after the create", async () => {
    const rec = recorder();
    const writer = fresh(rec);

    // A title is derived from the first user message — which necessarily
    // precedes that message's own `system/init`.
    writer.touch({ title: "explain the repo" });
    await writer.settled();
    // Still nothing: a buffered patch must not conjure the row early.
    expect(rec.creates).toEqual([]);
    expect(rec.touches).toEqual([]);

    writer.materialize({ model: "haiku", mode: "ask" });
    await writer.settled();

    // The title survived, and it was written AFTER the insert it depends on.
    expect(rec.order).toEqual(["create", "touch:title"]);
    expect(rec.touches).toEqual([{ id: "row-1", patch: { title: "explain the repo" } }]);
  });

  it("keeps buffered patches in order and serializes everything behind the create", async () => {
    const rec = recorder();
    const writer = fresh(rec);

    writer.touch({ title: "first" });
    writer.touch({ title: "refined" });
    writer.materialize({ model: "haiku", mode: "ask" });
    writer.touch({ model: "sonnet" });
    await writer.settled();

    expect(rec.order).toEqual(["create", "touch:title", "touch:title", "touch:model"]);
    expect(rec.touches.map((entry) => entry.patch)).toEqual([
      { title: "first" },
      { title: "refined" },
      { model: "sonnet" },
    ]);
  });

  it("a second init never re-INSERTs — it patches the row that already exists", async () => {
    const rec = recorder();
    const writer = fresh(rec);

    writer.materialize({ model: "haiku", mode: "ask" });
    writer.materialize({ model: "sonnet", mode: "workspace" });
    await writer.settled();

    expect(rec.creates).toHaveLength(1);
    expect(rec.touches).toEqual([{ id: "row-1", patch: { model: "sonnet", mode: "workspace" } }]);
  });

  it("a failed create does not strand the writer or throw into the turn", async () => {
    const rec = recorder({ failCreate: true });
    const errors: string[] = [];
    const writer = new ClaudeSessionRowWriter({
      rowId: "row-1",
      identity: IDENTITY,
      rowExists: false,
      port: rec.port,
      onError: (_error, stage) => errors.push(stage),
    });

    writer.touch({ title: "buffered" });
    writer.materialize({ model: "haiku", mode: "ask" });
    await expect(writer.settled()).resolves.toBeUndefined();

    expect(errors).toEqual(["create"]);
    // The buffered patch still drains rather than being lost with the failure.
    expect(rec.touches).toEqual([{ id: "row-1", patch: { title: "buffered" } }]);
  });

  // Taskana 4123 cross-review F1: the flush of a report snapshot buffered
  // behind the CREATE used to fire with `void` and no catch — a rejected
  // save (SQLITE_BUSY past busy_timeout is the realistic trigger) surfaced
  // as an unhandled rejection, which kills the host under Node's default
  // `--unhandled-rejections=throw` exactly at the session's first turn.
  it("a flush whose save rejects surfaces to onError (pending_reports), never as an unhandled rejection", async () => {
    const rec = recorder({ failPendingReports: true });
    const errors: Array<{ stage: string; message: string }> = [];
    const writer = new ClaudeSessionRowWriter({
      rowId: "row-1",
      identity: IDENTITY,
      rowExists: false,
      port: rec.port,
      pendingChildReportsPort: rec.pendingChildReportsPort,
      onError: (error, stage) => errors.push({ stage, message: String(error) }),
    });

    // A report snapshot lands while the row still does not exist, then the
    // first system/init materializes the row and flushes the buffer.
    await writer.savePendingChildReports('{"reports":[{"id":"call-1"}]}');
    expect(writer.materialized).toBe(false);

    writer.materialize({ model: "haiku", mode: "ask" });
    await writer.settled();
    await tick();

    expect(errors).toEqual([{ stage: "pending_reports", message: "Error: SQLITE_BUSY" }]);
    expect(rec.order).toEqual(["create", "pending_reports:json"]);
  });

  // Taskana 4123 cross-review F1 sub-case: `create` itself rejects ->
  // onError swallows it and `this.chain` stays "resolved" — the flush used
  // to run anyway, silently UPDATE-ing a row that does not exist (0 rows
  // matched, no error) while the queue believed the report durable.
  it("a failed create keeps the buffered report snapshot buffered (no no-op flush against a missing row)", async () => {
    const rec = recorder({ failCreate: true });
    const errors: string[] = [];
    const writer = new ClaudeSessionRowWriter({
      rowId: "row-1",
      identity: IDENTITY,
      rowExists: false,
      port: rec.port,
      pendingChildReportsPort: rec.pendingChildReportsPort,
      onError: (_error, stage) => errors.push(stage),
    });

    await writer.savePendingChildReports('{"reports":[{"id":"call-1"}]}');
    writer.materialize({ model: "haiku", mode: "ask" });
    await writer.settled();
    await tick();

    expect(errors).toEqual(["create"]);
    // The flush never fired: nothing was written against the missing row
    // (the OLD behavior fired a no-op UPDATE here and believed the snapshot
    // durable) — and the snapshot is NOT resurrected into the buffer either:
    // nothing would ever re-flush it (a second materialize takes the touch
    // path), and the queue's own next mutation persists the full current
    // snapshot through the live path anyway.
    expect(rec.order).toEqual(["create:failed"]);
  });

  // Taskana 4123 review N1: the buffered flush used to be DEFERRED to
  // `created.then(...)` — it registered on the serialized chain only when the
  // create settled, i.e. AFTER any live save issued between materialize() and
  // that settlement had already registered. The older buffered snapshot then
  // landed LAST (port order NEW, OLD), clobbering the newer live state. Here
  // that means the drained-by-null write is followed by a stale json write:
  // after a restart the queue would resurrect reports the user had already
  // acknowledged. The buffer must never win against a live save.
  it("a live save registering between materialize() and the create settling is never overwritten by the older buffered snapshot", async () => {
    const rec = recorder();
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const writer = new ClaudeSessionRowWriter({
      rowId: "row-1",
      identity: IDENTITY,
      rowExists: false,
      // The create hangs until the gate opens, so the window between
      // materialize() and the create settling is fully controllable.
      port: {
        ...rec.port,
        create: async (id, row) => {
          await createGate;
          return rec.port.create(id, row);
        },
      },
      pendingChildReportsPort: rec.pendingChildReportsPort,
      onError: () => {},
    });

    // A snapshot is buffered while the row does not exist...
    await writer.savePendingChildReports('{"reports":[{"id":"call-old"}]}');
    // ...the row starts materializing (create now in flight)...
    writer.materialize({ model: "haiku", mode: "ask" });
    // ...and a NEWER live save registers on the chain inside the window — the
    // queue drained, so the truthful latest state is null.
    const liveSave = writer.savePendingChildReports(null);
    releaseCreate();
    await writer.settled();
    await liveSave;
    await tick();

    // The live save is the LAST word: exactly one report write, the null one.
    // (OLD behavior: two writes — null, then the stale buffered json.)
    expect(rec.reportSaves.map((save) => save.json)).toEqual([null]);
    expect(rec.order).toEqual(["create", "pending_reports:null"]);
  });

  // Taskana 4123 review N1, json variant: same window, but the live save
  // carries a NEWER json snapshot (a second report). The buffered one-report
  // snapshot must not land after it and silently drop the second report.
  it("a live json save inside the window stays newer than the buffered snapshot (no NEW,OLD reorder)", async () => {
    const rec = recorder();
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const writer = new ClaudeSessionRowWriter({
      rowId: "row-1",
      identity: IDENTITY,
      rowExists: false,
      port: {
        ...rec.port,
        create: async (id, row) => {
          await createGate;
          return rec.port.create(id, row);
        },
      },
      pendingChildReportsPort: rec.pendingChildReportsPort,
      onError: () => {},
    });

    await writer.savePendingChildReports('{"reports":[{"id":"call-1"}]}');
    writer.materialize({ model: "haiku", mode: "ask" });
    const liveSave = writer.savePendingChildReports('{"reports":[{"id":"call-1"},{"id":"call-2"}]}');
    releaseCreate();
    await writer.settled();
    await liveSave;
    await tick();

    expect(rec.reportSaves.map((save) => save.json)).toEqual([
      '{"reports":[{"id":"call-1"},{"id":"call-2"}]}',
    ]);
    expect(rec.order).toEqual(["create", "pending_reports:json"]);
  });

  // The live path (row exists / already materialized) is the save every REAL
  // detached-child report takes (a child can only exist after a parent turn
  // ran, i.e. after materialize). Its rejection must REACH THE CALLER — the
  // durability helper's `saveJson(...).catch(console.error)` — never leak as
  // an unhandled rejection through some internal fire-and-forget use.
  it("a live-path save rejection propagates to the caller (the durability helper catches it), never as an unhandled rejection", async () => {
    const rec = recorder({ failPendingReports: true });
    const writer = new ClaudeSessionRowWriter({
      rowId: "row-1",
      identity: IDENTITY,
      rowExists: true,
      port: rec.port,
      pendingChildReportsPort: rec.pendingChildReportsPort,
      onError: () => {},
    });

    // The durability helper's exact posture: void saveJson(...).catch(...)
    let caught: unknown = undefined;
    void writer.savePendingChildReports('{"reports":[]}').catch((error: unknown) => {
      caught = error;
    });
    await tick();

    expect(String(caught)).toBe("Error: SQLITE_BUSY");
    expect(rec.order).toEqual(["pending_reports:json"]);
  });
});

// TASK.102 CUT-S4 §4.3: `index.ts`'s `bootClaudeSession` is not importable in
// a test (it touches `process.parentPort` at module scope — the established
// host-test idiom, see `index.test.ts`'s own header). This mirrors the exact
// `sessionRow` object literal that function now builds — identity plus
// `parentSessionId`/`spawnToolCallId` ONLY when `args.child !== undefined` —
// the same "reproduce the DECISION's shape locally" precedent
// `child-session-wire.test.ts`'s header documents for boot.ts's lock #1: a
// mirror, not an import, because there is no exported production function to
// import here (the ternary lives inline in `bootClaudeSession`). What IS
// proven end-to-end, through the REAL `ClaudeSessionRowWriter`, is the part
// that matters for the owner invariant: `create()` receives
// `parentSessionId`/`spawnToolCallId` for a child, and does NOT for a root —
// core's `listRootSessions` filters on `parent_session_id IS NULL`
// (adapters/node/sqlite-persistence.ts), so this is exactly the field whose
// presence/absence decides Sidebar visibility.
describe("ClaudeSessionRowWriter — child stamp (CUT-S4 §4.3, mirrors bootClaudeSession's sessionRow literal)", () => {
  function buildSessionRow(child: { parentSessionId: string; spawnToolCallId: string } | undefined) {
    return {
      workspace: "/work",
      engineId: "claude" as const,
      externalSessionRef: "native-ref-1",
      ...(child !== undefined ? { parentSessionId: child.parentSessionId, spawnToolCallId: child.spawnToolCallId } : {}),
    };
  }

  it("a ROOT boot's identity carries no parentSessionId/spawnToolCallId (byte-identical to pre-S4)", async () => {
    const rec = recorder();
    const writer = new ClaudeSessionRowWriter({
      rowId: "row-root",
      identity: buildSessionRow(undefined),
      rowExists: false,
      port: rec.port,
      onError: () => {},
    });

    writer.materialize({ model: "opus[1m]", mode: "ask" });
    await writer.settled();

    expect(rec.creates).toEqual([{ id: "row-root", row: { ...IDENTITY, model: "opus[1m]", mode: "ask" } }]);
    expect(rec.creates[0]!.row).not.toHaveProperty("parentSessionId");
    expect(rec.creates[0]!.row).not.toHaveProperty("spawnToolCallId");
  });

  it("a CHILD boot's identity carries parentSessionId/spawnToolCallId through to create() — the field listRootSessions excludes on", async () => {
    const rec = recorder();
    const writer = new ClaudeSessionRowWriter({
      rowId: "row-child",
      identity: buildSessionRow({ parentSessionId: "parent-1", spawnToolCallId: "call-1" }),
      rowExists: false,
      port: rec.port,
      onError: () => {},
    });

    // A plan-mode parent (child-permission-map.ts maps plan -> "read-only")
    // — the SAME `mode` the engine's own onFirstSystemInit reports back,
    // proving the "mode column carries the assigned preset" half of §4.2's
    // persistence-honesty requirement travels through this same writer.
    writer.materialize({ model: "opus[1m]", mode: "read-only" });
    await writer.settled();

    expect(rec.creates).toEqual([
      {
        id: "row-child",
        row: { ...IDENTITY, parentSessionId: "parent-1", spawnToolCallId: "call-1", model: "opus[1m]", mode: "read-only" },
      },
    ]);
  });
});

describe("ClaudeSessionRowWriter — a resume writes straight through", () => {  function resumed(rec: Recorder): ClaudeSessionRowWriter {
    return new ClaudeSessionRowWriter({
      rowId: "row-1",
      identity: IDENTITY,
      rowExists: true,
      port: rec.port,
      onError: () => {},
    });
  }

  it("never INSERTs over an existing row — main sends --resume <id> for every respawn", async () => {
    const rec = recorder();
    const writer = resumed(rec);

    writer.touch({ title: "existing session" });
    writer.materialize({ model: "opus[1m]", mode: "workspace" });
    await writer.settled();

    expect(rec.creates).toEqual([]);
    expect(rec.order).toEqual(["touch:title", "touch:model,mode"]);
  });

  it("patches the resumed row with the posture the native session actually settled on", async () => {
    const rec = recorder();
    const writer = resumed(rec);

    // The row said haiku/ask; the surviving native session is on opus/workspace.
    writer.materialize({ model: "opus[1m]", mode: "workspace" });
    await writer.settled();

    expect(rec.touches).toEqual([{ id: "row-1", patch: { model: "opus[1m]", mode: "workspace" } }]);
  });
});

/**
 * The Sessions API acknowledges a title only after it is stored, so that path
 * needs a write whose failure REACHES it. A plain `touch` is deliberately
 * fail-soft (a turn is never failed by its own title write); `commitTitle` is
 * the strict twin — a row that was never created, or an UPDATE that failed,
 * rejects instead of passing for a stored title.
 */
describe("ClaudeSessionRowWriter — a title write its caller must confirm", () => {
  function failingTitleWriter(options: { failCreate?: boolean } = {}) {
    const writes: string[] = [];
    const errors: string[] = [];
    const writer = new ClaudeSessionRowWriter({
      rowId: "row-1",
      identity: IDENTITY,
      rowExists: false,
      port: {
        create: async () => {
          if (options.failCreate === true) throw new Error("db is gone");
          return undefined;
        },
        touch: async (_id, patch) => {
          writes.push(Object.keys(patch).join(","));
          if (patch.title !== undefined) throw new Error("SQLITE_BUSY");
          return undefined;
        },
      },
      onError: (_error, stage) => errors.push(stage),
    });
    return { writer, writes, errors };
  }

  it("rejects a buffered title when the row could not be created (no no-op UPDATE passes for a stored title)", async () => {
    const { writer, writes, errors } = failingTitleWriter({ failCreate: true });

    const committed = writer.commitTitle("worker-1");
    writer.materialize({ model: "haiku", mode: "ask" });

    await expect(committed).rejects.toThrow("db is gone");
    // The create failure is reported once, as a create failure.
    expect(errors).toEqual(["create"]);
    expect(writes).toEqual([]);
  });

  it("rejects a buffered title whose UPDATE failed, while the ordinary patch beside it stays fail-soft", async () => {
    const { writer, writes, errors } = failingTitleWriter();

    const sibling = writer.touch({ model: "sonnet" });
    const committed = writer.commitTitle("worker-1");
    writer.materialize({ model: "haiku", mode: "ask" });

    await expect(committed).rejects.toThrow("SQLITE_BUSY");
    await expect(sibling).resolves.toBeUndefined();
    await writer.settled();
    expect(writes).toEqual(["model", "title"]);
    expect(errors).toEqual(["touch"]);
  });

  it("rejects on the live path (a resumed row) without breaking the writes queued behind it", async () => {
    const writes: string[] = [];
    const writer = new ClaudeSessionRowWriter({
      rowId: "row-1",
      identity: IDENTITY,
      rowExists: true,
      port: {
        create: async () => undefined,
        touch: async (_id, patch) => {
          writes.push(Object.keys(patch).join(","));
          if (patch.title !== undefined) throw new Error("SQLITE_BUSY");
          return undefined;
        },
      },
      onError: () => {},
    });

    const committed = writer.commitTitle("worker-1");
    const sibling = writer.touch({ model: "sonnet" });

    await expect(committed).rejects.toThrow("SQLITE_BUSY");
    await expect(sibling).resolves.toBeUndefined();
    // The failing title write did not strand the next one.
    expect(writes).toEqual(["title", "model"]);
  });

  it("resolves once the buffered title is on disk (a later resume reads it back)", async () => {
    const rec = recorder();
    const writer = fresh(rec);

    const committed = writer.commitTitle("worker-1");
    writer.materialize({ model: "haiku", mode: "ask" });
    await committed;

    expect(rec.order).toEqual(["create", "touch:title"]);
    expect(rec.touches).toEqual([{ id: "row-1", patch: { title: "worker-1" } }]);
  });
});
