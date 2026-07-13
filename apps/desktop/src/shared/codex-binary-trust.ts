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
 * RESIDUALS, DELIBERATELY NOT PAPERED OVER:
 *   - The window between the final `stat` and the kernel's `execve` is
 *     irreducible from userspace (Node exposes no `fexecve`), so a same-user
 *     (or root) attacker who wins that race still wins. The check narrows WHO
 *     can attack (no longer any local user via a writable directory) and WHEN
 *     (a sub-millisecond window instead of the whole span from discovery to
 *     spawn) — it does not eliminate the race.
 *   - The Linux user-private-group case (`unsafeReason`'s shape (b)) trusts
 *     `entry.gid === egid` without asking who else shares that gid. A distro
 *     whose default primary group is a wide SHARED one (classic `users`,
 *     often gid 100) would trust a directory writable by every local account
 *     on the box under this rule. This is a real, known weakening: there is
 *     no portable way from here to ask "is this primary group private to me"
 *     — only the machine's own account policy can guarantee that.
 *   - POSIX mode bits are the entire model here. Windows has no such bits,
 *     and ACL evaluation is out of scope for this track, so
 *     `checkCodexBinaryTrust` returns `null` (trusted) unconditionally on
 *     `win32`. That `null` is an UNCHECKED path, not a verified-safe one —
 *     callers must not read it as a guarantee.
 * None of the above is a closed guarantee; callers must not describe it as one.
 */

/** The subset of `fs.Stats` this policy reads. Callers pass `statSync` output straight in. */
export interface CodexPathStat {
  isFile: boolean;
  isDirectory: boolean;
  /** Permission bits (`stat.mode & 0o7777` or the raw mode — only the low bits are read). */
  mode: number;
  uid: number;
  gid: number;
  /** The path this stat was read from — carried only so a refusal message can name it. */
  path: string;
}

export interface CodexBinaryTrustInput {
  /** The binary itself, stat'ed with symlinks RESOLVED (what `execve` will actually read). */
  file: CodexPathStat;
  /**
   * Every directory that can be used to swap the binary out from under us:
   * the FULL ancestor chain (up to the filesystem root) of the resolved
   * binary's directory, plus — when the candidate path is a symlink — the
   * same chain for the directory holding that symlink (replacing the link is
   * just as good as replacing the target). A writable GRANDPARENT can rename
   * or replace an otherwise-safe immediate directory out from under it, so a
   * single-level check is bypassable; callers must supply the whole chain.
   */
  directories: readonly CodexPathStat[];
  /** `process.getuid()`. */
  uid: number;
  /** `process.getegid()` — the Linux user-private-group trust case is judged against THIS, not supplementary group membership (membership is not trust — see `unsafeReason`). */
  egid: number;
  platform: NodeJS.Platform;
}

/** `0` is root: a root-owned path is trusted because root already owns the whole machine. */
const ROOT_UID = 0;

/** macOS's `wheel` (root's own group) and `admin` (whose members already have `sudo`) — see `unsafeReason` shape (a). */
const DARWIN_WHEEL_GID = 0;
const DARWIN_ADMIN_GID = 80;

/**
 * Why group-writability is judged against these two narrow shapes and not
 * "any group we happen to belong to" (the bug this replaces): membership is
 * not trust. A path `victim:developers 0775`, or — on every Mac — any path
 * owned by the current user with group `staff` (gid 20, the DEFAULT primary
 * group of every local account), passes a membership test, because the
 * current user is ALSO a `developers`/`staff` member — but so is every OTHER
 * member of that group, and any of them can replace the file too. That is
 * exactly the third-party write this policy exists to refuse.
 *
 * The two shapes that ARE trusted grant nothing beyond what their writers
 * already have:
 *   (a) darwin, `gid ∈ {0 (wheel), 80 (admin)}` — the stock Homebrew prefix
 *       on Apple Silicon is `<user>:admin 0775`. `admin` members already
 *       have `sudo`, so trusting the group here concedes no new capability;
 *       `wheel` is root's own group. Judged on the gid value itself, not on
 *       whether THIS process happens to be a member — an `admin` co-writer
 *       who is not us already outranks us via `sudo` regardless of our own
 *       membership.
 *   (b) linux, `entry.uid === self && entry.gid === egid` — the
 *       user-private-group install pattern (`useradd -U` and equivalents),
 *       where the group that can write is, in practice, one person.
 * Every other group-writable path is refused, naming the path, the group,
 * and the remedy.
 */
function unsafeReason(entry: CodexPathStat, kind: "file" | "directory", input: CodexBinaryTrustInput): string | null {
  const mode = entry.mode & 0o7777;
  const label = kind === "file" ? "Codex binary" : "Codex binary's directory";

  // World-writable: ANY local process can swap it. Never acceptable, and the
  // sticky bit does not rescue it (a sticky /tmp still lets an attacker plant
  // and win a race with a file of their own).
  if ((mode & 0o002) !== 0) {
    return `${label} (${entry.path}) is world-writable`;
  }
  // Owned by a third party (not us, not root): they can rewrite it at will,
  // no race required.
  if (entry.uid !== input.uid && entry.uid !== ROOT_UID) {
    return `${label} (${entry.path}) is owned by another user (uid ${entry.uid})`;
  }
  if ((mode & 0o020) === 0) return null;
  const darwinRootEquivalentGroup =
    input.platform === "darwin" && (entry.gid === DARWIN_WHEEL_GID || entry.gid === DARWIN_ADMIN_GID);
  const linuxUserPrivateGroup = input.platform === "linux" && entry.uid === input.uid && entry.gid === input.egid;
  if (darwinRootEquivalentGroup || linuxUserPrivateGroup) return null;
  return `${label} (${entry.path}) is writable by group ${entry.gid}, which grants a co-member of that group write access; remedy: chmod g-w ${entry.path}`;
}

/**
 * Returns a human-readable refusal reason, or `null` when the path is safe to
 * execute. Windows returns `null` unconditionally — an UNCHECKED path, not a
 * verified-safe one (see the module header's residuals).
 */
export function checkCodexBinaryTrust(input: CodexBinaryTrustInput): string | null {
  if (input.platform === "win32") return null;
  if (!input.file.isFile) return `Codex binary path is not a file (${input.file.path})`;
  if ((input.file.mode & 0o111) === 0) return `Codex binary is not executable (${input.file.path})`;
  const fileReason = unsafeReason(input.file, "file", input);
  if (fileReason !== null) return fileReason;
  for (const directory of input.directories) {
    if (!directory.isDirectory) return `Codex binary's directory is not a directory (${directory.path})`;
    const reason = unsafeReason(directory, "directory", input);
    if (reason !== null) return reason;
  }
  return null;
}
