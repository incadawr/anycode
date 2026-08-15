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
 * U1-P5 tunes their composition. This module performs zero I/O and depends on
 * the one exported Bash splitter (`splitBashSegments` from `./rules.js`, the
 * ONE splitter — invariant 2) and no other core types.
 *
 * TASK.35 (`classifyBashCommandLine`, below `classifyBashCommand`): widens
 * auto-allow to Bash PIPELINES under grammar v1 (`|` only). A line the
 * splitter reads as one segment routes to `classifyBashCommand` on the
 * ORIGINAL string, bit-for-bit — the single-command path below is completely
 * unmodified by this addition. The widening surface is exactly all-`|`
 * multi-segment pipelines whose every segment independently proves read-only
 * through a doubly-conservative per-segment screen (raw metacharacter screen,
 * THEN quote-aware tokenization) — see `classifyPipelineSegment`.
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
 *    and the WRITE_CAPABLE_FLAGS screen is pure defense in depth — no entry may
 *    LEAN on it (TASK.35 fix wave 1 removed `tree` for exactly that reason; see
 *    the READ_ONLY_BINARIES doc below).
 *    A binary whose write/exec surface the screen cannot exhaust is NOT a
 *    candidate for the allowlist: ripgrep (`--pre`/`--pre-glob` run an arbitrary
 *    program per file, `--hostname-bin` runs one unconditionally, `-z` spawns
 *    external decompressors), `file` (`-C`/`--compile` writes a `magic.mgc`
 *    into cwd), and `tree` (`-o FILE` writes, and `-no FILE`/`-o<FILE>` cluster
 *    spellings evade any verbatim flag net — TASK.35 fix wave 1) are therefore
 *    DELIBERATELY excluded — fail-closed, plain search is
 *    covered by grep/egrep/fgrep. Any binary ADDED via U1-P5 tuning must be
 *    read-only by nature (not merely "denylist a few flags") before it is trusted.
 */

import { splitBashSegments } from "./rules.js";

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
 * `tree` was REMOVED (TASK.35 fix wave 1, W1-BLOCKER-1): `tree -o FILE` writes
 * its listing to FILE, and the verbatim flag net cannot exhaust that surface —
 * short clusters and attached values (`tree -no FILE`, `tree -o<FILE>`) spell
 * the same write without ever producing the token `-o`. Under the module-doc
 * admission criterion (a binary whose write surface the screen cannot exhaust
 * is not a candidate) `tree` never qualified; it now asks like any other
 * non-allowlisted binary. No entry may lean on the flag net for its safety.
 */
export const READ_ONLY_BINARIES: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "whoami", "id", "uname",
  "stat", "du", "df", "echo", "printf",
  "grep", "egrep", "fgrep",
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

/** Classification of a full Bash command LINE (TASK.35). `class` is the
 * allow-relevant verdict; `shellExpression` is a PRESENTATION-ONLY fact
 * (true when the line is more than one plain simple command — pipeline,
 * forbidden separator, substitution, unbalanced quote, or any shell
 * metacharacter in a single command) consumed by the permission modal's
 * «unknown shell expression» copy. It never feeds the allow decision. */
export interface BashCommandLineClassification {
  class: BashCommandClass;
  shellExpression: boolean;
}

/** The one accepted sed script shape: `<n>p` or `<n>,<m>p` (DV-5). */
const SED_PRINT_SCRIPT_RE = /^[0-9]+(,[0-9]+)?p$/;

interface SegmentToken {
  /** Token exactly as written, quotes included. */
  raw: string;
  /** Token with quote characters removed (shell word after quote removal). */
  unquoted: string;
}

/**
 * Quote-aware word splitter for ONE pipeline segment (TASK.35). Input is a
 * segment that already passed `hasUnsafeCharacter` (no metacharacters,
 * control chars, backslash, `$`, or backtick remain) — the walls below are
 * kept anyway as a defensive floor that does not depend on the caller.
 * Returns `undefined` on any wall hit or an unterminated quote.
 */
function tokenizeSegment(segment: string): SegmentToken[] | undefined {
  const tokens: SegmentToken[] = [];
  let raw = "";
  let unquoted = "";
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment.charAt(i);
    const code = segment.charCodeAt(i);
    // Hard walls (unreachable after the §4.2 raw screen, kept fail-closed):
    // escapes and expansions have no tokenization here at all.
    if (ch === "\\" || ch === "$" || ch === "`") {
      return undefined;
    }
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      return undefined;
    }
    if (inSingle) {
      raw += ch;
      hasToken = true;
      if (ch === "'") {
        inSingle = false;
      } else {
        unquoted += ch;
      }
      continue;
    }
    if (inDouble) {
      raw += ch;
      hasToken = true;
      if (ch === '"') {
        inDouble = false;
      } else {
        unquoted += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      raw += ch;
      hasToken = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      raw += ch;
      hasToken = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (hasToken) {
        tokens.push({ raw, unquoted });
        raw = "";
        unquoted = "";
        hasToken = false;
      }
      continue;
    }
    raw += ch;
    unquoted += ch;
    hasToken = true;
  }
  if (inSingle || inDouble) {
    return undefined;
  }
  if (hasToken) {
    tokens.push({ raw, unquoted });
  }
  return tokens;
}

/** Classifies a `sed -n '<addr>p' <path>` pipeline segment (DV-5, §4.3). Every
 * other sed form asks — this is a branch in the pipeline segment classifier
 * only, `sed` is NOT added to READ_ONLY_BINARIES. */
