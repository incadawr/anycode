/**
 * The shared effort validator is the only place that decides whether a
 * requested session effort is legal, so these tests are the contract main and
 * the host both rely on: exact strings, the model's own order, and a refusal
 * detail that names everything a caller needs to correct itself.
 */
import { describe, expect, it } from "vitest";
import { normalizeEffortLevels, validateSessionEffort } from "./session-effort.js";

const codex = {
  engine: "codex",
  model: "gpt-6.1-terra",
  levels: ["low", "medium", "high", "xhigh"],
};

describe("validateSessionEffort", () => {
  it("accepts only exact advertised effort strings", () => {
    expect(validateSessionEffort("xhigh", codex)).toEqual({ ok: true, effort: "xhigh" });

    // Case changes, surrounding whitespace, empty values, numbers and null are
    // all refused — the request is never repaired into something else.
    const notAdvertised = ["XHIGH", "Xhigh", " xhigh", "xhigh "];
    const malformed: unknown[] = ["  ", "", 3, null, true, ["xhigh"], { effort: "xhigh" }];
    for (const value of [...notAdvertised, ...malformed]) {
      const result = validateSessionEffort(value, codex);
      expect(result.ok, `expected ${JSON.stringify(value)} to be refused`).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("invalid_effort");
      const expectedReason = notAdvertised.includes(value as string) ? "not_advertised" : "invalid_type";
      expect(result.detail).toContain(`reason=${expectedReason}`);
    }
  });

  it("preserves native levels outside the core vocabulary", () => {
    const native = { engine: "codex", model: "gpt-6.1-terra", levels: ["low", "turbo-9"] };
    expect(validateSessionEffort("turbo-9", native)).toEqual({ ok: true, effort: "turbo-9" });

    // `off` is NOT granted by the validator — only an advertised level passes.
    expect(validateSessionEffort("off", native)).toMatchObject({ ok: false, reason: "invalid_effort" });
  });

  it("formats invalid effort with the complete allowed list", () => {
    const result = validateSessionEffort("turbo", codex);
    expect(result).toEqual({
      ok: false,
      reason: "invalid_effort",
      detail: 'engine=codex; model="gpt-6.1-terra"; effort="turbo"; allowed=["low","medium","high","xhigh"]; reason=not_advertised',
    });
  });

  it("refuses every explicit value when the model advertises no levels", () => {
    const result = validateSessionEffort("high", { engine: "claude", model: "a", levels: [] });
    expect(result).toEqual({
      ok: false,
      reason: "invalid_effort",
      detail: 'engine=claude; model="a"; effort="high"; allowed=[]; reason=no_supported_levels',
    });
    // A non-string is still a type error even with an empty vocabulary.
    expect(validateSessionEffort(1, { engine: "claude", model: "a", levels: [] })).toMatchObject({
      ok: false,
      detail: expect.stringContaining("reason=invalid_type"),
    });
  });
});

describe("normalizeEffortLevels", () => {
  it("preserves advertised order and drops duplicate, empty and non-string entries", () => {
    expect(normalizeEffortLevels(["high", "", "low", "high", "  ", 7, null, "xhigh", "low"])).toEqual([
      "high",
      "low",
      "xhigh",
    ]);
  });
});
