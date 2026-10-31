/**
 * The usage-limit banner's "Continue on another account" controller.
 *
 * The banner shows a picker of the OTHER Codex accounts (the one the tab runs
 * on is not an option — it is the one that just ran out). Picking one asks main
 * to copy the thread's rollout into that account's own `CODEX_HOME` and open a
 * NEW tab resuming the thread there; this tab keeps its account, which is why
 * the action is "continue", never "switch".
 *
 * All identity stays in main: the renderer sends a registry id it read from
 * `listProfiles()`/`tabAccount()`, and main re-validates it against its own
 * list before touching a single path.
 */
import { useMemo } from "react";
import type { CodexAccountOption } from "../../shared/codex-account.js";
import { SYSTEM_CODEX_ACCOUNT_ID } from "../../shared/codex-account.js";

/** Every account except the one this tab already runs on. */
export function codexOtherAccounts(
  currentAccountId: string,
  accounts: readonly CodexAccountOption[],
): CodexAccountOption[] {
  return accounts.filter((account) => account.id !== currentAccountId);
}

export interface CodexContinueController {
  /** The choices to show; the exhausted account is already excluded. */
  accounts(): Promise<readonly CodexAccountOption[]>;
  /** Opens the new tab. A refusal's `detail` is shown in the banner as-is. */
  continueOn(accountId: string): Promise<{ ok: true } | { ok: false; detail: string }>;
}

/**
 * `undefined` = the action is not offered (not a Codex session, or a preload
 * without the channel). The disabled state still runs the same hooks so the
 * component's hook order never depends on the engine.
 */
export function useCodexContinue(tabId: string, enabled: boolean): CodexContinueController | undefined {
  return useMemo(() => {
    if (!enabled) return undefined;
    const api = window.anycode?.codex;
    if (
      typeof api?.continueOnAccount !== "function" ||
      typeof api.tabAccount !== "function" ||
      typeof api.listProfiles !== "function"
    ) {
      return undefined;
    }
    return {
      async accounts(): Promise<readonly CodexAccountOption[]> {
        const [current, snapshot] = await Promise.all([api.tabAccount(tabId), api.listProfiles()]);
        const currentAccountId = current.ok ? current.accountId : SYSTEM_CODEX_ACCOUNT_ID;
        const options: CodexAccountOption[] = [
          { id: SYSTEM_CODEX_ACCOUNT_ID, label: "System" },
          ...snapshot.profiles.map((entry) => ({ id: entry.profile.id, label: entry.profile.label })),
        ];
        return codexOtherAccounts(currentAccountId, options);
      },
      async continueOn(accountId: string) {
        const result = await api.continueOnAccount(tabId, accountId);
        return result.ok ? { ok: true as const } : { ok: false as const, detail: result.detail };
      },
    };
  }, [tabId, enabled]);
}