function classifySedPipelineTokens(tokens: SegmentToken[]): BashCommandClass {
  // Exactly `sed -n '<addr>p' <path>`, four tokens, fixed positions (DV-5).
  if (tokens.length !== 4) {
    return "unknown";
  }
  const flag = tokens[1]!;
  const script = tokens[2]!;
  const operand = tokens[3]!;
  // `-n` must be written plainly: a quoted "-n" or a bundled `-ni`/`-ne` asks.
  if (flag.raw !== "-n") {
    return "unknown";
  }
  // Script is matched after quote removal ('1,5p' / "1,5p" / 1,5p all fine);
  // anything beyond `<n>p` / `<n>,<m>p` — `w`, `s///`, `i`, `d`, `$`, `;`,
  // steps — fails here or already died on the §4.2 raw screen.
  if (!SED_PRINT_SCRIPT_RE.test(script.unquoted)) {
    return "unknown";
  }
  // Exactly one path operand; a dash-leading token (raw or unquoted) could be
  // parsed by sed as another option (or stdin `-`) — refused.
  if (operand.unquoted === "" || operand.unquoted.startsWith("-") || operand.raw.startsWith("-")) {
    return "unknown";
  }
  return "read-only";
}

/** Classifies ONE pipeline segment (TASK.35, §4.2). Doubly conservative: the
 * quote-UNAWARE raw screen runs first (same maximum-conservatism rule as the
 * single-command path), THEN quote-aware tokenization — tokenization exists
 * to CATCH what quotes hide, never to ADMIT what quotes wrap. */
function classifyPipelineSegment(segment: string): BashCommandClass {
  // 1. Quote-UNAWARE raw screen — the same maximum-conservatism rule as the
  //    single-command path: any shell metacharacter or control character
  //    anywhere in the segment (redirects < >, $, backtick, \, = env
  //    assignment, glob * ? [ ], brace { }, ~, !, #, NUL/ESC/CR/DEL…) demotes
  //    it, even inside quotes. Only plain quote characters survive to the
  //    tokenizer: quote-awareness exists to CATCH hidden flags, not to ADMIT
  //    quoted metacharacters (CUT-S2 D-S2-5).
  if (hasUnsafeCharacter(segment)) {
    return "unknown";
  }
  // 2. Quote-aware word split with quote removal (§5). Fail or empty => unknown.
  const tokens = tokenizeSegment(segment);
  if (tokens === undefined || tokens.length === 0) {
    return "unknown";
  }
  // 3. The command word must be quote-free (D-S2-6): a quoted or
  //    quote-assembled binary name never auto-runs. LIVE but security-inert
  //    (ARBITRATION-S2-W1 D-W1-2): removing it would only admit
  //    quoted-directory-prefix spellings (`"a"/cat x`) whose executed basename
  //    is identical to an already-sanctioned unquoted twin (RES-6 basename
  //    trust). Kept as a zero-cost strictness rule, not as a load-bearing
  //    security guard — do NOT delete as "dead code" (MUTATION-S2.md W1
  //    corrections; A7's slash-after-quote vectors go red on deletion).
  const first = tokens[0]!;
  if (first.raw !== first.unquoted) {
    return "unknown";
  }
  const binary = basename(first.raw);
  // 4. v1: no git segments in pipelines (DV-5 — the examples table wins).
  if (binary === "git") {
    return "unknown";
  }
  // 5. The one sed subgrammar (DV-5); every other sed form asks.
  if (binary === "sed") {
    return classifySedPipelineTokens(tokens);
  }
  // 6. Allowlist basename — same basename-trust limit as the single path.
  if (!READ_ONLY_BINARIES.has(binary)) {
    return "unknown";
  }
  // 7. Bare-only binaries: any argument may carry an effect (`date -s`).
  if (NO_ARGUMENT_BINARIES.has(binary) && tokens.length > 1) {
    return "unknown";
  }
  // 8. Write-flag screen on RAW and UNQUOTED forms — unquoted is the
  //    load-bearing one (`tree "-o" x` — DV-5); raw is defense in depth.
  for (const token of tokens.slice(1)) {
    if (isWriteFlag(token.raw, WRITE_CAPABLE_FLAGS) || isWriteFlag(token.unquoted, WRITE_CAPABLE_FLAGS)) {
      return "unknown";
    }
  }
  return "read-only";
}

/**
 * Classifies a full Bash command line, pipelines included (TASK.35, DV-5).
 * Grammar v1: the ONLY accepted compound form is `cmd | cmd | …` — every
 * separator `|`, no blank segments, every segment independently provable
 * read-only via the pipeline segment screens. A single-segment line routes to
 * classifyBashCommand on the ORIGINAL string, bit-for-bit. Everything else —
 * `;`/`&`/`&&`/`||`/`|&`/newline chains, substitutions, redirects,
 * unbalanced quotes — is "unknown" (fail-closed).
 */
export function classifyBashCommandLine(command: string): BashCommandLineClassification {
  const split = splitBashSegments(command);
  if (split === undefined) {
    // Substitution or unterminated quote: unsegmentable, never auto-allow.
    return { class: "unknown", shellExpression: true };
  }
  if (split.segments.length === 1) {
    // Single plain command: the pre-TASK.35 path, verdict-for-verdict.
    return { class: classifyBashCommand(command), shellExpression: hasUnsafeCharacter(command) };
  }
  if (split.separators.some((separator) => separator !== "|")) {
    return { class: "unknown", shellExpression: true };
  }
  if (split.segments.some((segment) => segment.trim() === "")) {
    // A blank between pipes (`a | | b`, leading/trailing pipe, `|&` middle):
    // malformed or smuggled — never auto-allow (invariant 4).
    return { class: "unknown", shellExpression: true };
  }
  for (const segment of split.segments) {
    if (classifyPipelineSegment(segment) !== "read-only") {
      return { class: "unknown", shellExpression: true };
    }
  }
  return { class: "read-only", shellExpression: true };
}
