/**
 * "Which Codex account is this session running on?" — the main-side read
 * behind the session account line in the context popover.
 *
 * The authority is main's own live tab + registry state: the tab's resolved
 * `codexProfile.id` (the profile its host actually forked with, persisted on
 * the session row) and the persisted registry slice. Nothing here is
 * renderer-supplied, and no credential value crosses the bridge — the answer
 * is an id, a label, and whether that id is the default for new sessions.
 */
import type { CodexTabAccountResult } from "../shared/codex-account.js";
import { SYSTEM_CODEX_ACCOUNT, SYSTEM_CODEX_ACCOUNT_ID } from "../shared/codex-account.js";

/** Mirrors `CODEX_PROFILE_*_CHANNEL` (main/codex-ipc.ts) — same duplicated-literal convention. */
export const CODEX_TAB_ACCOUNT_CHANNEL = "anycode:codex-tab-account";

export interface CodexTabAccountDeps {
  /** Live tab facts; `undefined` for an unknown/closing/child tab. */
  tab(tabId: string): { engine?: string; codexProfile?: { id?: string } | null } | undefined;
  /** Fresh read of the persisted `settings.codex` slice (main is the sole writer). */
  accounts(): Promise<{ activeProfileId?: string; profiles?: Array<{ id: string; label: string }> }>;
}

/**
 * A tab that never pinned a profile runs on the ambient home (`system`) — that
 * is the historical meaning of an absent id, not a bug to paper over. An id
 * whose record has since been deleted still names the account the session was
 * created under, so the label falls back to the id itself rather than hiding
 * the fact.
 */
export async function handleCodexTabAccount(
  deps: CodexTabAccountDeps,
  tabId: string,
): Promise<CodexTabAccountResult> {
  const tab = deps.tab(tabId);
  if (tab === undefined) return { ok: false, reason: "unknown_tab" };
  if (tab.engine !== "codex") return { ok: false, reason: "not_codex" };
  const accountId = tab.codexProfile?.id ?? SYSTEM_CODEX_ACCOUNT_ID;
  let slice: Awaited<ReturnType<CodexTabAccountDeps["accounts"]>> = {};
  try {
    slice = await deps.accounts();
  } catch {
    // Presentation only: an unreadable registry must not make the line lie —
    // the id is still the truth, the label just degrades to it.
  }
  const label =
    accountId === SYSTEM_CODEX_ACCOUNT_ID
      ? SYSTEM_CODEX_ACCOUNT.label
      : slice.profiles?.find((profile) => profile.id === accountId)?.label ?? accountId;
  return {
    ok: true,
    accountId,
    label,
    isDefault: accountId === (slice.activeProfileId ?? SYSTEM_CODEX_ACCOUNT_ID),
  };
}
