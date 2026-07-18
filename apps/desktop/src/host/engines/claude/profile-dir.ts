/**
 * The single fixed AnyCode Claude profile directory, host-plane copy.
 *
 * `CLAUDE_CONFIG_DIR` is a REQUIRED spawn input (cut invariant C1 — no ambient
 * `~/.claude` fallback ever), and the host is the process that spawns. The
 * authority for the path is `main/claude-binary.ts`'s `defaultClaudeProfileDir`
 * — that is the dir main's doctor diagnoses and the dir the onboarding text
 * tells the user to sign into — but the host plane never imports from `main/`
 * (no such edge exists anywhere in `src/host/**`), so the path is mirrored here
 * the same way `ClaudeEnginePane.tsx` already mirrors it for its onboarding
 * copy, and the same way `draft-args.ts`/`process-ownership.ts` are deliberate
 * duplicates of their codex counterparts.
 *
 * Drift here is not cosmetic: the doctor would report "ready" for one profile
 * while the session spawned against another, i.e. a signed-in doctor and a
 * signed-out turn. `profile-dir.test.ts` therefore pins this function's output
 * against main's own, on both platform branches.
 */

import { posix, win32 } from "node:path";

export function defaultClaudeProfileDir(home: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === "win32" ? win32 : posix;
  return paths.join(home, ".anycode", "claude", "profile-default");
}
