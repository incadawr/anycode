import { describe, expect, it } from "vitest";
import { parseOpenCodeGoQuota } from "./opencode-go-quota-adapter";

describe("parseOpenCodeGoQuota", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  it("parses all named windows and normalizes resets", () => {
    expect(parseOpenCodeGoQuota({ usage: {
      rolling: { percent: 0, resetsAt: "2026-01-02T00:00:00Z", status: "ignored" },
      weekly: { percent: 12.5, resetsAt: 1767398400 },
      monthly: { percent: 100, resetsAt: 1767484800000 }, extra: { percent: 5 },
    } }, now)).toEqual({ rolling: { usedPercent: 0, resetsAt: 1767312000 }, weekly: { usedPercent: 12.5, resetsAt: 1767398400 }, monthly: { usedPercent: 100, resetsAt: 1767484800 } });
  });
  it("drops invalid windows and expired resets without inventing dates", () => {
    expect(parseOpenCodeGoQuota({ usage: { rolling: { percent: 10, resetsAt: 1767225600 }, weekly: { percent: "5" }, monthly: { percent: 4, resetsAt: "bad" } } }, now)).toEqual({ monthly: { usedPercent: 4 } });
    for (const value of [null, {}, { usage: [] }, { usage: { rolling: { percent: NaN }, weekly: { percent: 101 }, monthly: { status: "ok" } } }]) expect(parseOpenCodeGoQuota(value, now)).toBeNull();
  });
});
