/**
 * cut §1.5 DoD-2 (transcript resume, unit-able): `projectClaudeHistory` is
 * the read side of the shadow transcript mirror — pure ordering + unwrap,
 * no I/O. The mirror is the SOLE resume source (`--resume` never re-emits
 * history on the wire, probe #4), so getting the order wrong here would
 * scramble a resumed tab's transcript even though every row was written
 * correctly.
 */

import { describe, expect, it } from "vitest";
import type { ClaudeTranscriptItem, HistoryItem } from "@anycode/core";
import { projectClaudeHistory } from "./history-projection.js";

function row(turnOrdinal: number, positionInTurn: number, id: string): ClaudeTranscriptItem {
  const data: HistoryItem = { id, createdAt: 0, message: { role: "user", content: id } };
  return { itemId: `${turnOrdinal}:${positionInTurn}`, turnOrdinal, positionInTurn, data };
}

describe("projectClaudeHistory (cut §1.5 DoD-2)", () => {
  it("orders rows by (turnOrdinal, positionInTurn) regardless of write/read order", () => {
    const rows = [row(1, 1, "t1-b"), row(0, 0, "t0-a"), row(1, 0, "t1-a"), row(0, 1, "t0-b")];
    const items = projectClaudeHistory(rows);
    expect(items.map((item) => item.id)).toEqual(["t0-a", "t0-b", "t1-a", "t1-b"]);
  });

  it("unwraps each row's projected HistoryItem verbatim", () => {
    const items = projectClaudeHistory([row(0, 0, "only")]);
    expect(items).toEqual([{ id: "only", createdAt: 0, message: { role: "user", content: "only" } }]);
  });

  it("is empty for an empty mirror (fresh session, nothing to hydrate)", () => {
    expect(projectClaudeHistory([])).toEqual([]);
  });
});
