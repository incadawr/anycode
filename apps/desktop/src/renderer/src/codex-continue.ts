/** Dormant controller retained for compatibility while continuation is unavailable. */
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
