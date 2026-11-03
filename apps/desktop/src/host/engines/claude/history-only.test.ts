import { expect, it } from "vitest";
import { claudeHistoryOnlyEngine } from "./history-only.js";
import { ClaudeSessionRowWriter } from "./session-row.js";
import { SqlitePersistenceAdapter } from "@anycode/core";

it("shows history without launching or resuming a native session", async () => {
  const history = [{ id: "u", createdAt: 1, message: { role: "user" as const, content: "failed prompt" } }];
  const engine = claudeHistoryOnlyEngine(history);
  expect(engine.historyItems()).toEqual(history);
  const events = [];
  for await (const event of engine.runTurn("retry", { signal: new AbortController().signal })) events.push(event);
  expect(events).toMatchObject([{ type: "error", safe: { code: "history_only" } }, { type: "loop_end", reason: "error" }]);
});

it("stores a discoverable failure without a native reference", async () => {
  const db = new SqlitePersistenceAdapter(":memory:");
  const writer = new ClaudeSessionRowWriter({ rowId: "failed", identity: { workspace: "/work", engineId: "claude", externalSessionRef: "not-yet-created" }, rowExists: false, port: { create: (id, row) => db.createSession({ id, ...row } as Parameters<typeof db.createSession>[0]), touch: (id, patch) => db.touchSession(id, patch as Parameters<typeof db.touchSession>[1]) }, onError: () => {} });
  writer.materializeFailure({ model: "m", mode: "ask" });
  await writer.settled();
  await db.appendHistory("failed", [{ id: "u", createdAt: 1, turnId: "t", message: { role: "user", content: "prompt" } }]);
  await db.appendTurnError("failed", { kind: "turn_error", id: "e", createdAt: 2, turnId: "t", engine: "claude", model: "m", error: { name: "AgentError", message: "failed" } });
  expect(await db.getRootSession("failed")).toMatchObject({ engineId: "claude", id: "failed" });
  expect((await db.getRootSession("failed"))?.externalSessionRef).toBeUndefined();
  expect(await db.loadTurnErrors("failed")).toHaveLength(1);
  expect(claudeHistoryOnlyEngine(await db.loadHistory("failed")).historyItems()).toHaveLength(1);
  await db.close();
});
