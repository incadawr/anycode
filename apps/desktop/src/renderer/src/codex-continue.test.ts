import { describe, expect, it } from "vitest";
import type { CodexAccountOption } from "../../shared/codex-account.js";
import { codexOtherAccounts } from "./codex-continue.js";

describe("codexOtherAccounts — the banner's picker choices", () => {
  const accounts: CodexAccountOption[] = [
    { id: "system", label: "System" },
    { id: "account-a", label: "Account A" },
    { id: "account-b", label: "Account B" },
  ];

  it("excludes the account the tab already runs on and keeps the registry order", () => {
    expect(codexOtherAccounts("account-a", accounts)).toEqual([
      { id: "system", label: "System" },
      { id: "account-b", label: "Account B" },
    ]);
  });

  it("offers every account when the current one is not in the list", () => {
    expect(codexOtherAccounts("unknown", accounts)).toEqual(accounts);
  });
});
