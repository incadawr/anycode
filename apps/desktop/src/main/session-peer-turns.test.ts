import { expect, it } from "vitest";
import { createSessionPeerTurns } from "./session-peer-turns.js";

it("pins dispatch, generation, message and terminal; rejects stale, unknown and repeated events", () => {
  const turns = createSessionPeerTurns();
  const proc = {}, old = {};
  const host = { proc, generation: 2 };
  const context = { type: "session_peer_turn", generation: 2, sequence: 1, turnId: "t", requestId: "m", deliveredMessageIds: ["m"] };
  const result = { source: "live_turn", turnId: "t", requestId: "m", nativeTurnId: null, terminalReason: "completed", publicAnswer: "answer", truncated: false, completedAt: 1 };
  const terminal = { ...context, type: "session_peer_terminal", result };
  turns.expectMessage(proc, "m");
  expect(turns.accept(host, old, context)).toBeNull();
  expect(turns.accept(host, proc, { ...context, generation: 1 })).toBeNull();
  expect(turns.accept(host, proc, { ...context, deliveredMessageIds: ["unknown"] })).toBeNull();
  expect(turns.accept(host, proc, terminal)).toBeNull();
  expect(turns.accept(host, proc, context)).toMatchObject({ turnId: "t" });
  expect(turns.active(proc)).toMatchObject({ deliveredMessageIds: ["m"] });
  expect(turns.accept(host, proc, { ...terminal, turnId: "unknown" })).toBeNull();
  expect(turns.accept(host, proc, { ...terminal, result: { ...result, reasoning: "secret" } })).toBeNull();
  expect(turns.accept(host, proc, terminal)).toMatchObject({ result });
  expect(turns.active(proc)).toBeUndefined();
  expect(turns.accept(host, proc, terminal)).toBeNull();
  expect(turns.accept(host, proc, context)).toBeNull();
  expect(turns.accept(host, proc, { ...context, sequence: 2, turnId: "t2", requestId: "user", deliveredMessageIds: [] })).toBeTruthy();
  expect(turns.accept(host, proc, terminal)).toBeNull();
});
