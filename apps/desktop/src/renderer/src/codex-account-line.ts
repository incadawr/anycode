/**
 * The session account line in the composer's context popover.
 *
 * A Codex session spends a specific account's plan, and until this line existed
 * there was no way to see WHICH one from inside the session — the owner found
 * out by burning a 5-hour personal limit. The data comes from main
 * (`codex-tab-account.ts`): the tab's own resolved profile id, its registry
 * label, and whether it is the default for new sessions.
 *
 * Pure and DOM-free so it is testable in this package's node environment.
 */
import type { CodexTabAccountResult } from "../../shared/codex-account.js";

export function describeCodexAccountLine(result: CodexTabAccountResult | null | undefined): string | null {
  if (result === null || result === undefined || !result.ok) return null;
  return `Codex account: ${result.label}${result.isDefault ? " (default)" : ""}`;
}
