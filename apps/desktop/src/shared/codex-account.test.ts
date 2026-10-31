import { describe, expect, it } from "vitest";
import {
  SYSTEM_CODEX_ACCOUNT,
  formatCodexAccountCandidate,
  selectCodexAccount,
  type CodexAccountOption,
} from "./codex-account.js";

const accounts: CodexAccountOption[] = [
  SYSTEM_CODEX_ACCOUNT,
  { id: "work", label: "Work" },
  { id: "acc2", label: "Personal" },
];

describe("selectCodexAccount (create_session's account argument)", () => {
  it("matches a profile id, case-insensitively and trimmed", () => {
    expect(selectCodexAccount("work", accounts)).toEqual({ ok: true, id: "work" });
    expect(selectCodexAccount("  ACC2 ", accounts)).toEqual({ ok: true, id: "acc2" });
  });

  it("matches the label, which is what a caller actually knows", () => {
    expect(selectCodexAccount("Personal", accounts)).toEqual({ ok: true, id: "acc2" });
    expect(selectCodexAccount("  work ", accounts)).toEqual({ ok: true, id: "work" });
  });

  it("accepts the system pseudo-account by id or label", () => {
    expect(selectCodexAccount("system", accounts)).toEqual({ ok: true, id: "system" });
    expect(selectCodexAccount("System", accounts)).toEqual({ ok: true, id: "system" });
  });

  it("refuses an unknown name and lists every candidate — no guess, no ambient fallback", () => {
    expect(selectCodexAccount("main", accounts)).toEqual({
      ok: false,
      candidates: ["System (system)", "Work (work)", "Personal (acc2)"],
    });
  });

  it("refuses a label two profiles share rather than spending an arbitrary subscription", () => {
    const shared: CodexAccountOption[] = [
      { id: "one", label: "Same" },
      { id: "two", label: "Same" },
    ];
    expect(selectCodexAccount("Same", shared)).toEqual({ ok: false, candidates: ["Same (one)", "Same (two)"] });
  });

  it("refuses an empty/whitespace query", () => {
    expect(selectCodexAccount("   ", accounts).ok).toBe(false);
  });

  it("formats a candidate as `label (id)`", () => {
    expect(formatCodexAccountCandidate({ id: "work", label: "Work" })).toBe("Work (work)");
  });
});
