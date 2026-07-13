/**
 * The trust policy for a `codex` binary we are about to EXECUTE — the pure
 * decision half of the discovery ladder's "validated binary" claim (cut §2(g)).
 *
 * Two independent call sites execute a user-installed `codex`: the host engine
 * (host/engines/codex/app-server-client.ts) and main's onboarding doctor/login
 * (main/codex-doctor.ts). A host->main import is architecturally forbidden
 * (cut §2(g)), so — exactly like shared/codex-timeouts.ts does for the teardown
 * recipe — this module is the ONE place the policy itself lives, and each layer
 * supplies its own filesystem reads. Two independently-written trust checks is
 * the same divergence hazard, one layer down.
 *
 * VALUE/POLICY-ONLY module with ZERO imports (precedent: shared/codex-
 * timeouts.ts): callers pass already-read stat data in, so this file drags no
 * `node:fs` dependency into any process that imports it.
 *
 * ── THREAT MODEL (and what this policy does NOT promise) ───────────────────
 * The attack: a path that passed discovery's `stat()` is REPLACED before it is
 * executed (classic TOCTOU), or a path that is executable-but-writable-by-a-
 * third-party is executed at all. Discovery alone cannot close this, so:
 *   1. every spawn site re-runs this check immediately before `spawn()`, not
 *      just at discovery time, and
 *   2. a path a third party can write is refused outright — the swap it enables
 *      is what makes the TOCTOU window exploitable in the first place.
 *
 * RESIDUAL, DELIBERATELY NOT PAPERED OVER: the window between the final stat
 * and the kernel's `execve` is irreducible from userspace (Node exposes no
 * `fexecve`), so a same-user (or root) attacker who wins that race still wins.
 * The check narrows WHO can attack (no longer any local user via a writable
 * directory) and WHEN (a sub-millisecond window instead of the whole span from
 * discovery to spawn) — it does not eliminate the race. Callers must not
 * describe the result as a guarantee.
 */

/** The subset of `fs.Stats` this policy reads. Callers pass `statSync` output straight in. */
export interface CodexPathStat {
  isFile: boolean;
  isDirectory: boolean;
  /** Permission bits (`stat.mode & 0o7777` or the raw mode — only the low bits are read). */
  mode: number;
  uid: number;
  gid: number;
}

export interface CodexBinaryTrustInput {
  /** The binary itself, stat'ed with symlinks RESOLVED (what `execve` will actually read). */
  file: CodexPathStat;
  /**
   * Every directory that can be used to swap the binary out from under us: the
   * resolved binary's own directory, plus — when the candidate path is a
   * symlink — the directory holding that symlink (replacing the link is just as
   * good as replacing the target).
   */
  directories: readonly CodexPathStat[];
  /** `process.getuid()`. */
  uid: number;
  /** `process.getgroups()` — group-writability only matters for a group we are actually in. */
  gids: readonly number[];
  platform: NodeJS.Platform;
}

/** `0` is root: a root-owned path is trusted because root already owns the whole machine. */
const ROOT_UID = 0;

/**
 * Why group-writability is judged against OWNERSHIP rather than refused
 * outright: the stock Homebrew prefix on Apple Silicon is
 * `drwxrwxr-x  <user>:admin /opt/homebrew/bin` — GROUP-WRITABLE by design, and
 * the single most common place a real `codex` lives on a Mac. A blanket
 * group-writable refusal would reject the majority of legitimate installs while
 * buying nothing: the extra writers it admits there are (a) the owner, who is
 * us, and (b) `admin`, whose members can already `sudo`. What the rule DOES
 * refuse is the case that actually grants a foreign principal a write: a path
 * owned by someone other than us or root, and any path writable by a group we
 * are not even a member of.
 */
function unsafeReason(entry: CodexPathStat, kind: "file" | "directory", input: CodexBinaryTrustInput): string | null {
  const mode = entry.mode & 0o7777;
  const label = kind === "file" ? "Codex binary" : "Codex binary's directory";

  // World-writable: ANY local process can swap it. Never acceptable, and the
  // sticky bit does not rescue it (a sticky /tmp still lets an attacker plant
  // and win a race with a file of their own).
  if ((mode & 0o002) !== 0) {
    return `${label} is world-writable`;
  }
  // Owned by a third party (not us, not root): they can rewrite it at will,
  // no race required.
  if (entry.uid !== input.uid && entry.uid !== ROOT_UID) {
    return `${label} is owned by another user`;
  }
  // Group-writable by a group we do not belong to means somebody else can write
  // where we cannot even see it coming.
  if ((mode & 0o020) !== 0 && !input.gids.includes(entry.gid)) {
    return `${label} is writable by a group this user is not a member of`;
  }
  return null;
}

/**
 * Returns a human-readable refusal reason, or `null` when the path is safe to
 * execute. Windows returns `null`: POSIX mode bits do not exist there and ACL
 * evaluation is out of scope for this track — the Windows residual is stated in
 * the module header rather than hidden behind a check that would silently pass.
 */
export function checkCodexBinaryTrust(input: CodexBinaryTrustInput): string | null {
  if (input.platform === "win32") return null;
  if (!input.file.isFile) return "Codex binary path is not a file";
  if ((input.file.mode & 0o111) === 0) return "Codex binary is not executable";
  const fileReason = unsafeReason(input.file, "file", input);
  if (fileReason !== null) return fileReason;
  for (const directory of input.directories) {
    if (!directory.isDirectory) return "Codex binary's directory is not a directory";
    const reason = unsafeReason(directory, "directory", input);
    if (reason !== null) return reason;
  }
  return null;
}
