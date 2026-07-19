/**
 * The isolated AnyCode Claude profile directory, host-plane copy.
 *
 * Ambient `~/.claude` is the product default (owner pivot — see
 * shared/claude-config-dir.ts): `ClaudeClientOptions.profileDir` is an
 * OPTIONAL override, not a required spawn input. This builder survives as the
 * path an explicit override resolves to, and the one the env-gated live
 * tests pin to (live-profile-dir.ts) for isolation that must never fall back
 * to ambient. The authority for the path is `main/claude-binary.ts`'s
 * `defaultClaudeProfileDir` — but the host plane never imports from `main/`
 * (no such edge exists anywhere in `src/host/**`), so the path is mirrored
 * here the same way `draft-args.ts`/`process-ownership.ts` are deliberate
 * duplicates of their codex counterparts.
 *
 * Drift here is not cosmetic: an explicit override that resolved to two
 * different paths in main vs host would let the doctor diagnose one profile
 * while a session spawned against another. `profile-dir.test.ts` therefore
 * pins this function's output against main's own, on both platform branches.
 */

import { posix, win32 } from "node:path";

export function defaultClaudeProfileDir(home: string, platform: NodeJS.Platform = process.platform): string {
  const paths = platform === "win32" ? win32 : posix;
  return paths.join(home, ".anycode", "claude", "profile-default");
}
