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
import { ClaudeSessionRowWriter, type ClaudeSessionRowPatch, type ClaudeSessionRowPort } from "./session-row.js";

interface Recorder {
  port: ClaudeSessionRowPort;
  creates: { id: string; row: Record<string, unknown> }[];
  touches: { id: string; patch: ClaudeSessionRowPatch }[];
  /** Ordered log of every write, for the serialization assertions. */
  order: string[];
}

function recorder(options: { failCreate?: boolean } = {}): Recorder {
  const creates: { id: string; row: Record<string, unknown> }[] = [];
  const touches: { id: string; patch: ClaudeSessionRowPatch }[] = [];
  const order: string[] = [];
  return {
    creates,
    touches,
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
  };
}

const IDENTITY = { workspace: "/work", engineId: "claude", externalSessionRef: "native-ref-1" };

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
});

describe("ClaudeSessionRowWriter — a resume writes straight through", () => {
  function resumed(rec: Recorder): ClaudeSessionRowWriter {
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
