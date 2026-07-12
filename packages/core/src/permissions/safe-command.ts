/**
 * Bash safe-command classifier (Phase 5 slice-5.1-cut.md §2.1). A purely
 * lexical, fail-closed gate answering ONE question: is a Bash command PROVABLY
 * read-only? It returns "read-only" only when every conservative check passes;
 * anything it does not fully prove safe — including anything it does not
 * understand — is "unknown".
 *
 * WHY IT EXISTS: the ExecutionPort runs commands through
 * `spawn(command, { shell: true })` (adapters/node/node-execution.ts:90), so the
 * raw string is handed to /bin/sh, which interprets `;` `&&` `|` `$()` backticks
 * redirects globs etc. A single string like `ls; rm -rf ~` is one valid Bash
 * tool input that the shell would execute in full. This classifier is the only
 * lexical barrier before that shell, so its design is deliberately asymmetric

 * is acceptable; a false-positive (a silent auto-approve of an effectful
 * command) is an RCE-class failure and is not.
 *
 * The exported constants (READ_ONLY_BINARIES, GIT_SAFE_SUBCOMMANDS,
 * GIT_BARE_ONLY_SUBCOMMANDS, WRITE_CAPABLE_FLAGS) are the shipped "strictest
 * reasonable default": slice 5.2 reads them to seed its OS-sandbox profile and
 * U1-P5 tunes their composition. This module performs zero I/O and depends on no
 * core types.
 *
 * KNOWN, SANCTIONED LIMITS (all lexical; true enforcement is the OS layer in
 * slice 5.2):
 *  - Basename trust: the first token's basename is matched against the
 *    allowlist, so `/bin/ls` classifies as read-only (a required positive) — and
 *    therefore so would a planted `/tmp/evil/ls`, or a PATH-shadowed bare `ls`.
 *    Lexical analysis cannot verify a binary's true identity; that is the OS
 *    sandbox's job (5.2). This is an accepted limit, not a defect.
 *  - Quote-unaware: metacharacters are rejected even inside quotes, so
 *    `grep "a;b" f` is (safely) demoted to "unknown". Maximum conservatism is

 *  - The write-flag safety net matches whole flag tokens (and `--long=value`),
 *    not bundled short flags (`-ao`) or attached short values (`-ofile`). It is
 *    NOT the source of safety: every allowlisted binary is read-only BY NATURE,
 *    and the WRITE_CAPABLE_FLAGS screen is only a defense-in-depth backstop for a
 *    binary that is read-only except for one rare output flag (e.g. `tree -o`).
 *    A binary whose write/exec surface the screen cannot exhaust is NOT a
 *    candidate for the allowlist: ripgrep (`--pre`/`--pre-glob` run an arbitrary
 *    program per file, `--hostname-bin` runs one unconditionally, `-z` spawns
 *    external decompressors) and `file` (`-C`/`--compile` writes a `magic.mgc`
 *    into cwd) are therefore DELIBERATELY excluded — fail-closed, plain search is
 *    covered by grep/egrep/fgrep. Any binary ADDED via U1-P5 tuning must be
 *    read-only by nature (not merely "denylist a few flags") before it is trusted.
 */

export type BashCommandClass = "read-only" | "unknown";

/**
 * Shell metacharacters whose mere presence proves the string is more than a
 * single plain command: composition (`;` `&` `|`), subshell/substitution
 * (`` ` `` `$` `(` `)` `{` `}`), redirects/here-docs (`<` `>`), escapes (`\`),
 * history-expansion (`!`), glob/brace/tilde expansion (`*` `?` `[` `]` `~`),
 * env-assignment (`=`), and comments (`#`). Newline/carriage-return are also
 * caught by the control-character scan below. Rejected even inside quotes.
 */
const SHELL_METACHARACTERS: ReadonlySet<string> = new Set([
  ";", "&", "|", "`", "$", "(", ")", "{", "}", "<", ">", "\\",
  "!", "*", "?", "[", "]", "~", "=", "#", "\n", "\r",
]);

/**
 * Binaries with no subcommand grammar that are read-only by default. Each is
 * additionally screened against WRITE_CAPABLE_FLAGS (and, for the effectful
 * positional case below, restricted further). `git` is NOT here — it has a
 * subcommand grammar and is handled via GIT_SAFE_SUBCOMMANDS. `env` and
 * `hostname` are deliberately EXCLUDED: `env cmd` executes an arbitrary program
 * and `hostname name` sets the system hostname. `rg` (ripgrep) and `file` are
 * also EXCLUDED (fail-closed): ripgrep's `--pre`/`--hostname-bin`/`-z` execute
 * arbitrary programs and `file -C` writes to cwd — write/exec surfaces the flag
 * screen cannot exhaust. Plain search is served by grep/egrep/fgrep instead.
 *
 * `tree` is the ONE entry whose read-only-ness leans on the WRITE_CAPABLE_FLAGS
 * net rather than being read-only by nature: `tree -o FILE` writes, but `-o` is
 * in the net so `tree -o out.txt` demotes to "unknown" (pinned by regression
 * test). It is retained because that single output flag is fully covered; a tool
 * with more than one such flag would not qualify.
 */
export const READ_ONLY_BINARIES: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "whoami", "id", "uname",
  "stat", "du", "df", "echo", "printf",
  "grep", "egrep", "fgrep", "tree",
  "readlink", "basename", "dirname", "realpath",
  "cksum", "md5sum", "sha1sum",
  "date", "true", "false",
]);

/**
 * Read-only binaries that are safe ONLY when invoked bare (zero arguments),
 * because a positional/flag form has an effect. `date -s`, and BSD
 * `date <stamp>` with a positional, set the system clock — so only bare `date`
 * is provably read-only.
 */
