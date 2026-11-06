import { describe, expect, it } from "vitest";
import { parseOpenCodeGoQuota } from "./opencode-go-quota-adapter.js";

describe("parseOpenCodeGoQuota", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  it("parses all named windows and normalizes resets", () => {
    expect(parseOpenCodeGoQuota({ usage: {
      rolling: { percent: 0, resetsAt: "2026-01-02T00:00:00Z", status: "ignored" },
      weekly: { percent: 12.5, resetsAt: 1767398400 },
      monthly: { percent: 100, resetsAt: 1767484800000 }, extra: { percent: 5 },
    } }, now)).toEqual({ rolling: { usedPercent: 0, resetsAt: 1767312000 }, weekly: { usedPercent: 12.5, resetsAt: 1767398400 }, monthly: { usedPercent: 100, resetsAt: 1767484800 } });
  });
  it("parses the observed live response shape and reset times", () => {
    // The live report records the latter two reset times to the minute.
    const raw = { usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-11-06T11:00:43Z" },
      weekly: { status: "ok", percent: 32, resetsAt: "2026-11-09T00:00:00Z" },
      monthly: { status: "ok", percent: 16, resetsAt: "2026-12-05T18:04:00Z" },
    } };
    expect(parseOpenCodeGoQuota(raw, Date.parse("2026-11-06T06:00:00Z"))).toEqual({
      rolling: { usedPercent: 0, resetsAt: Date.parse(raw.usage.rolling.resetsAt) / 1000 },
      weekly: { usedPercent: 32, resetsAt: Date.parse(raw.usage.weekly.resetsAt) / 1000 },
      monthly: { usedPercent: 16, resetsAt: Date.parse(raw.usage.monthly.resetsAt) / 1000 },
    });
  });
  it("drops invalid windows and expired resets without inventing dates", () => {
    expect(parseOpenCodeGoQuota({ usage: { rolling: { percent: 10, resetsAt: 1767225600 }, weekly: { percent: "5" }, monthly: { percent: 4, resetsAt: "bad" } } }, now)).toEqual({ monthly: { usedPercent: 4 } });
    for (const value of [null, {}, { usage: [] }, { usage: { rolling: { percent: NaN }, weekly: { percent: 101 }, monthly: { status: "ok" } } }]) expect(parseOpenCodeGoQuota(value, now)).toBeNull();
  });
});
