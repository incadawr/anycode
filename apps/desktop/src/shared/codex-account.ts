/**
 * One Codex account as a caller may name it: the persisted profile id plus the
 * human label registered in Settings → Codex. Shared so main (identity
 * authority) and the renderer (presentation) agree on the same wire shape —
 * and so the matching rule below is unit-testable without a registry.
 */
export interface CodexAccountOption {
  /** Registry id (`system` for the ambient pseudo-profile). */
  id: string;
  /** The user-facing label; may repeat across profiles. */
  label: string;
}

/** Matches `SYSTEM_PROFILE_ID` (main/codex-profiles.ts) — duplicated on purpose, like the renderer's own copy. */
export const SYSTEM_CODEX_ACCOUNT_ID = "system";

/** The pseudo-account that always exists: the ambient `~/.codex` home. */
export const SYSTEM_CODEX_ACCOUNT: CodexAccountOption = { id: SYSTEM_CODEX_ACCOUNT_ID, label: "System" };

export type CodexAccountPick = { ok: true; id: string } | { ok: false; candidates: string[] };

/** `label (id)` — the candidate spelling used in every refusal text. */
export function formatCodexAccountCandidate(account: CodexAccountOption): string {
  return `${account.label} (${account.id})`;
}

/**
 * Resolves what a caller typed (`create_session`'s `account`) to exactly ONE
 * registry id. Accepted spellings: an id, or a label. Both comparisons are
 * case-insensitive and trimmed, because people type labels, not ids.
 * Anything else — including a label two profiles share — is refused with the
 * complete candidate list, never guessed: picking an account is choosing whose
 * subscription gets spent, so ambiguity must be resolved by the caller.
 */
export function selectCodexAccount(query: string, accounts: readonly CodexAccountOption[]): CodexAccountPick {
  const wanted = query.trim().toLowerCase();
  const candidates = accounts.map(formatCodexAccountCandidate);
  if (wanted === "") return { ok: false, candidates };
  const byId = accounts.find((account) => account.id.toLowerCase() === wanted);
  if (byId !== undefined) return { ok: true, id: byId.id };
  const byLabel = accounts.filter((account) => account.label.trim().toLowerCase() === wanted);
  if (byLabel.length === 1 && byLabel[0] !== undefined) return { ok: true, id: byLabel[0].id };
  return { ok: false, candidates };
}

/**
 * Which Codex account a session is running on — the renderer's read for the
 * session account line (context popover). Main computes it from live tab facts
 * and its own registry, never from a renderer-supplied label.
 */
export type CodexTabAccountResult =
  | { ok: true; accountId: string; label: string; isDefault: boolean }
  | { ok: false; reason: "unknown_tab" | "not_codex" };

/**
 * The usage-limit banner's "continue on another account" reply. On success the
 * session row and tab already exist; a refusal always carries a sentence the
 * banner can show as-is (no codes in the UI).
 */
export type CodexContinueResult =
  | { ok: true; sessionId: string; tabId: string }
  | { ok: false; reason: string; detail: string };
