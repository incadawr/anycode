import { describe, expect, it } from "vitest";
import { describeCodexAccountLine } from "./codex-account-line.js";

describe("describeCodexAccountLine (the session's Codex account line)", () => {
  it("names the account and marks the default", () => {
    expect(describeCodexAccountLine({ ok: true, accountId: "acc2", label: "Personal", isDefault: true })).toBe(
      "Codex account: Personal (default)",
    );
  });

  it("names a non-default account without the marker", () => {
    expect(describeCodexAccountLine({ ok: true, accountId: "work", label: "Work", isDefault: false })).toBe("Codex account: Work");
  });

  it("renders nothing for a refusal or before the answer lands", () => {
    expect(describeCodexAccountLine({ ok: false, reason: "not_codex" })).toBeNull();
    expect(describeCodexAccountLine(null)).toBeNull();
    expect(describeCodexAccountLine(undefined)).toBeNull();
  });
});
