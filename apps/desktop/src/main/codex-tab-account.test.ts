import { describe, expect, it } from "vitest";
import { handleCodexTabAccount, type CodexTabAccountDeps } from "./codex-tab-account.js";

function deps(over: Partial<CodexTabAccountDeps> = {}, tabs: Record<string, { engine?: string; codexProfile?: { id?: string } | null }> = {}): CodexTabAccountDeps {
  return {
    tab: (tabId) => tabs[tabId],
    accounts: async () => ({ activeProfileId: "acc2", profiles: [{ id: "acc2", label: "Personal" }, { id: "work", label: "Work" }] }),
    ...over,
  };
}

describe("handleCodexTabAccount (the session's account line)", () => {
  it("names the profile the tab was created under and whether it is the default", async () => {
    const result = await handleCodexTabAccount(deps({}, { "tab-1": { engine: "codex", codexProfile: { id: "acc2" } } }), "tab-1");
    expect(result).toEqual({ ok: true, accountId: "acc2", label: "Personal", isDefault: true });
  });

  it("a non-default profile reports isDefault false", async () => {
    const result = await handleCodexTabAccount(deps({}, { "tab-1": { engine: "codex", codexProfile: { id: "work" } } }), "tab-1");
    expect(result).toEqual({ ok: true, accountId: "work", label: "Work", isDefault: false });
  });

  it("a tab that never pinned a profile is the `system` account, and says so", async () => {
    const result = await handleCodexTabAccount(deps({}, { "tab-1": { engine: "codex", codexProfile: null } }), "tab-1");
    expect(result).toEqual({ ok: true, accountId: "system", label: "System", isDefault: false });
  });

  it("system is the default when nothing else is chosen", async () => {
    const result = await handleCodexTabAccount(
      deps({ accounts: async () => ({}) }, { "tab-1": { engine: "codex", codexProfile: null } }),
      "tab-1",
    );
    expect(result).toMatchObject({ ok: true, accountId: "system", isDefault: true });
  });

  it("a deleted profile still names the account the session was created under (label falls back to the id)", async () => {
    const result = await handleCodexTabAccount(deps({}, { "tab-1": { engine: "codex", codexProfile: { id: "gone" } } }), "tab-1");
    expect(result).toEqual({ ok: true, accountId: "gone", label: "gone", isDefault: false });
  });

  it("an unreadable registry degrades the label, never the account identity", async () => {
    const result = await handleCodexTabAccount(
      deps({ accounts: async () => { throw new Error("settings unreadable"); } }, { "tab-1": { engine: "codex", codexProfile: { id: "work" } } }),
      "tab-1",
    );
    expect(result).toEqual({ ok: true, accountId: "work", label: "work", isDefault: false });
  });

  it("refuses a non-Codex tab and an unknown one", async () => {
    await expect(handleCodexTabAccount(deps({}, { "tab-1": { engine: "core" } }), "tab-1")).resolves.toEqual({ ok: false, reason: "not_codex" });
    await expect(handleCodexTabAccount(deps(), "nope")).resolves.toEqual({ ok: false, reason: "unknown_tab" });
  });
});
