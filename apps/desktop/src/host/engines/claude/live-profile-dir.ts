/**
 * The `CLAUDE_CONFIG_DIR` an ENV-GATED live test is allowed to spawn against.
 *
 * Custody invariant C1 (cut §0.2-2) has no test exemption: every spawn of the
 * `claude` binary must be confined to a dedicated AnyCode profile, never the
 * ambient `~/.claude`. A live test that defaults to `~/.claude` loads and SENDS
 * the machine owner's global `CLAUDE.md` plus their AutoMem `MEMORY.md` into
 * the model's context — the exact leak W0 measured at 9,629 tokens
 * (`w0-17-custody-A-default.jsonl`), on a real metered turn.
 *
 * So there is no ambient fallback here either. A live run either points at a
 * profile it was told to use, or it uses AnyCode's own fixed profile — the same
 * one `main/claude-binary.ts`'s doctor diagnoses and the onboarding text tells
 * the user to sign into. Reaching `~/.claude` requires naming it explicitly in
 * the override, which is then a deliberate act rather than a default.
 *
 * Product code never calls this: `ClaudeClient`'s `profileDir` is a REQUIRED
 * constructor option with no default at all.
 */

import { homedir } from "node:os";
import { defaultClaudeProfileDir } from "./profile-dir.js";

/** Points a live run at a specific profile (an isolated temp dir, a second account, …). */
export const ENV_CLAUDE_LIVE_CONFIG_DIR = "ANYCODE_CLAUDE_LIVE_CONFIG_DIR";

/**
 * The explicit override when one is set, otherwise AnyCode's own dedicated
 * profile. NEVER `~/.claude`.
 */
export function liveClaudeProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_CLAUDE_LIVE_CONFIG_DIR];
  if (override !== undefined && override.trim() !== "") return override;
  return defaultClaudeProfileDir(homedir());
}