const NO_ARGUMENT_BINARIES: ReadonlySet<string> = new Set(["date"]);

/**
 * git subcommands that are read-only for ANY arguments (their args cannot
 * produce an effect), subject to the git write-flag screen. `branch`/`remote`
 * are NOT here — they have create/delete/reconfigure forms via positional args
 * or flags the screen cannot catch, so they are read-only only bare (see
 * GIT_BARE_ONLY_SUBCOMMANDS). Excluded entirely (effectful forms, none of them
 * required positives): config, tag, symbolic-ref, stash, notes, and every write
 * subcommand (add/commit/push/checkout/reset/clean/apply/worktree/merge/…).
 */
export const GIT_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "rev-parse", "describe",
  "blame", "shortlog", "ls-files", "ls-tree", "cat-file",
]);

/**
 * git subcommands that are read-only only when invoked bare (`git branch`,
 * `git remote`): with arguments they create/delete/reconfigure
 * (`git branch -d x`, `git branch new`, `git remote add origin url`).
 */
export const GIT_BARE_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(["branch", "remote"]);

/**
 * General write-targeting flags denied for EVERY read-only binary (safety net).
 * These select a write destination or in-place edit across common tools
 * (`-o`/`-O`/`--output`, `-i`/`--in-place`, `-w`/`--write`). Denying them may
 * reject a few read-only uses (e.g. `grep -i`, `ls -o`) — an accepted

 */
export const WRITE_CAPABLE_FLAGS: ReadonlySet<string> = new Set([
  "-o", "-O", "--output", "-i", "--in-place", "-w", "--write",
]);

/** Write flags for git read-only subcommands: the general net plus config/output mutators. */
const GIT_WRITE_FLAGS: ReadonlySet<string> = new Set([
  ...WRITE_CAPABLE_FLAGS,
  "--add", "--set", "--unset", "--edit",
]);

/**
 * True when the string carries any shell metacharacter or control character.
 * Control characters (below 0x20, except tab) and DEL (0x7f) are rejected
 * outright — this is what catches newline/carriage-return line injection and
 * embedded NUL.
 */
function hasUnsafeCharacter(command: string): boolean {
  for (let i = 0; i < command.length; i += 1) {
    const code = command.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      return true;
    }
    if (SHELL_METACHARACTERS.has(command.charAt(i))) {
      return true;
    }
  }
  return false;
}

/** Splits on ASCII whitespace (space/tab). Assumes the metacharacter screen already passed. */
function tokenize(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed === "") {
    return [];
  }
  return trimmed.split(/[ \t]+/);
}

/** The token after the last `/` (path is intentionally not screened, so `/bin/ls` -> `ls`). */
function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

/**
 * True when an argument token is a write-targeting flag in `flags`. Long flags
 * are normalized by dropping a `=value` suffix (`--output=f` -> `--output`);
 * short flags are compared verbatim.
 */
function isWriteFlag(arg: string, flags: ReadonlySet<string>): boolean {
  if (arg.length < 2 || arg.charAt(0) !== "-") {
    return false;
  }
  const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
  const normalized = eq === -1 ? arg : arg.slice(0, eq);
  return flags.has(normalized);
}

/** Classifies a `git <subcommand> …` invocation (tokens[0] basename is `git`). */
function classifyGit(tokens: string[]): BashCommandClass {
  if (tokens.length < 2) {
    // Bare `git` (prints help) — harmless, but not worth allowlisting.
    return "unknown";
  }
  const subcommand = tokens[1]!;
  if (GIT_BARE_ONLY_SUBCOMMANDS.has(subcommand)) {
    return tokens.length === 2 ? "read-only" : "unknown";
  }
  if (!GIT_SAFE_SUBCOMMANDS.has(subcommand)) {
    return "unknown";
  }
  for (const arg of tokens.slice(2)) {
    if (isWriteFlag(arg, GIT_WRITE_FLAGS)) {
      return "unknown";
    }
  }
  return "read-only";
}

/**
 * Classifies a Bash command string as provably "read-only" or else "unknown".
 * Fail-closed: returns "read-only" only when the metacharacter screen, the
 * basename allowlist, and the per-binary flag/subcommand screens all pass.
 */
export function classifyBashCommand(command: string): BashCommandClass {
  // 1. Raw-string screen: any shell metacharacter or control character means
  //    the string is not a single plain command (composition, redirect,
  //    substitution, expansion, env-assignment, comment, or line injection).
  //    Redirect screening is also this slice's runtime confinement: any write,
  //    to any path, demotes the command to "unknown".
  if (hasUnsafeCharacter(command)) {
    return "unknown";
  }

  // 2. Whitespace tokenization (safe now: no metacharacters remain).
  const tokens = tokenize(command);
  if (tokens.length === 0) {
    return "unknown";
  }

  // 3. Basename of the first token against the allowlist. See the basename-trust
  //    limit in the module doc: `/bin/ls` -> `ls` is intentionally read-only.
  const binary = basename(tokens[0]!);
  if (binary === "git") {
    return classifyGit(tokens);
  }
  if (!READ_ONLY_BINARIES.has(binary)) {
    return "unknown";
  }

  // 4a. Bare-only binaries: any argument may carry an effect (e.g. `date -s`).
  if (NO_ARGUMENT_BINARIES.has(binary) && tokens.length > 1) {
    return "unknown";
  }

  // 4b. Write-flag safety net across every argument.
  for (const arg of tokens.slice(1)) {
    if (isWriteFlag(arg, WRITE_CAPABLE_FLAGS)) {
      return "unknown";
    }
  }

  // 5. Every conservative check passed.
  return "read-only";
}
