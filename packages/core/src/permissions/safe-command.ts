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
 * ORIGINAL string, bit-for-bit. The widening surface is exactly all-`|`
 * multi-segment pipelines whose every segment independently proves read-only
 * through a doubly-conservative per-segment screen (raw metacharacter screen,
 * THEN quote-aware tokenization) — see `classifyPipelineSegment`.
 *
 * Arguments are checked after quote removal as well as in their raw form, so
 * quoting a write flag cannot hide it from the screen.
 *
 * KNOWN LEXICAL LIMITS:
 *  - Bare command names still rely on the execution environment's PATH. Paths
 *    supplied as command words are rejected, including absolute paths.
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
 * positional case below, restricted further). `git` is excluded: repository
 * configuration can run pagers, diff drivers, text converters and fsmonitor hooks. `env` and
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

/** Historical Git policy exported for consumers; it does not grant automatic
 * approval, because repository configuration can run external programs. */
export const GIT_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "rev-parse", "describe",
  "blame", "shortlog", "ls-files", "ls-tree", "cat-file",
]);

/** Historical bare-only Git policy, retained for consumers. */
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

/**
 * Classifies a Bash command string as provably "read-only" or else "unknown".
 * Fail-closed: returns "read-only" only when the metacharacter screen, the
 * command allowlist, and the per-binary flag screens all pass.
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

  // Check arguments after quote removal as well as in their raw form.
  const segmentTokens = tokenizeSegment(command);

  // Only bare, unquoted command names are trusted; a repository can contain
  // an arbitrary executable named like an allowlisted program.
  const binary = tokens[0]!;
  if (binary.includes("/")) return "unknown";
  if (!READ_ONLY_BINARIES.has(binary)) {
    return "unknown";
  }

  // 4a. Bare-only binaries: any argument may carry an effect (e.g. `date -s`).
  if (NO_ARGUMENT_BINARIES.has(binary) && tokens.length > 1) {
    return "unknown";
  }

  // 4b. Write-flag safety net across every argument, screened on BOTH the raw
  //     (quotes intact) and quote-stripped form (TASK.136 RES-1 fix): a
  //     quoted flag like `"--output"` starts with `"`, not `-`, so checking
  //     the naive string alone never recognizes it (`git diff "--output" f`
  //     wrote `f` on live git 2.37.1 before this fix — see GP2). Fail-closed
  //     on an unterminated quote: `segmentTokens === undefined` means the
  //     quote-aware split could not prove any argument flag-free, and
  //     "unprovable" is "unknown" by this module's own rule (module doc,
  //     top), not "read-only" by default. This is a real, intentional
  //     behavior change from the pre-TASK.136 code, which never looked at
  //     quote state on this path at all and would fall through to
  //     "read-only" here (see the now-updated V4 pin).
  if (segmentTokens === undefined) {
    return "unknown";
  }
  for (const token of segmentTokens.slice(1)) {
    if (isWriteFlag(token.raw, WRITE_CAPABLE_FLAGS) || isWriteFlag(token.unquoted, WRITE_CAPABLE_FLAGS)) {
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
  // Reject quoted command words and path-qualified executables.
  const first = tokens[0]!;
  if (first.raw !== first.unquoted) {
    return "unknown";
  }
  const binary = first.raw;
  if (binary.includes("/")) return "unknown";
  // 5. The one sed subgrammar (DV-5); every other sed form asks.
  if (binary === "sed") {
    return classifySedPipelineTokens(tokens);
  }
  // 6. Only allowlisted bare command names pass.
  if (!READ_ONLY_BINARIES.has(binary)) {
    return "unknown";
  }
  // 7. Bare-only binaries: any argument may carry an effect (`date -s`).
  if (NO_ARGUMENT_BINARIES.has(binary) && tokens.length > 1) {
    return "unknown";
  }
  // 8. Write-flag screen on RAW and UNQUOTED forms — unquoted is the
  //    load-bearing one (`cat "--in-place" f | wc` — MV5's sole surviving
  //    discriminator; the original DV-5 example `tree "-o" x` now dies at
  //    the step-6 allowlist miss, W1 removed tree); raw is defense in depth.
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

// TASK.36: the scoped-runner grammar lives once in rules.ts; re-exported here so
// the desktop renderer reaches it through this EXISTING package.json subpath
// (the exports map is frozen outside TASK.36's allowed paths). This module
// already imports splitBashSegments from ./rules.js, so no new dependency edge.
export {
  SCOPED_PATTERN_PREFIX,
  SCOPED_RUNNER_BINARIES,
  SCOPED_RUNNER_VERBS,
  formatScopedRunnerPattern,
  parseScopedRunnerPattern,
  recognizeScopedRunnerCommand,
} from "./rules.js";
export type { ScopedRunnerRule } from "./rules.js";
